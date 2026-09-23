import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { deleteSetting, setSetting } from '../api';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { invalidateAdminSettings } from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS, TextInput } from '../ui/Form';
import { toastOk } from '../ui/toast';
import { usePendingOperation } from '../lib/pendingOperation';

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
  const op = usePendingOperation(def.label);
  const busy = op.pending;

  // Unsaved = the draft differs from the server value (secrets included —
  // held in memory only, never persisted).
  const guard = useUnsavedChanges({
    label: def.label,
    values: draft,
    baseline: current,
  });
  const latestDraft = useRef(draft);
  latestDraft.current = draft;

  const syncedCurrent = useRef(current);
  useEffect(() => {
    if (current === syncedCurrent.current) return;
    if (draft === syncedCurrent.current) setDraft(current);
    syncedCurrent.current = current;
  }, [current, draft]);

  const run = (fn: () => Promise<unknown>, receipt: string, saved?: string) => {
    const sent = draft;
    op.run(fn, {
      onSuccess: () => {
        // Saved as typed-then-trimmed: show exactly what the server holds,
        // and release that SUBMITTED snapshot until the refetch brings it
        // back as `current` — unless the operator kept typing meanwhile
        // (then that newer draft stays unsaved).
        if (saved !== undefined && latestDraft.current === sent) {
          setDraft(saved);
          guard.release(saved);
        }
        void invalidateAdminSettings(qc);
        toastOk(receipt);
      },
    });
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
              run(
                () => setSetting(def.key, draft.trim()),
                `${def.label} saved`,
                draft.trim(),
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
              run(() => deleteSetting(def.key), `${def.label} cleared`)
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
