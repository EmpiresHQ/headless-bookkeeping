import { signedMoney } from '../lib/money';
import { monthKey, monthLabel } from '../queries/books';

/**
 * Books date range + order (issue #279). Pure: parsing the URL, the date
 * predicate, the ordering into sections and per-currency totals, so the
 * segments only render. Params are carried across a segment switch (like
 * ?q=) and always named in the ActiveFilters line where they apply.
 */
export const ORDER_PARAMS = ['from', 'to', 'sort'] as const;

export type BooksOrder = 'newest' | 'oldest' | 'largest' | 'smallest';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A real calendar date in YYYY-MM-DD, year 1–9999 as a native date input
 *  accepts (2026-02-30 and 0000-01-01 are not). Proleptic Gregorian leap
 *  rule computed directly — Date.UTC would remap years 0–99 to 19xx. */
export function isCalendarDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= (mo === 2 && leap ? 29 : DAYS_IN_MONTH[mo - 1]);
}

/** '2026-07-03' → '3 Jul 2026'. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]} ${y}`;
}

/** A unix-seconds timestamp as the viewer's local calendar day. */
export function localDay(unixSecs: number): string {
  const t = new Date(unixSecs * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

export interface BooksOrderState {
  /** Bounds actually applied (null = open on that side). */
  from: string | null;
  to: string | null;
  order: BooksOrder;
  /** Raw values that are present but not a date, per input. */
  fromInvalid: boolean;
  toInvalid: boolean;
  /** Both bounds valid but From is after To — no date restriction applied. */
  reversed: boolean;
  /** Any of the params is in the URL (Reset must be offered). */
  present: boolean;
  /** Restrictions / not-applied notes for the ActiveFilters line. */
  labels: string[];
}

/** No date range, newest first — what an absent URL parses to. */
export const DEFAULT_ORDER: BooksOrderState = {
  from: null,
  to: null,
  order: 'newest',
  fromInvalid: false,
  toInvalid: false,
  reversed: false,
  present: false,
  labels: [],
};

export interface OrderSemantics {
  /** Prefix for the date part of the ActiveFilters line ('Tax point'). */
  dateNoun: string;
  /** Amount orders are offered (Documents have no amount). */
  amounts: boolean;
  /** Plural noun for the not-applied amount note. */
  noun: string;
}

const ORDERS: readonly BooksOrder[] = [
  'newest',
  'oldest',
  'largest',
  'smallest',
];
export const ORDER_LABELS: Record<BooksOrder, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  largest: 'Largest amount first',
  smallest: 'Smallest amount first',
};

/** Parse ?from= ?to= ?sort= for a segment. Never claims a value it did not
 *  apply: an invalid bound, a reversed range, an unknown order or an amount
 *  order where there is no amount each become a "not applied" label. */
export function parseBooksOrder(
  params: URLSearchParams,
  sem: OrderSemantics,
): BooksOrderState {
  // An empty value (?sort=) is the default, not an unknown value.
  const raw = (k: string) => {
    const v = params.get(k);
    return v === null || v === '' ? null : v;
  };
  const rawFrom = raw('from');
  const rawTo = raw('to');
  const rawSort = raw('sort');
  const fromInvalid = rawFrom !== null && !isCalendarDate(rawFrom);
  const toInvalid = rawTo !== null && !isCalendarDate(rawTo);
  let from = rawFrom !== null && !fromInvalid ? rawFrom : null;
  let to = rawTo !== null && !toInvalid ? rawTo : null;
  const reversed = from !== null && to !== null && from > to;
  const labels: string[] = [];

  if (reversed) {
    labels.push('Dates not applied: From is after To');
    from = null;
    to = null;
  } else if (from !== null && to !== null) {
    labels.push(`${sem.dateNoun} ${longDate(from)} – ${longDate(to)}`);
  } else if (from !== null) {
    labels.push(`${sem.dateNoun} from ${longDate(from)}`);
  } else if (to !== null) {
    labels.push(`${sem.dateNoun} until ${longDate(to)}`);
  }
  if (fromInvalid)
    labels.push(`From “${excerpt(rawFrom)}” not applied (not a date)`);
  if (toInvalid) labels.push(`To “${excerpt(rawTo)}” not applied (not a date)`);

  let order: BooksOrder = 'newest';
  if (rawSort !== null) {
    const known = ORDERS.includes(rawSort as BooksOrder)
      ? (rawSort as BooksOrder)
      : null;
    if (known === null) {
      labels.push(`Order “${excerpt(rawSort)}” not recognised — newest first`);
    } else if (!sem.amounts && (known === 'largest' || known === 'smallest')) {
      labels.push(`Newest first — ${sem.noun} have no amount to order by`);
    } else {
      order = known;
      if (known !== 'newest') labels.push(ORDER_LABELS[known]);
    }
  }

  return {
    from,
    to,
    order,
    fromInvalid,
    toInvalid,
    reversed,
    present: rawFrom !== null || rawTo !== null || rawSort !== null,
    labels,
  };
}

/** A raw URL value quoted in the line: bounded, so a pasted long value
 *  cannot push Reset off the first lines at 320px. */
const excerpt = (s: string): string =>
  s.length > 24 ? `${s.slice(0, 24)}…` : s;

/** Inclusive calendar-day range check (ISO strings compare as dates). */
export function inRange(
  day: string,
  range: { from: string | null; to: string | null },
): boolean {
  return (
    (range.from === null || day >= range.from) &&
    (range.to === null || day <= range.to)
  );
}

// ── Sections + totals ─────────────────────────────────────────────────────

export interface CurrencyTotal {
  currency: string;
  cents: number;
}

/** Sum per currency, never across currencies (no FX). Listed EUR first,
 *  then by code — a display convention only, not the org's base currency. */
export function totalsByCurrency<T>(
  rows: readonly T[],
  amount: (r: T) => number,
  currency: (r: T) => string,
): CurrencyTotal[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const c = currency(r);
    sums.set(c, (sums.get(c) ?? 0) + amount(r));
  }
  return [...sums.entries()]
    .map(([c, cents]) => ({ currency: c, cents }))
    .sort((a, b) => byCurrency(a.currency, b.currency));
}

const byCurrency = (a: string, b: string): number =>
  a === b ? 0 : a === 'EUR' ? -1 : b === 'EUR' ? 1 : a.localeCompare(b);

/** '−120.00 € · −40.00 USD' — one figure per currency. Each figure keeps
 *  its currency mark on its line (no-break space); lines break between
 *  figures. */
export const formatTotals = (totals: readonly CurrencyTotal[]): string =>
  totals
    .map((t) => signedMoney(t.cents, t.currency).replace(' ', '\u00a0'))
    .join(' · ');

export interface OrderedSection<T> {
  key: string;
  label: string;
  rows: T[];
}

export interface Orderable {
  id: number;
  day: string;
  amount: number;
  currency: string;
}

/**
 * The filtered rows in the chosen order, as sections:
 * - newest/oldest: month sections in that direction, rows by date in that
 *   direction, ties by id (newest: higher id first; oldest: lower first);
 * - largest/smallest: ONE global ranking per currency (no month sections
 *   that could override it, no FX so no cross-currency comparison), ties by
 *   date newest then id descending.
 * `key` maps a row to its date/amount/currency facts.
 */
export function orderSections<T>(
  rows: readonly T[],
  order: BooksOrder,
  key: (r: T) => Orderable,
): OrderedSection<T>[] {
  const facts = new Map<T, Orderable>();
  for (const r of rows) facts.set(r, key(r));
  const f = (r: T) => facts.get(r)!;
  const byDateDesc = (a: T, b: T) =>
    f(b).day.localeCompare(f(a).day) || f(b).id - f(a).id;

  if (order === 'newest' || order === 'oldest') {
    const dir = order === 'newest' ? 1 : -1;
    const sorted = [...rows].sort((a, b) => dir * byDateDesc(a, b));
    const sections: OrderedSection<T>[] = [];
    for (const r of sorted) {
      const month = monthKey(f(r).day);
      const last = sections[sections.length - 1];
      if (last?.key === month) last.rows.push(r);
      else sections.push({ key: month, label: monthLabel(month), rows: [r] });
    }
    return sections;
  }

  const dir = order === 'largest' ? 1 : -1;
  const sorted = [...rows].sort(
    (a, b) =>
      byCurrency(f(a).currency, f(b).currency) ||
      dir * (f(b).amount - f(a).amount) ||
      byDateDesc(a, b),
  );
  const sections: OrderedSection<T>[] = [];
  for (const r of sorted) {
    const c = f(r).currency;
    const last = sections[sections.length - 1];
    if (last?.key === c) last.rows.push(r);
    else sections.push({ key: c, label: `Amounts in ${c}`, rows: [r] });
  }
  return sections;
}
