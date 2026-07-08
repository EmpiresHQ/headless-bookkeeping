import { useQueries, useQuery, type QueryClient } from '@tanstack/react-query';
import {
  approveApproval,
  createExpense,
  executeMatches,
  getBankImportStatus,
  getCategories,
  getEntities,
  getMatchCandidates,
  getOrganization,
  getPendingApprovals,
  getReconciliationStatus,
  getStatementMatches,
  listBankStatements,
  listBankTransactions,
  manualMatch,
  postExpense,
  proposeMatches,
  unmatchMatch,
  type MatchProposalView,
} from '../api';

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

/** Import-job polling — the ONLY refetchInterval in the Bank section. */
export function useImportJob(jobId: number | null) {
  return useQuery({
    queryKey: bankKeys.importJob(jobId ?? -1),
    queryFn: () => getBankImportStatus(jobId as number),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.status === 'running'
        ? 1500
        : false,
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

export const useCategories = () =>
  useQuery({ queryKey: ['categories'], queryFn: getCategories });

export const useSuppliers = () =>
  useQuery({
    queryKey: ['entities'],
    queryFn: getEntities,
    select: (entities) => entities.filter((e) => e.role === 'supplier'),
  });

export const useOrganizationCountry = () =>
  useQuery({
    queryKey: ['organization'],
    queryFn: getOrganization,
    select: (org) => org.country,
  });

export function invalidateStatement(
  qc: QueryClient,
  statementId: number,
): Promise<void> {
  return qc.invalidateQueries({ queryKey: bankKeys.statement(statementId) });
}

// ── Composite flows ────────────────────────────────────────────────────────

const APPROVED_BY = 'operator';

/**
 * Book selected AI proposals: stage drafts (server creates one pending
 * approval per match), then approve each — the operator IS the approver.
 * The over-allocation cap is enforced server-side AT ACTIVATION; a 409 here
 * propagates to the caller with the server's message (no client cap math).
 * Returns the created match ids (for Undo via undoMatches).
 */
export async function bookProposals(
  statementId: number,
  proposals: MatchProposalView[],
): Promise<number[]> {
  const res = await executeMatches(statementId, proposals);
  for (const a of res.approvals) {
    await approveApproval(a.id, APPROVED_BY);
  }
  return res.approvals.map((a) => a.matchId);
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
  for (const a of res.approvals) {
    await approveApproval(a.id, APPROVED_BY);
  }
  return res.approvals[0]?.matchId ?? res.records[0].id;
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
