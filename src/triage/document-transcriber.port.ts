// src/triage/document-transcriber.port.ts

/**
 * Why a Pass-1 transcription failed. The intake workflow routes a transcription
 * failure to a human through the SAME typed-outcome seam as a Pass-2
 * classification failure (ADR-0024) — instead of an exception escaping and
 * leaving the Document stuck in `pending` with no AuditFinding.
 *
 *  - 'provider-unavailable': the OCR engine is not configured (no inference
 *                            endpoint set) or is unreachable (connection
 *                            refused) — no transcription attempted.
 *  - 'unreadable':           the document was sent but cannot be transcribed
 *                            (corrupt, blank, unsupported format, empty result)
 *                            — a permanent content problem.
 *  - 'transient':            an IO/temporary fault (timeout, 5xx, a stored
 *                            artifact file went missing) — likely retryable.
 *
 * A missing Document is NOT a category: it is a precondition violation (the
 * caller handed a bad id) with no object to route, so `OcrService.transcribe`
 * throws for that case before ever reaching the port.
 */
export type OcrFailureCategory =
  | 'provider-unavailable'
  | 'unreadable'
  | 'transient';

/** A successful Pass-1 transcription. */
export interface OcrSuccess {
  ok: true;
  markdown: string;
}

/** A Pass-1 failure carrying an explicit, observable category. */
export interface OcrFailure {
  ok: false;
  category: OcrFailureCategory;
  /** Human-readable detail (the underlying error message). */
  detail: string;
}

/** Discriminated outcome of a Pass-1 transcription attempt. */
export type OcrOutcome = OcrSuccess | OcrFailure;

/**
 * The raw document handed to a transcriber: bytes plus the metadata a multipart
 * upload needs. Matches DocumentsService.getFile's return shape.
 */
export interface TranscribableFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * The Pass-1 transcription edge: document bytes → markdown | typed failure.
 *
 * Mocked in every OcrService test; only the real adapter (MimeRoutingTranscriber)
 * does I/O. This is the single seam where the OCR engine is chosen —
 * OcrService's persistence/CRC/idempotency/race-safety machinery sits ENTIRELY
 * on the OcrOutcome contract and is engine-agnostic.
 */
export abstract class DocumentTranscriber {
  abstract transcribe(file: TranscribableFile): Promise<OcrOutcome>;
}
