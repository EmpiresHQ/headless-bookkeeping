import { pathOf, useCompletionNavigation } from '../lib/returnNavigation';
import { periodTitle } from '../queries/reports';
import { useReportingPeriods } from '../queries/shared';
import {
  isPeriodItemsPath,
  parsePeriodItemsPath,
  PERIOD_BUCKETS,
} from './periodItems';

/**
 * A Books record opened from a period drill-down list (issue #261). The
 * origin record lives in the entry's history state, so it survives reload
 * and Back/Forward. `returnTo` leaves for that list without a finished entry
 * left behind (#252) — the explicit return and the delete path alike (a
 * deleted draft drops out of the live list on its re-check).
 */
export function usePeriodOrigin() {
  const nav = useCompletionNavigation();
  const href = nav.origin?.href ?? null;
  const scope = href !== null ? parsePeriodItemsPath(pathOf(href)) : null;

  const returnTo = () => {
    if (href === null) return;
    nav.returnTo({ fallback: href, acceptOrigin: isPeriodItemsPath });
  };

  return scope !== null && href !== null ? { ...scope, href, returnTo } : null;
}

/** "Opened from <period> · <bucket>" with an explicit return. */
export function PeriodOriginNotice({
  origin,
}: {
  origin: NonNullable<ReturnType<typeof usePeriodOrigin>>;
}) {
  const periodsQ = useReportingPeriods();
  const period = periodsQ.data?.find((p) => p.id === origin.periodId);
  const name =
    period !== undefined
      ? periodTitle(period.name)
      : `period #${origin.periodId}`;
  return (
    <div className="mx-3.5 mb-3.5 flex items-center justify-between gap-3 rounded-2xl bg-tint px-4 py-3 text-[13px] text-accent">
      <span>
        Opened from {name} · {PERIOD_BUCKETS[origin.bucket].title.toLowerCase()}
      </span>
      <button
        type="button"
        onClick={origin.returnTo}
        className="flex-none font-semibold"
      >
        Return to list
      </button>
    </div>
  );
}
