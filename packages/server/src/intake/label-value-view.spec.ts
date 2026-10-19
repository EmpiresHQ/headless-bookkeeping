import {
  canonicalLabelValueLines,
  withCanonicalLabelValueView,
} from './label-value-view';

/**
 * Unit spec for the layout-tolerant canonical label/value view (issue #405).
 *
 * Estonian supplier invoices whose PDF text layer interleaves value BEFORE
 * label (columnar layout) arrive as glued single text runs such as
 * `5001799762Arve number:` — the value the label refers to is printed
 * immediately before the label itself, with no whitespace. A label-anchored
 * consumer takes the token AFTER the label, so it extracts the NEXT line's
 * value (the date) as the invoice number and reads the gross as 0. The
 * canonical view re-associates each glued value with its own label.
 */
describe('canonicalLabelValueLines', () => {
  it('re-associates the issue #405 production text (value before label)', () => {
    const text =
      '5001799762Arve number:\n' +
      '02.10.2026Kuupäev:\n' +
      '6221000702446172Viitenumber:';
    expect(canonicalLabelValueLines(text)).toEqual([
      'Arve number: 5001799762',
      'Kuupäev: 02.10.2026',
      'Viitenumber: 6221000702446172',
    ]);
  });

  it('re-associates every glued field in one run', () => {
    const text = '5001799762Arve number:02.10.2026Kuupäev:91,00Kokku:';
    expect(canonicalLabelValueLines(text)).toEqual([
      'Arve number: 5001799762',
      'Kuupäev: 02.10.2026',
      'Kokku: 91,00',
    ]);
  });

  it('leaves ordinary label-before-value text untouched', () => {
    const text =
      'Arve number: 5001799763\nKuupäev: 03.10.2026\nViitenumber: 6221000702446173\nKokku: 91,00';
    expect(canonicalLabelValueLines(text)).toEqual([]);
  });

  it('does not split codes whose letters and digits belong to one token', () => {
    // Production pair 72/73 numbers: one token, letters and digits interleaved;
    // no glued digit-run-to-label junction exists, so nothing is re-associated.
    expect(canonicalLabelValueLines('Invoice RI7USPNX0014:')).toEqual([]);
    expect(canonicalLabelValueLines('INV-O01:')).toEqual([]);
  });

  it('does not rewrite times or prose containing colons', () => {
    expect(canonicalLabelValueLines('Kell 12:30')).toEqual([]);
    expect(canonicalLabelValueLines('As of 2026: paid in full')).toEqual([]);
  });

  describe('whole-value preservation (root review regressions)', () => {
    it('preserves a thousands-grouped value completely', () => {
      expect(canonicalLabelValueLines('1 234,56Kokku:')).toEqual([
        'Kokku: 1 234,56',
      ]);
    });

    it('preserves an NBSP-grouped value completely, normalized to a space', () => {
      expect(canonicalLabelValueLines('1\u00A0234,56Kokku:')).toEqual([
        'Kokku: 1 234,56',
      ]);
    });

    it('preserves a separated minus sign completely', () => {
      expect(canonicalLabelValueLines('- 91,00Kokku:')).toEqual([
        'Kokku: - 91,00',
      ]);
    });

    it('preserves a separated U+2212 minus completely, normalized to ASCII', () => {
      expect(canonicalLabelValueLines('− 91,00Kokku:')).toEqual([
        'Kokku: - 91,00',
      ]);
    });

    it('preserves a glued negative amount completely', () => {
      expect(canonicalLabelValueLines('-91,00Kokku:')).toEqual([
        'Kokku: -91,00',
      ]);
    });

    it('skips a letter-fused token ENTIRELY instead of dropping its prefix', () => {
      // `INV-123` fused to the label: unsupported — never a truncated
      // `-123` with a confidently wrong value ahead of the raw text.
      expect(canonicalLabelValueLines('INV-123Arve number:')).toEqual([]);
    });

    it('skips two whitespace-separated amounts instead of fusing/truncating', () => {
      expect(canonicalLabelValueLines('17,61 91,00Kokku:')).toEqual([]);
    });

    it('skips a time-shaped value glued to a label instead of truncating it', () => {
      expect(canonicalLabelValueLines('12:30Kell:')).toEqual([]);
    });

    it('preserves ordinary structured serial numbers as identity keys (duplicate-gate control)', () => {
      // Not date-shaped, not labels: these belong to the number, untouched.
      expect(canonicalLabelValueLines('Invoice 1-2-3:')).toEqual([]);
      expect(canonicalLabelValueLines('Invoice 1234-56-7890:')).toEqual([]);
    });
  });
});

describe('withCanonicalLabelValueView', () => {
  it('prepends a canonical field view and preserves the raw text verbatim', () => {
    const raw = '5001799762Arve number:\n02.10.2026Kuupäev:';
    const view = withCanonicalLabelValueView(raw);
    // The raw OCR text is preserved verbatim as audit evidence (ADR-0024)…
    expect(view.endsWith(raw)).toBe(true);
    // …and the canonical association comes FIRST, because a label-anchored
    // reader takes the first `label:` it meets — in the glued raw text that
    // would be the NEXT line's value (the issue #405 defect).
    expect(view.indexOf('Arve number: 5001799762')).toBeLessThan(
      view.indexOf('5001799762Arve number:'),
    );
    expect(view).toContain('Kuupäev: 02.10.2026');
  });

  it('returns the text unchanged when no glued value-before-label run exists', () => {
    const raw = 'Arve number: 5001799763\nKokku: 91,00';
    expect(withCanonicalLabelValueView(raw)).toBe(raw);
  });
});
