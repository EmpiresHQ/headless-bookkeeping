import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  getExpense,
  getNeedsTriageItems,
  getPendingApprovals,
  type Approval,
  type Entity,
  type Expense,
  type NeedsTriageItem,
  type ReportingPeriod,
  type SalesInvoice,
} from '../api';
import { sharedKeys } from './keys';
import { useExpenses, useReportingPeriods } from './shared';

/**
 * Inbox data layer. The queue itself is a PURE merge of two server lists
 * (needs-triage documents + pending approvals) — kept as plain functions so
 * ordering, sections, and auto-advance are unit-testable without React.
 *
 * POLLING RULE (supersedes Plan 02's "import job is the only refetchInterval"):
 * the import job keeps the only FAST poll (1.5s); the two Inbox lists poll at
 * a modest 30s and ONLY while an Inbox route observes them — refetchInterval
 * is per-observer in TanStack Query v5, and the always-mounted badge observer
 * passes `false`, so no polling happens outside the Inbox section.
 */
export const INBOX_REFETCH_MS = 30_000;

export const inboxRefetchInterval = (poll: boolean): number | false =>
  poll ? INBOX_REFETCH_MS : false;

export const inboxKeys = {
  all: ['inbox'] as const,
  needsTriage: ['inbox', 'needs-triage'] as const,
  approvals: ['inbox', 'approvals', 'pending'] as const,
  docDetails: (id: number) => ['inbox', 'doc', id, 'details'] as const,
  reclassify: (id: number) => ['inbox', 'doc', id, 'reclassify'] as const,
  pendingDraft: (id: number) => ['inbox', 'doc', id, 'pending-draft'] as const,
  approvalExpense: (id: number) => ['inbox', 'approval-expense', id] as const,
};

const oldestFirst = <T extends { created_at: number }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.created_at - b.created_at);

/** Needs-triage list, FIFO (the server sends newest-first). */
export function useNeedsTriage(opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: inboxKeys.needsTriage,
    queryFn: getNeedsTriageItems,
    select: oldestFirst,
    refetchInterval: inboxRefetchInterval(opts.poll === true),
  });
}

/** Pending approvals, FIFO. */
export function usePendingApprovals(opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: inboxKeys.approvals,
    queryFn: getPendingApprovals,
    select: oldestFirst,
    refetchInterval: inboxRefetchInterval(opts.poll === true),
  });
}

/** Single-expense facts for the approval detail. */
export function useExpenseDetail(id: number | null) {
  return useQuery({
    queryKey: inboxKeys.approvalExpense(id ?? -1),
    queryFn: () => getExpense(id as number),
    enabled: id !== null,
  });
}

// ── Pure queue model ───────────────────────────────────────────────────────

export type InboxSegment = 'all' | 'triage' | 'approvals';

export type InboxEntry =
  | { kind: 'triage'; createdAt: number; route: string; item: NeedsTriageItem }
  | { kind: 'approval'; createdAt: number; route: string; approval: Approval };

/** Merge the two sources into ONE FIFO queue (oldest first — the queue must
 *  end; stuck items stay on top). Segment filters, never re-orders. */
export function buildQueue(
  triage: NeedsTriageItem[],
  approvals: Approval[],
  seg: InboxSegment,
): InboxEntry[] {
  const t: InboxEntry[] =
    seg === 'approvals'
      ? []
      : triage.map((item) => ({
          kind: 'triage' as const,
          createdAt: item.created_at,
          route: `/inbox/doc/${item.id}`,
          item,
        }));
  const a: InboxEntry[] =
    seg === 'triage'
      ? []
      : approvals.map((approval) => ({
          kind: 'approval' as const,
          createdAt: approval.created_at,
          route: `/inbox/approval/${approval.id}`,
          approval,
        }));
  return [...t, ...a].sort((x, y) => x.createdAt - y.createdAt);
}

export function startOfTodayUnix(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function splitTodayEarlier(
  entries: InboxEntry[],
  now: Date = new Date(),
): { today: InboxEntry[]; earlier: InboxEntry[] } {
  const cutoff = startOfTodayUnix(now);
  return {
    today: entries.filter((e) => e.createdAt >= cutoff),
    earlier: entries.filter((e) => e.createdAt < cutoff),
  };
}

/** "N of M" for the detail nav title. */
export function queuePosition(
  entries: InboxEntry[],
  route: string,
): { pos: number; total: number } | null {
  const i = entries.findIndex((e) => e.route === route);
  return i === -1 ? null : { pos: i + 1, total: entries.length };
}

/** Auto-advance: after deciding the item at `route`, go to the entry that
 *  followed it (same index once removed), else the previous one, else back
 *  to the queue. Callers compute this BEFORE mutating (the queue refetch
 *  will drop the decided entry). */
export function nextRouteAfter(entries: InboxEntry[], route: string): string {
  const i = entries.findIndex((e) => e.route === route);
  if (i === -1) return '/inbox';
  const rest = entries.filter((_, j) => j !== i);
  if (rest.length === 0) return '/inbox';
  return (rest[i] ?? rest[rest.length - 1]).route;
}

/** The two list queries + the merged queue, for the Inbox screens
 *  (poll: true there) and the detail screens (position/advance). */
export function useInboxQueue(
  seg: InboxSegment,
  opts: { poll?: boolean } = {},
) {
  const triageQ = useNeedsTriage(opts);
  const approvalsQ = usePendingApprovals(opts);
  const triage = triageQ.data ?? [];
  const approvals = approvalsQ.data ?? [];
  return {
    triageQ,
    approvalsQ,
    entries: buildQueue(triage, approvals, seg),
    counts: { triage: triage.length, approvals: approvals.length },
    isPending: triageQ.isPending || approvalsQ.isPending,
  };
}

/** Nav badge (TabBar + Sidebar): SAME cache keys as the queue, NO polling —
 *  it updates from the shared cache whenever the Inbox refetches, plus the
 *  global staleTime/refetchOnWindowFocus defaults. */
export function useInboxCount(): number {
  const t = useNeedsTriage();
  const a = usePendingApprovals();
  return (t.data?.length ?? 0) + (a.data?.length ?? 0);
}

// ── Row enrichment ─────────────────────────────────────────────────────────

/** Queue-row facts for an approval: WHO (counterparty, not "Expense #214")
 *  and HOW MUCH (signed cents; negative = outflow). Joined client-side from
 *  the list endpoints — pending expenses/invoices ARE in those lists. */
export function approvalDisplay(
  a: Approval,
  ctx: { expenses: Expense[]; invoices: SalesInvoice[]; entities: Entity[] },
): { title: string; amountCents: number | null } {
  switch (a.object_type) {
    case 'expense': {
      const e = ctx.expenses.find((x) => x.id === a.object_id);
      const supplier =
        e?.supplier_id != null
          ? ctx.entities.find((en) => en.id === e.supplier_id)
          : undefined;
      return {
        title: supplier?.name ?? e?.category ?? 'Expense',
        amountCents: e ? -e.gross_amount : null,
      };
    }
    case 'sales_invoice': {
      const inv = ctx.invoices.find((x) => x.id === a.object_id);
      const customer =
        inv?.customer_id != null
          ? ctx.entities.find((en) => en.id === inv.customer_id)
          : undefined;
      return {
        title: customer?.name ?? inv?.invoice_number ?? 'Sales invoice',
        amountCents: inv ? inv.gross_amount : null,
      };
    }
    case 'reconciliation_match':
      return { title: 'Bank match', amountCents: null };
    case 'allowance':
      return { title: 'Allowance', amountCents: null };
    default:
      return { title: a.object_type, amountCents: null };
  }
}

/** After approve/reject/triage: the queue AND the business-object lists the
 *  rows join against are stale — including entities (ResolveSupplierSheet
 *  can create a new supplier, and queue titles/facts/pickers join against
 *  the entities list), books (approve/reject changes the expense/invoice
 *  detail, rejection, and documents that Books screens read — otherwise the
 *  "Open Inbox" round-trip back to Books shows stale pending state under
 *  Books' own 15s staleTime), AND reports (an approval posts an expense/
 *  invoice that changes the open period's live KMD/warnings/hero net). */
export function invalidateInbox(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: inboxKeys.all }),
    qc.invalidateQueries({ queryKey: sharedKeys.expenses }),
    qc.invalidateQueries({ queryKey: sharedKeys.invoices }),
    qc.invalidateQueries({ queryKey: sharedKeys.entities }),
    qc.invalidateQueries({ queryKey: ['books'] }),
    qc.invalidateQueries({ queryKey: ['reports'] }),
  ]).then(() => undefined);
}

// ── Hero card data (open period + month total) ─────────────────────────────

/** Latest open reporting period, or null (hero hidden — no fake surface). */
export function openPeriod(periods: ReportingPeriod[]): ReportingPeriod | null {
  const open = periods.filter((p) => p.status === 'open');
  if (open.length === 0) return null;
  return [...open].sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
}

/** Money spent in the period: posted + pending expenses (drafts are not
 *  money yet), tax_point_date within [start, end]. ISO strings compare
 *  lexicographically. */
export function periodExpensesTotal(
  expenses: Expense[],
  period: ReportingPeriod,
): number {
  return expenses
    .filter(
      (e) =>
        (e.status === 'posted' || e.status === 'pending') &&
        e.tax_point_date >= period.start_date &&
        e.tax_point_date <= period.end_date,
    )
    .reduce((sum, e) => sum + e.gross_amount, 0);
}

export function useInboxHero(): {
  periodName: string;
  monthTotalCents: number;
} | null {
  const periodsQ = useReportingPeriods();
  const expensesQ = useExpenses();
  const period = openPeriod(periodsQ.data ?? []);
  if (period === null || expensesQ.data === undefined) return null;
  return {
    periodName: period.name,
    monthTotalCents: periodExpensesTotal(expensesQ.data, period),
  };
}
