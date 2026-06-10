import { applyRules } from './apply-rules';
import type { MappingRuleset } from './bank-mapping.types';

const lhvLike: MappingRuleset = {
  account_code: 'BANK_EUR',
  date_column: 'Date',
  date_format: 'YYYY-MM-DD',
  amount: { mode: 'debit_credit', amount_column: 'Amount', indicator_column: 'D/C', debit_value: 'D' },
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

  it('throws when the produced statement fails the kernel schema (e.g. empty)', () => {
    expect(() => applyRules(lhvLike, 'Date,Amount,D/C,Currency,Explanation,CounterpartyIban,Reference\n')).toThrow();
  });
});
