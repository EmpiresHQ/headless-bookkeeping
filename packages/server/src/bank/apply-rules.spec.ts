import { applyRules, sourceFingerprint } from './apply-rules';
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

  it('retains the PRINTED rate’s quoted decimal precision before numeric coercion (issue #403)', () => {
    const withDecimals: MappingRuleset = {
      ...lhvLike,
      amount: { mode: 'signed', column: 'Amount' },
      fx_rate: { column: 'Rate' },
    };
    // A dedicated column: '0.133833300' — 9 printed decimals.
    const dot = applyRules(
      withDecimals,
      'Date,Amount,Currency,Rate\n2026-06-19,-8.11,EUR,0.133833300',
    );
    expect(dot.transactions[0].fx_rate_decimals).toBe(9);
    // European decimal comma: '0,133833300' — still 9 printed decimals
    // (a quoted CSV cell, so the comma survives the column split).
    const comma = applyRules(
      withDecimals,
      'Date,Amount,Currency,Rate\n2026-06-19,-8.11,EUR,"0,133833300"',
    );
    expect(comma.transactions[0].fx_rate_decimals).toBe(9);
    // An embedded description extraction: 'bank rate 0.1338333' — 7 decimals.
    const embedded: MappingRuleset = {
      ...lhvLike,
      amount: { mode: 'signed', column: 'Amount' },
      fx_rate: {
        column: 'Explanation',
        pattern: 'bank rate ([\\d.]+)',
      },
    };
    const emb = applyRules(
      embedded,
      'Date,Amount,Currency,Explanation\n2026-06-19,-8.11,EUR,DKK 60; bank rate 0.1338333',
    );
    expect(emb.transactions[0].fx_rate_decimals).toBe(7);
    // A printed integer rate quotes 0 decimals; an exponent form carries no
    // plain printed precision — none fabricated.
    const integer = applyRules(
      withDecimals,
      'Date,Amount,Currency,Rate\n2026-06-19,-8.00,EUR,1',
    );
    expect(integer.transactions[0].fx_rate_decimals).toBe(0);
    const exponent = applyRules(
      withDecimals,
      'Date,Amount,Currency,Rate\n2026-06-19,-8.11,EUR,1.338333e-1',
    );
    expect(exponent.transactions[0].fx_rate_decimals).toBeNull();
  });

  it('leaves absent evidence targets NULL (absent evidence, not zero)', () => {
    const out = applyRules(lhvLike, csv);
    const t = out.transactions[0];
    expect(t.source_currency).toBeNull();
    expect(t.source_amount).toBeNull();
    expect(t.fx_rate).toBeNull();
    expect(t.fx_rate_decimals).toBeNull();
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

  // ── Issue #399: canonical identity inputs ──────────────────────

  const identityCsv = `Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference,BankTransactionId,ArchiveId,Account
2026-05-08,27.59,D,EUR,Invoice 1000,DK7430000014041346,REF1,SYN-TXN-1,SYN-ARCH-1,EE11SYNTHETIC
2026-05-30,13.91,D,EUR,OPENROUTER,,REF2,SYN-TXN-2,SYN-ARCH-2,EE11SYNTHETIC`;

  it('extracts the bank transaction id, archive reference and source account through the ruleset (issue #399)', () => {
    const out = applyRules(
      {
        ...lhvLike,
        provider_code: 'LHV',
        external_id: { column: 'BankTransactionId' },
        archive_id: { column: 'ArchiveId' },
        source_account: { column: 'Account' },
      },
      identityCsv,
    );
    expect(out.provider_code).toBe('LHV');
    expect(out.source_account_ref).toBe('EE11SYNTHETIC');
    expect(out.transactions[0].external_id).toBe('SYN-TXN-1');
    expect(out.transactions[0].archive_ref).toBe('SYN-ARCH-1');
    expect(out.transactions[1].external_id).toBe('SYN-TXN-2');
    expect(out.transactions[1].archive_ref).toBe('SYN-ARCH-2');
  });

  it('leaves absent identity targets NULL — unknown identity never merges (issue #399)', () => {
    const out = applyRules(lhvLike, identityCsv);
    expect(out.provider_code).toBeNull();
    expect(out.source_account_ref).toBeNull();
    expect(out.transactions[0].external_id).toBeNull();
    expect(out.transactions[0].archive_ref).toBeNull();
  });

  it('normalises the provider and source account references (trim + uppercase, issue #399)', () => {
    const out = applyRules(
      {
        ...lhvLike,
        provider_code: '  lhv ',
        external_id: { column: 'BankTransactionId' },
        source_account: { column: 'Account' },
      },
      'Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference,BankTransactionId,Account\n' +
        '2026-05-08,27.59,D,EUR,Invoice 1000,DK7430000014041346,REF1,SYN-TXN-1, ee11synthetic ',
    );
    expect(out.provider_code).toBe('LHV');
    expect(out.source_account_ref).toBe('EE11SYNTHETIC');
  });

  it('extracts an id embedded in a description cell via an explicit pattern (rules, not rows, ADR-0031)', () => {
    const out = applyRules(
      {
        ...lhvLike,
        external_id: {
          column: 'Explanation',
          pattern: 'Arch\\s*ref\\s*([A-Z0-9-]+)',
        },
      },
      'Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference\n' +
        '2026-05-08,27.59,D,EUR,Payment Arch ref SYN-ARCH-9,DK7430000014041346,REF1',
    );
    expect(out.transactions[0].external_id).toBe('SYN-ARCH-9');
  });

  it('sourceFingerprint: row-order-insensitive but unmapped-column-sensitive (issue #399)', () => {
    const exportA =
      'Date,Amount,Currency,Memo\n2026-01-05,-12.50,EUR,export A memo\n2026-01-06,-1.00,EUR,row two\n';
    // Same rows, reordered, renamed header order — the same source.
    const reordered =
      'Memo,Date,Amount,Currency\nrow two,2026-01-06,-1.00,EUR\nexport A memo,2026-01-05,-12.50,EUR\n';
    expect(sourceFingerprint(reordered)).toBe(sourceFingerprint(exportA));
    // A DIFFERENT export of the same mapped movements — differing only in an
    // UNMAPPED memo value — is a DIFFERENT source, never one silent replay.
    const exportB =
      'Date,Amount,Currency,Memo\n2026-01-05,-12.50,EUR,export B memo\n2026-01-06,-1.00,EUR,row two\n';
    expect(sourceFingerprint(exportB)).not.toBe(sourceFingerprint(exportA));
    // Multiplicity participates: a source with the row twice is different.
    const doubled =
      'Date,Amount,Currency,Memo\n2026-01-05,-12.50,EUR,export A memo\n2026-01-05,-12.50,EUR,export A memo\n';
    expect(sourceFingerprint(doubled)).not.toBe(sourceFingerprint(exportA));
  });

  it('sourceFingerprint retains duplicate-header values and raw cell whitespace', () => {
    const original = 'Date,Memo,Memo\n2026-06-01,first,second\n';
    expect(
      sourceFingerprint('Date,Memo,Memo\n2026-06-01,changed,second\n'),
    ).not.toBe(sourceFingerprint(original));
    expect(
      sourceFingerprint('Date,Memo,Memo\n2026-06-01, first,second\n'),
    ).not.toBe(sourceFingerprint(original));
  });

  it('throws when rows disagree about which source account they cover (one statement = one account, issue #399)', () => {
    expect(() =>
      applyRules(
        {
          ...lhvLike,
          source_account: { column: 'Account' },
        },
        'Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference,Account\n' +
          '2026-05-08,27.59,D,EUR,Invoice 1000,DK7430000014041346,REF1,EE11SYNTHETIC\n' +
          '2026-05-30,13.91,D,EUR,OPENROUTER,,REF2,EE22OTHER',
      ),
    ).toThrow(/Inconsistent source account references/i);
  });
});
