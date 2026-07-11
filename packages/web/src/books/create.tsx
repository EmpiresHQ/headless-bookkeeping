import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createExpense,
  createInvoice,
  triageDocument,
  uploadDocument,
} from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import { outcomeText } from '../inbox/reason';
import {
  centsToEuroInput,
  eurosToCents,
  signedEuros,
  vatFromGross,
} from '../lib/money';
import { invalidateBooks } from '../queries/books';
import {
  useCategories,
  useCustomers,
  useEntities,
  useSuppliers,
} from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
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
  const [busy, setBusy] = useState(false);

  const valid =
    category !== '' &&
    date !== '' &&
    m.grossParsed !== null &&
    m.grossParsed > 0 &&
    m.vatEffective !== null &&
    m.vatEffective >= 0;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const created = await createExpense({
        category,
        gross_amount: m.grossParsed as number,
        vat_amount: m.vatEffective as number,
        currency: 'EUR',
        tax_point_date: date,
        supplier_id: supplierId === '' ? null : Number(supplierId),
      });
      await invalidateBooks(qc);
      toastOk('Draft created — submit it for posting from the detail');
      onOpenChange(false);
      navigate(`/books/expenses/${created.id}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New expense">
      <div className="space-y-3 px-5 pb-2">
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
          onClick={() => void submit()}
        >
          {m.grossParsed !== null && m.grossParsed > 0
            ? `Create expense · ${signedEuros(-m.grossParsed)}`
            : 'Create expense'}
        </Button>
      </div>
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
  const [busy, setBusy] = useState(false);

  const valid =
    number.trim() !== '' &&
    date !== '' &&
    m.grossParsed !== null &&
    m.grossParsed > 0 &&
    m.vatEffective !== null &&
    m.vatEffective >= 0;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const created = await createInvoice({
        invoice_number: number.trim(),
        gross_amount: m.grossParsed as number,
        vat_amount: m.vatEffective as number,
        currency: 'EUR',
        tax_point_date: date,
        customer_id: customerId === '' ? null : Number(customerId),
        due_date: dueDate === '' ? null : dueDate,
      });
      await invalidateBooks(qc);
      toastOk('Draft created — submit it for posting from the detail');
      onOpenChange(false);
      navigate(`/books/invoices/${created.id}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New sales invoice">
      <div className="space-y-3 px-5 pb-2">
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
          onClick={() => void submit()}
        >
          {m.grossParsed !== null && m.grossParsed > 0
            ? `Create invoice · ${signedEuros(m.grossParsed)}`
            : 'Create invoice'}
        </Button>
      </div>
    </Sheet>
  );
}

export function UploadSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const entitiesQ = useEntities();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [claimantId, setClaimantId] = useState('');
  const [busy, setBusy] = useState(false);

  // ADR-0036: employee/director who paid out-of-pocket.
  const claimants = (entitiesQ.data ?? []).filter(
    (e) => e.role === 'employee' || e.role === 'director',
  );

  const submit = async () => {
    if (busy) return;
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { document, deduplicated } = await uploadDocument(file, {
        claimantId: claimantId === '' ? null : Number(claimantId),
      });
      if (deduplicated)
        toastOk('Already uploaded — using the existing document');
      const outcome = await triageDocument(document.id);
      if (outcome.kind === 'unknown') toastErr(outcomeText(outcome));
      else toastOk(outcomeText(outcome));
      await invalidateBooks(qc);
      onOpenChange(false);
      navigate(`/books/documents/${document.id}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Upload a document">
      <div className="space-y-3 px-5 pb-2">
        <Field label="File">
          <input
            ref={fileRef}
            type="file"
            className="w-full text-[14px]"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          />
        </Field>
        {claimants.length > 0 && (
          <Field
            label="Paid by (claimant)"
            hint="Only when an employee/director paid out-of-pocket — the expense is then held for approval (ADR-0036)"
          >
            <SelectInput
              value={claimantId}
              onChange={(e) => setClaimantId(e.target.value)}
            >
              <option value="">— company paid —</option>
              {claimants.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectInput>
          </Field>
        )}
        <Button
          className="w-full"
          busy={busy}
          disabled={fileName === null || busy}
          onClick={() => void submit()}
        >
          Upload &amp; process
        </Button>
        {busy && (
          <p className="text-center text-[12.5px] text-ink-2">
            AI is reading the document — this can take a minute…
          </p>
        )}
      </div>
    </Sheet>
  );
}
