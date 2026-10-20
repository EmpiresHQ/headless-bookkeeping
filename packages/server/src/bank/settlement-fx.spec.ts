import { describe, expect, it } from '@jest/globals';
import { deriveSettlementFx, type BankSettlementLink } from './settlement-fx';

/**
 * Issue #403's deterministic settlement-FX derivation, exercised on the
 * ticket's own figures (synthetic: labelled as such, not a production claim).
 *
 *   Next House Copenhagen: DKK 60 → debit 8.11 = principal 8.03 + fee 0.08,
 *     bank rate 0.1338333 EUR/DKK (803 = round(0.1338333 × 6000)).
 *   Circle K: DKK 39 → debit 5.27 = principal 5.22 + fee 0.05,
 *     bank rate 0.1338461 (522 = round(0.1338461 × 3900)).
 */

const nextHouse = (over?: Partial<BankSettlementLink>): BankSettlementLink => ({
  bankTransactionId: 305,
  statementId: 15,
  supplierId: 7,
  bookingDate: '2026-06-20',
  transactionDate: '2026-06-19',
  sourceCurrency: 'DKK',
  sourceAmount: 6000,
  settledCurrency: 'EUR',
  settledAmount: -811,
  fxRate: 0.1338333,
  conversionFee: 8,
  bankReferenceRate: null,
  ...over,
});

describe('deriveSettlementFx (issue #403)', () => {
  it('derives evidence from the bank\u2019s explicit rate and evidenced fee (Next House fixture)', () => {
    const out = deriveSettlementFx(nextHouse(), 'EUR');
    expect(out.outcome).toBe('evidence');
    if (out.outcome !== 'evidence') return;
    const e = out.evidence;
    expect(e.rate).toBe(0.1338333);
    expect(e.rateOrigin).toBe('bank_statement');
    expect(e.feeOrigin).toBe('explicit');
    expect(e.feeAmount).toBe(8);
    expect(e.principalAmount).toBe(803);
    expect(e.debitAmount).toBe(811);
    expect(e.sourceAmount).toBe(6000);
    expect(e.transactionDate).toBe('2026-06-19');
    expect(e.bookingDate).toBe('2026-06-20');
  });

  it('derives evidence from the explicit rate with an explicitly evidenced ZERO fee', () => {
    const out = deriveSettlementFx(
      nextHouse({ settledAmount: -803, conversionFee: 0 }),
      'EUR',
    );
    expect(out.outcome).toBe('evidence');
    if (out.outcome !== 'evidence') return;
    expect(out.evidence.feeOrigin).toBe('explicit');
    expect(out.evidence.feeAmount).toBe(0);
    expect(out.evidence.principalAmount).toBe(803);
  });

  it('derives the rate from the fee-separated principal when the bank printed none', () => {
    const out = deriveSettlementFx(
      nextHouse({
        fxRate: null,
        settledAmount: -527,
        sourceAmount: 3900,
        conversionFee: 5,
      }),
      'EUR',
    );
    expect(out.outcome).toBe('evidence');
    if (out.outcome !== 'evidence') return;
    const e = out.evidence;
    // (|527| - 5) / 3900 — full precision kept, origin recorded as derived.
    expect(e.rate).toBeCloseTo(522 / 3900, 12);
    expect(e.rateOrigin).toBe('derived_principal');
    expect(e.principalAmount).toBe(522);
    expect(e.feeAmount).toBe(5);
    // The acceptance's own consistency check: the rounded rate × source
    // amount agrees with the principal exactly.
    expect(Math.round(e.rate * e.sourceAmount)).toBe(e.principalAmount);
  });

  it('refuses a fee-inclusive debit whose residual nobody evidenced (Circle K rate, no fee stated)', () => {
    const out = deriveSettlementFx(
      nextHouse({
        fxRate: 0.1338461,
        sourceAmount: 3900,
        settledAmount: -527,
        conversionFee: null,
      }),
      'EUR',
    );
    expect(out.outcome).toBe('conflicting');
    if (out.outcome === 'evidence') return;
    expect(out.reason).toMatch(/residual is not an evidenced fee/i);
  });

  it('refuses an evidenced fee that disagrees with the explicit rate', () => {
    const out = deriveSettlementFx(nextHouse({ conversionFee: 20 }), 'EUR');
    expect(out.outcome).toBe('conflicting');
  });

  // ── The one-cent boundary (issue #403's full-debit consistency) ─────────
  // A debit of 8.12 with a stated fee of 0.08 charges a principal of 8.04,
  // but the quoted rate's own rounded product is 8.03 — the bank's figures
  // drift by one minor unit. Accepting that drift would post a purchase at
  // 8.03 whose settlement leaves the fee strandable (a 1-cent unreconcilable
  // remainder), so it is CONFLICTING data, refused BEFORE anything posts.
  // Both directions of the drift are refused.
  it('refuses a one-cent rounding drift above the quoted rate (charged principal 8.04 vs quoted 8.03)', () => {
    const out = deriveSettlementFx(
      nextHouse({ settledAmount: -812, conversionFee: 8 }),
      'EUR',
    );
    expect(out.outcome).toBe('conflicting');
    if (out.outcome === 'conflicting') {
      expect(out.reason).toMatch(/does not equal the quoted rate's own/i);
    }
  });

  it('refuses a one-cent rounding drift below the quoted rate', () => {
    const out = deriveSettlementFx(
      nextHouse({ settledAmount: -810, conversionFee: 8 }),
      'EUR',
    );
    expect(out.outcome).toBe('conflicting');
  });

  it('accepts an exactly consistent fee-inclusive settlement (8.03 + 0.08 = 8.11)', () => {
    const out = deriveSettlementFx(nextHouse(), 'EUR');
    expect(out.outcome).toBe('evidence');
    if (out.outcome === 'evidence') {
      expect(out.evidence.principalAmount + out.evidence.feeAmount).toBe(811);
    }
  });

  it('refuses a stated fee that absorbs the whole debit', () => {
    const out = deriveSettlementFx(
      nextHouse({ fxRate: null, conversionFee: 811 }),
      'EUR',
    );
    expect(out.outcome).toBe('conflicting');
  });

  it('refuses to derive when neither rate nor fee is evidenced (no guess)', () => {
    const out = deriveSettlementFx(
      nextHouse({ fxRate: null, conversionFee: null }),
      'EUR',
    );
    expect(out.outcome).toBe('unavailable');
    if (out.outcome === 'unavailable') {
      expect(out.reason).toMatch(/without a guess/i);
    }
  });

  it('refuses a refund/credit line — only a debit settlement is evidence', () => {
    const out = deriveSettlementFx(nextHouse({ settledAmount: 811 }), 'EUR');
    expect(out.outcome).toBe('unavailable');
  });

  it('refuses a settlement kept in a foreign account (no base valuation evidenced)', () => {
    const out = deriveSettlementFx(
      // A DKK-kept account (e.g. BANK_DKK) evidences no EUR base valuation;
      // valuing it would need a second, invented rate.
      nextHouse({ settledCurrency: 'DKK' }),
      'EUR',
    );
    expect(out.outcome).toBe('unavailable');
    if (out.outcome === 'unavailable') {
      expect(out.reason).toMatch(/not the base currency/i);
    }
  });

  it('refuses a zero or missing original amount', () => {
    expect(
      deriveSettlementFx(nextHouse({ sourceAmount: 0 }), 'EUR').outcome,
    ).toBe('unavailable');
  });

  it('refuses a non-positive or unusable explicit rate', () => {
    expect(deriveSettlementFx(nextHouse({ fxRate: 0 }), 'EUR').outcome).toBe(
      'unavailable',
    );
    expect(
      deriveSettlementFx(nextHouse({ fxRate: Number.NaN }), 'EUR').outcome,
    ).toBe('unavailable');
  });

  it('refuses an unusable evidenced fee', () => {
    const out = deriveSettlementFx(nextHouse({ conversionFee: -3 }), 'EUR');
    expect(out.outcome).toBe('unavailable');
  });
});
