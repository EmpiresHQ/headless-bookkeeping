/**
 * Pure date-computation utilities for reporting period creation.
 *
 * All functions are stateless and side-effect-free — no DB access, no DI.
 * Dates are always ISO 8601 strings (YYYY-MM-DD). Frequency values match
 * CountryPlugin.getDefaultPeriodFrequency(): 'monthly' | 'quarterly' |
 * 'half-yearly' | 'yearly'.
 */

export type PeriodFrequency =
  | 'monthly'
  | 'quarterly'
  | 'half-yearly'
  | 'yearly';

export interface PeriodDates {
  start_date: string;
  end_date: string;
}

/**
 * Given a frequency and the last period's end date (or null if no periods
 * exist yet), compute the start and end dates for the next period.
 *
 * When `lastEndDate` is null the period is anchored to `today`: the start
 * date is the first day of the current period window (e.g. for 'monthly'
 * it's the first of the current month).
 *
 * When `lastEndDate` is given, the next period starts the following day.
 */
export function computeNextPeriodDates(
  frequency: string,
  lastEndDate: string | null,
  today: string,
): PeriodDates {
  let start_date: string;

  if (lastEndDate === null) {
    start_date = firstDayOfCurrentPeriod(frequency, today);
  } else {
    start_date = addDays(lastEndDate, 1);
  }

  const end_date = computeEndFromStart(frequency, start_date);
  return { start_date, end_date };
}

/**
 * Compute the end date for a period starting at `startDate` given `frequency`.
 */
export function computeEndFromStart(
  frequency: string,
  startDate: string,
): string {
  const [year, month, day] = startDate.split('-').map(Number);

  switch (frequency) {
    case 'monthly': {
      // End on last day of the same month.
      const lastDay = new Date(year, month, 0).getDate();
      return formatDate(year, month, lastDay);
    }
    case 'quarterly': {
      // End on last day of the third month from start month.
      const endMonth = month + 2;
      const endYear = year + Math.floor((endMonth - 1) / 12);
      const normalizedEndMonth = ((endMonth - 1) % 12) + 1;
      const lastDay = new Date(endYear, normalizedEndMonth, 0).getDate();
      return formatDate(endYear, normalizedEndMonth, lastDay);
    }
    case 'half-yearly': {
      // End on last day of the sixth month from start month.
      const endMonth = month + 5;
      const endYear = year + Math.floor((endMonth - 1) / 12);
      const normalizedEndMonth = ((endMonth - 1) % 12) + 1;
      const lastDay = new Date(endYear, normalizedEndMonth, 0).getDate();
      return formatDate(endYear, normalizedEndMonth, lastDay);
    }
    case 'yearly': {
      // End on last day of the 12th month from start month (or Dec 31 if Jan 1).
      if (month === 1 && day === 1) {
        return formatDate(year, 12, 31);
      }
      const endMonth = month + 11;
      const endYear = year + Math.floor((endMonth - 1) / 12);
      const normalizedEndMonth = ((endMonth - 1) % 12) + 1;
      const lastDay = new Date(endYear, normalizedEndMonth, 0).getDate();
      return formatDate(endYear, normalizedEndMonth, lastDay);
    }
    default:
      // Unknown frequency: treat as monthly.
      return formatDate(year, month, new Date(year, month, 0).getDate());
  }
}

/**
 * Compute a human-readable period name from its start date and frequency.
 *
 * Examples:
 *   monthly   2024-01-01 → "2024-01"
 *   quarterly 2024-01-01 → "2024-Q1"
 *   half-yearly 2024-01-01 → "2024-H1"
 *   yearly    2024-01-01 → "2024"
 */
export function computeNameFromStart(
  frequency: string,
  startDate: string,
): string {
  const [year, month] = startDate.split('-').map(Number);

  switch (frequency) {
    case 'monthly':
      return `${year}-${String(month).padStart(2, '0')}`;
    case 'quarterly': {
      const quarter = Math.ceil(month / 3);
      return `${year}-Q${quarter}`;
    }
    case 'half-yearly': {
      const half = month <= 6 ? 1 : 2;
      return `${year}-H${half}`;
    }
    case 'yearly':
      return `${year}`;
    default:
      return `${year}-${String(month).padStart(2, '0')}`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format year/month/day as YYYY-MM-DD. */
function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Add `n` days to an ISO date string and return a new ISO date string. */
function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Return the first day of the current period window containing `today`,
 * based on frequency. For monthly: first of the month. For quarterly: first
 * of the quarter-start month. For half-yearly: Jan 1 or Jul 1. For yearly:
 * Jan 1.
 */
function firstDayOfCurrentPeriod(frequency: string, today: string): string {
  const [year, month] = today.split('-').map(Number);

  switch (frequency) {
    case 'monthly':
      return formatDate(year, month, 1);
    case 'quarterly': {
      const quarterStart = Math.floor((month - 1) / 3) * 3 + 1;
      return formatDate(year, quarterStart, 1);
    }
    case 'half-yearly': {
      const halfStart = month <= 6 ? 1 : 7;
      return formatDate(year, halfStart, 1);
    }
    case 'yearly':
      return formatDate(year, 1, 1);
    default:
      return formatDate(year, month, 1);
  }
}
