import { Injectable, Logger } from '@nestjs/common';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/** A positioned text fragment from pdf.js' `getTextContent()`. */
interface PdfTextItem {
  str: string;
  // Affine transform; [4] = x, [5] = y (PDF user-space units).
  transform: number[];
  width: number;
}

interface PdfPageData {
  getTextContent(opts: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items: PdfTextItem[] }>;
}

// The deep `pdf-parse/lib/pdf-parse.js` import is typed as a 1-arg function; the
// runtime accepts an options object (incl. our custom pagerender). Narrow it.
type PdfParseWithOptions = (
  buffer: Buffer,
  options: { pagerender: (page: PdfPageData) => Promise<string> },
) => Promise<{ text: string }>;

// Two fragments are on the same visual line when their baselines differ by no
// more than this (PDF units).
const Y_TOLERANCE = 1;
// Insert a space between same-line fragments when the horizontal gap exceeds
// this. pdf.js often emits each word as a separate fragment with NO trailing
// space, so without this the default render glues words together
// ("Invoiceto", "FinanceApS"). Tuned on real EU invoices: small enough to keep
// "services in" split, large enough not to shatter tight numeric columns.
const X_GAP_SPACE = 2;

/**
 * Rebuild a page's plain text from positioned fragments, restoring the spaces
 * and line breaks that pdf.js drops. Exported for unit testing. Pure.
 */
export function reconstructPageText(items: PdfTextItem[]): string {
  let out = '';
  let lastY: number | null = null;
  let lastEndX: number | null = null;
  for (const it of items) {
    const x = it.transform[4];
    const y = it.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > Y_TOLERANCE) {
      // New line: never a leading space (the else-if below is skipped); lastEndX
      // is refreshed at the end of this iteration regardless.
      out += '\n';
    } else if (lastEndX !== null && x - lastEndX > X_GAP_SPACE) {
      out += ' ';
    }
    out += it.str;
    lastY = y;
    lastEndX = x + (it.width ?? 0);
  }
  return out;
}

/**
 * Extracts the embedded text layer of a born-digital PDF, in-process, with no
 * ML and minimal memory (pure JS) — the cheap path that keeps a $5 VPS idle for
 * software-generated invoices. Returns the text; an empty/near-empty result
 * signals a scanned PDF, which the router sends to OCR. Never throws: a
 * corrupt/non-PDF buffer (or a PDF with no text layer) yields ''.
 *
 * A custom `pagerender` reconstructs word spacing from glyph positions —
 * pdf.js' default rendering concatenates positioned fragments without spaces,
 * which mangles invoices ("Invoiceto", merged table columns) and in turn wrecks
 * downstream Pass-2 classification.
 */
@Injectable()
export class PdfTextExtractor {
  private readonly logger = new Logger(PdfTextExtractor.name);

  async extract(pdf: Buffer): Promise<string> {
    try {
      const parse = pdfParse as unknown as PdfParseWithOptions;
      const result = await parse(pdf, {
        pagerender: (page: PdfPageData) =>
          page
            .getTextContent({
              normalizeWhitespace: false,
              disableCombineTextItems: false,
            })
            .then((tc) => reconstructPageText(tc.items)),
      });
      return result.text.trim();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.debug(`PDF text extraction yielded nothing: ${err.message}`);
      return '';
    }
  }
}
