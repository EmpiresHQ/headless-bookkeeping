import { describe, expect, it } from 'vitest';
import { formatStatementPeriod, formatTxDate, txTitle } from './format';

describe('formatStatementPeriod', () => {
  it('renders a single month', () => {
    expect(formatStatementPeriod('2026-06-01', '2026-06-30')).toBe('Jun 2026');
  });
  it('renders a same-year range', () => {
    expect(formatStatementPeriod('2026-04-01', '2026-06-30')).toBe(
      'Apr – Jun 2026',
    );
  });
  it('renders a cross-year range', () => {
    expect(formatStatementPeriod('2025-12-01', '2026-01-31')).toBe(
      'Dec 2025 – Jan 2026',
    );
  });
});

describe('formatTxDate', () => {
  it('renders day + short month', () => {
    expect(formatTxDate('2026-06-27')).toBe('27 Jun');
  });
});

describe('txTitle', () => {
  it('prefers description, then descriptor, then reference', () => {
    expect(
      txTitle({
        description: 'WOLT 220627',
        counterparty_descriptor: 'x',
        reference: 'y',
      }),
    ).toBe('WOLT 220627');
    expect(
      txTitle({
        description: null,
        counterparty_descriptor: 'CIRCLE K 4411',
        reference: 'y',
      }),
    ).toBe('CIRCLE K 4411');
    expect(
      txTitle({
        description: null,
        counterparty_descriptor: null,
        reference: null,
      }),
    ).toBe('Bank transaction');
  });
});
