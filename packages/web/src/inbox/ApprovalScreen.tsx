import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { approveApproval, rejectApproval } from '../api';
import { ScreenHeader } from '../shell/Headers';
import {
  invalidateInbox,
  nextRouteAfter,
  queuePosition,
  useExpenseDetail,
  useInboxQueue,
  usePendingApprovals,
} from '../queries/inbox';
import { useEntities, useInvoices } from '../queries/shared';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup } from '../ui/List';
import { LinkButton } from '../ui/LinkButton';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { DocPreviewRow } from './DocPreviewRow';
import {
  absoluteDate,
  absoluteDateFromIso,
  signedEuros,
  vatRatePct,
} from './format';
import { humanizePolicyReason } from './reason';
import { RejectSheet } from './RejectSheet';

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
      <p className="truncate text-[12.5px] text-ink-2">{subtitle}</p>
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

  const approvalsQ = usePendingApprovals();
  const approval = approvalsQ.data?.find((a) => a.id === approvalId);
  const { entries } = useInboxQueue('all');
  const position = queuePosition(entries, route);

  const expenseQ = useExpenseDetail(
    approval?.object_type === 'expense' ? approval.object_id : null,
  );
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
  // skeleton). generic/reconciliation_match types never load sub-facts, so
  // they keep the previous (always-enabled) behavior.
  const factsUnresolved =
    approval?.object_type === 'expense'
      ? expenseQ.data === undefined
      : approval?.object_type === 'sales_invoice'
        ? invoicesQ.data?.find((x) => x.id === approval.object_id) === undefined
        : false;

  const navigate = useNavigate();
  const qc = useQueryClient();
  const [rejectOpen, setRejectOpen] = useState(false);
  // Computed from the CURRENT queue before the mutation lands (the refetch
  // will drop this entry).
  const next = nextRouteAfter(entries, route);

  const approveMut = useMutation({
    mutationFn: () => approveApproval(approvalId, 'operator'),
    onSuccess: async (_res, _vars, _ctx) => {
      // NO Undo: approve posts the voucher in the same transaction
      // (Reality #1); recovery is the correction flow.
      toastOk(
        heroAmount !== null
          ? `Approved & posted · ${heroAmount}`
          : 'Approved & posted',
      );
      navigate(next);
      await invalidateInbox(qc);
    },
    onError: (e) => toastErr(e instanceof Error ? e.message : String(e)),
  });

  const rejectMut = useMutation({
    mutationFn: (reason: string) => rejectApproval(approvalId, reason),
    onSuccess: async () => {
      setRejectOpen(false);
      toastOk('Rejected — returned to draft');
      navigate(next);
      await invalidateInbox(qc);
    },
    onError: (e) => toastErr(e instanceof Error ? e.message : String(e)),
  });

  const title =
    position !== null ? `${position.pos} of ${position.total}` : 'Approval';

  if (approvalsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo="/inbox" />
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (approvalsQ.isError) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo="/inbox" />
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
  if (approval === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo="/inbox" />
        <EmptyState
          icon="✓"
          title="Already decided"
          hint="This approval is no longer pending."
          action={<LinkButton to="/inbox">Back to Inbox</LinkButton>}
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
                ? `${(e.vat_amount / 100).toFixed(2)} € (${vatRatePct(e.gross_amount, e.vat_amount)}%)`
                : `${(e.vat_amount / 100).toFixed(2)} €`
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
          <KeyValue k="VAT" v={`${(inv.vat_amount / 100).toFixed(2)} €`} />
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
  } else {
    // reconciliation_match / allowance / future types: generic, safe.
    const label =
      approval.object_type === 'reconciliation_match'
        ? 'Bank match'
        : approval.object_type === 'allowance'
          ? 'Allowance'
          : approval.object_type;
    body = (
      <>
        <div className="px-5 pb-3 pt-1 text-center">
          <p className="text-[22px] font-extrabold">{label}</p>
          <Chip tone="muted">{approval.object_type}</Chip>
        </div>
        <WhyHeldBox reason={approval.policy_reason} />
        <ListGroup label="Facts">
          <KeyValue k="Requested by" v={approval.requested_by} />
          <KeyValue k="Waiting since" v={absoluteDate(approval.created_at)} />
        </ListGroup>
        {approval.object_type === 'reconciliation_match' && (
          <p className="mx-6 mb-3 text-[12px] text-ink-2">
            This hold is normally confirmed from the Bank section, where the
            matched line and its object are visible. Approving here activates
            the match; rejecting discards it.
          </p>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo="/inbox" />
      {body}
      <div className="mx-3.5 mt-2 flex gap-2.5">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={approveMut.isPending || rejectMut.isPending}
          onClick={() => setRejectOpen(true)}
        >
          Reject…
        </Button>
        <Button
          className="flex-1"
          busy={approveMut.isPending}
          disabled={rejectMut.isPending || factsUnresolved}
          onClick={() => approveMut.mutate()}
        >
          {heroAmount !== null ? `Approve · ${heroAmount}` : 'Approve'}
        </Button>
      </div>
      <p className="px-6 pt-2 text-center text-[10.5px] text-ink-2">
        Approve posts to the books immediately — recover via a correction
      </p>
      <RejectSheet
        // Remount per approval: auto-advance re-renders this same element
        // for the NEXT item, and a carried-over reason would land a stale
        // justification in the next item's audit trail.
        key={approvalId}
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        busy={rejectMut.isPending}
        onSubmit={(reason) => rejectMut.mutate(reason)}
      />
    </div>
  );
}
