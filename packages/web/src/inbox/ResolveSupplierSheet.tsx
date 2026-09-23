import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getPendingDraft,
  onboardEntity,
  resolveSupplier,
  type TriageOutcome,
} from '../api';
import { signedEuros } from '../lib/money';
import { usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { inboxKeys } from '../queries/inbox';
import { useSuppliers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';
import { absoluteDateFromIso } from './format';

/**
 * Triage flow 1 — "who is this supplier?" Prefill → confirm: the AI proposal
 * (name/country/reg-key + the parsed draft) is already filled in; the
 * operator verifies or picks an existing supplier instead. Booking happens
 * server-side via resolve-supplier (the parked draft is completed).
 */
export function ResolveSupplierSheet({
  documentId,
  open,
  onOpenChange,
  onDone,
}: {
  documentId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (o: TriageOutcome) => void;
}) {
  const draftQ = useQuery({
    queryKey: inboxKeys.pendingDraft(documentId),
    queryFn: () => getPendingDraft(documentId),
    enabled: open,
  });
  const suppliersQ = useSuppliers();
  const [q, setQ] = useState('');
  const op = usePendingOperation('Resolve supplier');
  const busy = op.pending;
  // Partial success (issue #251): the supplier was created but resolving
  // the document failed. Bound to the exact identity it was created from —
  // a retry of the SAME input only resolves (never a second supplier).
  const created = useRef<{
    key: string;
    entityId: number;
    name: string;
  } | null>(null);
  const [createdShown, setCreatedShown] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [regKey, setRegKey] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  // What the proposal offered, committed with the prefill: the offered
  // values are not unsaved input, anything typed over them is.
  const [prefillBase, setPrefillBase] = useState({
    name: '',
    country: '',
    regKey: '',
  });

  // Untouched-only functional updates (ClassifyExpenseSheet's pattern): the
  // operator may already be typing when the draft lands.
  useEffect(() => {
    if (!prefilled && draftQ.data !== undefined) {
      const proposal = draftQ.data.supplier_proposal;
      const offered =
        proposal.kind === 'create'
          ? {
              name: proposal.create_name,
              country: proposal.create_country,
              regKey: proposal.create_registration_key ?? '',
            }
          : {
              name: '',
              country: proposal.observed_country ?? '',
              regKey: proposal.observed_registration_key ?? '',
            };
      setName((cur) => (cur === '' ? offered.name : cur));
      setCountry((cur) => (cur === '' ? offered.country : cur));
      setRegKey((cur) => (cur === '' ? offered.regKey : cur));
      setPrefillBase(offered);
      setPrefilled(true);
    }
  }, [draftQ.data, prefilled]);

  // The search box is a filter. Picking an existing supplier or creating
  // one both complete the task, so either success releases the form.
  const guard = useUnsavedChanges({
    label: 'Resolve supplier',
    active: open,
    values: { name, country, regKey },
    baseline: prefillBase,
  });

  const draft = draftQ.data?.draft;
  const amount = draft !== undefined ? signedEuros(-draft.gross_amount) : null;

  const finish = (supplierEntityId: number) => {
    op.run(() => resolveSupplier(documentId, supplierEntityId), {
      onSuccess: (outcome) => {
        guard.release();
        onDone(outcome);
      },
    });
  };

  const createKey = JSON.stringify([
    name.trim(),
    country.trim(),
    regKey.trim(),
  ]);
  const landed =
    created.current !== null && created.current.key === createKey
      ? created.current
      : null;

  const onCreate = () => {
    const key = createKey;
    const req = {
      role: 'supplier' as const,
      name: name.trim(),
      country: country.trim(),
      registrationKey: regKey.trim(),
    };
    const resume = landed;
    op.run(
      async (ctx) => {
        let entityId: number;
        if (resume !== null) {
          entityId = resume.entityId;
        } else {
          const entity = await onboardEntity(req);
          entityId = entity.id;
          created.current = { key, entityId, name: entity.name };
        }
        ctx.check();
        return resolveSupplier(documentId, entityId);
      },
      {
        onSuccess: (outcome) => {
          guard.release();
          onDone(outcome);
        },
        onError: (e) => {
          const c = created.current;
          const message = e instanceof Error ? e.message : String(e);
          if (c !== null && c.key === key) {
            setCreatedShown(c.entityId);
            toastErr(
              `Supplier “${c.name}” was created, but booking the document failed: ${message}`,
            );
          } else {
            toastErr(message);
          }
        },
      },
    );
  };

  const createValid =
    name.trim() !== '' && country.trim() !== '' && regKey.trim() !== '';
  const matches = (suppliersQ.data ?? [])
    .filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 6);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Resolve supplier"
      guard={guard}
      busy={busy}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-5 pb-2">
        {draftQ.isPending && (
          <p className="text-[13px] text-ink-2">Loading the AI proposal…</p>
        )}
        {draftQ.isError && (
          <p className="text-[13px] font-semibold text-err">
            {draftQ.error instanceof Error
              ? draftQ.error.message
              : 'Failed to load the proposal'}
          </p>
        )}
        {draft !== undefined && (
          <p className="text-[13px] text-ink-2">
            AI read: {draft.category} · {signedEuros(-draft.gross_amount)} ·{' '}
            {absoluteDateFromIso(draft.tax_point_date)}
          </p>
        )}
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Country">
              <TextInput
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Reg. key" hint="Required — identity of the supplier">
              <TextInput
                value={regKey}
                onChange={(e) => setRegKey(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <Button
          className="w-full"
          busy={busy}
          disabled={!createValid || draft === undefined}
          onClick={onCreate}
        >
          {landed !== null
            ? 'Retry booking with the created supplier'
            : amount !== null
              ? `Create supplier & book · ${amount}`
              : 'Create supplier & book'}
        </Button>
        {landed !== null && createdShown === landed.entityId && (
          <p className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            Supplier “{landed.name}” already exists on the server — only booking
            the document failed. Retrying books it with that supplier; it does
            not create another one.
          </p>
        )}
        <p className="pt-1 text-center text-[11px] font-bold uppercase tracking-wide text-ink-2">
          or pick an existing supplier
        </p>
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Search suppliers…"
        />
        <div className="overflow-hidden rounded-2xl bg-surface">
          {matches.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => finish(s.id)}
              className="flex w-full items-center justify-between border-b border-line px-3.5 py-3 text-left text-[14px] font-semibold last:border-b-0 disabled:opacity-50"
            >
              {s.name}
              <span className="text-[12px] font-normal text-ink-2">
                {s.country}
              </span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-3.5 py-3 text-[12.5px] text-ink-2">No matches</p>
          )}
        </div>
      </PendingFieldset>
    </Sheet>
  );
}
