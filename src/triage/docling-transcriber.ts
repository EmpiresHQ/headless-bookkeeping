import { Injectable, Logger } from '@nestjs/common';
import {
  DocumentTranscriber,
  OcrOutcome,
  TranscribableFile,
} from './document-transcriber.port';

/** Path of the docling-serve convert endpoint, relative to DOCLING_BASE_URL.
 *  Verified against the pinned docling-serve image tag (see docker-compose). */
const CONVERT_PATH = '/v1alpha/convert/file';

/** Per-request ceiling. OCR of a scanned multi-page PDF on CPU is slow; give it
 *  room but cap it so a hung sidecar surfaces as a transient failure. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Shape of the slice of the docling-serve response we read. */
interface DoclingConvertResponse {
  document?: { md_content?: string };
  status?: string;
  errors?: unknown[];
}

/**
 * Real Pass-1 transcriber — sends the document to a `docling-serve` sidecar and
 * returns its markdown. Uses Node 24 global fetch/FormData/Blob; never throws
 * (all faults map to a typed OcrFailure). The base URL is read from the
 * environment at call time (precedent: dev.agent.ts reads process.env).
 */
@Injectable()
export class DoclingTranscriber extends DocumentTranscriber {
  private readonly logger = new Logger(DoclingTranscriber.name);

  async transcribe(file: TranscribableFile): Promise<OcrOutcome> {
    const base = process.env.DOCLING_BASE_URL?.trim();
    if (!base) {
      this.logger.warn('DOCLING_BASE_URL unset — cannot transcribe');
      return {
        ok: false,
        category: 'provider-unavailable',
        detail: 'DOCLING_BASE_URL is not configured',
      };
    }

    const form = new FormData();
    // Copy into a Uint8Array backed by a plain ArrayBuffer — a Node Buffer's
    // ArrayBufferLike backing is not assignable to the DOM BlobPart type.
    form.append(
      'files',
      new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
      file.filename,
    );
    form.append('to_formats', 'md');

    let response: Response;
    try {
      response = await fetch(`${base}${CONVERT_PATH}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError';
      const category = timedOut ? 'transient' : 'provider-unavailable';
      this.logger.warn(
        `docling-serve unreachable (${category}): ${err.message}`,
      );
      return { ok: false, category, detail: err.message };
    }

    if (!response.ok) {
      // 5xx = server-side blip (retryable); 4xx = the document/request is bad.
      const category = response.status >= 500 ? 'transient' : 'unreadable';
      const detail = `docling-serve returned HTTP ${response.status}`;
      this.logger.warn(`${detail} (${category})`);
      return { ok: false, category, detail };
    }

    const body = (await response.json()) as DoclingConvertResponse;
    const markdown = body.document?.md_content ?? '';
    const failed = body.status === 'failure' || body.status === 'skipped';

    if (failed || markdown.trim().length === 0) {
      const detail = `docling-serve produced no markdown (status=${body.status ?? 'unknown'})`;
      this.logger.warn(detail);
      return { ok: false, category: 'unreadable', detail };
    }

    return { ok: true, markdown };
  }
}
