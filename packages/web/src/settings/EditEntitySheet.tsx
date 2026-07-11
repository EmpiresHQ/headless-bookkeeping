import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { updateEntity, type Entity } from '../api';
import { invalidateEntities } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/** Edit sheet — EXACTLY the server's PATCH surface: name, country,
 *  goods/services (Reality #5; identity fields are immutable). */
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
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(entity.name);
  const [country, setCountry] = useState(entity.country);
  const [goods, setGoods] = useState<'goods' | 'services' | 'unknown'>(
    entity.goods_vs_services === 'goods' ||
      entity.goods_vs_services === 'services'
      ? entity.goods_vs_services
      : 'unknown',
  );

  const valid = name.trim() !== '' && country.trim() !== '';

  const submit = async () => {
    setBusy(true);
    try {
      await updateEntity(entity.id, {
        name: name.trim(),
        country: country.trim().toUpperCase(),
        goodsVsServices: goods,
      });
      toastOk('Entity updated');
      onClose();
      void invalidateEntities(qc);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Edit entity"
    >
      <div className="space-y-4 px-6 pb-2">
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
        <Button
          className="w-full"
          busy={busy}
          disabled={!valid || busy}
          onClick={() => void submit()}
        >
          Save changes
        </Button>
      </div>
    </Sheet>
  );
}
