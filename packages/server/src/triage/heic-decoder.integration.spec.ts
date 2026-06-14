import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HeicDecoder } from './heic-decoder';

/**
 * Integration test for the REAL HeicDecoder against a real HEIC file (a
 * downscaled copy of the field document IMG_1875.HEIC that Pass-1 could not OCR
 * before HEIC support). Requires a HEIC decoder on PATH — heif-convert
 * (Linux/Docker, libheif-tools) or sips (macOS dev). Skips when none is present
 * so CI without a decoder is green rather than red.
 */
function hasAnyDecoder(): boolean {
  for (const probe of [
    ['heif-convert', ['--version']],
    ['sips', ['--version']],
    ['magick', ['-version']],
    ['convert', ['-version']],
  ] as const) {
    try {
      execFileSync(probe[0], probe[1], { stdio: 'ignore' });
      return true;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}

const FIXTURE = join(__dirname, '../../test/fixtures/sample.heic');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const maybe = hasAnyDecoder() ? describe : describe.skip;

maybe('HeicDecoder (requires a HEIC decoder: heif-convert or sips)', () => {
  it('decodes a real HEIC file to a PNG buffer', async () => {
    const heic = readFileSync(FIXTURE);
    const png = await new HeicDecoder().toPng(heic);

    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(0);
    // Real PNG output starts with the PNG magic number.
    expect(png!.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });

  it('returns null (never throws) for bytes that are not a HEIC image', async () => {
    const png = await new HeicDecoder().toPng(Buffer.from('not an image'));
    expect(png).toBeNull();
  });
});

if (!hasAnyDecoder()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[heic-decoder.integration.spec] no HEIC decoder found (heif-convert/sips) — integration tests skipped',
  );
}
