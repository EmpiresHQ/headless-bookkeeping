import { useParams } from 'react-router-dom';
import { ScreenHeader } from '../shell/Headers';
import {
  queuePosition,
  useExpenseDetail,
  useInboxQueue,
  usePendingApprovals,
} from '../queries/inbox';
import { useEntities, useInvoices } from '../queries/shared';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup } from '../ui/List';
import { LinkButton } from '../ui/LinkButton';
import { LoadError } from '../ui/LoadError';
import { DocPreviewRow } from './DocPreviewRow';
import {
  absoluteDate,
  absoluteDateFromIso,
  signedEuros,
  vatRatePct,
} from './format';
import { humanizePolicyReason } from './reason';

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
 *  "why held" with concrete numbers → document preview → facts KV.
 *  Renders EVERY object_type safely; actions are wired in Task 9. */
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
    body =
      e === undefined ? (
        <SkeletonRows count={2} />
      ) : (
        <>
          <Hero
            amount={signedEuros(-e.gross_amount)}
            subtitle={`${supplier?.name ?? 'Unknown supplier'} · ${e.category}`}
          />
          <WhyHeldBox reason={approval.policy_reason} />
          {e.document_id !== null && (
            <DocPreviewRow documentId={e.document_id} />
          )}
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
    body =
      inv === undefined ? (
        <SkeletonRows count={2} />
      ) : (
        <>
          <Hero
            amount={signedEuros(inv.gross_amount)}
            subtitle={`${customer?.name ?? 'No customer'} · ${inv.invoice_number}`}
          />
          <WhyHeldBox reason={approval.policy_reason} />
          <ListGroup label="Facts">
            <KeyValue k="VAT" v={`${(inv.vat_amount / 100).toFixed(2)} €`} />
            <KeyValue
              k="Tax point"
              v={absoluteDateFromIso(inv.tax_point_date)}
            />
            <KeyValue k="Invoice number" v={inv.invoice_number} />
          </ListGroup>
        </>
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
      {/* Action bar lands in Task 9 */}
    </div>
  );
}
