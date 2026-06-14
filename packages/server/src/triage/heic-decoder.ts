import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

/**
 * Decodes a HEIC/HEIF image to PNG using libheif's `heif-convert` — a small
 * system binary, mirroring how PdfRasterizer shells out to poppler's
 * `pdftoppm`. HEIC is the default iPhone capture format; vision providers do
 * not decode it, so it must be transcoded before OCR (the same reason scanned
 * PDFs are rasterised first). Never throws: returns null on any failure, which
 * the router maps to a typed, actionable "convert to PDF/JPG" outcome.
 */
@Injectable()
export class HeicDecoder {
  private readonly logger = new Logger(HeicDecoder.name);

  async toPng(heic: Buffer): Promise<Buffer | null> {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'ocr-heic-'));
      const inPath = join(dir, 'in.heic');
      const outPath = join(dir, 'out.png');
      await writeFile(inPath, heic);

      // heif-convert in.heic out.png → a single PNG (first image of the file).
      await execFileAsync('heif-convert', [inPath, outPath]);

      return await readFile(outPath);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`HEIC decode failed: ${err.message}`);
      return null;
    } finally {
      if (dir)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
