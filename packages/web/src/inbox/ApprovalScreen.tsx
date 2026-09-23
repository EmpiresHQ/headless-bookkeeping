import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  approveApproval,
  fmtCents,
  rejectApproval,
  type Approval,
} from '../api';
import { ScreenHeader } from '../shell/Headers';
import { signedEuros } from '../lib/money';
import { errorMessage, usePendingOperation } from '../lib/pendingOperation';
import { useReceipt, type ResultLink } from '../lib/resultLog';
import {
  invalidateInbox,
  pendingApprovalFor,
  useExpenseDetail,
  useMatchFacts,
  usePendingApprovals,
} from '../queries/inbox';
import { HttpError } from '../auth';
import { useEntities, useInvoices } from '../queries/shared';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup, READABLE } from '../ui/List';
import { LinkButton } from '../ui/LinkButton';
import { LoadError, RefetchError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { DocPreviewRow } from './DocPreviewRow';
import { absoluteDate, absoluteDateFromIso, vatRatePct } from './format';
import { humanizePolicyReason } from './reason';
import {
  MatchApprovalFacts,
  matchHero,
  matchMeaning,
} from './MatchApprovalFacts';
import { checkMatchFacts, formatMoney } from './matchFacts';
import { approvalKind, rejectCopy } from './approvalSemantics';
import { useSheet } from '../lib/useSheet';
import { RejectSheet } from './RejectSheet';
import { useInboxCompletion } from './useInboxCompletion';
import { useEffect, useState } from 'react';

/** The decided object by its real name, and where it lives (#259). */
function decidedObject(
  approval: Approval,
  invoiceNumber: string | null,
  lineHref: string | null,
): { title: string; links: ResultLink[] } {
  const id = approval.object_id;
  switch (approval.object_type) {
    case 'expense':
      return {
        title: `Expense #${id}`,
        links: [{ label: `Expense #${id}`, to: `/books/expenses/${id}` }],
      };
    case 'sales_invoice': {
      const title =
        invoiceNumber !== null
          ? `Invoice ${invoiceNumber}`
          : `Sales invoice #${id}`;
      return { title, links: [{ label: title, to: `/books/invoices/${id}` }] };
    }
    case 'reconciliation_match':
      return {
        title: `Bank match #${id}`,
        // Without validated facts no line id is invented: Bank is the
        // context where a discarded or active match is found.
        links:
          lineHref !== null
            ? [{ label: 'Bank line', to: lineHref }]
            : [{ label: 'Bank statements', to: '/bank' }],
      };
    default:
      return {
        title: `${approval.object_type} #${id}`,
        links: [{ label: 'Inbox approvals', to: '/inbox?seg=approvals' }],
      };
  }
}

function WhyHeldBox({ reason }: { reason: string | null }) {
  return (
    <div className="mx-3.5 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5">
      <p className="text-[11px] font-bold uppercase tracking-wide text-warn">
        Why held
      </p>
      <p className="text-[12.5px] leading-snug text-warn">
        {humanizePolicyReason(reason)}
      </p>
    </div>
  );
}

function Hero({ amount, subtitle }: { amount: string; subtitle: string }) {
  return (
    <div className="px-5 pb-3 pt-1 text-center">
      <p className="whitespace-nowrap text-[28px] font-extrabold tabular-nums">
        {amount}
      </p>
      <p className={`text-[12.5px] text-ink-2 ${READABLE}`}>{subtitle}</p>
    </div>
  );
}

/** /inbox/approval/:id — the decision detail (asset §2): amount hero →
 *  "why held" with concrete numbers → document preview → facts KV →
 *  Approve/Reject action bar. Renders EVERY object_type safely. */
export function ApprovalScreen() {
  const { id } = useParams();
  const approvalId = Number(id);
  const route = `/inbox/approval/${approvalId}`;

  const { position, next, leave, context, backHref, source, advance } =
    useInboxCompletion(route);
  // Opened from a Books record (issue #262): the link was built from a list
  // that may be outdated by now (decided/withdrawn elsewhere) — this entry
  // re-checks, even over a fresh cached list that still holds it.
  const approvalsQ = usePendingApprovals(
    source !== null ? { refetchOnMount: 'always', staleTime: 0 } : {},
  );
  const approval = approvalsQ.data?.find((a) => a.id === approvalId);
  // Absence is claimed only from a list fetched since this screen mounted:
  // a cached list without this id is re-checked once first.
  const absentUnchecked =
    approvalsQ.data !== undefined &&
    approval === undefined &&
    !approvalsQ.isFetchedAfterMount;
  // A Books-origin entry is neither shown as pending nor decidable until
  // its own re-check has settled; a failed re-check keeps Approve off.
  const sourceUnchecked =
    source !== null &&
    approvalsQ.data !== undefined &&
    !approvalsQ.isFetchedAfterMount;
  const sourceUnverified =
    source !== null && (sourceUnchecked || approvalsQ.isError);
  const refetchApprovals = approvalsQ.refetch;
  const recheckRunning = approvalsQ.isFetching;
  useEffect(() => {
    if (absentUnchecked && !recheckRunning)
      void refetchApprovals({ cancelRefetch: false });
  }, [absentUnchecked, recheckRunning, refetchApprovals]);

  const expenseQ = useExpenseDetail(
    approval?.object_type === 'expense' ? approval.object_id : null,
  );
  // A bank-match approval carries only the match id (issue #256): the exact
  // line/object pair comes from its own read, validated before use.
  const matchQ = useMatchFacts(
    approval?.object_type === 'reconciliation_match'
      ? approval.object_id
      : null,
  );
  const matchCheck =
    approval !== undefined && matchQ.data !== undefined
      ? checkMatchFacts(matchQ.data, approval)
      : null;
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const entities = entitiesQ.data ?? [];

  const heroAmount: string | null =
    approval?.object_type === 'expense' && expenseQ.data !== undefined
      ? signedEuros(-expenseQ.data.gross_amount)
      : approval?.object_type === 'sales_invoice'
        ? (() => {
            const inv = invoicesQ.data?.find(
              (x) => x.id === approval.object_id,
            );
            return inv !== undefined ? signedEuros(inv.gross_amount) : null;
          })()
        : null;

  // Approve must never post blind: for expense/invoice the amount comes from
  // a sub-fetch (single expense / joined invoice list) that can be pending,
  // errored, OR settled-without-a-match — all three leave heroAmount null,
  // so `undefined`/"not found" IS "unresolved" here (unlike the body render
  // below, which must tell those three states apart to avoid a dead-end
  // skeleton). A bank match needs its VALIDATED exact pair, and a failed
  // re-check blocks it even over cached facts until a re-check succeeds
  // (the pair may have been unmatched/re-staged meanwhile). Other types
  // (allowance, future) load no sub-facts and keep the previous behavior.
  const factsUnresolved =
    sourceUnverified ||
    (approval?.object_type === 'expense'
      ? expenseQ.data === undefined
      : approval?.object_type === 'sales_invoice'
        ? invoicesQ.data?.find((x) => x.id === approval.object_id) === undefined
        : approval?.object_type === 'reconciliation_match'
          ? matchCheck?.ok !== true || matchQ.isError
          : false);

  // What deciding does depends on the type (#290); a type this client cannot
  // describe is never decided here — no action may claim posting or drafting
  // it does not know happens.
  const kind =
    approval !== undefined ? approvalKind(approval.object_type) : null;
  const undecidable = kind?.kind === 'unknown';
  // Validated AND current match facts — cached ones from before a failed
  // re-check are never described as freshly verified.
  const matchFresh = matchCheck?.ok === true && !matchQ.isError;

  const qc = useQueryClient();
  const rejectSheet = useSheet();

  const op = usePendingOperation('Approval');
  // One receipt per approval: a retry, or rejecting after a failed
  // approve, supersedes the earlier outcome (#259).
  const writeReceipt = useReceipt();
  const failed = (
    verb: 'Approve' | 'Reject',
    object: ReturnType<typeof decided>,
    e: unknown,
  ) => {
    toastErr(errorMessage(e));
    if (object === null) return;
    writeReceipt(`approval:${approvalId}`, {
      action: verb,
      title: object.title,
      outcome: `${verb === 'Approve' ? 'Approving' : 'Rejecting'} was not confirmed (${errorMessage(e)}). Open the approval or the item for its current state before deciding again.`,
      tone: 'error',
      links: [
        { label: 'Approval', to: `/inbox/approval/${approvalId}` },
        ...object.links,
      ].slice(0, 3),
    });
  };
  const decided = () => {
    if (approval === undefined) return null;
    const bt =
      matchCheck?.ok === true ? matchCheck.facts.bankTransaction : undefined;
    return decidedObject(
      approval,
      approval.object_type === 'sales_invoice'
        ? (invoicesQ.data?.find((x) => x.id === approval.object_id)
            ?.invoice_number ?? null)
        : null,
      bt !== undefined
        ? `/bank/statements/${bt.statementId}/tx/${bt.id}`
        : null,
    );
  };
  const [running, setRunning] = useState<'approve' | 'reject'>('approve');
  const approving = op.pending && running === 'approve';
  const rejecting = op.pending && running === 'reject';

  // The queue is refetched AFTER leaving (the refetch drops this entry and
  // would otherwise flash "not found" here); the leave itself is the
  // operation's synchronous continuation.
  const approve = () => {
    // The button's gate, enforced again here: a stale or synthetic click must
    // never decide on facts that are not (or no longer) established.
    if (factsUnresolved || undecidable) return;
    const to = next;
    const matchFacts = matchCheck?.ok === true ? matchCheck.facts : null;
    const receipt =
      matchFacts !== null
        ? matchFacts.status === 'active'
          ? 'Approval closed — the match was already active'
          : matchFacts.target.kind === 'prepayment'
            ? `Match confirmed · applied to the advance · ${formatMoney(matchFacts.amountMatched, matchFacts.baseCurrency)}`
            : `Match confirmed · settlement booked · ${formatMoney(matchFacts.amountMatched, matchFacts.baseCurrency)}`
        : heroAmount !== null
          ? `Approved & posted · ${heroAmount}`
          : 'Approved & posted';
    const object = decided();
    let accepted = false;
    const started = op.run(
      async (ctx) => {
        await approveApproval(approvalId, 'operator');
        accepted = true;
        // Recorded as soon as the decision is accepted (#259) — only a
        // SUCCESSFUL approve is ever recorded as posted/matched.
        if (object !== null)
          writeReceipt(
            `approval:${approvalId}`,
            {
              action: 'Approve',
              title: object.title,
              outcome: receipt,
              tone: 'ok',
              links: object.links,
            },
            ctx.live,
          );
      },
      {
        onSuccess: () => {
          // NO Undo: approve posts in the same transaction (Reality #1) — the
          // object's voucher, or a bank match's settlement (an already-active
          // match only closes the request). Recovery is the correction flow,
          // or Unmatch in Bank for a match.
          toastOk(receipt);
          leave(to);
          void invalidateInbox(qc);
        },
        onError: (e) => {
          if (accepted) toastErr(errorMessage(e));
          else failed('Approve', object, e);
        },
      },
    );
    if (started) setRunning('approve');
  };

  // Reject is never gated on facts: it posts nothing for any type, so
  // blocking it adds no safety and would strand the held item. For a bank
  // match the server succeeds ONLY by deleting the draft link
  // (discardDraftMatch; an active or missing match is refused 409/404 and the
  // approval stays pending), so the receipt below is true whenever it shows.
  const reject = (reason: string, release: () => void) => {
    if (undecidable) return;
    const to = next;
    const receipt =
      approval?.object_type === 'reconciliation_match'
        ? 'Rejected — the staged match was discarded'
        : 'Rejected — returned to draft';
    const object = decided();
    let accepted = false;
    const started = op.run(
      async (ctx) => {
        await rejectApproval(approvalId, reason);
        accepted = true;
        if (object !== null)
          writeReceipt(
            `approval:${approvalId}`,
            {
              action: 'Reject',
              title: object.title,
              outcome: `${receipt} — nothing was posted. Reason: ${reason}`,
              tone: 'ok',
              links: object.links,
            },
            ctx.live,
          );
      },
      {
        onSuccess: () => {
          // `release` must run before leave(to).
          release();
          rejectSheet.close();
          toastOk(receipt);
          leave(to);
          void invalidateInbox(qc);
        },
        onError: (e) => {
          if (accepted) toastErr(errorMessage(e));
          else failed('Reject', object, e);
        },
      },
    );
    if (started) setRunning('reject');
  };

  const title =
    position !== null ? `${position.pos} of ${position.total}` : 'Approval';

  if (approvalsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo={backHref} />
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (approvalsQ.isError && approvalsQ.data === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo={backHref} />
        <LoadError
          message={
            approvalsQ.error instanceof Error
              ? approvalsQ.error.message
              : 'Failed to load the approval'
          }
          onRetry={() => void approvalsQ.refetch()}
        />
      </div>
    );
  }
  if (sourceUnchecked || absentUnchecked) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo={backHref} />
        <p role="status" className="mx-6 mb-3.5 text-[12.5px] text-ink-2">
          Checking this approval…
        </p>
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (approval === undefined) {
    // A Books-record origin (#262) gets its record back — with its own
    // history state — never the global queue.
    const toSource = source !== null && (
      <Button
        variant={approvalsQ.isError ? 'secondary' : 'primary'}
        onClick={() => leave('/inbox')}
      >
        Return to {source.label}
      </Button>
    );
    if (approvalsQ.isError) {
      return (
        <div className="mx-auto max-w-3xl pb-6">
          <ScreenHeader title="Approval" backTo={backHref} />
          <LoadError
            message={`Couldn't check whether approval #${approvalId} is still pending — ${
              approvalsQ.error instanceof Error
                ? approvalsQ.error.message
                : 'request failed'
            }`}
            onRetry={() => void approvalsQ.refetch()}
          />
          {toSource !== false && <div className="mx-3.5">{toSource}</div>}
        </div>
      );
    }
    // Only a CURRENT pending approval of exactly the origin's typed pair —
    // never the raw `superseded_by` pointer, which the server does not tie
    // to the same object.
    const current =
      source !== null
        ? pendingApprovalFor(
            { object_type: source.objectType, object_id: source.objectId },
            approvalsQ.data,
          )
        : null;
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo={backHref} />
        <EmptyState
          icon="✓"
          title="No pending approval"
          hint={
            source === null
              ? `Approval #${approvalId} is not in the pending list — it may have been decided or withdrawn.`
              : current !== null
                ? `Approval #${approvalId} is not pending now. ${source.label} is waiting for approval #${current.id}.`
                : `Approval #${approvalId} is not pending now — it may have been decided or withdrawn. Open ${source.label} for its current status.`
          }
          action={
            source === null ? (
              <LinkButton to={backHref}>Back to Inbox</LinkButton>
            ) : (
              <div className="flex flex-col gap-2">
                {current !== null && (
                  <Button
                    onClick={() => advance(`/inbox/approval/${current.id}`)}
                  >
                    Open approval #{current.id}
                  </Button>
                )}
                {toSource}
              </div>
            )
          }
        />
      </div>
    );
  }

  let body: JSX.Element;
  if (approval.object_type === 'expense') {
    const e = expenseQ.data;
    const supplier =
      e?.supplier_id != null
        ? entities.find((en) => en.id === e.supplier_id)
        : undefined;
    body = expenseQ.isError ? (
      <LoadError
        message={
          expenseQ.error instanceof Error
            ? expenseQ.error.message
            : 'Failed to load the expense'
        }
        onRetry={() => void expenseQ.refetch()}
      />
    ) : e === undefined ? (
      <SkeletonRows count={2} />
    ) : (
      <>
        <Hero
          amount={heroAmount ?? ''}
          subtitle={`${supplier?.name ?? 'Unknown supplier'} · ${e.category}`}
        />
        <WhyHeldBox reason={approval.policy_reason} />
        {e.document_id !== null && <DocPreviewRow documentId={e.document_id} />}
        <ListGroup label="Facts">
          <KeyValue
            k="VAT"
            v={
              vatRatePct(e.gross_amount, e.vat_amount) !== null
                ? `${fmtCents(e.vat_amount)} € (${vatRatePct(e.gross_amount, e.vat_amount)}%)`
                : `${fmtCents(e.vat_amount)} €`
            }
          />
          <KeyValue k="Tax point" v={absoluteDateFromIso(e.tax_point_date)} />
          {e.ai_confidence !== null && (
            <KeyValue
              k="AI confidence"
              v={
                <span
                  className={e.ai_confidence >= 0.9 ? 'text-ok' : 'text-warn'}
                >
                  {e.ai_confidence.toFixed(2)}
                </span>
              }
            />
          )}
          <KeyValue k="Supplier" v={supplier?.name ?? '—'} />
          {e.supplier_invoice_number !== null && (
            <KeyValue k="Invoice number" v={e.supplier_invoice_number} />
          )}
        </ListGroup>
      </>
    );
  } else if (approval.object_type === 'sales_invoice') {
    const inv = invoicesQ.data?.find((x) => x.id === approval.object_id);
    const customer =
      inv?.customer_id != null
        ? entities.find((en) => en.id === inv.customer_id)
        : undefined;
    body = invoicesQ.isError ? (
      <LoadError
        message={
          invoicesQ.error instanceof Error
            ? invoicesQ.error.message
            : 'Failed to load invoices'
        }
        onRetry={() => void invoicesQ.refetch()}
      />
    ) : inv !== undefined ? (
      <>
        <Hero
          amount={heroAmount ?? ''}
          subtitle={`${customer?.name ?? 'No customer'} · ${inv.invoice_number}`}
        />
        <WhyHeldBox reason={approval.policy_reason} />
        <ListGroup label="Facts">
          <KeyValue k="VAT" v={`${fmtCents(inv.vat_amount)} €`} />
          <KeyValue k="Tax point" v={absoluteDateFromIso(inv.tax_point_date)} />
          <KeyValue k="Invoice number" v={inv.invoice_number} />
        </ListGroup>
      </>
    ) : invoicesQ.isPending ? (
      <SkeletonRows count={2} />
    ) : (
      <EmptyState
        icon="⚠"
        title="Facts unavailable"
        hint="The invoice could not be loaded"
      />
    );
  } else if (approval.object_type === 'reconciliation_match') {
    const shown = matchCheck?.facts ?? null;
    const gone =
      matchQ.error instanceof HttpError && matchQ.error.status === 404;
    body =
      shown !== null ? (
        <>
          <Hero {...matchHero(shown)} />
          {matchQ.isError && (
            // Cached facts stay readable, but they are no longer confirmed:
            // Approve stays off until a re-check succeeds.
            <LoadError
              message={
                gone
                  ? 'This match no longer exists — it was discarded or unmatched. The facts below are from before.'
                  : `Could not re-check this match — ${
                      matchQ.error instanceof Error
                        ? matchQ.error.message
                        : 'unknown error'
                    }. Approve is off until it re-loads; the facts below may be out of date.`
              }
              onRetry={() => void matchQ.refetch()}
            />
          )}
          {matchCheck?.ok === false && (
            <div className="mx-3.5 mb-3 rounded-[13px] bg-err-bg px-3.5 py-2.5">
              <p className="text-[12.5px] font-semibold leading-snug text-err">
                {matchCheck.reason}
              </p>
            </div>
          )}
          <WhyHeldBox reason={approval.policy_reason} />
          <MatchApprovalFacts facts={shown} />
          {matchCheck?.ok === true && (
            <p className="mx-6 mb-3 text-[12px] leading-snug text-ink-2">
              {matchMeaning(shown)}
            </p>
          )}
        </>
      ) : matchQ.isError ? (
        gone ? (
          <EmptyState
            icon="⚠"
            title="Match no longer exists"
            hint="It was discarded or unmatched in Bank, so there is nothing to approve."
          />
        ) : (
          <LoadError
            message={
              matchQ.error instanceof Error
                ? matchQ.error.message
                : 'Failed to load the bank match'
            }
            onRetry={() => void matchQ.refetch()}
          />
        )
      ) : matchCheck?.ok === false ? (
        <LoadError
          message={`Facts unavailable — ${matchCheck.reason}`}
          onRetry={() => void matchQ.refetch()}
        />
      ) : (
        <SkeletonRows count={3} />
      );
  } else {
    // allowance / future types: generic, safe.
    const label =
      approval.object_type === 'allowance' ? 'Allowance' : approval.object_type;
    body = (
      <>
        <div className="px-5 pb-3 pt-1 text-center">
          <p className="text-[22px] font-extrabold">{label}</p>
          <Chip tone="muted">{approval.object_type}</Chip>
        </div>
        {undecidable && (
          <p className="mx-6 mb-3 text-[12.5px] leading-snug text-ink-2">
            This app does not recognise “{approval.object_type}” approvals, so
            it cannot say what approving or rejecting one would do, and offers
            neither. Nothing has been decided and it stays pending — ask your
            bookkeeper or system operator to review it.
          </p>
        )}
        <WhyHeldBox reason={approval.policy_reason} />
        <ListGroup label="Facts">
          <KeyValue k="Requested by" v={approval.requested_by} />
          <KeyValue k="Waiting since" v={absoluteDate(approval.created_at)} />
        </ListGroup>
      </>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo={backHref} />
      <p className="-mt-1 px-5 pb-1 text-center text-[11.5px] text-ink-2">
        {context}
      </p>
      <RefetchError query={approvalsQ} />
      {sourceUnverified && (
        <p className="mx-6 mb-3 text-[12px] leading-snug text-ink-2">
          Approve is off until this approval re-checks as still pending.
        </p>
      )}
      {body}
      <div className="mx-3.5 mt-2 flex gap-2.5">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={op.pending || undecidable}
          onClick={() => rejectSheet.open()}
        >
          {kind?.kind === 'match' ? 'Reject match…' : 'Reject…'}
        </Button>
        <Button
          className="flex-1"
          busy={approving}
          disabled={rejecting || factsUnresolved || undecidable}
          onClick={approve}
        >
          {kind?.kind === 'match'
            ? matchFresh && matchCheck?.facts?.status === 'active'
              ? 'Close approval'
              : 'Approve match'
            : heroAmount !== null
              ? `Approve · ${heroAmount}`
              : 'Approve'}
        </Button>
      </div>
      <p className="px-6 pt-2 text-center text-[10.5px] text-ink-2">
        {kind?.kind === 'unknown'
          ? 'Approve and Reject are off for this unrecognised type — nothing has been decided'
          : kind?.kind === 'draft-object'
            ? 'Approve posts to the books immediately — recover via a correction'
            : matchCheck?.facts?.status === 'active'
              ? 'Approve only closes this request · Reject is refused for an active match — reverse it with Unmatch in Bank'
              : 'Approve settles the match immediately — undo via Unmatch in Bank'}
      </p>
      {rejectSheet.epoch > 0 && kind !== null && kind.kind !== 'unknown' && (
        <RejectSheet
          copy={rejectCopy(kind, matchCheck?.facts?.status ?? null, matchFresh)}
          // Remount per approval AND per open: auto-advance re-renders this
          // same element for the NEXT item, and a carried-over reason would
          // land a stale justification in the next item's audit trail.
          key={`${approvalId}-${rejectSheet.epoch}`}
          open={rejectSheet.isOpen}
          onOpenChange={(o) => !o && rejectSheet.close()}
          busy={rejecting}
          onSubmit={reject}
        />
      )}
    </div>
  );
}
