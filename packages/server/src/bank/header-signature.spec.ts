import { headerColumns, headerSignature } from './apply-rules';

const header = 'Date,Amount,D/C,Currency\n2026-10-01,10.00,C,EUR\n';
const BOM = String.fromCharCode(0xfeff);

describe('headerSignature', () => {
  it('is identical with and without a leading UTF-8 BOM', () => {
    expect(headerSignature(BOM + header)).toBe(headerSignature(header));
  });

  it('is identical for quoted and unquoted spellings of the same names', () => {
    const unquoted = 'Date,Amount,Currency\n2026-10-01,10.00,EUR\n';
    const quoted = '"Date","Amount","Currency"\n"2026-10-01","10.00","EUR"\n';
    expect(headerSignature(quoted)).toBe(headerSignature(unquoted));
  });

  it('ignores surrounding whitespace in header names', () => {
    expect(headerSignature(' Date , Amount \n2026-10-01,10.00\n')).toBe(
      headerSignature('Date,Amount\n2026-10-01,10.00\n'),
    );
  });

  it('changes when a column changes', () => {
    const other = 'Date,Amount,D/C,Memo\n2026-10-01,10.00,C,hello\n';
    expect(headerSignature(other)).not.toBe(headerSignature(header));
  });

  it('participates in column order (a reordered export is a different format)', () => {
    const reordered = 'Amount,Date,D/C,Currency\n10.00,2026-10-01,C,EUR\n';
    expect(headerSignature(reordered)).not.toBe(headerSignature(header));
  });

  it('hashes only the first record, not the rows', () => {
    const otherRows = 'Date,Amount,D/C,Currency\n2026-11-01,20.00,D,USD\n';
    expect(headerSignature(otherRows)).toBe(headerSignature(header));
  });
});

describe('headerColumns', () => {
  it('returns the trimmed header names in original order', () => {
    expect(headerColumns(header)).toEqual([
      'Date',
      'Amount',
      'D/C',
      'Currency',
    ]);
  });

  it('returns an empty list for an empty input', () => {
    expect(headerColumns('')).toEqual([]);
  });
});
