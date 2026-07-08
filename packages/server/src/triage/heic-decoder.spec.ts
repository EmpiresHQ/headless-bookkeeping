import { isHeicMagicBytes } from './heic-decoder';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Build an ISOBMFF buffer where bytes 8–11 carry the given 4-char brand. */
function heicBuf(brand: string): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(24, 0);
  return Buffer.concat([
    size, // 0–3  box size (BE u32)
    Buffer.from('ftyp'), // 4–7  box type
    Buffer.from(brand.padEnd(4)), // 8–11 major brand
    Buffer.alloc(12), // 12–23 minor version + compatible brands
  ]);
}

describe('isHeicMagicBytes', () => {
  it('returns true for a buffer beginning with ftyp + heic brand', () => {
    expect(isHeicMagicBytes(heicBuf('heic'))).toBe(true);
  });

  it('returns true for heix brand (HEVC still image, extended)', () => {
    expect(isHeicMagicBytes(heicBuf('heix'))).toBe(true);
  });

  it('returns true for hevc brand (raw HEVC bitstream)', () => {
    expect(isHeicMagicBytes(heicBuf('hevc'))).toBe(true);
  });

  it('returns true for hevx brand', () => {
    expect(isHeicMagicBytes(heicBuf('hevx'))).toBe(true);
  });

  it('returns true for mif1 brand (HEIF multi-image)', () => {
    expect(isHeicMagicBytes(heicBuf('mif1'))).toBe(true);
  });

  it('returns true for msf1 brand (HEIF sequence)', () => {
    expect(isHeicMagicBytes(heicBuf('msf1'))).toBe(true);
  });

  it('returns false for a buffer shorter than 12 bytes', () => {
    expect(isHeicMagicBytes(Buffer.alloc(11))).toBe(false);
  });

  it('returns false for a non-ISOBMFF buffer (random bytes)', () => {
    expect(isHeicMagicBytes(Buffer.from('not an image file at all'))).toBe(
      false,
    );
  });

  it('returns false for a JPEG buffer (JFIF magic)', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    ]);
    expect(isHeicMagicBytes(jpeg)).toBe(false);
  });

  it('returns false for a PNG buffer', () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    expect(isHeicMagicBytes(png)).toBe(false);
  });

  it('returns false for an MP4 ftyp (ftypmp42)', () => {
    expect(isHeicMagicBytes(heicBuf('mp42'))).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(isHeicMagicBytes(Buffer.alloc(0))).toBe(false);
  });

  it('returns true for the real sample.heic fixture', () => {
    // The fixture is an actual iPhone HEIC photo.  isHeicMagicBytes is a pure
    // function — no filesystem, no decoder — so it must recognise this.
    const buf = readFileSync(
      join(__dirname, '../../test/fixtures/sample.heic'),
    );
    expect(isHeicMagicBytes(buf)).toBe(true);
  });
});
