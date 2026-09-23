import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createExpense, createInvoice } from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import {
  centsToEuroInput,
  eurosToCents,
  signedEuros,
  vatFromGross,
} from '../lib/money';
import { errorMessage, usePendingOperation } from '../lib/pendingOperation';
import { useReceipt } from '../lib/resultLog';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { invalidateBooks } from '../queries/books';
import { useCategories, useCustomers, useSuppliers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, SelectInput, TextInput } from '../ui/Form';
import { ListGroup, ListRow } from '../ui/List';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

export type CreateKind = 'expense' | 'invoice' | 'upload';

/** Header "+" menu (spec: create flows via FAB/plus). */
export function CreateMenu({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (kind: CreateKind) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add to the books">
      <ListGroup>
        <ListRow
          onClick={() => onPick('upload')}
          leading={<span aria-hidden>📄</span>}
          title="Upload a document"
          subtitle="Receipt, invoice, statement — AI reads it"
        />
        <ListRow
          onClick={() => onPick('expense')}
          leading={<span aria-hidden>🧾</span>}
          title="New expense"
          subtitle="Manual entry, becomes a draft"
        />
        <ListRow
          onClick={() => onPick('invoice')}
          leading={<span aria-hidden>📨</span>}
          title="New sales invoice"
          subtitle="Manual entry, becomes a draft"
        />
      </ListGroup>
    </Sheet>
  );
}

const EMPTY_MONEY = { gross: '', vat: '' };

/** Shared euro-amount pair: gross typed, VAT auto at the standard rate until
 *  touched (same convention as Plans 02/03; field stays editable). */
function useMoneyPair() {
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const grossParsed = eurosToCents(gross);
  const vatAuto =
    grossParsed !== null && grossParsed > 0
      ? vatFromGross(grossParsed, STANDARD_VAT_RATE_PCT)
      : null;
  const vatEffective = vatTouched ? eurosToCents(vat) : vatAuto;
  return {
    /** The values as displayed — the dirty check compares what the
     *  operator sees, not whether a field was touched. */
    draft: {
      gross,
      vat: vatTouched ? vat : vatAuto !== null ? centsToEuroInput(vatAuto) : '',
    },
    gross,
    setGross,
    vat,
    setVat,
    vatTouched,
    setVatTouched,
    grossParsed,
    vatAuto,
    vatEffective,
  };
}

export function NewExpenseSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const categoriesQ = useCategories();
  const suppliersQ = useSuppliers();
  const [category, setCategory] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [date, setDate] = useState('');
  const m = useMoneyPair();
  const op = usePendingOperation('New expense');
  const receipt = useReceipt();
  // Attempts of ONE draft share a receipt (a retry supersedes a failure);
  // a created draft closes the series.
  const series = useRef(0);
  const busy = op.pending;
  const guard = useUnsavedChanges({
    label: 'New expense',
    active: open,
    values: { category, supplierId, date, ...m.draft },
    baseline: { category: '', supplierId: '', date: '', ...EMPTY_MONEY },
  });

  const valid =
    category !== '' &&
    date !== '' &&
    m.grossParsed !== null &&
    m.grossParsed > 0 &&
    m.vatEffective !== null &&
    m.vatEffective >= 0;

  const submit = () => {
    if (!valid) return;
    const req = {
      category,
      gross_amount: m.grossParsed as number,
      vat_amount: m.vatEffective as number,
      currency: 'EUR',
      tax_point_date: date,
      supplier_id: supplierId === '' ? null : Number(supplierId),
    };
    const key = `create:${series.current}`;
    let accepted = false;
    op.run(
      async (ctx) => {
        const created = await createExpense(req);
        accepted = true;
        series.current += 1;
        ctx.check();
        receipt(
          key,
          {
            action: 'New expense',
            title: `Expense #${created.id}`,
            outcome: `Draft created · ${signedEuros(-req.gross_amount)} — not posted yet; submit it for posting from the expense.`,
            tone: 'ok',
            links: [
              {
                label: `Expense #${created.id}`,
                to: `/books/expenses/${created.id}`,
              },
            ],
          },
          ctx.live,
        );
        await invalidateBooks(qc);
        return created;
      },
      {
        onSuccess: (created) => {
          toastOk('Draft created — submit it for posting from the detail');
          guard.release();
          onOpenChange(false);
          navigate(`/books/expenses/${created.id}`);
        },
        onError: (e) => {
          toastErr(errorMessage(e));
          if (accepted) return;
          // Input is kept; whether the server created it is unknown.
          receipt(key, {
            action: 'New expense',
            title: 'Draft expense',
            outcome: `Creating the draft was not confirmed (${errorMessage(e)}). Your input is still in the form — check Books before creating it again, in case it was stored.`,
            tone: 'error',
            links: [{ label: 'Books', to: '/books?seg=expenses' }],
          });
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="New expense"
      guard={guard}
      busy={busy}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-5 pb-2">
        <Field label="Category">
          <SelectInput
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">— select —</option>
            {(categoriesQ.data ?? []).map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field
          label="Supplier"
          hint="Optional — unknown suppliers can be resolved later"
        >
          <SelectInput
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
          >
            <option value="">— none —</option>
            {(suppliersQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Gross (€)">
          <TextInput
            inputMode="decimal"
            value={m.gross}
            onChange={(e) => m.setGross(e.target.value)}
          />
        </Field>
        <Field
          label="VAT (€)"
          hint={
            m.vatTouched
              ? undefined
              : `Auto at ${STANDARD_VAT_RATE_PCT}% — edit if the receipt says otherwise`
          }
        >
          <TextInput
            inputMode="decimal"
            value={
              m.vatTouched
                ? m.vat
                : m.vatAuto !== null
                  ? centsToEuroInput(m.vatAuto)
                  : ''
            }
            onChange={(e) => {
              m.setVatTouched(true);
              m.setVat(e.target.value);
            }}
          />
        </Field>
        <Field label="Tax point date">
          <TextInput
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid}
          onClick={submit}
        >
          {m.grossParsed !== null && m.grossParsed > 0
            ? `Create expense · ${signedEuros(-m.grossParsed)}`
            : 'Create expense'}
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}

export function NewInvoiceSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const customersQ = useCustomers();
  const [number, setNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const m = useMoneyPair();
  const op = usePendingOperation('New sales invoice');
  const receipt = useReceipt();
  // Attempts of ONE draft share a receipt (a retry supersedes a failure);
  // a created draft closes the series.
  const series = useRef(0);
  const busy = op.pending;
  const guard = useUnsavedChanges({
    label: 'New sales invoice',
    active: open,
    values: { number, customerId, date, dueDate, ...m.draft },
    baseline: {
      number: '',
      customerId: '',
      date: '',
      dueDate: '',
      ...EMPTY_MONEY,
    },
  });

  const valid =
    number.trim() !== '' &&
    date !== '' &&
    m.grossParsed !== null &&
    m.grossParsed > 0 &&
    m.vatEffective !== null &&
    m.vatEffective >= 0;

  const submit = () => {
    if (!valid) return;
    const req = {
      invoice_number: number.trim(),
      gross_amount: m.grossParsed as number,
      vat_amount: m.vatEffective as number,
      currency: 'EUR',
      tax_point_date: date,
      customer_id: customerId === '' ? null : Number(customerId),
      due_date: dueDate === '' ? null : dueDate,
    };
    const key = `create:${series.current}`;
    let accepted = false;
    op.run(
      async (ctx) => {
        const created = await createInvoice(req);
        accepted = true;
        series.current += 1;
        ctx.check();
        receipt(
          key,
          {
            action: 'New sales invoice',
            title: `Invoice ${req.invoice_number}`,
            outcome: `Draft created · ${signedEuros(req.gross_amount)} — not posted yet; submit it for posting from the invoice.`,
            tone: 'ok',
            links: [
              {
                label: `Invoice ${req.invoice_number}`,
                to: `/books/invoices/${created.id}`,
              },
            ],
          },
          ctx.live,
        );
        await invalidateBooks(qc);
        return created;
      },
      {
        onSuccess: (created) => {
          toastOk('Draft created — submit it for posting from the detail');
          guard.release();
          onOpenChange(false);
          navigate(`/books/invoices/${created.id}`);
        },
        onError: (e) => {
          toastErr(errorMessage(e));
          if (accepted) return;
          // Input is kept; whether the server created it is unknown.
          receipt(key, {
            action: 'New sales invoice',
            title: 'Draft invoice',
            outcome: `Creating the draft was not confirmed (${errorMessage(e)}). Your input is still in the form — check Books before creating it again, in case it was stored.`,
            tone: 'error',
            links: [{ label: 'Books', to: '/books?seg=invoices' }],
          });
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="New sales invoice"
      guard={guard}
      busy={busy}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-5 pb-2">
        <Field label="Invoice number">
          <TextInput
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
        </Field>
        <Field label="Customer" hint="Optional">
          <SelectInput
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">— none —</option>
            {(customersQ.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Gross (€)">
          <TextInput
            inputMode="decimal"
            value={m.gross}
            onChange={(e) => m.setGross(e.target.value)}
          />
        </Field>
        <Field
          label="VAT (€)"
          hint={
            m.vatTouched
              ? undefined
              : `Auto at ${STANDARD_VAT_RATE_PCT}% — edit if needed`
          }
        >
          <TextInput
            inputMode="decimal"
            value={
              m.vatTouched
                ? m.vat
                : m.vatAuto !== null
                  ? centsToEuroInput(m.vatAuto)
                  : ''
            }
            onChange={(e) => {
              m.setVatTouched(true);
              m.setVat(e.target.value);
            }}
          />
        </Field>
        <Field label="Tax point date">
          <TextInput
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Due date" hint="Optional">
          <TextInput
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid}
          onClick={submit}
        >
          {m.grossParsed !== null && m.grossParsed > 0
            ? `Create invoice · ${signedEuros(m.grossParsed)}`
            : 'Create invoice'}
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}
