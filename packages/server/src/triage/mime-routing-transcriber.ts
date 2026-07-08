import { Injectable } from '@nestjs/common';
import {
  DocumentTranscriber,
  OcrOutcome,
  TranscribableFile,
} from './document-transcriber.port';
import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfRasterizer } from './pdf-rasterizer';
import { HeicDecoder, isHeicMagicBytes } from './heic-decoder';
import { ImageScaler } from './image-scaler';

/** A born-digital text layer shorter than this is treated as "no real text"
 *  (a scanned PDF whose only glyphs are noise) → OCR fallback. */
const MIN_TEXT_CHARS = 16;
/** Page separator in the concatenated OCR of a multi-page scanned PDF. */
const PAGE_SEPARATOR = '\n\n---\n\n';

/**
 * The Pass-1 engine, routed by MIME (ADR-0032). Born-digital PDFs are text-
 * extracted in-process (no ML, no network); images and scanned PDFs are OCR'd
 * by the external vision endpoint. Keeps the heavy work off the host entirely.
 * Never throws — every path yields a typed OcrOutcome.
 */
@Injectable()
export class MimeRoutingTranscriber extends DocumentTranscriber {
  constructor(
    private readonly vision: LlmVisionTranscriber,
    private readonly pdfText: PdfTextExtractor,
    private readonly rasterizer: PdfRasterizer,
    private readonly heic: HeicDecoder,
    private readonly scaler: ImageScaler,
  ) {
    super();
  }

  /** Downscale then send to vision — shared by all image paths. */
  private async ocrImage(
    buffer: Buffer,
    mimeType: string,
  ): Promise<OcrOutcome> {
    const { buffer: scaled, mimeType: mt } = await this.scaler.downscale(
      buffer,
      mimeType,
    );
    return this.vision.transcribeImage({ buffer: scaled, mimeType: mt });
  }

  async transcribe(file: TranscribableFile): Promise<OcrOutcome> {
    const mime = file.mimeType.toLowerCase();

    // Detect HEIC/HEIF by MIME type OR by magic bytes.  The browser-reported
    // MIME is unreliable: Chrome/Firefox on desktop return an empty string for
    // HEIC files, and even the iOS app may send `application/octet-stream` when
    // the UTI mapping misfires.  The magic-bytes check is the definitive
    // server-side fallback — it is pure, synchronous, and never throws.
    const mimeIsHeic = mime === 'image/heic' || mime === 'image/heif';
    const magicIsHeic = !mimeIsHeic && isHeicMagicBytes(file.buffer);
    const isHeic = mimeIsHeic || magicIsHeic;

    // HEIC/HEIF (default iPhone capture) is an image/* the vision provider can
    // NOT decode — transcode to PNG first, like a scanned PDF is rasterised. A
    // decode failure is surfaced with an actionable hint rather than silently
    // forwarded to a model that would reject it.
    if (isHeic) {
      const png = await this.heic.toPng(file.buffer);
      if (!png) {
        return {
          ok: false,
          category: 'unreadable',
          detail: `HEIC/HEIF image could not be decoded for OCR (${file.mimeType}). Convert it to PDF or JPG and re-upload.`,
        };
      }
      return this.ocrImage(png, 'image/png');
    }

    if (mime.startsWith('image/')) {
      return this.ocrImage(file.buffer, file.mimeType);
    }

    if (mime === 'application/pdf') {
      return this.transcribePdf(file.buffer);
    }

    return {
      ok: false,
      category: 'unreadable',
      detail: `Unsupported document type for OCR: ${file.mimeType}`,
    };
  }

  /** Digital PDF → text layer; scanned PDF → raster + per-page vision OCR. */
  private async transcribePdf(pdf: Buffer): Promise<OcrOutcome> {
    const text = await this.pdfText.extract(pdf);
    if (text.trim().length >= MIN_TEXT_CHARS) {
      return { ok: true, markdown: text };
    }

    // No usable text layer → scanned PDF. Rasterise and OCR each page.
    const pages = await this.rasterizer.toPngPages(pdf);
    if (pages.length === 0) {
      return {
        ok: false,
        category: 'unreadable',
        detail: 'PDF has no text layer and could not be rasterised for OCR',
      };
    }

    const markdowns: string[] = [];
    let firstFailure: OcrOutcome | null = null;
    for (const page of pages) {
      const out = await this.ocrImage(page, 'image/png');
      if (out.ok) markdowns.push(out.markdown);
      else if (!firstFailure) firstFailure = out;
    }

    if (markdowns.length === 0) {
      // Every page failed — surface the first typed failure (e.g. transient).
      return (
        firstFailure ?? {
          ok: false,
          category: 'unreadable',
          detail: 'OCR produced no text for any page',
        }
      );
    }
    return { ok: true, markdown: markdowns.join(PAGE_SEPARATOR) };
  }
}
