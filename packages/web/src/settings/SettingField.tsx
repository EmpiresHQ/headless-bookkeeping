import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { deleteSetting, setSetting } from '../api';
import { invalidateAdminSettings } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS, TextInput } from '../ui/Form';
import { toastErr, toastOk } from '../ui/toast';

export interface SettingDef {
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  hint?: string;
}

/**
 * One validated-registry admin setting (Reality #2). Save is disabled on an
 * empty draft (the server's nonEmpty validator would 400); Clear DELETEs the
 * key (server falls back to its built-in default). The sync guard ports the
 * old combined Settings tab's: a background refetch adopts the new server
 * value ONLY while the operator has no unsaved edit.
 */
export function SettingField({
  def,
  current,
}: {
  def: SettingDef;
  current: string;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false);

  const syncedCurrent = useRef(current);
  useEffect(() => {
    if (current === syncedCurrent.current) return;
    if (draft === syncedCurrent.current) setDraft(current);
    syncedCurrent.current = current;
  }, [current, draft]);

  const run = async (fn: () => Promise<unknown>, receipt: string) => {
    setBusy(true);
    try {
      await fn();
      await invalidateAdminSettings(qc);
      toastOk(receipt);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label={def.label} hint={def.hint}>
      <div className="flex items-start gap-2">
        {def.multiline === true ? (
          <textarea
            aria-label={def.label}
            rows={3}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={`${INPUT_CLS} min-w-0 flex-1 font-mono text-[13px]`}
          />
        ) : (
          <TextInput
            aria-label={def.label}
            type={def.secret === true ? 'password' : 'text'}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={`${INPUT_CLS} min-w-0 flex-1 font-mono text-[13px]`}
          />
        )}
        <div className="flex flex-none flex-col gap-1.5">
          <Button
            busy={busy}
            disabled={busy || draft.trim().length === 0}
            onClick={() =>
              void run(
                () => setSetting(def.key, draft.trim()),
                `${def.label} saved`,
              )
            }
            aria-label={`Save ${def.label}`}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            disabled={busy || current.length === 0}
            onClick={() =>
              void run(() => deleteSetting(def.key), `${def.label} cleared`)
            }
            aria-label={`Clear ${def.label}`}
          >
            Clear
          </Button>
        </div>
      </div>
    </Field>
  );
}
