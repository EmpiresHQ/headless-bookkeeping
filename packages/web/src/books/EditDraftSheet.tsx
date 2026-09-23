import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  updateExpenseDraft,
  updateInvoiceDraft,
  type Entity,
  type ExpenseDetail,
  type SalesInvoice,
  type ServicePlaceRule,
} from '../api';
import { centsToEuroInput, eurosToCents } from '../lib/money';
import { usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges, type DismissGuard } from '../lib/unsavedChanges';
import { invalidateBooks } from '../queries/books';
import { useCategories, useEntities } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastOk } from '../ui/toast';

/**
 * Issue #247 — edit a DRAFT expense / sales invoice in place, then submit it
 * again from the detail screen. Saving never posts. The source document, AI
 * facts and rejection history stay on the SAME object (the server refuses
 * provenance fields by name); a POSTED object keeps its separate Correct…
 * flow.
 *
 * Resilience contract: fields prefill with the exact stored cents; a failed
 * save keeps every typed value and shows the server's reason inline; while a
 * save is in flight the sheet cannot be closed and the button cannot be
 * pressed again; a failed lookup (categories/entities) is shown, and the
 * current value always stays selectable so it is never lost.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

const PLACE_RULES: [ServicePlaceRule, string][] = [
  ['general', 'General rule'],
  ['immovable_property', 'Immovable property'],
  ['passenger_transport', 'Passenger transport'],
  [
    'cultural_artistic_sporting_admission',
    'Cultural / artistic / sporting admission',
  ],
  ['restaurant_catering', 'Restaurant / catering'],
  ['short_term_hire_of_means_of_transport', 'Short-term hire of transport'],
  ['electronically_supplied_to_consumer', 'E-services to a consumer'],
  ['other_special', 'Other special rule'],
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shared money/date/currency validation — mirrors the server contract
 *  (integer cents, gross > 0, 0 ≤ VAT ≤ gross, real YYYY-MM-DD, ISO code). */
function useFacts(init: {
  gross: number;
  vat: number;
  currency: string;
  date: string;
}) {
  const [gross, setGross] = useState(centsToEuroInput(init.gross));
  const [vat, setVat] = useState(centsToEuroInput(init.vat));
  const [currency, setCurrency] = useState(init.currency);
  const [date, setDate] = useState(init.date);
  const grossC = eurosToCents(gross);
  const vatC = eurosToCents(vat);
  const cur = currency.trim().toUpperCase();
  const errors = {
    gross:
      grossC === null
        ? 'Enter an amount like 12.40'
        : grossC <= 0
          ? 'Gross must be greater than zero'
          : null,
    vat:
      vatC === null
        ? 'Enter an amount like 2.40'
        : vatC < 0
          ? 'VAT cannot be negative'
          : grossC !== null && vatC > grossC
            ? 'VAT cannot exceed the gross'
            : null,
    currency: CURRENCY.test(cur) ? null : 'Use a 3-letter code, e.g. EUR',
    date: isRealDate(date) ? null : 'Pick a valid date',
  };
  return {
    /** What the operator can type — the dirty-check values. */
    draft: { gross, vat, currency, date },
    gross,
    setGross,
    vat,
    setVat,
    currency,
    setCurrency,
    date,
    setDate,
    grossC,
    vatC,
    cur,
    errors,
    valid: Object.values(errors).every((e) => e === null),
  };
}

function isRealDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** An entity <select> that never loses the current value: while the lookup
 *  is loading or failed, the stored id stays an option. */
function EntitySelect({
  value,
  onChange,
  options,
  noneLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Entity[];
  noneLabel: string;
  disabled?: boolean;
}) {
  const known = options.some((o) => String(o.id) === value);
  return (
    <SelectInput
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{noneLabel}</option>
      {value !== '' && !known && (
        <option value={value}>{`Current (#${value})`}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </SelectInput>
  );
}

function lookupError(q: { isError: boolean; error: unknown }, what: string) {
  return q.isError
    ? `Couldn't load ${what} (${errText(q.error)}) — the current value is kept`
    : null;
}

/** Sheet shell: refuses to close while a save is in flight. */
function EditShell({
  open,
  onOpenChange,
  busy,
  title,
  guard,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  busy: boolean;
  title: string;
  guard: DismissGuard;
  children: ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o && busy) return;
        onOpenChange(o);
      }}
      title={title}
      guard={guard}
      busy={busy}
    >
      <div className="space-y-3 px-5 pb-2">{children}</div>
    </Sheet>
  );
}

function SaveError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <div role="alert" className="rounded-xl bg-err/10 px-3.5 py-2.5">
      <p className="text-[13px] font-semibold text-err">Not saved</p>
      <p className="mt-0.5 text-[12.5px] text-ink">{message}</p>
      <p className="mt-0.5 text-[12px] text-ink-2">
        Your changes are kept — fix them and save again.
      </p>
    </div>
  );
}

// ── Expense ────────────────────────────────────────────────────────────────

export function ExpenseEditSheet({
  open,
  onOpenChange,
  detail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: ExpenseDetail;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const categoriesQ = useCategories();
  const entitiesQ = useEntities();
  const f = useFacts({
    gross: detail.gross_amount,
    vat: detail.vat_amount,
    currency: detail.currency,
    date: detail.tax_point_date,
  });
  const [category, setCategory] = useState(detail.category);
  const [supplierId, setSupplierId] = useState(
    detail.supplier_id == null ? '' : String(detail.supplier_id),
  );
  const [invoiceNo, setInvoiceNo] = useState(
    detail.supplier_invoice_number ?? '',
  );
  const [claimantId, setClaimantId] = useState(
    detail.claimant_id == null ? '' : String(detail.claimant_id),
  );
  const [receipt, setReceipt] = useState(
    detail.company_addressed_receipt == null
      ? ''
      : detail.company_addressed_receipt
        ? 'yes'
        : 'no',
  );
  // Both the duplicate refusal and the operator's "save anyway" consent are
  // bound to the exact duplicate-key VALUES they were given for (server:
  // supplier, invoice no., currency, gross, date, claimant). Change any of
  // them and the refusal no longer applies — an ordinary save is possible
  // again — and the consent is void, so it can never carry over to a
  // collision with a DIFFERENT purchase.
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  const [consentKey, setConsentKey] = useState<string | null>(null);
  // The operation's own ref lock: two clicks in one frame send one save.
  const op = usePendingOperation('Edit draft expense');
  const busy = op.pending;
  const [saveError, setSaveError] = useState<string | null>(null);
  const values = {
    ...f.draft,
    category,
    supplierId,
    invoiceNo,
    claimantId,
    receipt,
  };
  // Seeded once from `detail` (initializers above) — frozen alike.
  const [baseline] = useState(values);
  const guard = useUnsavedChanges({
    label: 'Edit draft expense',
    active: open,
    values,
    baseline,
  });

  const entities = entitiesQ.data ?? [];
  const suppliers = entities.filter((e) => e.role === 'supplier');
  const claimants = entities.filter(
    (e) => e.role === 'employee' || e.role === 'director',
  );
  const categories = categoriesQ.data ?? [];
  const valid = f.valid && category !== '';
  const dupKey = JSON.stringify([
    supplierId,
    invoiceNo.trim(),
    f.cur,
    f.grossC,
    f.date,
    claimantId,
  ]);
  const duplicate = refusedKey !== null && refusedKey === dupKey;
  const allowDuplicate = duplicate && consentKey === dupKey;
  // A duplicate refusal for values that have since changed is stale.
  const shownError = refusedKey !== null && !duplicate ? null : saveError;

  const save = () => {
    if (!valid) return;
    const keyAtSave = dupKey;
    const id = detail.id;
    const req = {
      category,
      supplier_id: supplierId === '' ? null : Number(supplierId),
      gross_amount: f.grossC as number,
      vat_amount: f.vatC as number,
      currency: f.cur,
      tax_point_date: f.date,
      supplier_invoice_number: invoiceNo.trim() === '' ? null : invoiceNo,
      claimant_id: claimantId === '' ? null : Number(claimantId),
      company_addressed_receipt:
        receipt === '' ? null : receipt === 'yes' ? true : false,
      ...(allowDuplicate ? { allow_duplicate: true } : {}),
    };
    const started = op.run(
      async (ctx) => {
        await updateExpenseDraft(id, req);
        ctx.check();
        await invalidateBooks(qc);
      },
      {
        onSuccess: () => {
          toastOk('Draft saved — submit it for posting when ready');
          guard.release();
          onSaved?.();
          onOpenChange(false);
        },
        onError: (e) => {
          const message = errText(e);
          setSaveError(message);
          setRefusedKey(/possible duplicate/i.test(message) ? keyAtSave : null);
        },
      },
    );
    if (started) setSaveError(null);
  };

  return (
    <EditShell
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title="Edit draft expense"
      guard={guard}
    >
      <fieldset disabled={busy} className="space-y-3">
        <Field label="Category" error={lookupError(categoriesQ, 'categories')}>
          <SelectInput
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {category !== '' && !categories.some((c) => c.key === category) && (
              <option value={category}>{category}</option>
            )}
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field
          label="Supplier"
          error={lookupError(entitiesQ, 'suppliers')}
          hint="Optional"
        >
          <EntitySelect
            value={supplierId}
            onChange={setSupplierId}
            options={suppliers}
            noneLabel="— none —"
          />
        </Field>
        <Field label="Supplier invoice no." hint="Optional">
          <TextInput
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
          />
        </Field>
        <Field label={`Gross (${f.cur || '—'})`} error={f.errors.gross}>
          <TextInput
            inputMode="decimal"
            value={f.gross}
            onChange={(e) => f.setGross(e.target.value)}
          />
        </Field>
        <Field label={`VAT (${f.cur || '—'})`} error={f.errors.vat}>
          <TextInput
            inputMode="decimal"
            value={f.vat}
            onChange={(e) => f.setVat(e.target.value)}
          />
        </Field>
        <Field label="Currency" error={f.errors.currency}>
          <TextInput
            value={f.currency}
            maxLength={3}
            autoCapitalize="characters"
            onChange={(e) => f.setCurrency(e.target.value)}
          />
        </Field>
        <Field label="Tax point date" error={f.errors.date}>
          <TextInput
            type="date"
            value={f.date}
            onChange={(e) => f.setDate(e.target.value)}
          />
        </Field>
        <Field
          label="Paid by (claimant)"
          hint="Only when an employee or director paid out of their own pocket"
          error={lookupError(entitiesQ, 'claimants')}
        >
          <EntitySelect
            value={claimantId}
            onChange={setClaimantId}
            options={claimants}
            noneLabel="— company paid —"
          />
        </Field>
        {claimantId !== '' && (
          <Field label="Receipt addressed to the company?">
            <SelectInput
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
            >
              <option value="">— not recorded —</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </SelectInput>
          </Field>
        )}
      </fieldset>

      <p className="text-[12px] text-ink-2">
        The source document, the AI reading and the approval history stay
        attached and cannot be edited here.
      </p>

      <SaveError message={shownError} />
      {duplicate && (
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={allowDuplicate}
            disabled={busy}
            onChange={(e) => setConsentKey(e.target.checked ? dupKey : null)}
          />
          <span>
            This is a separate purchase — save anyway (recorded in the audit
            log)
          </span>
        </label>
      )}

      <Button
        className="w-full"
        busy={busy}
        disabled={!valid || (duplicate && !allowDuplicate)}
        onClick={save}
      >
        Save draft
      </Button>
    </EditShell>
  );
}

// ── Sales invoice ──────────────────────────────────────────────────────────

export function InvoiceEditSheet({
  open,
  onOpenChange,
  invoice,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoice: SalesInvoice;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const entitiesQ = useEntities();
  const f = useFacts({
    gross: invoice.gross_amount,
    vat: invoice.vat_amount,
    currency: invoice.currency,
    date: invoice.tax_point_date,
  });
  // Identity is locked once the customer holds the document (server: 409).
  const identityLocked = invoice.sent_at != null;
  const [number, setNumber] = useState(invoice.invoice_number);
  const [customerId, setCustomerId] = useState(
    invoice.customer_id == null ? '' : String(invoice.customer_id),
  );
  const [dueDate, setDueDate] = useState(invoice.due_date ?? '');
  const [supplyType, setSupplyType] = useState<string>(
    invoice.supply_type ?? '',
  );
  const [placeRule, setPlaceRule] = useState<ServicePlaceRule>(
    invoice.service_place_rule,
  );
  const op = usePendingOperation('Edit draft invoice');
  const busy = op.pending;
  const [saveError, setSaveError] = useState<string | null>(null);
  const values = {
    ...f.draft,
    number,
    customerId,
    dueDate,
    supplyType,
    placeRule,
  };
  // Seeded once from `invoice` (initializers above) — frozen alike.
  const [baseline] = useState(values);
  const guard = useUnsavedChanges({
    label: 'Edit draft invoice',
    active: open,
    values,
    baseline,
  });

  const customers = (entitiesQ.data ?? []).filter((e) => e.role === 'customer');
  const numberError =
    number.trim() === '' ? 'The invoice number is required' : null;
  const dueError =
    dueDate !== '' && !isRealDate(dueDate) ? 'Pick a valid date' : null;
  const valid = f.valid && numberError === null && dueError === null;

  const save = () => {
    if (!valid) return;
    const id = invoice.id;
    const req = {
      ...(identityLocked
        ? {}
        : {
            invoice_number: number.trim(),
            customer_id: customerId === '' ? null : Number(customerId),
          }),
      gross_amount: f.grossC as number,
      vat_amount: f.vatC as number,
      currency: f.cur,
      tax_point_date: f.date,
      due_date: dueDate === '' ? null : dueDate,
      supply_type:
        supplyType === '' ? null : (supplyType as 'goods' | 'services'),
      service_place_rule: placeRule,
    };
    const started = op.run(
      async (ctx) => {
        await updateInvoiceDraft(id, req);
        ctx.check();
        await invalidateBooks(qc);
      },
      {
        onSuccess: () => {
          toastOk('Draft saved — submit it for posting when ready');
          guard.release();
          onSaved?.();
          onOpenChange(false);
        },
        onError: (e) => setSaveError(errText(e)),
      },
    );
    if (started) setSaveError(null);
  };

  return (
    <EditShell
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title="Edit draft invoice"
      guard={guard}
    >
      <fieldset disabled={busy} className="space-y-3">
        <Field
          label="Invoice number"
          error={identityLocked ? null : numberError}
          hint={
            identityLocked
              ? 'Locked — already sent to the customer'
              : 'Must be unique'
          }
        >
          <TextInput
            value={number}
            readOnly={identityLocked}
            disabled={identityLocked}
            onChange={(e) => setNumber(e.target.value)}
          />
        </Field>
        <Field
          label="Customer"
          error={lookupError(entitiesQ, 'customers')}
          hint={
            identityLocked
              ? 'Locked — already sent to the customer'
              : 'Optional'
          }
        >
          <EntitySelect
            value={customerId}
            onChange={setCustomerId}
            options={customers}
            noneLabel="— none —"
            disabled={identityLocked}
          />
        </Field>
        <Field label={`Gross (${f.cur || '—'})`} error={f.errors.gross}>
          <TextInput
            inputMode="decimal"
            value={f.gross}
            onChange={(e) => f.setGross(e.target.value)}
          />
        </Field>
        <Field label={`VAT (${f.cur || '—'})`} error={f.errors.vat}>
          <TextInput
            inputMode="decimal"
            value={f.vat}
            onChange={(e) => f.setVat(e.target.value)}
          />
        </Field>
        <Field label="Currency" error={f.errors.currency}>
          <TextInput
            value={f.currency}
            maxLength={3}
            autoCapitalize="characters"
            onChange={(e) => f.setCurrency(e.target.value)}
          />
        </Field>
        <Field label="Tax point date" error={f.errors.date}>
          <TextInput
            type="date"
            value={f.date}
            onChange={(e) => f.setDate(e.target.value)}
          />
        </Field>
        <Field label="Due date" hint="Optional" error={dueError}>
          <TextInput
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </Field>
        <Field label="Supply type">
          <SelectInput
            value={supplyType}
            onChange={(e) => setSupplyType(e.target.value)}
          >
            <option value="">From the customer (default)</option>
            <option value="goods">Goods</option>
            <option value="services">Services</option>
          </SelectInput>
        </Field>
        <Field
          label="Place-of-supply rule"
          hint="Services only — any rule but General is refused at posting for manual handling"
        >
          <SelectInput
            value={placeRule}
            onChange={(e) => setPlaceRule(e.target.value as ServicePlaceRule)}
          >
            {PLACE_RULES.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </SelectInput>
        </Field>
      </fieldset>

      <p className="text-[12px] text-ink-2">
        The source document and the approval history stay attached and cannot be
        edited here.
      </p>

      <SaveError message={saveError} />

      <Button className="w-full" busy={busy} disabled={!valid} onClick={save}>
        Save draft
      </Button>
    </EditShell>
  );
}
