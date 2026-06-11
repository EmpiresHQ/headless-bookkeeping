import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

/** Render DPI for OCR. 200 balances OCR accuracy against memory on a small VPS. */
const RENDER_DPI = '200';
/** Hard cap on pages rasterised — guards against a pathological multi-hundred-page scan. */
const MAX_PAGES = 20;

/**
 * Rasterises a (scanned) PDF to one PNG per page using poppler's `pdftoppm` —
 * a tiny, fast system binary, far lighter than node-canvas or a torch pipeline.
 * Used only on the fallback path (a PDF with no extractable text layer). Never
 * throws: returns [] on any failure (the router maps that to a typed failure).
 */
@Injectable()
export class PdfRasterizer {
  private readonly logger = new Logger(PdfRasterizer.name);

  async toPngPages(pdf: Buffer): Promise<Buffer[]> {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'ocr-raster-'));
      const inPath = join(dir, 'in.pdf');
      await writeFile(inPath, pdf);

      // pdftoppm -png -r 200 -l MAX_PAGES in.pdf <dir>/page → page-1.png, page-2.png, ...
      await execFileAsync('pdftoppm', [
        '-png',
        '-r',
        RENDER_DPI,
        '-l',
        String(MAX_PAGES),
        inPath,
        join(dir, 'page'),
      ]);

      // pdftoppm zero-pads the page number to the width of the page count, so
      // the pad width is constant within one render and a lexicographic sort is
      // correct (page-1 < page-2 …, or page-01 < page-02 … for 10+ pages).
      const files = (await readdir(dir))
        .filter((f) => f.startsWith('page') && f.endsWith('.png'))
        .sort();
      const pages: Buffer[] = [];
      for (const f of files) pages.push(await readFile(join(dir, f)));
      return pages;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`PDF rasterisation failed: ${err.message}`);
      return [];
    } finally {
      if (dir)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
