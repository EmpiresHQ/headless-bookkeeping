import type {
  BankTransaction,
  MatchCandidatesResult,
  MatchRowView,
} from '../api';

/**
 * The tx-screen state machine (asset: 2026-07-09-tx-screen-states.html).
 * First match wins; alternatives stay reachable via the "Or" sheet.
 * Degradations vs the asset's 8-context matrix (documented in the appendix):
 * state D (recurring) is omitted (no detection API); A and B merge into one
 * `create` state (no alias-lookup API — the supplier picker covers both);
 * the fee heuristic has no server signal (fee lives in the "Or" sheet).
 */
export type TxState =
  | { kind: 'loading' }
  | { kind: 'disposed'; status: string }
  | { kind: 'matched'; active: MatchRowView[]; staged: MatchRowView[] }
  | { kind: 'candidates'; result: MatchCandidatesResult }
  | { kind: 'incoming-open' }
  | { kind: 'create' };

export function routeTxState(args: {
  tx: BankTransaction | undefined;
  matches: MatchRowView[] | undefined;
  candidates: MatchCandidatesResult | undefined;
}): TxState {
  const { tx, matches, candidates } = args;
  if (!tx || matches === undefined) return { kind: 'loading' };
  if (tx.status !== 'open') return { kind: 'disposed', status: tx.status };
  const mine = matches.filter((m) => m.bankTransactionId === tx.id);
  if (mine.length > 0) {
    return {
      kind: 'matched',
      active: mine.filter((m) => m.status === 'active'),
      staged: mine.filter((m) => m.status === 'draft'),
    };
  }
  if (candidates === undefined) return { kind: 'loading' };
  if (candidates.candidates.length > 0)
    return { kind: 'candidates', result: candidates };
  if (tx.amount > 0) return { kind: 'incoming-open' };
  return { kind: 'create' };
}
