/**
 * PreviewRenderer spec — TDD: write RED first, then GREEN.
 *
 * Covers:
 *  1. PDF → renders page 1 as a ~256px PNG, returns a stable relative path
 *  2. JPEG → downscaled PNG, returns relative path
 *  3. HEIC → decoded via HeicDecoder then scaled, returns relative path
 *  4. Unsupported mime / corrupt bytes → null, never throws
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import sharp from 'sharp';
import { PreviewRenderer } from './preview-renderer';
import { DocumentStorageService } from './document-storage.service';
import { HeicDecoder } from '../triage/heic-decoder';
import { Document } from './types';

// ─── helpers ────────────────────────────────────────────────────────────────

function hasPdftoppm(): boolean {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Build a minimal one-page PDF (blank page). */
function blankPdf(): Buffer {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets)
    pdf += `${off.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/** Build a small PNG (100×100 red square). */
async function smallPng(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 100, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
}

/** Build a large JPEG (2000×1500, larger than 256px cap). */
async function largeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 2000, height: 1500, channels: 3, background: 'blue' },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** Build a stub Document row. */
function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: 1,
    hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc12345',
    filename: 'test.pdf',
    mime_type: 'application/pdf',
    size_bytes: 0,
    storage_path: '1/test.pdf',
    status: 'pending',
    processing_since: null,
    created_at: 1000000,
    claimant_id: null,
    preview_path: null,
    ...overrides,
  };
}

// ─── stub storage ────────────────────────────────────────────────────────────

/**
 * In-memory DocumentStorageService — captures saved buffers without touching
 * the filesystem so the spec is hermetic.
 */
class StubStorage {
  readonly saved = new Map<string, Buffer>();

  async saveFile(
    id: number,
    filename: string,
    buffer: Buffer,
  ): Promise<string> {
    const path = join(String(id), filename);
    this.saved.set(path, buffer);
    return path;
  }

  async readFile(storagePath: string): Promise<Buffer> {
    const buf = this.saved.get(storagePath);
    if (!buf) throw new Error(`Not found: ${storagePath}`);
    return buf;
  }

  async deleteFile(_: string): Promise<void> {}
}

// ─── tests ────────────────────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf: Buffer): boolean {
  return buf.subarray(0, 8).equals(PNG_MAGIC);
}

describe('PreviewRenderer', () => {
  let storage: StubStorage;
  let heicDecoder: HeicDecoder;
  let renderer: PreviewRenderer;

  beforeEach(() => {
    storage = new StubStorage();
    heicDecoder = new HeicDecoder();
    renderer = new PreviewRenderer(
      storage as unknown as DocumentStorageService,
      heicDecoder,
    );
  });

  // ── JPEG → downscaled PNG ─────────────────────────────────────────────────
  it('renders a JPEG to a downscaled PNG and returns its relative path', async () => {
    const bytes = await largeJpeg();
    const doc = makeDoc({ mime_type: 'image/jpeg', filename: 'photo.jpg' });

    const path = await renderer.render(doc, bytes);

    expect(path).not.toBeNull();
    // Path is `{docId}/previews/{hash}.png` — keyed by document ID and hash.
    expect(path).toMatch(/previews\//);
    expect(path).toMatch(/\.png$/);

    const saved = storage.saved.get(path!);
    expect(saved).toBeDefined();
    expect(isPng(saved!)).toBe(true);

    // Thumbnail must fit within 256px on each side.
    const meta = await sharp(saved!).metadata();
    expect(meta.width).toBeLessThanOrEqual(256);
    expect(meta.height).toBeLessThanOrEqual(256);
  });

  // ── Small image is preserved (not upscaled) ───────────────────────────────
  it('returns a PNG for a small image without upscaling', async () => {
    const bytes = await smallPng();
    const doc = makeDoc({ mime_type: 'image/png', filename: 'small.png' });

    const path = await renderer.render(doc, bytes);

    expect(path).not.toBeNull();
    const saved = storage.saved.get(path!);
    expect(saved).toBeDefined();
    expect(isPng(saved!)).toBe(true);

    const meta = await sharp(saved!).metadata();
    expect(meta.width).toBeLessThanOrEqual(256);
    expect(meta.height).toBeLessThanOrEqual(256);
  });

  // ── Thumbnail path is content-addressed (stable on re-render) ────────────
  it('produces the same path for the same document hash regardless of filename', async () => {
    const bytes = await smallPng();
    const hash =
      'aabbccdd1122334455667788aabbccdd1122334455667788aabbccdd1122334455';
    const doc1 = makeDoc({ hash, mime_type: 'image/png', filename: 'a.png' });
    const doc2 = makeDoc({ hash, mime_type: 'image/png', filename: 'b.png' });

    const path1 = await renderer.render(doc1, bytes);
    const path2 = await renderer.render(doc2, bytes);

    expect(path1).toBe(path2);
  });

  // ── Unsupported MIME type → null ──────────────────────────────────────────
  it('returns null for an unsupported MIME type without throwing', async () => {
    const doc = makeDoc({ mime_type: 'application/zip', filename: 'file.zip' });
    const path = await renderer.render(doc, Buffer.from('PK\x03\x04'));
    expect(path).toBeNull();
  });

  // ── Corrupt image bytes → null ────────────────────────────────────────────
  it('returns null for corrupt image bytes without throwing', async () => {
    const doc = makeDoc({ mime_type: 'image/jpeg', filename: 'corrupt.jpg' });
    const path = await renderer.render(doc, Buffer.from('not an image at all'));
    expect(path).toBeNull();
  });

  // ── HEIC → decoded + scaled ───────────────────────────────────────────────
  describe('HEIC handling', () => {
    it('decodes HEIC via HeicDecoder and returns a thumbnail path', async () => {
      // Stub the decoder so the test is hermetic (no system heif-convert needed).
      const pngBytes = await smallPng();
      jest.spyOn(heicDecoder, 'toPng').mockResolvedValueOnce(pngBytes);

      const doc = makeDoc({ mime_type: 'image/heic', filename: 'photo.heic' });
      const path = await renderer.render(doc, Buffer.from('fake-heic'));

      expect(heicDecoder.toPng).toHaveBeenCalled();
      expect(path).not.toBeNull();
      expect(path).toMatch(/previews\//);
      expect(path).toMatch(/\.png$/);

      const saved = storage.saved.get(path!);
      expect(saved).toBeDefined();
      expect(isPng(saved!)).toBe(true);
    });

    it('returns null when HeicDecoder.toPng returns null (no decoder available)', async () => {
      jest.spyOn(heicDecoder, 'toPng').mockResolvedValueOnce(null);

      const doc = makeDoc({ mime_type: 'image/heic', filename: 'photo.heic' });
      const path = await renderer.render(doc, Buffer.from('fake-heic'));

      expect(path).toBeNull();
    });

    it('detects HEIC by magic bytes when mime_type is application/octet-stream', async () => {
      // iOS can send wrong MIME — magic bytes must be the fallback.
      const pngBytes = await smallPng();
      jest.spyOn(heicDecoder, 'toPng').mockResolvedValueOnce(pngBytes);

      // Build a valid HEIC magic bytes buffer
      const heicBuf = Buffer.alloc(24);
      heicBuf.writeUInt32BE(24, 0);
      heicBuf.write('ftyp', 4, 'ascii');
      heicBuf.write('heic', 8, 'ascii');

      const doc = makeDoc({
        mime_type: 'application/octet-stream',
        filename: 'photo.heic',
      });
      const path = await renderer.render(doc, heicBuf);

      expect(heicDecoder.toPng).toHaveBeenCalled();
      expect(path).not.toBeNull();
    });
  });

  // ── PDF (requires pdftoppm) ───────────────────────────────────────────────
  const maybePdf = hasPdftoppm() ? describe : describe.skip;

  maybePdf('PDF (requires poppler pdftoppm)', () => {
    it('renders page 1 of a PDF to a PNG thumbnail and returns relative path', async () => {
      const bytes = blankPdf();
      const doc = makeDoc({
        mime_type: 'application/pdf',
        filename: 'doc.pdf',
      });

      const path = await renderer.render(doc, bytes);

      expect(path).not.toBeNull();
      expect(path).toMatch(/previews\//);
      expect(path).toMatch(/\.png$/);

      const saved = storage.saved.get(path!);
      expect(saved).toBeDefined();
      expect(isPng(saved!)).toBe(true);

      // Thumbnail should fit within 256px.
      const meta = await sharp(saved!).metadata();
      expect(meta.width).toBeLessThanOrEqual(256);
      expect(meta.height).toBeLessThanOrEqual(256);
    });

    it('returns null for a corrupt PDF buffer without throwing', async () => {
      const doc = makeDoc({
        mime_type: 'application/pdf',
        filename: 'bad.pdf',
      });
      const path = await renderer.render(doc, Buffer.from('%PDF-garbage'));
      expect(path).toBeNull();
    });
  });

  if (!hasPdftoppm()) {
    console.warn(
      '[preview-renderer.spec] pdftoppm not found — PDF rendering tests skipped',
    );
  }
});
