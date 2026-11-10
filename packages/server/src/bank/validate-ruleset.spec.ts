import { validateRuleset } from './apply-rules';
import type { MappingRuleset } from './bank-mapping.types';

const ruleset: MappingRuleset = {
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
  counterparty_iban_column: null,
  counterparty_descriptor_column: null,
  reference_column: null,
};

const csv = `Date,Amount,D/C,Currency,Explanation
2026-10-01,27.59,D,EUR,Invoice 1000
2026-10-02,6157.00,C,EUR,Payment received
`;

describe('validateRuleset', () => {
  it('accepts a ruleset whose referenced columns and sample values all fit', () => {
    expect(() => validateRuleset(ruleset, csv)).not.toThrow();
  });

  it('rejects a column the header does not contain, naming the field', () => {
    expect(() =>
      validateRuleset({ ...ruleset, date_column: 'ValueDate' }, csv),
    ).toThrow(/bank_mapping ruleset rejected: date_column.*ValueDate/);
  });

  it('rejects an fx_rate mapped to the debit/credit indicator column (the production incident)', () => {
    const incident: MappingRuleset = {
      ...ruleset,
      fx_rate: { column: 'D/C' },
    };
    expect(() => validateRuleset(incident, csv)).toThrow(
      /bank_mapping ruleset rejected: fx_rate.*indicator.*D\/C/,
    );
  });

  it.each(['source_amount', 'conversion_fee', 'bank_reference_rate'] as const)(
    'rejects %s mapped to the amount indicator column',
    (target) => {
      const bad: MappingRuleset = {
        ...ruleset,
        [target]: { column: 'D/C' },
      };
      expect(() => validateRuleset(bad, csv)).toThrow(
        /bank_mapping ruleset rejected:.*indicator/,
      );
    },
  );

  it('rejects a non-numeric fx_rate value on a sample row', () => {
    const bad: MappingRuleset = {
      ...ruleset,
      fx_rate: { column: 'Explanation' },
    };
    expect(() => validateRuleset(bad, csv)).toThrow(
      /bank_mapping ruleset rejected: fx_rate value "Invoice 1000".*not a positive number/,
    );
  });

  it('rejects a zero or negative bank_reference_rate value', () => {
    const negativeCsv =
      'Date,Amount,D/C,Currency,Explanation,ReferenceRate\n' +
      '2026-10-01,27.59,D,EUR,Invoice 1000,-0.5\n';
    expect(() =>
      validateRuleset(
        { ...ruleset, bank_reference_rate: { column: 'ReferenceRate' } },
        negativeCsv,
      ),
    ).toThrow(/bank_reference_rate.*not a positive number/);
  });

  it('accepts a rate extracted from a description cell by an explicit pattern', () => {
    const embeddedCsv =
      'Date,Amount,D/C,Currency,Explanation\n' +
      '2026-10-01,27.59,D,EUR,"DKK 60; bank rate 0.1338333 EUR/DKK"\n';
    expect(() =>
      validateRuleset(
        {
          ...ruleset,
          fx_rate: {
            column: 'Explanation',
            pattern: 'bank rate ([\\d.]+)',
          },
        },
        embeddedCsv,
      ),
    ).not.toThrow();
  });

  it('only samples the first five data rows', () => {
    const lateBad =
      'Date,Amount,D/C,Currency,Explanation,Rate\n' +
      '2026-10-01,1.00,D,EUR,a,1.1\n' +
      '2026-10-02,1.00,D,EUR,a,1.1\n' +
      '2026-10-03,1.00,D,EUR,a,1.1\n' +
      '2026-10-04,1.00,D,EUR,a,1.1\n' +
      '2026-10-05,1.00,D,EUR,a,1.1\n' +
      '2026-10-06,1.00,D,EUR,a,not-a-rate\n';
    expect(() =>
      validateRuleset({ ...ruleset, fx_rate: { column: 'Rate' } }, lateBad),
    ).not.toThrow();
  });
});
