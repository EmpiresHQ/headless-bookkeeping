import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

/**
 * Candidate HEIC→PNG transcoders, tried in order until one produces output.
 * libheif's `heif-convert` is what the Docker image ships (libheif-tools);
 * `sips` is the macOS-native fallback for local dev; ImageMagick covers the
 * rest. Each entry maps (inPath, outPath) to that tool's argv.
 */
const DECODERS: {
  cmd: string;
  args: (inPath: string, outPath: string) => string[];
}[] = [
  { cmd: 'heif-convert', args: (i, o) => [i, o] },
  { cmd: 'sips', args: (i, o) => ['-s', 'format', 'png', i, '--out', o] },
  { cmd: 'magick', args: (i, o) => [i, o] },
  { cmd: 'convert', args: (i, o) => [i, o] },
];

/**
 * Decodes a HEIC/HEIF image to PNG, mirroring how PdfRasterizer shells out to
 * poppler. HEIC is the default iPhone capture format; vision providers do not
 * decode it, so it must be transcoded before OCR (the same reason scanned PDFs
 * are rasterised first). Portable across the Docker image (heif-convert) and
 * local dev (sips). Never throws: returns null when no decoder is available or
 * the input is not a decodable image — the router maps that to a typed,
 * actionable "convert to PDF/JPG" outcome.
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

      for (const d of DECODERS) {
        try {
          await execFileAsync(d.cmd, d.args(inPath, outPath));
          return await readFile(outPath);
        } catch {
          // Tool missing (ENOENT) or it rejected the input — try the next one.
        }
      }
      this.logger.warn(
        'HEIC decode failed: no available decoder (heif-convert/sips/magick) could transcode the image',
      );
      return null;
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
