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
  const vision = {
    transcribeImage: jest.fn((img: { mimeType: string }) =>
      Promise.resolve(
        opts.vision ? opts.vision(img.mimeType) : { ok: true, markdown: 'IMG-OCR' },
      ),
    ),
  } as unknown as LlmVisionTranscriber;
  const pdfText = {
    extract: jest.fn(() => Promise.resolve(opts.pdfText ?? '')),
  } as unknown as PdfTextExtractor;
  const raster = {
    toPngPages: jest.fn(() => Promise.resolve(opts.pages ?? [])),
  } as unknown as PdfRasterizer;
  return {
    t: new MimeRoutingTranscriber(vision, pdfText, raster),
    vision,
    pdfText,
    raster,
  };
}

const file = (mimeType: string) => ({
  buffer: Buffer.from('x'),
  filename: 'f',
  mimeType,
});

describe('MimeRoutingTranscriber', () => {
  it('routes image/* straight to the vision OCR', async () => {
    const { t, vision, pdfText } = make({});
    const out = await t.transcribe(file('image/jpeg'));
    expect(out).toEqual({ ok: true, markdown: 'IMG-OCR' });
    expect(vision.transcribeImage).toHaveBeenCalledTimes(1);
    expect(pdfText.extract).not.toHaveBeenCalled();
  });

  it('uses the embedded text layer for a born-digital PDF (no OCR, no raster)', async () => {
    const { t, vision, raster } = make({ pdfText: '# Invoice\nAcme Ltd' });
    const out = await t.transcribe(file('application/pdf'));
    expect(out).toEqual({ ok: true, markdown: '# Invoice\nAcme Ltd' });
    expect(raster.toPngPages).not.toHaveBeenCalled();
    expect(vision.transcribeImage).not.toHaveBeenCalled();
  });

  it('falls back to raster + per-page OCR for a scanned PDF (empty text layer)', async () => {
    const { t, vision, raster } = make({
      pdfText: '   ',
      pages: [Buffer.from('p1'), Buffer.from('p2')],
    });
    const out = await t.transcribe(file('application/pdf'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.markdown).toBe('IMG-OCR\n\n---\n\nIMG-OCR');
    expect(raster.toPngPages).toHaveBeenCalledTimes(1);
    expect(vision.transcribeImage).toHaveBeenCalledTimes(2);
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
