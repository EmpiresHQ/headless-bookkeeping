import { fmtCents } from '../api';

/**
 * Client-side list search rules shared by the Inbox and the bank statement
 * (issue #278). Pure: every fact searched is already in the loaded lists.
 *
 * - Text: case-insensitive substring, every whitespace run read as one
 *   space; punctuation is kept (as #277 — `INV-12/3` needs its punctuation).
 * - Amount: a needle that reads as a magnitude (`1234,5`, `€1 234.50`,
 *   `-12.30`) is a substring of `fmtCents(|cents|)`. The sign is ignored:
 *   the row itself shows the direction.
 * - Date: substring of `YYYY-MM-DD` or `D Mon YYYY` (`21 sep`, `sep 2026`,
 *   `2026-09`).
 */

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

export const normText = (s: string): string =>
  s.toLowerCase().trim().replace(/\s+/g, ' ');

/** The needle as an amount (`1234.5`), or null if it is not one. */
export function amountNeedle(q: string): string | null {
  const s = q
    .trim()
    .replace(/[€\s]/g, '')
    .replace(/^[+\-−]/, '')
    .replace(',', '.');
  return /^\d+(\.\d{0,2})?$/.test(s) ? s : null;
}

export interface SearchNeedle {
  text: string;
  amount: string | null;
}

/** null: no search (empty or blank query). */
export function searchNeedle(q: string): SearchNeedle | null {
  const text = normText(q);
  return text === '' ? null : { text, amount: amountNeedle(q) };
}

export function textMatches(
  needle: SearchNeedle,
  hays: readonly (string | null | undefined)[],
): boolean {
  return hays.some((h) => h != null && normText(h).includes(needle.text));
}

export function amountMatches(
  needle: SearchNeedle,
  cents: number | null | undefined,
): boolean {
  return (
    needle.amount !== null &&
    cents != null &&
    fmtCents(Math.abs(cents)).includes(needle.amount)
  );
}

/** An ISO calendar date (`YYYY-MM-DD`), as-is — no time zone. */
export function isoDateMatches(needle: SearchNeedle, iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d || m > 12) return false;
  return [iso, `${d} ${MONTHS[m - 1]} ${y}`].some((h) =>
    h.includes(needle.text),
  );
}

/** A unix timestamp (seconds) by its LOCAL calendar date. */
export function unixDateMatches(needle: SearchNeedle, unix: number): boolean {
  const t = new Date(unix * 1000);
  if (Number.isNaN(t.getTime())) return false;
  const pad = (n: number) => String(n).padStart(2, '0');
  return isoDateMatches(
    needle,
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`,
  );
}
