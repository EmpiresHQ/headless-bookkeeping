import { MimeRoutingTranscriber } from './mime-routing-transcriber';
import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfRasterizer } from './pdf-rasterizer';
import { HeicDecoder } from './heic-decoder';
import { ImageScaler } from './image-scaler';
import { OcrOutcome } from './document-transcriber.port';

/** Build a minimal ISOBMFF buffer that `isHeicMagicBytes` will recognise. */
function heicMagicBuf(): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(24, 0);
  return Buffer.concat([
    size,
    Buffer.from('ftyp'),
    Buffer.from('heic'),
    Buffer.alloc(12),
  ]);
}

function make(opts: {
  vision?: (img: { buffer: Buffer; mimeType: string }) => OcrOutcome;
  pdfText?: string;
  pages?: Buffer[];
  /** HEIC decode result: a PNG buffer, or null to simulate a decode failure.
   *  `undefined` (the default) also yields null — heic is only exercised by the
   *  heic tests, which set this explicitly. */
  heicPng?: Buffer | null;
}) {
  // Standalone jest.fns so assertions reference the fn directly (avoids the
  // unbound-method lint on `obj.method`).
  const transcribeImage = jest.fn((img: { buffer: Buffer; mimeType: string }) =>
    Promise.resolve(
      opts.vision ? opts.vision(img) : { ok: true, markdown: 'IMG-OCR' },
    ),
  );
  const extract = jest.fn(() => Promise.resolve(opts.pdfText ?? ''));
  const toPngPages = jest.fn(() => Promise.resolve(opts.pages ?? []));
  const toPng = jest.fn(() => Promise.resolve(opts.heicPng ?? null));

  const vision = { transcribeImage } as unknown as LlmVisionTranscriber;
  const pdfText = { extract } as unknown as PdfTextExtractor;
  const raster = { toPngPages } as unknown as PdfRasterizer;
  const heic = { toPng } as unknown as HeicDecoder;
  const scaler = {
    downscale: jest.fn((buf: Buffer, mt: string) =>
      Promise.resolve({ buffer: buf, mimeType: mt }),
    ),
  } as unknown as ImageScaler;
  return {
    t: new MimeRoutingTranscriber(vision, pdfText, raster, heic, scaler),
    transcribeImage,
    extract,
    toPngPages,
    toPng,
  };
}

const file = (mimeType: string, buffer?: Buffer) => ({
  buffer: buffer ?? Buffer.from('x'),
  filename: 'f',
  mimeType,
});

describe('MimeRoutingTranscriber', () => {
  it('routes image/* straight to the vision OCR', async () => {
    const { t, transcribeImage, extract } = make({});
    const out = await t.transcribe(file('image/jpeg'));
    expect(out).toEqual({ ok: true, markdown: 'IMG-OCR' });
    expect(transcribeImage).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
  });

  it('uses the embedded text layer for a born-digital PDF (no OCR, no raster)', async () => {
    const { t, transcribeImage, toPngPages } = make({
      pdfText: '# Invoice\nAcme Ltd',
    });
    const out = await t.transcribe(file('application/pdf'));
    expect(out).toEqual({ ok: true, markdown: '# Invoice\nAcme Ltd' });
    expect(toPngPages).not.toHaveBeenCalled();
    expect(transcribeImage).not.toHaveBeenCalled();
  });

  it('falls back to raster + per-page OCR for a scanned PDF (empty text layer)', async () => {
    const { t, transcribeImage, toPngPages } = make({
      pdfText: '   ',
      pages: [Buffer.from('p1'), Buffer.from('p2')],
    });
    const out = await t.transcribe(file('application/pdf'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.markdown).toBe('IMG-OCR\n\n---\n\nIMG-OCR');
    expect(toPngPages).toHaveBeenCalledTimes(1);
    expect(transcribeImage).toHaveBeenCalledTimes(2);
  });

  it('maps a scanned PDF that will not rasterise to unreadable', async () => {
    const { t } = make({ pdfText: '', pages: [] });
    const out = await t.transcribe(file('application/pdf'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('propagates a vision failure when every scanned page fails', async () => {
    const { t } = make({
      pdfText: '',
      pages: [Buffer.from('p1')],
      vision: () => ({ ok: false, category: 'transient', detail: 'down' }),
    });
    const out = await t.transcribe(file('application/pdf'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('transient');
  });

  it('maps an unsupported mime to unreadable', async () => {
    const { t } = make({});
    const out = await t.transcribe(file('application/zip'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('decodes image/heic to PNG and routes the PNG to vision', async () => {
    const png = Buffer.from('PNG-BYTES');
    const { t, transcribeImage, toPng } = make({
      heicPng: png,
      vision: () => ({ ok: true, markdown: 'HEIC-OCR' }),
    });

    const out = await t.transcribe(file('image/heic'));

    expect(out).toEqual({ ok: true, markdown: 'HEIC-OCR' });
    expect(toPng).toHaveBeenCalledTimes(1);
    // Vision receives the DECODED png bytes tagged as image/png, never the heic.
    expect(transcribeImage).toHaveBeenCalledWith({
      buffer: png,
      mimeType: 'image/png',
    });
  });

  it('decodes image/heif the same way', async () => {
    const png = Buffer.from('PNG-BYTES');
    const { t, transcribeImage } = make({ heicPng: png });
    await t.transcribe(file('image/heif'));
    expect(transcribeImage).toHaveBeenCalledWith({
      buffer: png,
      mimeType: 'image/png',
    });
  });

  it('maps a heic that cannot be decoded to unreadable with an actionable hint', async () => {
    const { t, transcribeImage } = make({ heicPng: null });
    const out = await t.transcribe(file('image/heic'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
    expect(out.detail.toLowerCase()).toContain('heic');
    expect(out.detail.toLowerCase()).toContain('convert');
    // The undecoded heic is NEVER forwarded to a vision model that rejects it.
    expect(transcribeImage).not.toHaveBeenCalled();
  });

  // ── Magic-bytes fallback (browsers with empty / octet-stream MIME) ──

  it('routes empty MIME + HEIC magic bytes to the decoder, not unreadable', async () => {
    const png = Buffer.from('PNG-BYTES');
    const { t, transcribeImage, toPng } = make({
      heicPng: png,
      vision: () => ({ ok: true, markdown: 'HEIC-OCR' }),
    });

    const out = await t.transcribe(file('', heicMagicBuf()));

    expect(out).toEqual({ ok: true, markdown: 'HEIC-OCR' });
    expect(toPng).toHaveBeenCalledTimes(1);
    expect(transcribeImage).toHaveBeenCalledWith({
      buffer: png,
      mimeType: 'image/png',
    });
  });

  it('routes application/octet-stream + HEIC magic bytes to the decoder', async () => {
    const png = Buffer.from('PNG-BYTES');
    const { t, toPng } = make({ heicPng: png });

    const out = await t.transcribe(
      file('application/octet-stream', heicMagicBuf()),
    );

    expect(out.ok).toBe(true);
    expect(toPng).toHaveBeenCalledTimes(1);
  });

  it('routes empty MIME + non-HEIC buffer to unreadable (regression)', async () => {
    const { t } = make({});
    const out = await t.transcribe(file(''));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.category).toBe('unreadable');
  });

  it('does NOT call magic-bytes when MIME is already image/heic (fast path)', async () => {
    // The fast path skips the magic-bytes check when the MIME is already known.
    // We verify this by passing a non-HEIC buffer with the correct MIME — the
    // decoder should still be called because MIME wins.
    const png = Buffer.from('PNG-BYTES');
    const { t, toPng } = make({ heicPng: png });
    const nonHeicBuf = Buffer.from('not-heic-at-all');

    await t.transcribe(file('image/heic', nonHeicBuf));
    expect(toPng).toHaveBeenCalledTimes(1);
  });
});
