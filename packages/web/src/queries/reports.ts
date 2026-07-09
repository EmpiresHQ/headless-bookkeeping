import { useQueries, useQuery, type QueryClient } from '@tanstack/react-query';
import {
  getKmd,
  getPeriodConfig,
  getPeriodWarnings,
  getSubmissionState,
  type Expense,
  type ReportingPeriod,
  type SalesInvoice,
  type SubmissionState,
  type SubmissionStatus,
} from '../api';
import { monthLabel } from './books';
import { sharedKeys } from './keys';

/**
 * Reports data layer. The periods list itself comes from the SHARED
 * useReportingPeriods (frozen sharedKeys.reportingPeriods — the Inbox hero
 * already populates it); this module adds the Reports-only reads and the
 * PURE model (period titles, lexicographic membership, INF gaps, fold
 * labels) so everything is unit-testable without React.
 * NO refetchInterval anywhere here (Global Constraints).
 */
export const reportsKeys = {
  all: ['reports'] as const,
  kmd: (periodId: number) => ['reports', 'kmd', periodId] as const,
  warnings: (periodId: number) => ['reports', 'warnings', periodId] as const,
  submission: (periodId: number) =>
    ['reports', 'submission', periodId] as const,
  periodConfig: ['reports', 'period-config'] as const,
};

/** Derived on every read — live preview for open periods (Reality #5). */
export const useKmd = (periodId: number) =>
  useQuery({
    queryKey: reportsKeys.kmd(periodId),
    queryFn: () => getKmd(periodId),
  });

/** Advisory ADR-0015 stragglers — enabled only where shown (open periods). */
export const usePeriodWarnings = (periodId: number, enabled: boolean) =>
  useQuery({
    queryKey: reportsKeys.warnings(periodId),
    queryFn: () => getPeriodWarnings(periodId),
    enabled,
  });

export const useSubmissionState = (periodId: number, enabled: boolean) =>
  useQuery({
    queryKey: reportsKeys.submission(periodId),
    queryFn: () => getSubmissionState(periodId),
    enabled,
  });

/** Folded submission line per LOCKED period (list screen): one small request
 *  per locked period — periods are few (one per month/quarter). A batch
 *  endpoint is on the server follow-up list (Appendix A gap 4). */
export function useSubmissionStates(
  lockedIds: number[],
): Map<number, SubmissionState> {
  return useQueries({
    queries: lockedIds.map((id) => ({
      queryKey: reportsKeys.submission(id),
      queryFn: () => getSubmissionState(id),
    })),
    combine: (results) => {
      const map = new Map<number, SubmissionState>();
      results.forEach((r, i) => {
        if (r.data !== undefined) map.set(lockedIds[i], r.data);
      });
      return map;
    },
  });
}

export const usePeriodConfig = () =>
  useQuery({ queryKey: reportsKeys.periodConfig, queryFn: getPeriodConfig });

/** After any Reports mutation: Reports reads, the shared periods list, AND
 *  the shared expenses list (the INF fix patches an expense; the straggler /
 *  in-period sections join it). */
export function invalidateReports(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: reportsKeys.all }),
    qc.invalidateQueries({ queryKey: sharedKeys.reportingPeriods }),
    qc.invalidateQueries({ queryKey: sharedKeys.expenses }),
  ]).then(() => undefined);
}

// ── Pure model ─────────────────────────────────────────────────────────────

/** Server period names are compact plugin-frequency labels
 *  (period-dates.ts:105-127): '2026-06' | '2026-Q1' | '2026-H1' | '2026'.
 *  Humanize the known shapes; operator overrides pass through verbatim. */
export function periodTitle(name: string): string {
  if (/^\d{4}-\d{2}$/.test(name)) return monthLabel(name);
  const quarterly = /^(\d{4})-([QH]\d)$/.exec(name);
  if (quarterly) return `${quarterly[2]} ${quarterly[1]}`;
  return name;
}

type PeriodLike = Pick<ReportingPeriod, 'start_date' | 'end_date' | 'status'>;

/** Lexicographic ISO ordering — no Date construction (Global Constraints). */
export const sortPeriodsNewestFirst = <T extends { start_date: string }>(
  rows: T[],
): T[] => [...rows].sort((a, b) => b.start_date.localeCompare(a.start_date));

/** The LATEST open period — mirror of GET /current
 *  (reporting-periods.service.ts:93-106). */
export function currentOpen<T extends PeriodLike>(periods: T[]): T | null {
  const open = periods.filter((p) => p.status === 'open');
  if (open.length === 0) return null;
  return open.reduce((a, b) => (b.start_date > a.start_date ? b : a));
}

/** The OLDEST open period — the only one the server will lock (filing is
 *  strictly oldest-first, Reality #2). */
export function oldestOpen<T extends PeriodLike>(periods: T[]): T | null {
  const open = periods.filter((p) => p.status === 'open');
  if (open.length === 0) return null;
  return open.reduce((a, b) => (b.start_date < a.start_date ? b : a));
}

/** Inclusive membership by tax point — pure string math, timezone-proof. */
export const inPeriod = (
  isoDate: string,
  p: Pick<ReportingPeriod, 'start_date' | 'end_date'>,
): boolean => p.start_date <= isoDate && isoDate <= p.end_date;

/** Statuses that are LIVE in the books — posted, plus reversed (= corrected;
 *  the corrected figures are what is live — Plan 04 Reality #1). */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'posted',
  'reversed',
]);

/** Live expenses dated in the period, newest tax point first. */
export function periodExpenses(
  expenses: Expense[],
  p: Pick<ReportingPeriod, 'start_date' | 'end_date'>,
): Expense[] {
  return expenses
    .filter((e) => LIVE_STATUSES.has(e.status) && inPeriod(e.tax_point_date, p))
    .sort((a, b) => b.tax_point_date.localeCompare(a.tax_point_date));
}

/** Live sales invoices dated in the period, newest tax point first. */
export function periodInvoices(
  invoices: SalesInvoice[],
  p: Pick<ReportingPeriod, 'start_date' | 'end_date'>,
): SalesInvoice[] {
  return invoices
    .filter((i) => LIVE_STATUSES.has(i.status) && inPeriod(i.tax_point_date, p))
    .sort((a, b) => b.tax_point_date.localeCompare(a.tax_point_date));
}

/** Client mirror of the per-partner INF net threshold (€1000 in cents —
 *  kmd-inf.ts:13). The server stays the authority at download time; this
 *  only makes the gap list honest up front (Reality #11). */
export const INF_THRESHOLD_NET = 100000;

/**
 * In-period live expenses that the INF annex will likely itemise but which
 * have NO supplier invoice number. Approximation, clearly labeled in the UI:
 * the client cannot see VAT codes or reg-key presence, so it filters only on
 * supplier net ≥ threshold + missing number. B2C (no supplier) never gaps.
 */
export function infGapCandidates(
  expenses: Expense[],
  p: Pick<ReportingPeriod, 'start_date' | 'end_date'>,
): Expense[] {
  const live = periodExpenses(expenses, p);
  const netBySupplier = new Map<number, number>();
  for (const e of live) {
    if (e.supplier_id == null) continue;
    netBySupplier.set(
      e.supplier_id,
      (netBySupplier.get(e.supplier_id) ?? 0) +
        Math.abs(e.gross_amount - e.vat_amount),
    );
  }
  return live.filter(
    (e) =>
      e.supplier_id != null &&
      (netBySupplier.get(e.supplier_id) ?? 0) >= INF_THRESHOLD_NET &&
      !e.supplier_invoice_number,
  );
}

export type KmdRowKey =
  | 'row1_base_24'
  | 'row2_base_reduced'
  | 'row3_base_zero'
  | 'row4_output_vat'
  | 'row5_input_vat'
  | 'row6_intra_eu_acquisition'
  | 'row7_other_acquisition';

/** Human-first labels (data rule 3) with the statutory row number as the
 *  secondary fact — never "Row 5 — input VAT" as the headline. */
export const KMD_ROWS: { key: KmdRowKey; label: string }[] = [
  { key: 'row1_base_24', label: 'Sales taxed at 24% — net (row 1)' },
  { key: 'row2_base_reduced', label: 'Sales at reduced 9/13% — net (row 2)' },
  {
    key: 'row3_base_zero',
    label: 'Zero-rated sales — exports, intra-EU (row 3)',
  },
  { key: 'row4_output_vat', label: 'VAT charged on sales (row 4)' },
  { key: 'row5_input_vat', label: 'VAT deductible on purchases (row 5)' },
  {
    key: 'row6_intra_eu_acquisition',
    label: 'Purchases from the EU — net (row 6)',
  },
  {
    key: 'row7_other_acquisition',
    label: 'Other reverse-charged purchases — net (row 7)',
  },
];

/** net_vat_due < 0 means reclaimable (vat-report/types.ts:44-45). */
export const netVatLabel = (cents: number): string =>
  cents < 0 ? 'VAT to reclaim' : 'VAT to pay';

/** The one server flag that embeds raw cents (Reality #6) — replaced by the
 *  client's own VD row + notice. Substring match is documented brittleness;
 *  structured flags are a server follow-up (Appendix A gap 3). */
export const isVdFlag = (flag: string): boolean =>
  flag.includes('VD koondaruanne');

export const displayFlags = (flags: string[]): string[] =>
  flags.filter((f) => !isVdFlag(f));

export const SUBMISSION_STATUS: Record<
  SubmissionStatus,
  { label: string; tone: 'ok' | 'warn' | 'err' | 'muted' }
> = {
  not_started: { label: 'No submission recorded', tone: 'muted' },
  prepared: { label: 'Prepared — not submitted', tone: 'warn' },
  submitted: { label: 'Submitted — awaiting confirmation', tone: 'warn' },
  accepted: { label: 'Accepted', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'err' },
  correction_submitted: { label: 'Correction submitted', tone: 'warn' },
  correction_accepted: { label: 'Correction accepted', tone: 'ok' },
};

/** One folded status line per period (asset §7 decision 6). */
export function submissionLine(
  state: Pick<SubmissionState, 'status' | 'lastExternalRef'>,
): string {
  const base = SUBMISSION_STATUS[state.status].label;
  return state.lastExternalRef !== null
    ? `${base} · ref ${state.lastExternalRef}`
    : base;
}
