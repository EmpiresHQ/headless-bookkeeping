import type { PolicyDecisionView } from '../api';
import { humanizePolicyReason } from '../inbox/reason';
import { errorMessage, type PendingOperation } from '../lib/pendingOperation';
import { useReceipt, type ResultLink } from '../lib/resultLog';
import { toastErr, toastOk } from '../ui/toast';

export interface PostingCopy {
  /** Supersedes the previous outcome of this same action on this object. */
  key: string;
  /** The object by its real name/id, e.g. "Expense #12". */
  title: string;
  /** Where to continue, e.g. the object's own detail route. */
  links: ResultLink[];
  /** The object's own amount, formatted for its currency ("−650.00 €"). */
  amount: string;
}

export interface PostingRequest {
  /** The POST that submits the object for posting. */
  request: () => Promise<{ policy: PolicyDecisionView }>;
  /** Persist-before-refresh: the confirmed result is recorded first. */
  refresh: () => Promise<void>;
  copy: PostingCopy;
}

/**
 * The posting protocol shared by ExpenseScreen and InvoiceScreen (ADR-0040):
 * run the POST through the screen's pending operation, classify the accepted
 * response (posted vs held for approval), record the receipt BEFORE the books
 * refresh, refresh, then notify. A refresh failure is reported but never
 * replaces the already-recorded outcome; a POST that was not accepted is
 * recorded as an unconfirmed attempt. The screens supply the object's name,
 * link and amount and render the operation's state — not the lifecycle order
 * or the hold-for-approval decision, which live here once.
 */
export function usePosting(op: PendingOperation) {
  const receipt = useReceipt();
  return {
    submit: ({ request, refresh, copy }: PostingRequest) => {
      let accepted = false;
      op.run(
        async (ctx) => {
          const res = await request();
          accepted = true;
          ctx.check();
          const held = res.policy.action === 'hold-for-approval';
          const reason = humanizePolicyReason(res.policy.reason);
          // Recorded before the cache refresh: the post is accepted (#259).
          receipt(
            copy.key,
            {
              action: 'Submit for posting',
              title: copy.title,
              outcome: held
                ? `Held for approval — ${reason}. Not posted until approved.`
                : `Posted · ${copy.amount}`,
              tone: held ? 'pending' : 'ok',
              links: copy.links,
            },
            ctx.live,
          );
          await refresh();
          return res;
        },
        {
          onSuccess: (res) => {
            const reason = humanizePolicyReason(res.policy.reason);
            toastOk(
              res.policy.action === 'hold-for-approval'
                ? `Held for approval — ${reason}`
                : `Posted · ${copy.amount}`,
            );
          },
          onError: (e) => {
            // The request's own failure is unconfirmed; a failed refresh
            // after an accepted post keeps its recorded outcome.
            toastErr(errorMessage(e));
            if (accepted) return;
            receipt(copy.key, {
              action: 'Submit for posting',
              title: copy.title,
              outcome: `Submitting for posting was not confirmed (${errorMessage(e)}). Open it for its current state before trying again.`,
              tone: 'error',
              links: copy.links,
            });
          },
        },
      );
    },
  };
}
