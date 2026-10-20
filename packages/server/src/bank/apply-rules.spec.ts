import { applyRules } from './apply-rules';
import type { MappingRuleset } from './bank-mapping.types';

const lhvLike: MappingRuleset = {
  account_code: 'BANK_EUR',
  date_column: 'Date',
  date_format: 'YYYY-MM-DD',
  amount: {
    mode: 'debit_credit',
    amount_column: 'Amount',
    indicator_column: 'D/C',
    debit_value: 'D',
  },
  currency_column: 'Currency',
  default_currency: 'EUR',
  description_column: 'Explanation',
  counterparty_iban_column: 'CounterpartyIban',
  counterparty_descriptor_column: null,
  reference_column: 'Reference',
};

const csv = `Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference
2026-05-08,6157.00,C,EUR,Invoice 1000,DK7430000014041346,REF1
2026-05-30,27.59,D,EUR,OPENROUTER,,`;

describe('applyRules', () => {
  it('maps a debit/credit CSV to CreateStatementInput with signed integer cents', () => {
    const out = applyRules(lhvLike, csv);
    expect(out.account_code).toBe('BANK_EUR');
    expect(out.transactions).toHaveLength(2);
    expect(out.transactions[0].amount).toBe(615700);
    expect(out.transactions[0].currency).toBe('EUR');
    expect(out.transactions[0].counterparty_iban).toBe('DK7430000014041346');
    expect(out.transactions[1].amount).toBe(-2759);
    expect(out.start_date).toBe('2026-05-08');
    expect(out.end_date).toBe('2026-05-30');
  });

  it('handles a single signed amount column', () => {
    const ruleset: MappingRuleset = {
      ...lhvLike,
      amount: { mode: 'signed', column: 'Amount' },
    };
    const signedCsv = `Date,Amount,Currency,Explanation,CounterpartyIban,Reference
2026-05-08,6157.00,EUR,x,,
2026-05-09,-27.59,EUR,y,,`;
    const out = applyRules(ruleset, signedCsv);
    expect(out.transactions[0].amount).toBe(615700);
    expect(out.transactions[1].amount).toBe(-2759);
  });

  it('strips a leading UTF-8 BOM (bank exports often include one)', () => {
    const out = applyRules(lhvLike, '\uFEFF' + csv);
    expect(out.transactions).toHaveLength(2);
    // Without BOM stripping the first header column would be prefixed by the
    // BOM and the Date column would be missing; this asserts it parsed cleanly.
    expect(out.start_date).toBe('2026-05-08');
    expect(out.transactions[0].amount).toBe(615700);
  });

  it('throws when the produced statement fails the kernel schema (e.g. empty)', () => {
    expect(() =>
      applyRules(
        lhvLike,
        'Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference\n',
      ),
    ).toThrow();
  });

  // ── Settlement-FX evidence targets (issue #403) ─────────────────────────
  // The issue's own case, synthetic: a converted card settlement whose
  // original amount, rate and fee sit in dedicated columns.
  it('maps dedicated settlement-FX evidence columns through the ruleset (issue #403)', () => {
    const ruleset: MappingRuleset = {
      ...lhvLike,
      amount: { mode: 'signed', column: 'Amount' },
      source_currency: { column: 'SourceCurrency' },
      source_amount: { column: 'SourceAmount' },
      fx_rate: { column: 'Rate' },
      conversion_fee: { column: 'Fee' },
      booking_date: { column: 'BookingDate' },
    };
    const fx = `Date,Amount,Currency,Explanation,SourceCurrency,SourceAmount,Rate,Fee,BookingDate
2026-06-19,-8.11,EUR,Next House Copenhagen,DKK,60.00,0.1338333,0.08,2026-06-20`;
    const out = applyRules(ruleset, fx);
    const t = out.transactions[0];
    expect(t.source_currency).toBe('DKK');
    expect(t.source_amount).toBe(6000);
    expect(t.fx_rate).toBeCloseTo(0.1338333, 12);
    expect(t.conversion_fee).toBe(8);
    expect(t.booking_date).toBe('2026-06-20');
  });

  it('extracts settlement-FX evidence embedded in a description cell via an explicit mapping pattern (ADR-0031: rules, not rows)', () => {
    const ruleset: MappingRuleset = {
      ...lhvLike,
      amount: { mode: 'signed', column: 'Amount' },
      source_currency: {
        column: 'Explanation',
        pattern: '(?:^|;\\s)([A-Z]{3}) \\d',
      },
      source_amount: {
        column: 'Explanation',
        pattern: '[A-Z]{3} ([\\d.]+)',
      },
      fx_rate: {
        column: 'Explanation',
        pattern: 'bank rate ([\\d.]+) [A-Z]{3}/[A-Z]{3}',
      },
      conversion_fee: {
        column: 'Explanation',
        pattern: 'conversion fee ([\\d.]+) [A-Z]{3}',
      },
    };
    const fx = `Date,Amount,Currency,Explanation
2026-06-19,-8.11,EUR,"DKK 60.00; conversion fee 0.08 EUR; bank rate 0.1338333 EUR/DKK; ECB reference rate 0.1337864 EUR/DKK"`;
    const out = applyRules(ruleset, fx);
    const t = out.transactions[0];
    expect(t.source_currency).toBe('DKK');
    expect(t.source_amount).toBe(6000);
    expect(t.fx_rate).toBeCloseTo(0.1338333, 12);
    expect(t.conversion_fee).toBe(8);
    // The raw description — including the bank's ECB-rate OBSERVATION — is
    // preserved verbatim as evidence, never parsed into statutory provenance.
    expect(t.description).toContain('ECB reference rate 0.1337864');
  });

  it('leaves absent evidence targets NULL (absent evidence, not zero)', () => {
    const out = applyRules(lhvLike, csv);
    const t = out.transactions[0];
    expect(t.source_currency).toBeNull();
    expect(t.source_amount).toBeNull();
    expect(t.fx_rate).toBeNull();
    expect(t.conversion_fee).toBeNull();
    expect(t.booking_date).toBeNull();
  });

  it('leaves a non-matching evidence pattern NULL rather than guessing a value', () => {
    const ruleset: MappingRuleset = {
      ...lhvLike,
      source_amount: { column: 'Explanation', pattern: 'NOK ([\\d.]+)' },
    };
    const out = applyRules(ruleset, csv);
    expect(out.transactions[0].source_amount).toBeNull();
  });

  it('throws on a malformed evidence pattern (the run fails loudly, ADR-0031)', () => {
    const ruleset: MappingRuleset = {
      ...lhvLike,
      fx_rate: { column: 'Explanation', pattern: '([\\d.+' },
    };
    expect(() => applyRules(ruleset, csv)).toThrow(/pattern/i);
  });

  it('throws on a non-numeric or non-positive extracted amount/rate/fee', () => {
    const badAmount: MappingRuleset = {
      ...lhvLike,
      source_amount: { column: 'Explanation' },
    };
    expect(() => applyRules(badAmount, csv)).toThrow();
    const badRate: MappingRuleset = {
      ...lhvLike,
      fx_rate: { column: 'Explanation' },
    };
    expect(() => applyRules(badRate, csv)).toThrow();
    const negativeRate: MappingRuleset = {
      ...lhvLike,
      fx_rate: { column: 'Explanation', pattern: '(-[\\d.]+)' },
    };
    const negativeCsv =
      'Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference\n' +
      '2026-05-08,10.00,D,EUR,rate -0.5,,';
    expect(() => applyRules(negativeRate, negativeCsv)).toThrow(
      /usable fx rate/i,
    );
  });
});
