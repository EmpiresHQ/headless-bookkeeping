import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  addEntityAlias,
  onboardEntity,
  type BankTransaction,
  type Entity,
} from '../api';
import { rethrowIfEnded, usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { useOrganizationCountry, useSuppliers } from '../queries/bank';
import { sharedKeys } from '../queries/keys';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, TextInput } from '../ui/Form';
import { lookupState, LookupNotice } from '../ui/Lookup';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';

/**
 * Supplier selection for create-from-line. No alias-lookup endpoint exists
 * (server gap) — the operator picks or creates the supplier here; on create,
 * the line's IBAN/descriptor/description are written back as aliases so the
 * server-side matcher recognizes this counterparty next time.
 */
export function SupplierSheet({
  open,
  onOpenChange,
  tx,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tx: BankTransaction;
  /** `created`: the server just onboarded it (the list may predate it). */
  onPick: (e: Entity, created: boolean) => void;
}) {
  const qc = useQueryClient();
  const suppliersQ = useSuppliers();
  const countryQ = useOrganizationCountry();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(
    tx.counterparty_descriptor ?? tx.description ?? '',
  );
  const [country, setCountry] = useState('');
  const [regKey, setRegKey] = useState('');
  const op = usePendingOperation('New supplier');
  const busy = op.pending;
  // Only the create sub-form is input to keep — the search box filters and
  // a list pick is immediate. Its name is seeded from the line (frozen).
  const values = { name, country, regKey };
  const [baseline] = useState(values);
  const guard = useUnsavedChanges({
    label: 'New supplier',
    active: open && creating,
    values,
    baseline,
  });

  // Issue #260: the organization's country is only a default once it is
  // KNOWN — a failed/pending load leaves the field empty for an explicit
  // answer instead of claiming one. A typed country always wins.
  const effCountry = country !== '' ? country : (countryQ.data ?? '');
  const countryState = lookupState(countryQ);
  const listState = lookupState(suppliersQ);
  const filtered = (suppliersQ.data ?? []).filter((e) =>
    e.name.toLowerCase().includes(q.toLowerCase()),
  );
  const createValid =
    name.trim() !== '' && regKey.trim() !== '' && effCountry.trim() !== '';

  const onCreate = () => {
    if (!createValid) return;
    const req = {
      role: 'supplier' as const,
      country: effCountry,
      name: name.trim(),
      registrationKey: regKey.trim(),
    };
    const iban = tx.counterparty_iban;
    const aliasText = tx.counterparty_descriptor ?? tx.description;
    const aliasKind = tx.counterparty_descriptor
      ? ('merchant_descriptor' as const)
      : ('name_alias' as const);
    op.run(
      async (ctx) => {
        const entity = await onboardEntity(req);
        // Best-effort alias write-back — a failed alias must not lose the
        // pick. An ended session is not "best effort": it stops here.
        try {
          if (iban) {
            ctx.check();
            await addEntityAlias(entity.id, { kind: 'iban', value: iban });
          }
          if (aliasText) {
            ctx.check();
            await addEntityAlias(entity.id, {
              kind: aliasKind,
              value: aliasText,
            });
          }
        } catch (e) {
          rethrowIfEnded(e);
          // Alias write-back is advisory; the supplier itself was created.
        }
        // Settled before the pick: no list fetch that predates the creation
        // can land after it and read as its removal (#260). A failed refresh
        // does not throw — the created supplier is still the answer.
        ctx.check();
        await qc.invalidateQueries({ queryKey: sharedKeys.entities });
        return entity;
      },
      {
        onSuccess: (entity) => {
          guard.release();
          onPick(entity, true);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Supplier"
      guard={guard}
      busy={busy}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-4 pb-4">
        {!creating && (
          <>
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Search suppliers…"
            />
            <div className="overflow-hidden rounded-2xl bg-surface">
              {filtered.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => {
                    onPick(e, false);
                    onOpenChange(false);
                  }}
                  className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14.5px] font-semibold">
                      {e.name}
                    </div>
                    <div className="truncate text-[12.5px] text-ink-2">
                      {e.country}
                    </div>
                  </div>
                </button>
              ))}
              {suppliersQ.data !== undefined && filtered.length === 0 && (
                <p className="px-3.5 py-3 text-[13px] text-ink-2">
                  {listState === 'stale'
                    ? 'No suppliers match in the list loaded earlier.'
                    : 'No suppliers match.'}
                </p>
              )}
            </div>
            <LookupNotice query={suppliersQ} what="suppliers" />
            {(listState === 'loading' || listState === 'error') && (
              <p className="text-[12.5px] text-ink-2">
                The supplier list is not available, so an existing supplier may
                not be shown — create one only if you are sure it is new.
              </p>
            )}
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setCreating(true)}
            >
              New supplier — remembered forever
            </Button>
          </>
        )}
        {creating && (
          // sanctioned one-off (approved mockup), no token — Plan 06 Task 2
          <div className="space-y-3 rounded-2xl border-[1.5px] border-dashed border-[#B7C4BA] bg-surface p-4">
            <Field label="Name" hint="Prefilled from the statement line">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div>
              <Field
                label="Country"
                hint={
                  country === '' && countryState === 'loading'
                    ? "ISO code, e.g. EE — loading the organization's country…"
                    : country === '' && countryState === 'stale'
                      ? "The organization's country as loaded earlier — it could not be refreshed; check it"
                      : 'ISO code, e.g. EE'
                }
                error={
                  country === '' && countryState === 'error'
                    ? "Couldn't load the organization's country — enter the supplier's country"
                    : undefined
                }
              >
                <TextInput
                  value={effCountry}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                  maxLength={2}
                />
              </Field>
              {country === '' &&
                (countryState === 'error' || countryState === 'stale') && (
                  <Button
                    variant="secondary"
                    className="mt-1.5 px-3 py-1.5 text-[13px]"
                    onClick={() => void countryQ.refetch()}
                  >
                    Retry organization country
                  </Button>
                )}
            </div>
            <Field
              label="Reg. key"
              hint="Registry / VAT number — required to onboard a supplier"
            >
              <TextInput
                value={regKey}
                onChange={(e) => setRegKey(e.target.value)}
              />
            </Field>
            <Button
              className="w-full"
              disabled={!createValid}
              busy={busy}
              onClick={onCreate}
            >
              Create supplier
            </Button>
            <p className="text-center text-[11px] text-ink-2">
              The line text becomes this supplier's alias — next month the
              server recognizes it by itself.
            </p>
          </div>
        )}
      </PendingFieldset>
    </Sheet>
  );
}
