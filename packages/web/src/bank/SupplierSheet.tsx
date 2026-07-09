import { useState } from 'react';
import {
  addEntityAlias,
  onboardEntity,
  type BankTransaction,
  type Entity,
} from '../api';
import { useOrganizationCountry, useSuppliers } from '../queries/bank';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';

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
  onPick: (e: Entity) => void;
}) {
  const suppliersQ = useSuppliers();
  const countryQ = useOrganizationCountry();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(
    tx.counterparty_descriptor ?? tx.description ?? '',
  );
  const [country, setCountry] = useState('');
  const [regKey, setRegKey] = useState('');
  const [busy, setBusy] = useState(false);

  const effCountry = country !== '' ? country : (countryQ.data ?? 'EE');
  const filtered = (suppliersQ.data ?? []).filter((e) =>
    e.name.toLowerCase().includes(q.toLowerCase()),
  );

  const onCreate = async () => {
    setBusy(true);
    try {
      const entity = await onboardEntity({
        role: 'supplier',
        country: effCountry,
        name: name.trim(),
        registrationKey: regKey.trim(),
      });
      // Best-effort alias write-back — a failed alias must not lose the pick.
      try {
        if (tx.counterparty_iban) {
          await addEntityAlias(entity.id, {
            kind: 'iban',
            value: tx.counterparty_iban,
          });
        }
        const aliasText = tx.counterparty_descriptor ?? tx.description;
        if (aliasText) {
          await addEntityAlias(entity.id, {
            kind: tx.counterparty_descriptor
              ? 'merchant_descriptor'
              : 'name_alias',
            value: aliasText,
          });
        }
      } catch {
        // Alias write-back is advisory; the supplier itself was created.
      }
      onPick(entity);
      onOpenChange(false);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Supplier">
      <div className="space-y-3 px-4 pb-4">
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
                    onPick(e);
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
              {suppliersQ.isSuccess && filtered.length === 0 && (
                <p className="px-3.5 py-3 text-[13px] text-ink-2">
                  No suppliers match.
                </p>
              )}
            </div>
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
          <div className="space-y-3 rounded-2xl border-[1.5px] border-dashed border-[#B7C4BA] bg-surface p-4">
            <Field label="Name" hint="Prefilled from the statement line">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Country" hint="ISO code, e.g. EE">
              <TextInput
                value={effCountry}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                maxLength={2}
              />
            </Field>
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
              disabled={
                name.trim() === '' ||
                regKey.trim() === '' ||
                effCountry.trim() === ''
              }
              busy={busy}
              onClick={() => void onCreate()}
            >
              Create supplier
            </Button>
            <p className="text-center text-[11px] text-ink-2">
              The line text becomes this supplier's alias — next month the
              server recognizes it by itself.
            </p>
          </div>
        )}
      </div>
    </Sheet>
  );
}
