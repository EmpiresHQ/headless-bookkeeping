import type {
  BankTransaction,
  MatchProposalView,
  MatchRowView,
  ReconciliationStatusRow,
} from '../api';

/** Everything the statement screen knows about one bank line, joined. */
export interface LineView {
  tx: BankTransaction;
  recon: ReconciliationStatusRow | undefined;
  active: MatchRowView[];
  staged: MatchRowView[];
  proposals: MatchProposalView[];
}

/** Internal selection key for a proposal — voucherId is NEVER displayed. */
export const proposalKey = (p: MatchProposalView): string =>
  `${p.bankTransactionId}:${p.voucherId}`;

export function buildLines(
  txns: BankTransaction[],
  recon: ReconciliationStatusRow[],
  matches: MatchRowView[],
  proposals: MatchProposalView[],
): LineView[] {
  const reconByTx = new Map(recon.map((r) => [r.bankTransactionId, r]));
  return txns.map((tx) => ({
    tx,
    recon: reconByTx.get(tx.id),
    active: matches.filter(
      (m) => m.bankTransactionId === tx.id && m.status === 'active',
    ),
    staged: matches.filter(
      (m) => m.bankTransactionId === tx.id && m.status === 'draft',
    ),
    proposals: proposals.filter((p) => p.bankTransactionId === tx.id),
  }));
}

/**
 * Statement-screen tiers (from the §6 mockup): AI proposals (incl. drafts the
 * import auto-staged) / decide yourself / done (matched or disposed).
 * A partially matched line stays in "decide" — its remainder is visible work.
 */
export type LineBucket = 'proposals' | 'decide' | 'done';

export function bucketOf(line: LineView): LineBucket {
  if (line.tx.status !== 'open') return 'done';
  if (line.recon?.reconStatus === 'matched') return 'done';
  if (line.proposals.length > 0 || line.staged.length > 0) return 'proposals';
  return 'decide';
}
