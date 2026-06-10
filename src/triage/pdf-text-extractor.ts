import { Injectable, Logger } from '@nestjs/common';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/**
 * Extracts the embedded text layer of a born-digital PDF, in-process, with no
 * ML and minimal memory (pure JS) — the cheap path that keeps a $5 VPS idle for
 * software-generated invoices. Returns the text; an empty/near-empty result
 * signals a scanned PDF, which the router sends to OCR. Never throws: a
 * corrupt/non-PDF buffer (or a PDF with no text layer) yields ''.
 */
@Injectable()
export class PdfTextExtractor {
  private readonly logger = new Logger(PdfTextExtractor.name);

  async extract(pdf: Buffer): Promise<string> {
    try {
      const result = await pdfParse(pdf);
      return result.text.trim();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.debug(`PDF text extraction yielded nothing: ${err.message}`);
      return '';
    }
  }
}
