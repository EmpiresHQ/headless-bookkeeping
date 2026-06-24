/**
 * Split a date range [start, end] inclusive into per-calendar-month segments
 * with day counts. Uses plain Date arithmetic — no external date library.
 *
 * @param start - ISO date string (YYYY-MM-DD), inclusive
 * @param end   - ISO date string (YYYY-MM-DD), inclusive
 * @returns Array of segments ordered chronologically
 */
export function splitByMonth(
  start: string,
  end: string,
): { month: string; days: number; monthStart: string; monthEnd: string }[] {
  const result: {
    month: string;
    days: number;
    monthStart: string;
    monthEnd: string;
  }[] = [];

  // Parse dates as UTC midnight to avoid DST issues
  const parseDate = (s: string): Date => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };

  const formatDate = (d: Date): string => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const formatMonth = (d: Date): string => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  };

  const startDate = parseDate(start);
  const endDate = parseDate(end);

  if (endDate < startDate) {
    return [];
  }

  let cursor = new Date(startDate);

  while (cursor <= endDate) {
    const segYear = cursor.getUTCFullYear();
    const segMonth = cursor.getUTCMonth(); // 0-based

    // Compute last day of this calendar month
    const lastDayOfMonth = new Date(Date.UTC(segYear, segMonth + 1, 0));

    // Segment ends at the earlier of end-of-month or the trip end
    const segEnd = lastDayOfMonth < endDate ? lastDayOfMonth : endDate;

    // Compute segment start (first day of this month or the trip start)
    const firstDayOfMonth = new Date(Date.UTC(segYear, segMonth, 1));
    const segStart = firstDayOfMonth > startDate ? firstDayOfMonth : startDate;

    const msPerDay = 24 * 60 * 60 * 1000;
    const days =
      Math.round((segEnd.getTime() - segStart.getTime()) / msPerDay) + 1;

    result.push({
      month: formatMonth(cursor),
      days,
      monthStart: formatDate(firstDayOfMonth),
      monthEnd: formatDate(lastDayOfMonth),
    });

    // Advance cursor to start of next month
    cursor = new Date(Date.UTC(segYear, segMonth + 1, 1));
  }

  return result;
}
