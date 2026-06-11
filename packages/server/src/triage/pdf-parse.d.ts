/**
 * Minimal typing for pdf-parse's library entry. We import the `lib/` path
 * (not the package index) on purpose: the index has a debug block that reads a
 * sample file when `module.parent` is falsy, which throws under some runtimes.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
  }
  function pdfParse(data: Buffer): Promise<PdfParseResult>;
  export = pdfParse;
}
