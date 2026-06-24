/**
 * PreviewRenderer - turns a Document's stored bytes into a single thumbnail PNG.
 *
 * Dispatch table:
 *   PDF                       -> pdftoppm (page 1 only, low DPI) -> sharp resize -> PNG
 *   JPEG/PNG/WebP/GIF/TIFF   -> sharp resize -> PNG
 *   HEIC (or magic-byte HEIC) -> HeicDecoder.toPng -> sharp resize -> PNG
 *   anything else / corrupt   -> null (never throws)
 *
 * Thumbnail path convention: `{docId}/previews/{hash}.png`
 *   Scoped under the document's storage namespace (same as its raw file).
 *   Content-addressed by sha256 hash, so the path is stable: re-rendering
 *   the same document always writes to the same key.
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

/** Longest edge of the generated thumbnail in pixels. */
const THUMBNAIL_SIZE = 256;

/**
 * Low DPI for preview rendering. At 50 DPI a typical A4 page (842 pt) renders
 * at ~584 px; sharp then downscales that to <=256 px.
 * Much faster than OCR-grade 200 DPI and produces far less memory pressure.
 */
const PREVIEW_DPI = '50';

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
   * Render `bytes` to a ~256px PNG thumbnail and persist it via storage.
   *
   * @param document  The Document row - used for `id` (storage namespace)
   *                  and `hash` (stable thumbnail key).
   * @param bytes     The raw file bytes to render.
   * @returns  Relative storage path of the thumbnail, or `null` on any failure.
   */
  async render(document: Document, bytes: Buffer): Promise<string | null> {
    try {
      const pngBuf = await this.renderToPng(document.mime_type, bytes);
      if (!pngBuf) return null;

      // DocumentStorageService.saveFile(id, filename) writes to
      // {root}/{id}/{filename} and returns join(String(id), filename).
      // We use filename=`previews/{hash}.png` so the returned relative path
      // is `{id}/previews/{hash}.png` - stable and content-addressed.
      const thumbnailFilename = `previews/${document.hash}.png`;
      const relativePath = await this.storage.saveFile(
        document.id,
        thumbnailFilename,
        pngBuf,
      );
      return relativePath;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `Preview render failed for document ${document.id}: ${err.message}`,
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
  ): Promise<Buffer | null> {
    // HEIC detection: check mime_type first, then fall back to magic bytes.
    // iOS/browsers can send wrong or empty MIME for HEIC files.
    if (HEIC_MIME_TYPES.has(mimeType) || isHeicMagicBytes(bytes)) {
      return this.renderHeic(bytes);
    }

    if (mimeType === 'application/pdf') {
      return this.renderPdf(bytes);
    }

    if (RASTER_MIME_TYPES.has(mimeType)) {
      return this.renderRaster(bytes);
    }

    // Unsupported MIME type.
    return null;
  }

  /** Resize any raster image to a <=THUMBNAIL_SIZE PNG via sharp. */
  private async renderRaster(bytes: Buffer): Promise<Buffer | null> {
    try {
      return await sharp(bytes)
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
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

  /** Rasterise page 1 of a PDF at low DPI, then resize to thumbnail. */
  private async renderPdf(bytes: Buffer): Promise<Buffer | null> {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'preview-pdf-'));
      const inPath = join(dir, 'in.pdf');
      await writeFile(inPath, bytes);

      // `-singlefile` writes exactly one file (no page-number suffix).
      // `-l 1` stops after page 1. `-r PREVIEW_DPI` keeps the raster small.
      await execFileAsync('pdftoppm', [
        '-png',
        '-r',
        PREVIEW_DPI,
        '-l',
        '1',
        '-singlefile',
        inPath,
        join(dir, 'page'),
      ]);

      const pageBuffer = await readFile(join(dir, 'page.png'));
      return this.renderRaster(pageBuffer);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`PDF preview render failed: ${err.message}`);
      return null;
    } finally {
      if (dir)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Decode HEIC to PNG via HeicDecoder, then resize to thumbnail. */
  private async renderHeic(bytes: Buffer): Promise<Buffer | null> {
    const pngBuffer = await this.heicDecoder.toPng(bytes);
    if (!pngBuffer) return null;
    return this.renderRaster(pngBuffer);
  }
}
