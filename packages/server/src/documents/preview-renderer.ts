/**
 * PreviewRenderer - turns a Document's stored bytes into a rendered PNG
 * variant (a small thumbnail, or a larger sharp preview for the lightbox).
 *
 * Dispatch table:
 *   PDF                       -> pdftoppm (page 1 only, low DPI) -> sharp resize -> PNG
 *   JPEG/PNG/WebP/GIF/TIFF   -> sharp resize -> PNG
 *   HEIC (or magic-byte HEIC) -> HeicDecoder.toPng -> sharp resize -> PNG
 *   anything else / corrupt   -> null (never throws)
 *
 * Variant table (VARIANTS below) controls the longest-edge cap, PDF raster
 * DPI, and filename suffix per variant:
 *   thumb -> `{docId}/previews/{hash}.png`      (CRITICAL: no suffix — existing
 *             preview_path DB rows point at this exact filename)
 *   lg    -> `{docId}/previews/{hash}@lg.png`   (lazily rendered; storage
 *             existence IS the cache, no DB column)
 *
 * This is the single render path shared by early intake (Task 3) and the lazy
 * fallback preview endpoint (Task 4). It lives in DocumentsModule with no
 * OcrModule import, avoiding any circular dependency.
 */
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { DocumentStorageService } from './document-storage.service';
import { HeicDecoder, isHeicMagicBytes } from '../triage/heic-decoder';
import { Document } from './types';

const execFileAsync = promisify(execFile);

export type PreviewVariant = 'thumb' | 'lg';

/**
 * Per-variant render parameters.
 *  - maxEdge: longest edge cap in pixels (sharp `resize`, withoutEnlargement).
 *  - dpi: pdftoppm raster DPI for PDFs. thumb stays at the historical 50 DPI
 *    (fast, low memory); lg renders at 150 DPI so `maxEdge` has real detail
 *    to downscale from instead of upscaling a blurry 50-DPI raster.
 *  - suffix: appended to the content-addressed filename. thumb's suffix MUST
 *    stay '' — existing preview_path DB rows point at `previews/{hash}.png`.
 */
const VARIANTS = {
  thumb: { maxEdge: 256, dpi: '50', suffix: '' },
  lg: { maxEdge: 1600, dpi: '150', suffix: '@lg' },
} as const;

const RASTER_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/bmp',
]);

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

@Injectable()
export class PreviewRenderer {
  private readonly logger = new Logger(PreviewRenderer.name);

  constructor(
    private readonly storage: DocumentStorageService,
    private readonly heicDecoder: HeicDecoder,
  ) {}

  /**
   * Render `bytes` to a PNG variant (thumb or lg) and persist it via storage.
   *
   * @param document  The Document row - used for `id` (storage namespace)
   *                  and `hash` (stable content-addressed key).
   * @param bytes     The raw file bytes to render.
   * @param variant   Which variant to render — defaults to 'thumb'.
   * @returns  Relative storage path of the rendered variant, or `null` on any
   *           failure.
   */
  async render(
    document: Document,
    bytes: Buffer,
    variant: PreviewVariant = 'thumb',
  ): Promise<string | null> {
    try {
      const spec = VARIANTS[variant];
      const pngBuf = await this.renderToPng(document.mime_type, bytes, spec);
      if (!pngBuf) return null;

      // DocumentStorageService.saveFile(id, filename) writes to
      // {root}/{id}/{filename} and returns join(String(id), filename).
      // We use filename=`previews/{hash}{suffix}.png` so the returned
      // relative path is `{id}/previews/{hash}{suffix}.png` - stable and
      // content-addressed. thumb's suffix is '' (unchanged filename).
      const filename = `previews/${document.hash}${spec.suffix}.png`;
      const relativePath = await this.storage.saveFile(
        document.id,
        filename,
        pngBuf,
      );
      return relativePath;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `Preview render failed for document ${document.id} (variant=${variant}): ${err.message}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private dispatch
  // ---------------------------------------------------------------------------

  private async renderToPng(
    mimeType: string,
    bytes: Buffer,
    spec: (typeof VARIANTS)[PreviewVariant],
  ): Promise<Buffer | null> {
    // HEIC detection: check mime_type first, then fall back to magic bytes.
    // iOS/browsers can send wrong or empty MIME for HEIC files.
    if (HEIC_MIME_TYPES.has(mimeType) || isHeicMagicBytes(bytes)) {
      return this.renderHeic(bytes, spec);
    }

    if (mimeType === 'application/pdf') {
      return this.renderPdf(bytes, spec);
    }

    if (RASTER_MIME_TYPES.has(mimeType)) {
      return this.renderRaster(bytes, spec);
    }

    // Unsupported MIME type.
    return null;
  }

  /** Resize any raster image to <=spec.maxEdge PNG via sharp. */
  private async renderRaster(
    bytes: Buffer,
    spec: (typeof VARIANTS)[PreviewVariant],
  ): Promise<Buffer | null> {
    try {
      return await sharp(bytes)
        .resize(spec.maxEdge, spec.maxEdge, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`Raster thumbnail failed: ${err.message}`);
      return null;
    }
  }

  /** Rasterise page 1 of a PDF at spec.dpi, then resize to spec.maxEdge. */
  private async renderPdf(
    bytes: Buffer,
    spec: (typeof VARIANTS)[PreviewVariant],
  ): Promise<Buffer | null> {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'preview-pdf-'));
      const inPath = join(dir, 'in.pdf');
      await writeFile(inPath, bytes);

      // `-singlefile` writes exactly one file (no page-number suffix).
      // `-l 1` stops after page 1. `-r spec.dpi` keeps the raster small.
      await execFileAsync('pdftoppm', [
        '-png',
        '-r',
        spec.dpi,
        '-l',
        '1',
        '-singlefile',
        inPath,
        join(dir, 'page'),
      ]);

      const pageBuffer = await readFile(join(dir, 'page.png'));
      return this.renderRaster(pageBuffer, spec);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`PDF preview render failed: ${err.message}`);
      return null;
    } finally {
      if (dir)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Decode HEIC to PNG via HeicDecoder, then resize to spec.maxEdge. */
  private async renderHeic(
    bytes: Buffer,
    spec: (typeof VARIANTS)[PreviewVariant],
  ): Promise<Buffer | null> {
    const pngBuffer = await this.heicDecoder.toPng(bytes);
    if (!pngBuffer) return null;
    return this.renderRaster(pngBuffer, spec);
  }
}
