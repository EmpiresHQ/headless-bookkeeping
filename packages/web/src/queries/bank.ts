import { useQueries, useQuery, type QueryClient } from '@tanstack/react-query';
import {
  approveApproval,
  createExpense,
  executeMatches,
  getBankImportStatus,
  getMatchCandidates,
  getPendingApprovals,
  getReconciliationStatus,
  getStatementMatches,
  listBankStatements,
  listBankTransactions,
  manualMatch,
  postExpense,
  proposeMatches,
  unmatchMatch,
  type BankImportJob,
  type ExecuteMatchesResult,
  type MatchProposalView,
} from '../api';
import { sharedKeys } from './keys';

/**
 * Bank data layer. Reads are TanStack Query hooks; the multi-call server
 * choreography (stage match → approve, create expense → post → match) lives
 * here as composite flows so screens stay declarative and the sequences are
 * unit-testable.
 */
export const bankKeys = {
  statements: ['bank', 'statements'] as const,
  statement: (id: number) => ['bank', 'statements', id] as const,
  transactions: (id: number) =>
    ['bank', 'statements', id, 'transactions'] as const,
  reconciliation: (id: number) =>
    ['bank', 'statements', id, 'reconciliation'] as const,
  matches: (id: number) => ['bank', 'statements', id, 'matches'] as const,
  proposals: (id: number) => ['bank', 'statements', id, 'proposals'] as const,
  candidates: (id: number, txId: number) =>
    ['bank', 'statements', id, 'candidates', txId] as const,
  unmatchedCount: (id: number) =>
    ['bank', 'statements', id, 'unmatched-count'] as const,
  importJob: (jobId: number) => ['bank', 'import', jobId] as const,
};

export const useBankStatements = () =>
  useQuery({ queryKey: bankKeys.statements, queryFn: listBankStatements });

export const useBankTransactions = (statementId: number) =>
  useQuery({
    queryKey: bankKeys.transactions(statementId),
    queryFn: () => listBankTransactions(statementId),
  });

export const useReconciliation = (statementId: number) =>
  useQuery({
    queryKey: bankKeys.reconciliation(statementId),
    queryFn: () => getReconciliationStatus(statementId),
  });

export const useStatementMatches = (statementId: number) =>
  useQuery({
    queryKey: bankKeys.matches(statementId),
    queryFn: () => getStatementMatches(statementId),
  });

/** proposeMatches is a POST but computes-and-returns without persisting —
 *  safe as a query (verified against ReconciliationService.proposeMatches). */
export const useMatchProposals = (statementId: number) =>
  useQuery({
    queryKey: bankKeys.proposals(statementId),
    queryFn: () => proposeMatches(statementId),
  });

export const useMatchCandidates = (
  statementId: number,
  txId: number,
  enabled = true,
) =>
  useQuery({
    queryKey: bankKeys.candidates(statementId, txId),
    queryFn: () => getMatchCandidates(statementId, txId),
    enabled,
  });

/**
 * Import-job poll pacing: 1.5s before the first result and while the job is
 * `running`; stop on terminal job statuses AND when the status fetch itself
 * errors (query.state.status === 'error') — otherwise a failing endpoint
 * would be polled forever. Exported for direct unit testing; `useImportJob`
 * passes it verbatim.
 */
export function importJobRefetchInterval(query: {
  state: { status: 'pending' | 'error' | 'success'; data?: BankImportJob };
}): number | false {
  if (query.state.status === 'error') return false;
  return query.state.data === undefined || query.state.data.status === 'running'
    ? 1500
    : false;
}

/** Import-job polling — the ONLY refetchInterval in the Bank section. */
export function useImportJob(jobId: number | null) {
  return useQuery({
    queryKey: bankKeys.importJob(jobId ?? -1),
    queryFn: () => getBankImportStatus(jobId as number),
    enabled: jobId !== null,
    refetchInterval: importJobRefetchInterval,
  });
}

/** Statements-list badge: unmatched = open lines not fully reconciled.
 *  Joins transactions (for disposition statuses) with reconciliation rows. */
async function fetchUnmatchedCount(statementId: number): Promise<number> {
  const [txns, recon] = await Promise.all([
    listBankTransactions(statementId),
    getReconciliationStatus(statementId),
  ]);
  const byTx = new Map(recon.map((r) => [r.bankTransactionId, r.reconStatus]));
  return txns.filter((t) => t.status === 'open' && byTx.get(t.id) !== 'matched')
    .length;
}

export const useUnmatchedCounts = (statementIds: number[]) =>
  useQueries({
    queries: statementIds.map((id) => ({
      queryKey: bankKeys.unmatchedCount(id),
      queryFn: () => fetchUnmatchedCount(id),
    })),
    combine: (results) =>
      new Map(statementIds.map((id, i) => [id, results[i].data])),
  });

// Cross-domain reads moved to the shared layer (Plan 03); re-exported so bank
// screens' imports keep working. Keys unchanged (see queries/keys.ts).
export { useCategories, useOrganizationCountry, useSuppliers } from './shared';

/** Booking/undoing a match flips reconciled flags and can create posted
 *  expenses — Books lists, expense/invoice detail, and the 🏦 markers all
 *  read that data, so a statement-scoped invalidation alone leaves them
 *  stale. */
export function invalidateStatement(
  qc: QueryClient,
  statementId: number,
): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: bankKeys.statement(statementId) }),
    qc.invalidateQueries({ queryKey: sharedKeys.expenses }),
    qc.invalidateQueries({ queryKey: ['books'] }),
  ]).then(() => undefined);
}

// ── Composite flows ────────────────────────────────────────────────────────

const APPROVED_BY = 'operator';

/**
 * Thrown when staging succeeded but an approval failed mid-loop: some matches
 * may already be ACTIVE, the rest are stranded as drafts. Carries the ids the
 * UI needs to recover — `getStatementMatches` shows draft-vs-active, and
 * `confirmStagedMatch` activates the leftovers. A staging failure is NOT
 * wrapped in this error; it propagates as-is (nothing was staged).
 */
export class BookingPartialError extends Error {
  /** Every match id staging returned (draft at the time of the failure). */
  readonly stagedMatchIds: number[];
  /** Match ids whose approvals succeeded before the failure (now active). */
  readonly approvedMatchIds: number[];
  /** The approval whose activation failed. */
  readonly failedApprovalId: number;
  /** The original error from the failed approveApproval call. */
  readonly cause: unknown;

  constructor(args: {
    stagedMatchIds: number[];
    approvedMatchIds: number[];
    failedApprovalId: number;
    cause: unknown;
  }) {
    const causeText =
      args.cause instanceof Error ? args.cause.message : String(args.cause);
    super(
      `Matches were staged but approval ${args.failedApprovalId} failed ` +
        `(${args.approvedMatchIds.length}/${args.stagedMatchIds.length} activated): ${causeText}`,
    );
    this.name = 'BookingPartialError';
    this.cause = args.cause;
    this.stagedMatchIds = args.stagedMatchIds;
    this.approvedMatchIds = args.approvedMatchIds;
    this.failedApprovalId = args.failedApprovalId;
  }
}

/**
 * Approve every staged approval in order, tracking progress. On a mid-loop
 * failure, throws BookingPartialError carrying the full staged set and the
 * already-activated subset. Returns the activated match ids on full success.
 */
async function approveStaged(res: ExecuteMatchesResult): Promise<number[]> {
  const stagedMatchIds = res.records.map((r) => r.id);
  const approvedMatchIds: number[] = [];
  for (const a of res.approvals) {
    try {
      await approveApproval(a.id, APPROVED_BY);
    } catch (cause) {
      throw new BookingPartialError({
        stagedMatchIds,
        approvedMatchIds,
        failedApprovalId: a.id,
        cause,
      });
    }
    approvedMatchIds.push(a.matchId);
  }
  return approvedMatchIds;
}

/**
 * Book selected AI proposals: stage drafts (server creates one pending
 * approval per match), then approve each — the operator IS the approver.
 * The over-allocation cap is enforced server-side AT ACTIVATION; a 409 here
 * propagates to the caller with the server's message (no client cap math) —
 * as a BookingPartialError when it strikes mid-loop after staging succeeded.
 * Returns the created match ids (for Undo via undoMatches).
 */
export async function bookProposals(
  statementId: number,
  proposals: MatchProposalView[],
): Promise<number[]> {
  const res = await executeMatches(statementId, proposals);
  return approveStaged(res);
}

/** Stage + approve a single manual match. Returns the match id (for Undo). */
export async function bookManualMatch(
  statementId: number,
  m: {
    bankTransactionId: number;
    voucherId: number;
    amountMatched: number;
    matchType: 'exact' | 'partial';
  },
): Promise<number> {
  const res = await manualMatch(statementId, m);
  if (res.approvals.length === 0 || res.records.length === 0) {
    // Never return a match id that was not activated: a staged match with no
    // approval cannot be approved-on-the-spot and is not booked.
    throw new Error(
      'manual match staged but no approval returned — server contract breach',
    );
  }
  const [matchId] = await approveStaged(res);
  return matchId;
}

/**
 * Activate a match that is already staged as a draft (e.g. auto-staged by the
 * import workflow): find its pending approval and approve it.
 */
export async function confirmStagedMatch(matchId: number): Promise<void> {
  const pending = await getPendingApprovals();
  const approval = pending.find(
    (a) => a.object_type === 'reconciliation_match' && a.object_id === matchId,
  );
  if (!approval) {
    throw new Error(`No pending approval found for match ${matchId}`);
  }
  await approveApproval(approval.id, APPROVED_BY);
}

/** Undo booked matches — works for draft AND active (server reverses FX). */
export async function undoMatches(
  statementId: number,
  matchIds: number[],
): Promise<void> {
  for (const id of matchIds) {
    await unmatchMatch(statementId, id);
  }
}

export interface CreateFromLineInput {
  statementId: number;
  bankTransactionId: number;
  category: string;
  grossCents: number; // positive
  vatCents: number;
  currency: string;
  taxPointDate: string; // YYYY-MM-DD, from the line (a fact)
  supplierId: number | null;
}

export type CreateFromLineResult =
  | { outcome: 'matched'; expenseId: number; matchId: number }
  | { outcome: 'held'; expenseId: number; reason: string };

/**
 * The core inversion — "bank line → expense", composed client-side:
 * 1. createExpense (draft), 2. post via the pipeline (Rules → Policy),
 * 3. if held-for-approval: report honestly (a pending expense has no voucher
 *    and cannot be matched), 4. else find the fresh expense among the line's
 *    match candidates and stage+approve the match.
 * NOT undoable as a whole: the expense is POSTED (posted objects are
 * immutable; only the match part can be undone later via Unmatch).
 */
export async function createExpenseFromLine(
  input: CreateFromLineInput,
): Promise<CreateFromLineResult> {
  const expense = await createExpense({
    category: input.category,
    gross_amount: input.grossCents,
    vat_amount: input.vatCents,
    currency: input.currency,
    tax_point_date: input.taxPointDate,
    supplier_id: input.supplierId,
  });
  const posted = await postExpense(expense.id);
  if (posted.policy.action === 'hold-for-approval') {
    return {
      outcome: 'held',
      expenseId: expense.id,
      reason: posted.policy.reason,
    };
  }
  const res = await getMatchCandidates(
    input.statementId,
    input.bankTransactionId,
  );
  const candidate = res.candidates.find(
    (c) => c.objectType === 'expense' && c.objectId === expense.id,
  );
  if (!candidate) {
    throw new Error(
      'Expense was created and posted but did not appear among match candidates — match it manually.',
    );
  }
  const amount = Math.min(res.lineRemaining, candidate.voucherRemaining);
  const matchType =
    amount === candidate.voucherRemaining && amount === res.lineRemaining
      ? 'exact'
      : 'partial';
  const matchId = await bookManualMatch(input.statementId, {
    bankTransactionId: input.bankTransactionId,
    voucherId: candidate.voucherId,
    amountMatched: amount,
    matchType,
  });
  return { outcome: 'matched', expenseId: expense.id, matchId };
}
