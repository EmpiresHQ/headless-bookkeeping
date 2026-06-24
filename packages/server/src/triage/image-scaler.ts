import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

/**
 * Maximum dimension (width OR height) for an image sent to the vision OCR
 * endpoint.  iPhone HEIC photos are typically 4032×3024 (12 MP); transcoded
 * to PNG they can be 15–20 MB, and base64 encoding adds ~33 %.  Most
 * OpenAI-compatible vision endpoints reject payloads over 4–20 MB.
 *
 * 2048 px is enough resolution for OCR to read printed text reliably while
 * keeping the JPEG under ~500 KB.
 */
const MAX_DIMENSION = 1024;
const JPEG_QUALITY = 85;

export interface ScaledImage {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Downscales large images before they are sent to the vision OCR endpoint.
 *
 * If the image's longest side exceeds {@link MAX_DIMENSION}, it is resized
 * (aspect ratio preserved) and re-encoded as JPEG quality 85 — a 12 MP PNG
 * becomes ~200 KB.  Images already within the limit are returned untouched.
 *
 * Never throws: on any sharp error the ORIGINAL buffer is returned so the
 * vision endpoint gets a chance to process it (or reject it with a typed
 * failure).  The scaler is an optimisation, not a gate.
 */
@Injectable()
export class ImageScaler {
  private readonly logger = new Logger(ImageScaler.name);

  async downscale(image: Buffer, mimeType: string): Promise<ScaledImage> {
    try {
      const meta = await sharp(image).metadata();
      const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
      if (longest <= MAX_DIMENSION) {
        return { buffer: image, mimeType };
      }

      const scaled = await sharp(image)
        .resize(MAX_DIMENSION, MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();

      this.logger.debug(
        `Downscaled image from ${meta.width}×${meta.height} to ≤${MAX_DIMENSION}px ` +
          `(${image.length} → ${scaled.length} bytes)`,
      );
      return { buffer: scaled, mimeType: 'image/jpeg' };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`Image downscale failed, sending original: ${err.message}`);
      return { buffer: image, mimeType };
    }
  }
}
