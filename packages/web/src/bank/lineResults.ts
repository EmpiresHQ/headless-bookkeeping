import { errorMessage } from '../lib/pendingOperation';
import type { ResultInit, ResultLink } from '../lib/resultLog';
import type { CreateFromLineResult, FromLineProgress } from '../queries/bank';

/**
 * Durable receipts of bank-line operations (issue #259). A line's record
 * carries its `subject`, so the line screen can show it again after a
 * reload — when the in-memory progress (and its "Finish" button) is gone
 * and a fresh create form would otherwise invite a second expense.
 */
export const lineSubject = (statementId: number, txId: number) =>
  `bank-line:${statementId}:${txId}`;

export const lineHref = (statementId: number, txId: number) =>
  `/bank/statements/${statementId}/tx/${txId}`;

export function lineLinks(statementId: number, txId: number): ResultLink[] {
  return [
    { label: 'Bank line', to: lineHref(statementId, txId) },
    { label: 'Statement', to: `/bank/statements/${statementId}` },
  ];
}

/**
 * The record of a "create expense from the line" chain (create & match, or
 * bank fee) at its latest accepted stage — or at its final result / error.
 * Null while nothing was accepted and nothing failed.
 */
export function fromLineRecord(args: {
  action: string;
  lineTitle: string;
  statementId: number;
  txId: number;
  amount: string;
  progress: FromLineProgress;
  result?: CreateFromLineResult;
  error?: unknown;
  /** The match is staged; its approval has not answered yet. */
  matchStaged?: boolean;
}): ResultInit | null {
  const { progress: p, result, error } = args;
  const expenseId = result?.expenseId ?? p.expenseId;
  if (expenseId === null) {
    // No expense id came back: whether one was created is unknown here.
    return error === undefined
      ? null
      : {
          action: args.action,
          title: `${args.lineTitle} · ${args.amount}`,
          subject: lineSubject(args.statementId, args.txId),
          links: [
            { label: 'Books expenses', to: '/books?seg=expenses' },
            ...lineLinks(args.statementId, args.txId),
          ],
          // A draft would not show among the line's match candidates.
          outcome: `Creating the expense was not confirmed — no expense ID was received (${errorMessage(error)}). It may exist as a draft: check the expenses in Books (drafts are not offered as match candidates) and the line's current state before creating another.`,
          tone: 'error',
        };
  }
  const exp = `Expense #${expenseId}`;
  const base = {
    action: args.action,
    title: `${args.lineTitle} · ${args.amount}`,
    subject: lineSubject(args.statementId, args.txId),
    links: [
      { label: exp, to: `/books/expenses/${expenseId}` },
      ...lineLinks(args.statementId, args.txId),
    ],
  };
  if (result?.outcome === 'matched') {
    return {
      ...base,
      outcome: `${exp} created, posted and matched to this line.`,
      tone: 'ok',
    };
  }
  if (result?.outcome === 'held' || p.posted?.held === true) {
    const reason =
      result?.outcome === 'held'
        ? result.reason
        : p.posted?.held === true
          ? p.posted.reason
          : '';
    return {
      ...base,
      links: [
        ...base.links,
        { label: 'Inbox approvals', to: '/inbox?seg=approvals' },
      ],
      outcome: `${exp} created and held for approval: ${reason}. The line is NOT matched — match it to ${exp} after approval; do not create another expense.`,
      tone: 'pending',
    };
  }
  const why = error !== undefined ? ` (${errorMessage(error)})` : '';
  if (p.stagedMatchIds !== null) {
    return {
      ...base,
      outcome: `${exp} is posted and its match to this line was staged; the match's approval was not confirmed${why}. Open the line — confirm the staged match there if it is still staged.`,
      tone: 'partial',
    };
  }
  if (p.posted !== null && args.matchStaged === true && error === undefined) {
    return {
      ...base,
      outcome: `${exp} is posted and its match to this line is staged — the approval's outcome is not known yet.`,
      tone: 'running',
    };
  }
  if (p.posted !== null) {
    return {
      ...base,
      outcome:
        error === undefined
          ? `${exp} created and posted — matching the line…`
          : `Posting of ${exp} was confirmed; matching the line was not confirmed${why}. Open the line for its current state — if it is still unmatched, match it to ${exp} from its candidates; do not create another expense.`,
      tone: error === undefined ? 'running' : 'partial',
    };
  }
  return {
    ...base,
    outcome:
      error === undefined
        ? `${exp} created as a draft — posting…`
        : `Draft ${exp} was created; posting it was not confirmed${why}. Finish it on the line while that screen is open, or open ${exp} for its current state — do not create another expense.`,
    tone: error === undefined ? 'running' : 'partial',
  };
}

/** An Undo of booked matches that did not finish (#259): what was
 *  observed removed, never more — the rest is "not confirmed". */
export function undoIncomplete(
  removed: number,
  total: number,
  error: unknown,
): string {
  return removed > 0
    ? `Undo did not complete: ${removed} of ${total} matches removed; removing the rest was not confirmed (${errorMessage(error)}). Open the statement for its current state.`
    : `Undo was not confirmed (${errorMessage(error)}) — the ${total === 1 ? 'match may still be' : 'matches may still be'} booked. Open the statement for its current state.`;
}
