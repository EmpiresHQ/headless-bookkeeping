import { describe, expect, it } from 'vitest';
import {
  formatTotals,
  inRange,
  isCalendarDate,
  localDay,
  orderSections,
  parseBooksOrder,
  totalsByCurrency,
} from './listOrder';

const TAX = { dateNoun: 'Tax point', amounts: true, noun: 'expenses' };
const DOCS = { dateNoun: 'Added', amounts: false, noun: 'documents' };
const parse = (qs: string, sem = TAX) =>
  parseBooksOrder(new URLSearchParams(qs), sem);

describe('isCalendarDate (issue #279)', () => {
  it.each([
    ['2026-02-28', true],
    ['2026-02-29', false],
    ['2024-02-29', true],
    ['2000-02-29', true], // divisible by 400
    ['1900-02-29', false], // century, not by 400
    ['0096-02-29', true], // two-digit-era leap year, not remapped to 1996
    ['0100-02-29', false], // not remapped to 2000
    ['0001-01-01', true],
    ['9999-12-31', true],
    ['0000-01-01', false], // a native date input has no year 0
    ['2026-04-31', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-01-00', false],
    ['2026-7-1', false],
    ['20260701', false],
    ['abc', false],
    ['', false],
  ])('%s → %s', (s, ok) => expect(isCalendarDate(s)).toBe(ok));
});

describe('parseBooksOrder', () => {
  it('absent and empty params are the default: no range, newest, no notes', () => {
    for (const qs of ['', 'from=&to=&sort=']) {
      const s = parse(qs);
      expect(s).toMatchObject({ from: null, to: null, order: 'newest' });
      expect(s.labels).toEqual([]);
      expect(s.present).toBe(false);
    }
  });

  it('names the applied range with the segment’s date field', () => {
    expect(parse('from=2026-07-01&to=2026-09-30').labels).toEqual([
      'Tax point 1 Jul 2026 – 30 Sep 2026',
    ]);
    expect(parse('from=2026-07-01').labels).toEqual([
      'Tax point from 1 Jul 2026',
    ]);
    expect(parse('to=2026-09-30', DOCS).labels).toEqual([
      'Added until 30 Sep 2026',
    ]);
  });

  it('an invalid bound is not applied and says so; the valid one still is', () => {
    const s = parse('from=2026-02-30&to=2026-09-30');
    expect(s).toMatchObject({
      from: null,
      to: '2026-09-30',
      fromInvalid: true,
    });
    expect(s.labels).toEqual([
      'Tax point until 30 Sep 2026',
      'From “2026-02-30” not applied (not a date)',
    ]);
  });

  it('a reversed range applies no date restriction at all', () => {
    const s = parse('from=2026-09-30&to=2026-07-01');
    expect(s).toMatchObject({ from: null, to: null, reversed: true });
    expect(s.labels).toEqual(['Dates not applied: From is after To']);
  });

  it('a long pasted value is quoted as a bounded excerpt', () => {
    const s = parse(`from=${'x'.repeat(500)}`);
    expect(s.labels[0].length).toBeLessThan(60);
  });

  it('orders: known applied, unknown noted (distinct from empty), amount on Documents noted', () => {
    expect(parse('sort=oldest')).toMatchObject({
      order: 'oldest',
      labels: ['Oldest first'],
    });
    expect(parse('sort=newest').labels).toEqual([]);
    expect(parse('sort=biggest')).toMatchObject({
      order: 'newest',
      labels: ['Order “biggest” not recognised — newest first'],
    });
    expect(parse('sort=largest', DOCS)).toMatchObject({
      order: 'newest',
      labels: ['Newest first — documents have no amount to order by'],
    });
  });
});

describe('inRange', () => {
  it('is inclusive on both ends and open on a missing side', () => {
    const r = { from: '2026-07-01', to: '2026-07-31' };
    expect(inRange('2026-07-01', r)).toBe(true);
    expect(inRange('2026-07-31', r)).toBe(true);
    expect(inRange('2026-06-30', r)).toBe(false);
    expect(inRange('2026-08-01', r)).toBe(false);
    expect(inRange('1999-01-01', { from: null, to: '2026-07-31' })).toBe(true);
    expect(inRange('2099-01-01', { from: '2026-07-01', to: null })).toBe(true);
  });

  it('documents are filtered on their local calendar day', () => {
    const t = new Date(2026, 6, 31, 23, 30).getTime() / 1000;
    expect(localDay(t)).toBe('2026-07-31');
  });
});

type Row = { id: number; day: string; amount: number; currency: string };
const row = (id: number, day: string, amount: number, currency = 'EUR') => ({
  id,
  day,
  amount,
  currency,
});
const ids = (s: { rows: Row[] }[]) => s.map((x) => x.rows.map((r) => r.id));
const facts = (r: Row) => r;

describe('orderSections', () => {
  const ROWS = [
    row(1, '2026-07-05', 500),
    row(2, '2026-08-10', 100),
    row(3, '2026-07-05', 9000),
    row(4, '2026-07-20', 50),
  ];

  it('newest: months newest first, same-day ties by higher id', () => {
    const s = orderSections(ROWS, 'newest', facts);
    expect(s.map((x) => x.label)).toEqual(['August 2026', 'July 2026']);
    expect(ids(s)).toEqual([[2], [4, 3, 1]]);
  });

  it('oldest: months oldest first, same-day ties by lower id', () => {
    const s = orderSections(ROWS, 'oldest', facts);
    expect(s.map((x) => x.label)).toEqual(['July 2026', 'August 2026']);
    expect(ids(s)).toEqual([[1, 3, 4], [2]]);
  });

  it('largest: one global ranking — a month never overrides it', () => {
    const s = orderSections(ROWS, 'largest', facts);
    expect(s.map((x) => x.label)).toEqual(['Amounts in EUR']);
    expect(ids(s)).toEqual([[3, 1, 2, 4]]);
    expect(ids(orderSections(ROWS, 'smallest', facts))).toEqual([[4, 2, 1, 3]]);
  });

  it('amount ties: newest date first, then higher id — deterministic', () => {
    const tied = [
      row(1, '2026-07-01', 100),
      row(2, '2026-07-09', 100),
      row(3, '2026-07-09', 100),
    ];
    expect(ids(orderSections(tied, 'largest', facts))).toEqual([[3, 2, 1]]);
    expect(ids(orderSections([...tied].reverse(), 'smallest', facts))).toEqual([
      [3, 2, 1],
    ]);
  });

  it('currencies are ranked separately (no FX), EUR listed first', () => {
    const mixed = [
      row(1, '2026-09-01', 50000, 'USD'),
      row(2, '2026-09-02', 1000, 'EUR'),
      row(3, '2026-09-03', 140000, 'EUR'),
      row(4, '2026-09-04', 700, 'GBP'),
    ];
    const s = orderSections(mixed, 'largest', facts);
    expect(s.map((x) => x.label)).toEqual([
      'Amounts in EUR',
      'Amounts in GBP',
      'Amounts in USD',
    ]);
    expect(ids(s)).toEqual([[3, 2], [4], [1]]);
  });
});

describe('totalsByCurrency', () => {
  it('sums per currency, never across; formatted one figure each', () => {
    const t = totalsByCurrency(
      [
        row(1, '2026-09-01', 50000, 'USD'),
        row(2, '2026-09-02', 100000, 'EUR'),
        row(3, '2026-09-03', 40000, 'EUR'),
      ],
      (r) => -r.amount,
      (r) => r.currency,
    );
    expect(t).toEqual([
      { currency: 'EUR', cents: -140000 },
      { currency: 'USD', cents: -50000 },
    ]);
    // No-break space inside a figure: the mark never wraps off its amount.
    expect(formatTotals(t)).toBe('−1400.00\u00a0€ · −500.00\u00a0USD');
  });
});
