import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { addEntityAlias, type AddAliasInput } from '../api';
import { ALIAS_KIND_LABEL, invalidateEntities } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

const KINDS: AddAliasInput['kind'][] = [
  'merchant_descriptor',
  'iban',
  'name_alias',
];

/** Add-alias sheet — exactly the three kinds the endpoint accepts
 *  (Reality #5). Aliases teach reconciliation to recognise this
 *  counterparty on bank lines and documents (ADR-0014). */
export function AddAliasSheet({
  entityId,
  open,
  onClose,
}: {
  entityId: number;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<AddAliasInput['kind']>(
    'merchant_descriptor',
  );
  const [value, setValue] = useState('');

  const submit = async () => {
    setBusy(true);
    try {
      await addEntityAlias(entityId, { kind, value: value.trim() });
      toastOk('Alias added');
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
      title="Add alias"
    >
      <div className="space-y-4 px-6 pb-2">
        <p className="text-[12.5px] text-ink-2">
          How documents and bank lines name this counterparty — an IBAN or card
          descriptor lets reconciliation recognise it automatically.
        </p>
        <Field label="Kind">
          <SelectInput
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as AddAliasInput['kind'])}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {ALIAS_KIND_LABEL[k]}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Value">
          <TextInput
            aria-label="Value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. CIRCLE K 4411"
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={busy || value.trim() === ''}
          onClick={() => void submit()}
        >
          Add alias
        </Button>
      </div>
    </Sheet>
  );
}
