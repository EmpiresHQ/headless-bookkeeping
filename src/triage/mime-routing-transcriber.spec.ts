import { MimeRoutingTranscriber } from './mime-routing-transcriber';
import { LlmVisionTranscriber } from './llm-vision-transcriber';
import { PdfTextExtractor } from './pdf-text-extractor';
import { PdfRasterizer } from './pdf-rasterizer';
import { OcrOutcome } from './document-transcriber.port';

function make(opts: {
  vision?: (mime: string) => OcrOutcome;
  pdfText?: string;
  pages?: Buffer[];
}) {
  // Standalone jest.fns so assertions reference the fn directly (avoids the
  // unbound-method lint on `obj.method`).
  const transcribeImage = jest.fn((img: { mimeType: string }) =>
    Promise.resolve(
      opts.vision
        ? opts.vision(img.mimeType)
        : { ok: true, markdown: 'IMG-OCR' },
    ),
  );
  const extract = jest.fn(() => Promise.resolve(opts.pdfText ?? ''));
  const toPngPages = jest.fn(() => Promise.resolve(opts.pages ?? []));

  const vision = { transcribeImage } as unknown as LlmVisionTranscriber;
  const pdfText = { extract } as unknown as PdfTextExtractor;
  const raster = { toPngPages } as unknown as PdfRasterizer;
  return {
    t: new MimeRoutingTranscriber(vision, pdfText, raster),
    transcribeImage,
    extract,
    toPngPages,
  };
}

const file = (mimeType: string) => ({
  buffer: Buffer.from('x'),
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
});
