import { ImageScaler } from './image-scaler';
import sharp from 'sharp';

describe('ImageScaler', () => {
  const scaler = new ImageScaler();

  it('returns the original buffer when the image is already small', async () => {
    const small = await sharp({
      create: { width: 100, height: 100, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();

    const result = await scaler.downscale(small, 'image/png');
    expect(result.buffer).toBe(small);
    expect(result.mimeType).toBe('image/png');
  });

  it('downscales a large image to ≤2048px and re-encodes as JPEG', async () => {
    const large = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();

    const result = await scaler.downscale(large, 'image/png');
    expect(result.buffer).not.toBe(large);
    expect(result.mimeType).toBe('image/jpeg');

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(2048);
    expect(meta.height).toBeLessThanOrEqual(2048);
    // JPEG magic bytes
    expect(result.buffer[0]).toBe(0xff);
    expect(result.buffer[1]).toBe(0xd8);
  });

  it('preserves aspect ratio when downscaling', async () => {
    // 4032×3024 is the classic iPhone 12 MP resolution
    const large = await sharp({
      create: { width: 4032, height: 3024, channels: 3, background: 'green' },
    })
      .png()
      .toBuffer();

    const result = await scaler.downscale(large, 'image/png');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBeLessThan(2048); // 3024 * (2048/4032) ≈ 1536
  });

  it('returns the original on a non-image buffer (never throws)', async () => {
    const junk = Buffer.from('not an image at all');
    const result = await scaler.downscale(junk, 'image/png');
    expect(result.buffer).toBe(junk);
    expect(result.mimeType).toBe('image/png');
  });

  it('returns the original on an empty buffer (never throws)', async () => {
    const result = await scaler.downscale(Buffer.alloc(0), 'image/png');
    expect(result.buffer).toHaveLength(0);
  });
});
