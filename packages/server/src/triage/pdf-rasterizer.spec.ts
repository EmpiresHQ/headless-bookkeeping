import { execFileSync } from 'child_process';
import { PdfRasterizer } from './pdf-rasterizer';

function hasPdftoppm(): boolean {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A minimal one-page PDF (no text needed — we only check it rasterises).
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

const maybe = hasPdftoppm() ? describe : describe.skip;

maybe('PdfRasterizer (requires poppler pdftoppm)', () => {
  it('renders a PDF to one PNG buffer per page', async () => {
    const pages = await new PdfRasterizer().toPngPages(blankPdf());
    expect(pages.length).toBe(1);
    const pngMagic = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(pages[0].subarray(0, 8).equals(pngMagic)).toBe(true);
  });

  it('returns [] for a non-PDF buffer (never throws)', async () => {
    const pages = await new PdfRasterizer().toPngPages(Buffer.from('garbage'));
    expect(pages).toEqual([]);
  });
});

if (!hasPdftoppm()) {
  console.warn(
    '[pdf-rasterizer.spec] pdftoppm not found — rasterizer tests skipped',
  );
}
