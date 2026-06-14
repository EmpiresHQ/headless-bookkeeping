import { extractIbans, matchesOrgIban } from './iban-match';

describe('iban-match', () => {
  it('extracts and normalises IBANs from OCR markdown (spaces removed, upper-cased)', () => {
    const md = 'Pay to: ee38 2200 2210 2014 5685\nRef 123';
    expect(extractIbans(md)).toContain('EE382200221020145685');
  });

  it('matches the org IBAN ignoring spacing and case', () => {
    const md = 'Bank: EE38 2200 2210 2014 5685';
    expect(matchesOrgIban(md, 'ee382200221020145685')).toBe(true);
  });

  it('returns false when the org has no IBAN configured', () => {
    expect(matchesOrgIban('EE382200221020145685', null)).toBe(false);
  });

  it('returns false when no doc IBAN matches the org IBAN', () => {
    expect(
      matchesOrgIban('LV80BANK0000435195001', 'EE382200221020145685'),
    ).toBe(false);
  });

  it('matches the org IBAN even when another IBAN shares the same line', () => {
    const md =
      'Pay to EE38 2200 2210 2014 5685  SWIFT HABAEE2X  Alt GB82 WEST 1234 5698 7654 32';
    expect(matchesOrgIban(md, 'EE382200221020145685')).toBe(true);
    expect(matchesOrgIban(md, 'GB82WEST12345698765432')).toBe(true);
  });

  it('does not match across a line break', () => {
    const md = 'EE38\n2200221020145685';
    expect(matchesOrgIban(md, 'EE382200221020145685')).toBe(false);
  });
});
