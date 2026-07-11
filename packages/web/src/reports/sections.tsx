import {
  fmtCents,
  type Expense,
  type PeriodWarning,
  type ReportingPeriod,
} from '../api';
import { signedEuros } from '../lib/money';
import { useSheet } from '../lib/useSheet';
import { entityName, shortDate } from '../queries/books';
import {
  INF_THRESHOLD_NET,
  infGapCandidates,
  periodExpenses,
  periodInvoices,
  usePeriodWarnings,
} from '../queries/reports';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { GroupHeader } from '../ui/GroupHeader';
import { GroupLabel, ListGroup, ListRow } from '../ui/List';
import { FixInvoiceNumberSheet } from './FixInvoiceNumberSheet';

type PeriodProp = Pick<
  ReportingPeriod,
  'id' | 'start_date' | 'end_date' | 'status' | 'filed_at'
>;

/**
 * INF annex gaps — client-DERIVED (no JSON endpoint exposes INF rows,
 * Reality #11): live in-period expenses of ≥-threshold suppliers with no
 * supplier invoice number. Labeled as an approximation; the fix is real
 * (Reality #12) and only offered while the period is open.
 */
export function InfGapsSection({ period }: { period: PeriodProp }) {
  const expensesQ = useExpenses();
  const entitiesQ = useEntities();
  const fix = useSheet<Expense>();

  const entities = entitiesQ.data ?? [];
  const gaps = infGapCandidates(expensesQ.data ?? [], period);
  const locked = period.status === 'locked';

  // Note: an early `if (gaps.length === 0) return null` here would unmount
  // the sheet mount below along with the gap group the moment the LAST gap
  // is fixed (the fix's own `invalidateReports` refetch drops `gaps` to
  // zero while the sheet is still closing) — killing its exit animation
  // mid-flight. Gate the gap-list markup on `gaps.length > 0` instead and
  // keep the sheet mount reachable regardless.
  return (
    <>
      {gaps.length > 0 && (
        <>
          <GroupLabel>INF annex — invoice numbers to add</GroupLabel>
          <ListGroup>
            {gaps.map((e) => {
              const supplier = entityName(entities, e.supplier_id);
              const subtitle = `${e.category} · ${shortDate(e.tax_point_date)} · no invoice number`;
              const trailing = (
                <AmountText
                  cents={-e.gross_amount}
                  className="block text-[14px]"
                />
              );
              return locked ? (
                <ListRow
                  key={e.id}
                  title={supplier ?? e.category}
                  subtitle={subtitle}
                  trailing={trailing}
                />
              ) : (
                <ListRow
                  key={e.id}
                  onClick={() => fix.open(e)}
                  title={supplier ?? e.category}
                  subtitle={subtitle}
                  trailing={trailing}
                />
              );
            })}
          </ListGroup>
          <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
            {locked
              ? 'The period is locked — numbers can no longer be edited here; the filed INF is what it is.'
              : `The INF annex itemises suppliers with over ${fmtCents(INF_THRESHOLD_NET)} € of purchases this period — these entries have no supplier invoice number yet. The downloaded KMD stays the authority.`}
          </p>
        </>
      )}
      {fix.payload !== null && (
        <FixInvoiceNumberSheet
          key={`${fix.payload.id}-${fix.epoch}`}
          expense={fix.payload}
          supplierName={entityName(entities, fix.payload.supplier_id)}
          open={fix.isOpen}
          onOpenChange={(o) => !o && fix.close()}
        />
      )}
    </>
  );
}

/** Aggregate straggler rows: [count, label suffix, link] per bucket. */
function stragglerRows(warnings: PeriodWarning[]) {
  const buckets = [
    {
      match: (w: PeriodWarning) => w.type === 'pending_approval',
      label: (n: number) => `${n} awaiting approval`,
      subtitle:
        'they enter the declaration only once approved — approving after close posts into the next open period',
      to: '/inbox?seg=approvals',
    },
    {
      match: (w: PeriodWarning) =>
        w.type === 'unposted_draft' && w.object_type === 'expense',
      label: (n: number) =>
        `${n} expense ${n === 1 ? 'draft' : 'drafts'} not posted`,
      subtitle: 'drafts are not part of the declaration',
      to: '/books?seg=expenses&status=draft',
    },
    {
      match: (w: PeriodWarning) =>
        w.type === 'unposted_draft' && w.object_type === 'sales_invoice',
      label: (n: number) =>
        `${n} invoice ${n === 1 ? 'draft' : 'drafts'} not posted`,
      subtitle: 'drafts are not part of the declaration',
      to: '/books?seg=invoices&status=draft',
    },
  ];
  return buckets
    .map((b) => ({ ...b, count: warnings.filter(b.match).length }))
    .filter((b) => b.count > 0);
}

/**
 * ADR-0015's "stranded items stay visible": the advisory pre-lock warnings
 * as navigations into Inbox/Books. Open periods only (the endpoint is a
 * pre-close aid); the server NEVER blocks on these. The raw `description`
 * (embeds cents, Reality #8) is never rendered.
 */
export function StragglersSection({ period }: { period: PeriodProp }) {
  const warningsQ = usePeriodWarnings(period.id, period.status === 'open');
  const warnings = warningsQ.data ?? [];
  const rows = stragglerRows(warnings);
  if (period.status !== 'open' || rows.length === 0) return null;

  return (
    <>
      <GroupLabel>Not decided in this period</GroupLabel>
      <ListGroup>
        {rows.map((r) => (
          <ListRow
            key={r.to}
            to={r.to}
            title={r.label(r.count)}
            subtitle={r.subtitle}
          />
        ))}
      </ListGroup>
    </>
  );
}

/**
 * The honest §7 drill-down substitute (Reality #10): every LIVE document
 * DATED in the period, as real Books navigations — declaration → documents
 * → object detail in two taps. Labeled by date membership, never as per-box
 * composition (the box routing is country-plugin logic).
 */
export function InPeriodSection({ period }: { period: PeriodProp }) {
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const entities = entitiesQ.data ?? [];

  // BOTH sources or nothing: rendering after only one list resolves showed a
  // half-total for a moment (P05 final-review transient). The section is
  // supplementary — skeletonless null is the honest loading state.
  if (!expensesQ.isSuccess || !invoicesQ.isSuccess) return null;

  const purchases = periodExpenses(expensesQ.data ?? [], period);
  const sales = periodInvoices(invoicesQ.data ?? [], period);
  if (purchases.length === 0 && sales.length === 0) return null;

  const purchasesTotal = purchases.reduce((s, e) => s + e.gross_amount, 0);
  const salesTotal = sales.reduce((s, i) => s + i.gross_amount, 0);

  return (
    <>
      {sales.length > 0 && (
        <ListGroup
          label={
            <GroupHeader
              label="Sales in this period"
              trailing={`${signedEuros(salesTotal)} · ${sales.length}`}
            />
          }
        >
          {sales.map((i) => (
            <ListRow
              key={i.id}
              to={`/books/invoices/${i.id}`}
              title={entityName(entities, i.customer_id) ?? i.invoice_number}
              subtitle={`${i.invoice_number} · ${shortDate(i.tax_point_date)}`}
              trailing={
                <AmountText
                  cents={i.gross_amount}
                  showSign
                  className="block text-[14px]"
                />
              }
            />
          ))}
        </ListGroup>
      )}
      {purchases.length > 0 && (
        <ListGroup
          label={
            <GroupHeader
              label="Purchases in this period"
              trailing={`${signedEuros(-purchasesTotal)} · ${purchases.length}`}
            />
          }
        >
          {purchases.map((e) => (
            <ListRow
              key={e.id}
              to={`/books/expenses/${e.id}`}
              title={entityName(entities, e.supplier_id) ?? e.category}
              subtitle={`${e.category} · ${shortDate(e.tax_point_date)}`}
              trailing={
                <AmountText
                  cents={-e.gross_amount}
                  className="block text-[14px]"
                />
              }
            />
          ))}
        </ListGroup>
      )}
      <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
        Documents dated in this period. Late corrections against a closed period
        are re-dated into the next open period and appear there instead.
      </p>
    </>
  );
}
