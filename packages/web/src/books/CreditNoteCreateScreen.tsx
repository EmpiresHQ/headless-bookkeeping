import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createCreditNote } from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import {
  entityName,
  invalidateBooks,
  remainingCreditable,
  shortDate,
  useCreditNotes,
} from '../queries/books';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { Field, TextInput } from '../ui/Form';
import { ListGroup, ListRow } from '../ui/List';
import { SearchInput } from '../ui/SearchInput';
import { toastErr, toastOk } from '../ui/toast';

interface Candidate {
  type: 'sales_invoice' | 'expense';
  id: number;
  label: string; // '2026-018 · Nordic Consulting OÜ'
  grossCents: number;
  outstandingCents: number;
  taxPointDate: string;
}

/** /books/credit-notes/new — data rule 8: a searchable PICKER over posted
 *  objects with full context; raw IDs are never typed. Euros in, cents on
 *  the wire (the legacy cent bug ends here). */
export function CreditNoteCreateScreen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const notesQ = useCreditNotes();
  const invoicesQ = useInvoices();
  const expensesQ = useExpenses();
  const entitiesQ = useEntities();

  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<{
    type: 'sales_invoice' | 'expense';
    id: number;
  } | null>(() => {
    const type = params.get('type');
    const id = Number(params.get('id'));
    return (type === 'sales_invoice' || type === 'expense') &&
      Number.isInteger(id) &&
      id > 0
      ? { type, id }
      : null;
  });
  const [number, setNumber] = useState('');
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);

  const loading =
    notesQ.isPending || invoicesQ.isPending || expensesQ.isPending;
  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader
          title="New credit note"
          backTo="/books?seg=credit-notes"
        />
        <SkeletonRows count={4} />
      </div>
    );
  }

  const notes = notesQ.data ?? [];
  const entities = entitiesQ.data ?? [];
  const candidates: Candidate[] = [
    ...(invoicesQ.data ?? [])
      .filter((i) => i.status === 'posted')
      .map((i) => ({
        type: 'sales_invoice' as const,
        id: i.id,
        label: `${i.invoice_number} · ${entityName(entities, i.customer_id) ?? 'no customer'}`,
        grossCents: i.gross_amount,
        outstandingCents: remainingCreditable(
          i.gross_amount,
          notes,
          'sales_invoice',
          i.id,
        ),
        taxPointDate: i.tax_point_date,
      })),
    ...(expensesQ.data ?? [])
      .filter((e) => e.status === 'posted')
      .map((e) => ({
        type: 'expense' as const,
        id: e.id,
        label: `${e.category} · ${entityName(entities, e.supplier_id) ?? 'no supplier'}`,
        grossCents: e.gross_amount,
        outstandingCents: remainingCreditable(
          e.gross_amount,
          notes,
          'expense',
          e.id,
        ),
        taxPointDate: e.tax_point_date,
      })),
  ];
  const selected =
    picked === null
      ? null
      : (candidates.find((c) => c.type === picked.type && c.id === picked.id) ??
        null);

  const needle = search.trim().toLowerCase();
  const visible = candidates.filter(
    (c) => needle === '' || c.label.toLowerCase().includes(needle),
  );

  const grossParsed = eurosToCents(gross);
  const vatAuto =
    grossParsed !== null && grossParsed > 0
      ? vatFromGross(grossParsed, STANDARD_VAT_RATE_PCT)
      : null;
  const vatEffective = vatTouched ? eurosToCents(vat) : vatAuto;
  const overCap =
    selected !== null &&
    grossParsed !== null &&
    grossParsed > selected.outstandingCents;
  const valid =
    selected !== null &&
    number.trim() !== '' &&
    grossParsed !== null &&
    grossParsed > 0 &&
    !overCap &&
    vatEffective !== null &&
    vatEffective >= 0;
  const sign = selected?.type === 'expense' ? '+' : '−';

  const submit = async () => {
    if (!valid || selected === null) return;
    setBusy(true);
    try {
      const created = await createCreditNote({
        credits_object_type: selected.type,
        credits_object_id: selected.id,
        credit_note_number: number.trim(),
        gross_amount: grossParsed as number,
        vat_amount: vatEffective as number,
        tax_point_date: date !== '' ? date : selected.taxPointDate,
      });
      await invalidateBooks(qc);
      toastOk(
        `Credit note issued · ${sign}${centsToEuroInput(grossParsed as number)} €`,
      );
      navigate(`/books/credit-notes/${created.id}`, { replace: true });
    } catch (e) {
      // Server cap/state errors carry the remaining amount — show verbatim.
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="New credit note" backTo="/books?seg=credit-notes" />

      <ListGroup label={selected === null ? 'Credit what?' : 'Crediting'}>
        {selected !== null ? (
          <ListRow
            onClick={() => setPicked(null)}
            title={selected.label}
            subtitle={`${centsToEuroInput(selected.grossCents)} € · ${centsToEuroInput(selected.outstandingCents)} € outstanding · tap to change`}
          />
        ) : (
          <div className="px-3.5 py-2.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Number, counterparty, category…"
            />
          </div>
        )}
        {selected === null &&
          visible.map((c) => (
            <ListRow
              key={`${c.type}-${c.id}`}
              onClick={() => setPicked({ type: c.type, id: c.id })}
              title={c.label}
              subtitle={`${shortDate(c.taxPointDate)} · ${centsToEuroInput(c.grossCents)} € · ${centsToEuroInput(c.outstandingCents)} € outstanding`}
            />
          ))}
        {selected === null && visible.length === 0 && (
          <ListRow
            title="Nothing creditable"
            subtitle="Only posted invoices and expenses can be credited"
          />
        )}
      </ListGroup>

      {selected !== null && (
        <div className="space-y-3 px-5">
          <Field label="Credit note number">
            <TextInput
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
          </Field>
          <Field
            label="Gross (€)"
            error={
              overCap && selected !== null
                ? `Only ${centsToEuroInput(selected.outstandingCents)} € remains creditable on this document`
                : null
            }
          >
            <TextInput
              inputMode="decimal"
              value={gross}
              onChange={(e) => setGross(e.target.value)}
            />
          </Field>
          <Field
            label="VAT (€)"
            hint={
              vatTouched
                ? undefined
                : `Auto at ${STANDARD_VAT_RATE_PCT}% — edit if the document says otherwise`
            }
          >
            <TextInput
              inputMode="decimal"
              value={
                vatTouched
                  ? vat
                  : vatAuto !== null
                    ? centsToEuroInput(vatAuto)
                    : ''
              }
              onChange={(e) => {
                setVatTouched(true);
                setVat(e.target.value);
              }}
            />
          </Field>
          <Field
            label="Tax point date"
            hint="Defaults to the credited document's date; a locked-period date is redirected server-side (ADR-0009)"
          >
            <TextInput
              type="date"
              value={date !== '' ? date : selected.taxPointDate}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Button
            className="w-full"
            busy={busy}
            disabled={!valid}
            onClick={() => void submit()}
          >
            {grossParsed !== null && grossParsed > 0
              ? `Issue credit note · ${sign}${centsToEuroInput(grossParsed)} €`
              : 'Issue credit note'}
          </Button>
        </div>
      )}
    </div>
  );
}
