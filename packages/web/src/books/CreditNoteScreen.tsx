import { useParams } from 'react-router-dom';
import { fmtCents } from '../api';
import { absoluteDateFromIso } from '../inbox/format';
import { useCreditNoteDetail } from '../queries/books';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { statusChip } from './chips';
import { creditNoteDisplay, creditNoteSign } from './CreditNotesSegment';

export function CreditNoteScreen() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const noteQ = useCreditNoteDetail(id);
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();

  if (noteQ.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Credit note" backTo="/books?seg=credit-notes" />
        <LoadError
          message={
            noteQ.error instanceof Error
              ? noteQ.error.message
              : 'Failed to load the credit note'
          }
          onRetry={() => void noteQ.refetch()}
        />
      </div>
    );
  }
  if (noteQ.data === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Credit note" backTo="/books?seg=credit-notes" />
        <SkeletonRows count={3} />
      </div>
    );
  }

  const n = noteQ.data;
  const d = creditNoteDisplay(n, {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  });
  const creditedTitle =
    n.credits_object_type === 'sales_invoice'
      ? `Invoice ${
          (invoicesQ.data ?? []).find((i) => i.id === n.credits_object_id)
            ?.invoice_number ?? ''
        }`.trim()
      : 'Expense';
  // d.title adds supplier/customer context when one exists; when the
  // credited object has none, d.title collapses to the same text as
  // creditedTitle — skip the subtitle rather than repeat it verbatim.
  const creditedSubtitle = d.title !== creditedTitle ? d.title : undefined;

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Credit note" backTo="/books?seg=credit-notes" />
      <div className="px-5 pb-4 pt-1 text-center">
        <AmountText
          cents={creditNoteSign(n)}
          currency={n.currency}
          showSign
          className="text-[30px]"
        />
        <p className="mt-1 text-[14px] text-ink-2">
          {n.credit_note_number}{' '}
          <span className="align-[2px]">{statusChip(n.status)}</span>
        </p>
      </div>
      {/* No "Number" row here — the header above already renders the bare
       *  credit note number as its own text node; duplicating the exact
       *  string made findByText('CN-1') ambiguous (same class of bug the
       *  InvoiceScreen/ExpenseScreen History sections hit and fixed). */}
      <ListGroup label="Facts">
        <KeyValue k="VAT" v={`${fmtCents(n.vat_amount)} €`} />
        <KeyValue k="Tax point" v={absoluteDateFromIso(n.tax_point_date)} />
      </ListGroup>
      <ListGroup label="Credits">
        {d.objectRoute != null ? (
          <ListRow
            to={d.objectRoute}
            title={creditedTitle}
            subtitle={creditedSubtitle}
          />
        ) : (
          <ListRow
            title="Credited object"
            subtitle="Not in the current lists — it may have been deleted"
          />
        )}
      </ListGroup>
      <p className="px-5 text-center text-[12.5px] text-ink-2">
        The credited document stays posted — a credit note offsets it, it does
        not rewrite it.
      </p>
    </div>
  );
}
