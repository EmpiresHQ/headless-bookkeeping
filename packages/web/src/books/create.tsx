import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createExpense, createInvoice } from '../api';
import { HttpError } from '../auth';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import {
  amountError,
  centsToEuroInput,
  eurosToCents,
  signedEuros,
  vatFromGross,
} from '../lib/money';
import { errorMessage, usePendingOperation } from '../lib/pendingOperation';
import { useReceipt } from '../lib/resultLog';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { invalidateBooks } from '../queries/books';
import { useCategories } from '../queries/shared';
import { Button } from '../ui/Button';
import {
  Field,
  FormErrorSummary,
  PendingFieldset,
  SelectInput,
  TextInput,
  useFormErrors,
} from '../ui/Form';
import { ListGroup, ListRow } from '../ui/List';
import {
  BlockedReason,
  lookupBlocker,
  lookupState,
  LookupNotice,
  NO_CATEGORIES,
} from '../ui/Lookup';
import { Sheet } from '../ui/Sheet';
import {
  CounterpartyField,
  EMPTY_COUNTERPARTY_DRAFT,
  useCounterparty,
} from './CounterpartyField';
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
const NO_COUNTERPARTY = { id: null, draft: EMPTY_COUNTERPARTY_DRAFT };

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
  const vatShown = vatTouched
    ? vat
    : vatAuto !== null
      ? centsToEuroInput(vatAuto)
      : '';
  // The CREATE contract (issue #265): gross > 0, VAT >= 0, whole cents. No
  // VAT <= gross rule — the create endpoints do not have one.
  const errors = {
    gross: amountError(gross, {
      blank: 'Enter the gross amount',
      sign: 'positive',
      what: 'The gross',
    }),
    // An untouched VAT follows the gross (its error covers both); a VAT
    // the operator edited — or cleared — is their answer and is checked.
    vat: !vatTouched
      ? null
      : amountError(vat, {
          blank: 'Enter the VAT — 0.00 if there is none',
          sign: 'nonNegative',
          what: 'VAT',
        }),
  };
  return {
    /** The values as displayed — the dirty check compares what the
     *  operator sees, not whether a field was touched. */
    draft: { gross, vat: vatShown },
    errors,
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

/** What the form can truthfully say about a failed create: the server's
 *  own refusal (it validates before it stores anything) — or an outcome
 *  the client does not know (network, 5xx). */
function createFailureHeading(e: unknown, what: string): string {
  return e instanceof HttpError && [400, 409, 422].includes(e.status)
    ? `Not created — the server refused this ${what}. Your input is kept.`
    : `Creating the ${what} was not confirmed — your input is kept. Check Books before creating it again, in case it was stored.`;
}

/** VAT hint: the automatic amount while untouched; after the operator
 *  cleared it, what an empty VAT needs (never the auto value silently). */
function vatHint(m: ReturnType<typeof useMoneyPair>, auto: string) {
  if (!m.vatTouched) return auto;
  return m.vat.trim() === ''
    ? 'Required — enter 0.00 if there is no VAT'
    : undefined;
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
  const [category, setCategory] = useState('');
  const [date, setDate] = useState('');
  const m = useMoneyPair();
  // One operation for the sheet (issue #251): adding the supplier and
  // creating the draft never overlap; `running` only says which button
  // shows it. The sheet is busy — and locked — for either.
  const op = usePendingOperation('New expense');
  const [running, setRunning] = useState<'submit' | 'counterparty'>('submit');
  const supplier = useCounterparty({
    role: 'supplier',
    op,
    onStart: () => setRunning('counterparty'),
  });
  const receipt = useReceipt();
  // Attempts of ONE draft share a receipt (a retry supersedes a failure);
  // a created draft closes the series.
  const series = useRef(0);
  const busy = op.pending;
  const guard = useUnsavedChanges({
    label: 'New expense',
    active: open,
    values: { category, supplier: supplier.guardValue, date, ...m.draft },
    baseline: {
      category: '',
      supplier: NO_COUNTERPARTY,
      date: '',
      ...EMPTY_MONEY,
    },
  });

  // Issue #260: a loading/failed list is not an empty one. The category must
  // be one the (usable) list offers; no supplier is an answer only against a
  // usable supplier list (or once one was just added here); a pick a refetch
  // no longer lists stays visible and blocks until corrected; a supplier
  // being added blocks until it is added or discarded (#263).
  const categories = categoriesQ.data;
  const categoryGone =
    category !== '' &&
    categories !== undefined &&
    !categories.some((c) => c.key === category);
  const blocker =
    lookupBlocker(categoriesQ, 'categories') ??
    (categories?.length === 0 ? NO_CATEGORIES : null) ??
    (categoryGone
      ? 'The chosen category is no longer available — choose again.'
      : null) ??
    supplier.blocker;

  // Field feedback (issue #265): the submit is disabled only by the
  // structural blocker above; a field problem is shown at the field.
  const fieldValues = {
    category,
    supplier: supplier.entity?.id ?? null,
    gross: m.gross,
    vat: m.draft.vat,
    date,
  };
  const v = useFormErrors({
    values: fieldValues,
    errors: {
      category: category === '' ? 'Choose a category' : null,
      supplier: null,
      gross: m.errors.gross,
      vat: m.errors.vat,
      date: date === '' ? 'Pick the tax point date' : null,
    },
    labels: {
      category: 'Category',
      supplier: 'Supplier',
      gross: 'Gross (€)',
      vat: 'VAT (€)',
      date: 'Tax point date',
    },
    serverFields: {
      category: 'category',
      supplier_id: 'supplier',
      gross_amount: 'gross',
      vat_amount: 'vat',
      tax_point_date: 'date',
    },
  });

  const submit = () => {
    if (blocker !== null || !v.attempt()) return;
    if (m.grossParsed === null || m.vatEffective === null) return;
    const sent = fieldValues;
    const req = {
      category,
      gross_amount: m.grossParsed,
      vat_amount: m.vatEffective,
      currency: 'EUR',
      tax_point_date: date,
      supplier_id: supplier.entity?.id ?? null,
    };
    const key = `create:${series.current}`;
    let accepted = false;
    const started = op.run(
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
          // Input is kept; whether the server created it is unknown. A
          // refusal is also stated in the form, at the field it names.
          v.failed(e, sent, createFailureHeading(e, 'draft expense'));
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
    if (started) setRunning('submit');
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
        <div>
          <Field
            label="Category"
            required
            error={
              categoryGone
                ? 'This category is no longer available — choose again'
                : categories?.length === 0
                  ? NO_CATEGORIES
                  : v.error('category')
            }
          >
            <SelectInput
              {...v.bind('category')}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">
                {categories === undefined
                  ? lookupState(categoriesQ) === 'loading'
                    ? 'Loading categories…'
                    : 'Categories unavailable'
                  : categories.length === 0
                    ? 'No categories defined'
                    : '— select —'}
              </option>
              {categoryGone && (
                <option value={category}>{category} (not available)</option>
              )}
              {(categories ?? []).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </SelectInput>
          </Field>
          <LookupNotice query={categoriesQ} what="categories" />
        </div>
        <CounterpartyField
          cp={supplier}
          hint="Optional — leave it unpicked for none; unknown suppliers can be resolved later"
          busy={op.pending && running === 'counterparty'}
          focusId={v.idOf('supplier')}
          error={v.error('supplier')}
        />
        <Field label="Gross (€)" required error={v.error('gross')}>
          <TextInput
            {...v.bind('gross')}
            inputMode="decimal"
            value={m.gross}
            onChange={(e) => m.setGross(e.target.value)}
          />
        </Field>
        <Field
          label="VAT (€)"
          required
          error={v.error('vat')}
          hint={vatHint(
            m,
            `Auto at ${STANDARD_VAT_RATE_PCT}% — edit if the receipt says otherwise`,
          )}
        >
          <TextInput
            {...v.bind('vat')}
            inputMode="decimal"
            value={m.draft.vat}
            onChange={(e) => {
              m.setVatTouched(true);
              m.setVat(e.target.value);
            }}
          />
        </Field>
        <Field label="Tax point date" required error={v.error('date')}>
          <TextInput
            {...v.bind('date')}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <FormErrorSummary form={v} blocked={blocker !== null} />
        <Button
          className="w-full"
          busy={busy && running === 'submit'}
          disabled={blocker !== null}
          onClick={submit}
        >
          {m.grossParsed !== null && m.grossParsed > 0
            ? `Create expense · ${signedEuros(-m.grossParsed)}`
            : 'Create expense'}
        </Button>
        <BlockedReason reason={blocker} />
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
  const [number, setNumber] = useState('');
  const [date, setDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const m = useMoneyPair();
  // One operation for the sheet (issue #251) — see NewExpenseSheet.
  const op = usePendingOperation('New sales invoice');
  const [running, setRunning] = useState<'submit' | 'counterparty'>('submit');
  const customer = useCounterparty({
    role: 'customer',
    op,
    onStart: () => setRunning('counterparty'),
  });
  const receipt = useReceipt();
  // Attempts of ONE draft share a receipt (a retry supersedes a failure);
  // a created draft closes the series.
  const series = useRef(0);
  const busy = op.pending;
  const guard = useUnsavedChanges({
    label: 'New sales invoice',
    active: open,
    values: {
      number,
      customer: customer.guardValue,
      date,
      dueDate,
      ...m.draft,
    },
    baseline: {
      number: '',
      customer: NO_COUNTERPARTY,
      date: '',
      dueDate: '',
      ...EMPTY_MONEY,
    },
  });

  // Issue #260: no customer is an answer only against a usable customer
  // list; see NewExpenseSheet and CounterpartyField.
  const blocker = customer.blocker;

  // Field feedback (issue #265) — see NewExpenseSheet.
  const fieldValues = {
    number,
    customer: customer.entity?.id ?? null,
    gross: m.gross,
    vat: m.draft.vat,
    date,
    dueDate,
  };
  const v = useFormErrors({
    values: fieldValues,
    errors: {
      number: number.trim() === '' ? 'Enter the invoice number' : null,
      customer: null,
      gross: m.errors.gross,
      vat: m.errors.vat,
      date: date === '' ? 'Pick the tax point date' : null,
      dueDate: null,
    },
    labels: {
      number: 'Invoice number',
      customer: 'Customer',
      gross: 'Gross (€)',
      vat: 'VAT (€)',
      date: 'Tax point date',
      dueDate: 'Due date',
    },
    serverFields: {
      invoice_number: 'number',
      customer_id: 'customer',
      gross_amount: 'gross',
      vat_amount: 'vat',
      tax_point_date: 'date',
      due_date: 'dueDate',
    },
  });

  const submit = () => {
    if (blocker !== null || !v.attempt()) return;
    if (m.grossParsed === null || m.vatEffective === null) return;
    const sent = fieldValues;
    const req = {
      invoice_number: number.trim(),
      gross_amount: m.grossParsed,
      vat_amount: m.vatEffective,
      currency: 'EUR',
      tax_point_date: date,
      customer_id: customer.entity?.id ?? null,
      due_date: dueDate === '' ? null : dueDate,
    };
    const key = `create:${series.current}`;
    let accepted = false;
    const started = op.run(
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
          // Input is kept; whether the server created it is unknown. A
          // refusal is also stated in the form, at the field it names.
          v.failed(e, sent, createFailureHeading(e, 'draft invoice'));
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
    if (started) setRunning('submit');
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
        <Field label="Invoice number" required error={v.error('number')}>
          <TextInput
            {...v.bind('number')}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
        </Field>
        <CounterpartyField
          cp={customer}
          hint="Optional — leave it unpicked for none"
          busy={op.pending && running === 'counterparty'}
          focusId={v.idOf('customer')}
          error={v.error('customer')}
        />
        <Field label="Gross (€)" required error={v.error('gross')}>
          <TextInput
            {...v.bind('gross')}
            inputMode="decimal"
            value={m.gross}
            onChange={(e) => m.setGross(e.target.value)}
          />
        </Field>
        <Field
          label="VAT (€)"
          required
          error={v.error('vat')}
          hint={vatHint(
            m,
            `Auto at ${STANDARD_VAT_RATE_PCT}% — edit if needed`,
          )}
        >
          <TextInput
            {...v.bind('vat')}
            inputMode="decimal"
            value={m.draft.vat}
            onChange={(e) => {
              m.setVatTouched(true);
              m.setVat(e.target.value);
            }}
          />
        </Field>
        <Field label="Tax point date" required error={v.error('date')}>
          <TextInput
            {...v.bind('date')}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Due date" hint="Optional" error={v.error('dueDate')}>
          <TextInput
            {...v.bind('dueDate')}
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </Field>
        <FormErrorSummary form={v} blocked={blocker !== null} />
        <Button
          className="w-full"
          busy={busy && running === 'submit'}
          disabled={blocker !== null}
          onClick={submit}
        >
          {m.grossParsed !== null && m.grossParsed > 0
            ? `Create invoice · ${signedEuros(m.grossParsed)}`
            : 'Create invoice'}
        </Button>
        <BlockedReason reason={blocker} />
      </PendingFieldset>
    </Sheet>
  );
}
