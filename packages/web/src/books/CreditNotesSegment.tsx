import {
  type CreditNote,
  type Entity,
  type Expense,
  type SalesInvoice,
} from '../api';
import {
  entityName,
  groupByMonth,
  shortDate,
  useCreditNotes,
} from '../queries/books';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { statusChip } from './chips';

export interface CreditedContext {
  expenses: Expense[];
  invoices: SalesInvoice[];
  entities: Entity[];
}

/** Business-terms display for a credit note (data rule 1: the row answers
 *  "what does this credit", never "row #7"). */
export function creditNoteDisplay(
  n: CreditNote,
  ctx: CreditedContext,
): { title: string; subtitle: string; objectRoute: string | null } {
  if (n.credits_object_type === 'sales_invoice') {
    const inv = ctx.invoices.find((i) => i.id === n.credits_object_id);
    const customer = inv ? entityName(ctx.entities, inv.customer_id) : null;
    return {
      title: inv
        ? customer
          ? `${customer} · Invoice ${inv.invoice_number}`
          : `Invoice ${inv.invoice_number}`
        : n.credit_note_number,
      subtitle: `${n.credit_note_number} · credits invoice · ${shortDate(n.tax_point_date)}`,
      objectRoute: inv ? `/books/invoices/${inv.id}` : null,
    };
  }
  const e = ctx.expenses.find((x) => x.id === n.credits_object_id);
  const supplier = e ? entityName(ctx.entities, e.supplier_id) : null;
  return {
    title: e
      ? supplier
        ? `${supplier} · Expense ${e.category}`
        : `Expense ${e.category}`
      : n.credit_note_number,
    subtitle: `${n.credit_note_number} · credits expense · ${shortDate(n.tax_point_date)}`,
    objectRoute: e ? `/books/expenses/${e.id}` : null,
  };
}

/** Sign: a sales credit note reduces income (−); a purchase credit note
 *  reduces cost (+). */
export const creditNoteSign = (n: CreditNote): number =>
  n.credits_object_type === 'sales_invoice' ? -n.gross_amount : n.gross_amount;

export function CreditNotesSegment({ q }: { q: string }) {
  const notesQ = useCreditNotes();
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const ctx: CreditedContext = {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  };

  if (notesQ.isPending) return <SkeletonRows count={4} />;
  if (notesQ.isError) {
    return (
      <LoadError
        message={
          notesQ.error instanceof Error
            ? notesQ.error.message
            : 'Failed to load credit notes'
        }
        onRetry={() => void notesQ.refetch()}
      />
    );
  }

  const needle = q.trim().toLowerCase();
  const rows = (notesQ.data ?? []).filter((n) => {
    if (needle === '') return true;
    const d = creditNoteDisplay(n, ctx);
    return (
      d.title.toLowerCase().includes(needle) ||
      n.credit_note_number.toLowerCase().includes(needle)
    );
  });
  const groups = groupByMonth(rows);

  return (
    <div>
      <div className="px-4 pb-3">
        <LinkButton
          to="/books/credit-notes/new"
          variant="secondary"
          className="w-full"
        >
          New credit note
        </LinkButton>
      </div>
      {groups.length === 0 && (
        <EmptyState
          icon="🧾"
          title="No credit notes"
          hint="Issue one from a posted invoice or expense detail"
        />
      )}
      {groups.map((g) => (
        <ListGroup key={g.month} label={g.label}>
          {g.rows.map((n) => {
            const d = creditNoteDisplay(n, ctx);
            return (
              <ListRow
                key={n.id}
                to={`/books/credit-notes/${n.id}`}
                title={d.title}
                subtitle={d.subtitle}
                trailing={
                  <div className="flex-none">
                    <AmountText
                      cents={creditNoteSign(n)}
                      showSign
                      className="block text-[14px]"
                    />
                    <div className="mt-0.5">{statusChip(n.status)}</div>
                  </div>
                }
              />
            );
          })}
        </ListGroup>
      ))}
    </div>
  );
}
