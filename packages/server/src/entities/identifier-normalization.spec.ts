import { normalizeIdentifier, MATCH_KINDS } from './identifier-normalization';

describe('normalizeIdentifier', () => {
  it('registration_key: uppercases and strips internal whitespace', () => {
    expect(normalizeIdentifier('registration_key', '  ee 100 200 300 ')).toBe('EE100200300');
  });

  it('email: trims and lowercases', () => {
    expect(normalizeIdentifier('email', '  Help@Anoma.LY ')).toBe('help@anoma.ly');
  });

  it('phone: keeps a leading + and digits, drops separators', () => {
    expect(normalizeIdentifier('phone', '+1 (555) 234-5678')).toBe('+15552345678');
    expect(normalizeIdentifier('phone', '555.234.5678')).toBe('5552345678');
  });

  it('address: collapses whitespace and lowercases', () => {
    expect(normalizeIdentifier('address', '  1   Main  St\n')).toBe('1 main st');
  });

  it('returns null when the value normalizes to empty', () => {
    expect(normalizeIdentifier('email', '   ')).toBeNull();
    expect(normalizeIdentifier('phone', '()-')).toBeNull();
  });

  it('MATCH_KINDS excludes address', () => {
    expect(MATCH_KINDS).toEqual(['registration_key', 'email', 'phone']);
    expect(MATCH_KINDS).not.toContain('address');
  });
});
