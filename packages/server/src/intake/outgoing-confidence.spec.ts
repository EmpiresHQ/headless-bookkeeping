import { composeOutgoingConfidence } from './outgoing-confidence';

const NONE = {
  org_name_is_issuer: false,
  org_vat_is_issuer: false,
  has_buyer_block: false,
  self_identifies_as_invoice: false,
};

describe('composeOutgoingConfidence', () => {
  it('is 0 when the org IBAN did not match (not an outgoing candidate)', () => {
    expect(composeOutgoingConfidence(false, { ...NONE, org_name_is_issuer: true })).toBe(0);
  });

  it('gives the IBAN-match base even with no corroborating signals', () => {
    expect(composeOutgoingConfidence(true, NONE)).toBeCloseTo(0.5);
  });

  it('reaches 1.0 when IBAN matched and every signal is true', () => {
    expect(
      composeOutgoingConfidence(true, {
        org_name_is_issuer: true,
        org_vat_is_issuer: true,
        has_buyer_block: true,
        self_identifies_as_invoice: true,
      }),
    ).toBeCloseTo(1.0);
  });

  it('adds issuer identity weight (name + VAT) above the base', () => {
    expect(composeOutgoingConfidence(true, { ...NONE, org_name_is_issuer: true, org_vat_is_issuer: true }))
      .toBeCloseTo(0.9);
  });
});
