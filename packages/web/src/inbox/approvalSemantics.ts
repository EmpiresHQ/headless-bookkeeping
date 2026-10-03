import type { Approval, MatchFacts } from '../api';

/** What deciding an approval really does, by object type (issue #290),
 *  mirroring ApprovalsService.approveApproval / rejectApproval:
 *  - `draft-object` (expense, sales_invoice, allowance): Approve posts the
 *    object's voucher; Reject returns the object to draft.
 *  - `match` (reconciliation_match): Approve activates the link (and books
 *    its settlement / realized FX); Reject deletes a DRAFT link only — an
 *    active or missing match is refused and the approval stays pending.
 *  - `unknown`: a type this client cannot describe — nothing is claimed and
 *    neither decision is offered. */
export type ApprovalKind =
  | { kind: 'draft-object'; noun: string }
  | { kind: 'match' }
  | { kind: 'unknown' };

export function approvalKind(
  objectType: Approval['object_type'],
): ApprovalKind {
  switch (objectType) {
    case 'expense':
      return { kind: 'draft-object', noun: 'expense' };
    case 'sales_invoice':
      return { kind: 'draft-object', noun: 'invoice' };
    case 'allowance':
      return { kind: 'draft-object', noun: 'allowance' };
    case 'reconciliation_match':
      return { kind: 'match' };
    default:
      return { kind: 'unknown' };
  }
}

export interface RejectCopy {
  title: string;
  intro: string;
  placeholder: string;
  action: string;
}

/** The Reject confirmation for a decidable type. The reason is stored on the
 *  approval (`rejected_reason`), never on the object itself. `matchStatus` is
 *  what the match facts last showed; `matchFresh` says whether those facts
 *  are validated and current, or only cached from before a failed re-check. */
export function rejectCopy(
  k: Exclude<ApprovalKind, { kind: 'unknown' }>,
  matchStatus: MatchFacts['status'] | null,
  matchFresh: boolean,
): RejectCopy {
  if (k.kind === 'draft-object')
    return {
      title: `Reject ${k.noun}`,
      intro:
        `The ${k.noun} goes back to draft, where it can be corrected and ` +
        'resubmitted. Nothing is posted and nothing is deleted. Your reason ' +
        'is saved with this rejected approval.',
      placeholder: 'Why this should not be posted…',
      action: 'Reject & return to draft',
    };
  const refused =
    'the rejection is refused and the approval stays pending. Reverse an ' +
    'active match with Unmatch in Bank.';
  return {
    title: 'Reject bank match',
    intro:
      matchStatus === 'active'
        ? matchFresh
          ? `This match is already active, so it cannot be discarded here: ${refused}`
          : 'When last loaded, this match was already active. If it still ' +
            `is, ${refused}`
        : 'Rejecting discards this proposed match: the proposed link is ' +
          'deleted, nothing is posted, and the bank line can be matched ' +
          'again in Bank. No expense, invoice or advance changes. Your ' +
          'reason is saved with this rejected approval. If the match was ' +
          `confirmed in Bank meanwhile, ${refused}`,
    placeholder: 'Why this match is wrong…',
    action: 'Reject & discard match',
  };
}
