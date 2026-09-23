import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { invalidateBooks } from '../queries/books';
import {
  useCategories,
  useCustomers,
  useEntities,
  useSuppliers,
} from '../queries/shared';
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
    op.run(
      async (ctx) => {
        const created = await createExpense(req);
        ctx.check();
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
    op.run(
      async (ctx) => {
        const created = await createInvoice(req);
        ctx.check();
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
  // The chosen File (identity) — also what is uploaded.
  const [file, setFile] = useState<File | null>(null);
  const [claimantId, setClaimantId] = useState('');
  const op = usePendingOperation('Upload a document');
  const busy = op.pending;
  // Partial success (issue #251): the upload landed but processing failed.
  // Bound to the exact File + claimant it was uploaded with — a retry of
  // the SAME input only re-runs processing (never a second upload); any
  // other input is a new upload.
  const landed = useRef<{
    file: File;
    claimantId: string;
    documentId: number;
  } | null>(null);
  const [landedId, setLandedId] = useState<number | null>(null);
  const partial =
    landed.current !== null &&
    landed.current.file === file &&
    landed.current.claimantId === claimantId
      ? landed.current
      : null;
  const guard = useUnsavedChanges({
    label: 'Upload a document',
    active: open,
    values: { file, claimantId },
    baseline: { file: null as File | null, claimantId: '' },
  });

  // ADR-0036: employee/director who paid out-of-pocket.
  const claimants = (entitiesQ.data ?? []).filter(
    (e) => e.role === 'employee' || e.role === 'director',
  );

  const submit = () => {
    if (file === null) return;
    const chosen = { file, claimantId };
    const resume = partial;
    op.run(
      async (ctx) => {
        let documentId: number;
        let deduplicated = false;
        if (resume !== null) {
          documentId = resume.documentId;
        } else {
          const up = await uploadDocument(chosen.file, {
            claimantId:
              chosen.claimantId === '' ? null : Number(chosen.claimantId),
          });
          documentId = up.document.id;
          deduplicated = up.deduplicated;
          landed.current = { ...chosen, documentId };
        }
        // Stage boundary: never start processing under another session.
        ctx.check();
        const outcome = await triageDocument(documentId);
        ctx.check();
        await invalidateBooks(qc);
        return { documentId, deduplicated, outcome };
      },
      {
        onSuccess: ({ documentId, deduplicated, outcome }) => {
          if (deduplicated)
            toastOk('Already uploaded — using the existing document');
          if (outcome.kind === 'unknown') toastErr(outcomeText(outcome));
          else toastOk(outcomeText(outcome));
          landed.current = null;
          guard.release();
          onOpenChange(false);
          navigate(`/books/documents/${documentId}`);
        },
        onError: (e) => {
          const up = landed.current;
          if (up !== null && up.file === chosen.file) {
            setLandedId(up.documentId);
            toastErr(
              `Uploaded as document #${up.documentId}, but processing failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          } else {
            toastErr(e instanceof Error ? e.message : String(e));
          }
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Upload a document"
      guard={guard}
      busy={busy}
    >
      <PendingFieldset
        pending={busy}
        status="AI is reading the document — this can take a minute…"
        className="space-y-3 px-5 pb-2"
      >
        <Field label="File">
          <input
            type="file"
            className="w-full text-[14px]"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
        {partial !== null && landedId === partial.documentId && (
          <p className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            This file is already uploaded as{' '}
            <Link
              className="font-semibold underline"
              to={`/books/documents/${partial.documentId}`}
            >
              document #{partial.documentId}
            </Link>{' '}
            — only processing failed. Retrying re-runs processing; it does not
            upload the file again.
          </p>
        )}
        <Button
          className="w-full"
          busy={busy}
          disabled={file === null || busy}
          onClick={submit}
        >
          {partial !== null ? 'Retry processing' : 'Upload & process'}
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}
