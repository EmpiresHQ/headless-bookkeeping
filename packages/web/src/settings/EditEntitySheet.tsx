import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { updateEntity, type Entity, type TaxStatus } from '../api';
import { invalidateEntities } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, PendingFieldset, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';
import { usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';

/** Edit sheet — EXACTLY the server's PATCH surface: name, country,
 *  goods/services, tax status (identity fields are immutable). */
export function EditEntitySheet({
  entity,
  open,
  onClose,
}: {
  entity: Entity;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const op = usePendingOperation('Edit entity');
  const busy = op.pending;
  const [name, setName] = useState(entity.name);
  const [country, setCountry] = useState(entity.country);
  const [goods, setGoods] = useState<'goods' | 'services' | 'unknown'>(
    entity.goods_vs_services === 'goods' ||
      entity.goods_vs_services === 'services'
      ? entity.goods_vs_services
      : 'unknown',
  );
  const [taxStatus, setTaxStatus] = useState<TaxStatus>(
    entity.tax_status === 'taxable_business' ||
      entity.tax_status === 'non_taxable'
      ? entity.tax_status
      : 'unknown',
  );

  const values = { name, country, goods, taxStatus };
  const [baseline] = useState(values);
  const guard = useUnsavedChanges({
    label: 'Edit entity',
    active: open,
    values,
    baseline,
  });
  const valid = name.trim() !== '' && country.trim() !== '';

  const submit = () => {
    op.run(
      () =>
        updateEntity(entity.id, {
          name: name.trim(),
          country: country.trim().toUpperCase(),
          goodsVsServices: goods,
          taxStatus,
        }),
      {
        onSuccess: () => {
          toastOk('Entity updated');
          guard.release();
          onClose();
          void invalidateEntities(qc);
        },
        onError: (e) => {
          toastErr(e instanceof Error ? e.message : String(e));
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      guard={guard}
      busy={busy}
      title="Edit entity"
    >
      <PendingFieldset pending={busy} className="space-y-4 px-6 pb-2">
        <Field label="Name">
          <TextInput
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Country">
          <TextInput
            aria-label="Country"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            maxLength={2}
          />
        </Field>
        <Field label="Goods or services">
          <SelectInput
            aria-label="Goods or services"
            value={goods}
            onChange={(e) =>
              setGoods(e.target.value as 'goods' | 'services' | 'unknown')
            }
          >
            <option value="unknown">Unknown</option>
            <option value="goods">Goods</option>
            <option value="services">Services</option>
          </SelectInput>
        </Field>
        <Field
          label="Tax status"
          hint="Whether this counterparty is a business acting as such. Needed before a cross-border service invoice can be posted — while it is unknown the server refuses rather than guessing."
        >
          <SelectInput
            aria-label="Tax status"
            value={taxStatus}
            onChange={(e) => setTaxStatus(e.target.value as TaxStatus)}
          >
            <option value="unknown">Unknown</option>
            <option value="taxable_business">Business (taxable person)</option>
            <option value="non_taxable">Consumer (non-taxable)</option>
          </SelectInput>
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={submit}
        >
          Save changes
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}
