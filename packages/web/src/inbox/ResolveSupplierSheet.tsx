import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getPendingDraft,
  onboardEntity,
  resolveSupplier,
  type TriageOutcome,
} from '../api';
import { inboxKeys } from '../queries/inbox';
import { useSuppliers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';
import { absoluteDateFromIso, signedEuros } from './format';

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
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [regKey, setRegKey] = useState('');
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (!prefilled && draftQ.data !== undefined) {
      setName(draftQ.data.supplier_proposal.create_name);
      setCountry(draftQ.data.supplier_proposal.create_country);
      setRegKey(draftQ.data.supplier_proposal.create_registration_key);
      setPrefilled(true);
    }
  }, [draftQ.data, prefilled]);

  const draft = draftQ.data?.draft;
  const amount = draft !== undefined ? signedEuros(-draft.gross_amount) : null;

  const finish = async (supplierEntityId: number) => {
    setBusy(true);
    try {
      onDone(await resolveSupplier(documentId, supplierEntityId));
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    setBusy(true);
    try {
      const entity = await onboardEntity({
        role: 'supplier',
        name: name.trim(),
        country: country.trim(),
        registrationKey: regKey.trim(),
      });
      onDone(await resolveSupplier(documentId, entity.id));
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const createValid =
    name.trim() !== '' && country.trim() !== '' && regKey.trim() !== '';
  const matches = (suppliersQ.data ?? [])
    .filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 6);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Resolve supplier">
      <div className="space-y-3 px-5 pb-2">
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
          onClick={() => void onCreate()}
        >
          {amount !== null
            ? `Create supplier & book · ${amount}`
            : 'Create supplier & book'}
        </Button>
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
              onClick={() => void finish(s.id)}
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
      </div>
    </Sheet>
  );
}
