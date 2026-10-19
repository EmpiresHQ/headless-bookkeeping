import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  canonicalLabelValueLines,
  withCanonicalLabelValueView,
} from '../intake/label-value-view';

/**
 * REAL-PDF layout regression (issue #405) — pdf-parse is NOT mocked here.
 *
 * The synthetic fixture reproduces the production defect mechanically: the
 * supplier's generator draws each field's value and label as ONE PDF text
 * run (a single TJ operator, no gap), so pdf.js combines them into a single
 * glued item `5001799762Arve number:`. The plain reconstruction keeps the
 * glue (raw OCR evidence is preserved), and the canonical label/value view
 * consumed by Pass-2 re-associates each value with its own label.
 *
 * pdf.js misbehaves under the jest module loader ("bad XRef entry"), so the
 * extraction runs in a plain-Node child process against the ACTUAL
 * PdfTextExtractor source (see test/pdf-text-extraction-runner.cjs).
 */

/** The self-locating runner: packages/server/test/pdf-text-extraction-runner.cjs. */
const RUNNER = join(
  __dirname,
  '..',
  '..',
  'test',
  'pdf-text-extraction-runner.cjs',
);

/** Build a minimal one-page PDF whose content stream draws the given runs. */
function buildPdf(
  runs: Array<{
    /**
     * Chunks of one TJ text run: [text, kern-thousandths]. The kern may be
     * omitted in the fixture for readability — it defaults to NUMERIC 0 (an
     * adjacent chunk, the glued layout), never `undefined`, which would
     * serialize a non-number token into the PDF content stream.
     */
    tj: Array<[string] | [string, number]>;
    x: number;
    y: number;
  }>,
): Buffer {
  const esc = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let content = 'BT /F1 10 Tf ';
  for (const run of runs) {
    const chunks = run.tj
      .map(([t, k = 0]): string => `(${esc(t)}) ${k}`)
      .join(' ');
    content += `1 0 0 1 ${run.x} ${run.y} Tm [${chunks}] TJ `;
  }
  content += 'ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * The issue #405 columnar invoice: every labeled field prints its value
 * immediately BEFORE its label, in one glued PDF text run (kern 0). The
 * sibling control lines print label BEFORE value.
 */
function columnarInvoicePdf(): Buffer {
  return buildPdf([
    // Supplier header (ordinary prose runs).
    { tj: [['Osaühing Columnar Fixtures']], x: 60, y: 780 },
    { tj: [['Registrikood 10000001']], x: 60, y: 764 },
    // ── Columnar fields: value glued to its label in ONE text run ──
    {
      tj: [
        ['5001799762', 0],
        ['Arve number:', 0],
      ],
      x: 60,
      y: 740,
    },
    {
      tj: [
        ['02.10.2026', 0],
        ['Kuupäev:', 0],
      ],
      x: 60,
      y: 724,
    },
    {
      tj: [
        ['6221000702446172', 0],
        ['Viitenumber:', 0],
      ],
      x: 60,
      y: 708,
    },
    // Items table (ordinary label-before-value columns).
    { tj: [['Nimetus Kogus Hind']], x: 60, y: 680 },
    { tj: [['Nõupidamine 1 73,39']], x: 60, y: 664 },
    // Totals: net and VAT label-before-value, gross value-before-label.
    { tj: [['Käibemaks 22%: 17,61']], x: 60, y: 636 },
    {
      tj: [
        ['91,00', 0],
        ['Kokku:', 0],
      ],
      x: 60,
      y: 620,
    },
    // Sibling invoice printed the ordinary way (control).
    {
      tj: [
        ['Arve number: ', 0],
        ['5001799763', 0],
      ],
      x: 60,
      y: 596,
    },
  ]);
}

/** Run the ACTUAL extractor over a PDF, in a plain-Node child process. */
function extractViaRunner(pdf: Buffer): string {
  return JSON.parse(
    execFileSync(process.execPath, [RUNNER, pdf.toString('base64')], {
      encoding: 'utf8',
    }),
  ) as string;
}

describe('PdfTextExtractor + canonical label/value view (issue #405)', () => {
  let raw: string;
  beforeAll(() => {
    raw = extractViaRunner(columnarInvoicePdf());
  });

  it('reconstructs the glued value-before-label runs (raw evidence)', () => {
    // The defect itself: the raw text layer glues value to label in one run.
    expect(raw).toContain('5001799762Arve number:');
    expect(raw).toContain('02.10.2026Kuupäev:');
    expect(raw).toContain('6221000702446172Viitenumber:');
    expect(raw).toContain('91,00Kokku:');
    // The sibling invoice prints label before value and stays readable.
    expect(raw).toContain('Arve number: 5001799763');
    expect(raw).toContain('Käibemaks 22%: 17,61');
  });

  it('re-associates every columnar field with its own label (the #405 seam)', () => {
    const lines = canonicalLabelValueLines(raw);
    expect(lines).toContain('Arve number: 5001799762');
    expect(lines).toContain('Kuupäev: 02.10.2026');
    expect(lines).toContain('Viitenumber: 6221000702446172');
    expect(lines).toContain('Kokku: 91,00');
    // The associations must NOT bleed onto the sibling invoice's number.
    expect(lines).not.toContain('Arve number: 5001799763');
    expect(lines).not.toContain('Kuupäev: 5001799762');
    expect(lines).not.toContain('Arve number: 02.10.2026');
  });

  it('feeds Pass-2 a canonical view that preserves the raw text', () => {
    const view = withCanonicalLabelValueView(raw);
    expect(view.endsWith(raw)).toBe(true);
    // Label-anchored readers must meet the canonical association first.
    expect(view.indexOf('Arve number: 5001799762')).toBeLessThan(
      view.indexOf('5001799762Arve number:'),
    );
    expect(view).toContain('Kuupäev: 02.10.2026');
    expect(view).toContain('Viitenumber: 6221000702446172');
    expect(view).toContain('Kokku: 91,00');
  });
});
