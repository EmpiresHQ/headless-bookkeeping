import { useQueryClient } from '@tanstack/react-query';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { deleteSetting, setSetting, type Setting } from '../api';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import {
  invalidateAdminSettings,
  settingsKeys,
  useAdminSettings,
} from '../queries/settings';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS, TextInput } from '../ui/Form';
import { toastErr, toastOk } from '../ui/toast';
import {
  errorMessage,
  usePendingOperation,
  wasRejected,
} from '../lib/pendingOperation';

export interface SettingDef {
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  hint?: string;
  /** What the server does while NO value is stored for this key — which is
   *  also what Clear leads to. Per key: there is no universal default (some
   *  keys inherit, some fall back to a built-in, some are simply off), and
   *  GET /admin/settings returns stored rows only, never effective values. */
  unset: string;
}

/** The last write of this key the server acknowledged (PUT echo / DELETE
 *  deleted:true), stamped with when the response arrived. */
interface Ack {
  value: string | null;
  at: number;
}

type Outcome =
  | { kind: 'saved'; value: string }
  | { kind: 'removed' }
  | {
      kind: 'failed';
      action: 'save' | 'clear';
      message: string;
      /** False when the server may still have applied it (see wasRejected). */
      definite: boolean;
      /** The stored value when it failed: an unconfirmed outcome is moot once
       *  a re-read shows a different one. */
      stored: string | null | undefined;
    };

type Tone = 'muted' | 'ok' | 'warn' | 'err';

const TONE_CLS: Record<Tone, string> = {
  muted: 'text-ink-2',
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
};

/** A stored value as it may be quoted in the status line: secrets never,
 *  long text only by size. */
function describeStored(def: SettingDef, value: string): string {
  if (def.secret === true) return 'a hidden value';
  if (def.multiline === true) return `custom text (${value.length} characters)`;
  return value.length > 48 ? `“${value.slice(0, 47)}…”` : `“${value}”`;
}

/**
 * One validated-registry admin setting (Reality #2). Every field saves ON
 * ITS OWN — there is no atomic multi-key save on the server — and says so
 * next to its buttons: what is edited but unsaved, what the server holds,
 * what Clear leads to (`def.unset`), and the outcome of its last Save/Clear.
 *
 * Save is disabled on an empty draft (the server's nonEmpty validator would
 * 400) and when it would store the value already stored; Clear DELETEs the
 * stored override and is enabled only while one is known to exist.
 *
 * What counts as stored: the settings list, EXCEPT that a write the server
 * acknowledged outranks any list older than that acknowledgement. So a
 * reload that fails (or is still running) after a Save/Clear never shows
 * the pre-write value as current; a list fetched after it wins again (the
 * mutation's invalidation cancels any fetch already in flight).
 *
 * The input stays editable while a request runs (issue #250/#251): the
 * response adopts the saved value into the field only if nothing was typed
 * meanwhile, and a background refetch adopts a new value ONLY while the
 * operator has no unsaved edit. Newer input is never overwritten and stays
 * unsaved.
 */
export function SettingField({ def }: { def: SettingDef }) {
  const qc = useQueryClient();
  const settingsQ = useAdminSettings();
  const op = usePendingOperation(def.label);
  const busy = op.pending;
  const [ack, setAck] = useState<Ack | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [inFlight, setInFlight] = useState<{
    action: 'save' | 'clear';
    sent: string;
  } | null>(null);

  const listed =
    settingsQ.data === undefined
      ? undefined
      : (settingsQ.data[def.key] ?? null);
  const fromAck =
    ack !== null && (listed === undefined || ack.at >= settingsQ.dataUpdatedAt);
  /** string = stored; null = nothing stored; undefined = not known yet. */
  const stored: string | null | undefined = fromAck ? ack.value : listed;
  const baseline = stored ?? '';

  const [draft, setDraft] = useState(baseline);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;

  // Unsaved = the draft differs from the stored value (secrets included —
  // held in memory only, never persisted).
  const guard = useUnsavedChanges({
    label: def.label,
    values: draft,
    baseline,
  });

  // Layout effect: the adoption lands before paint, so an untouched field
  // never flashes as "unsaved" for the frame the baseline moved in.
  const synced = useRef(baseline);
  useLayoutEffect(() => {
    if (baseline === synced.current) return;
    if (latestDraft.current === synced.current) setDraft(baseline);
    synced.current = baseline;
  }, [baseline]);

  // Re-read the list. Any read already in flight may predate the write, so
  // it is cancelled FIRST: invalidateQueries alone cancels a running
  // refetch but not the initial fetch of an empty cache, whose old answer
  // would then land after the acknowledgement and outrank it.
  //
  // An acknowledged write is also recorded in the SHARED list (in memory,
  // stamped with the acknowledgement time) once the cancelled read has
  // reverted: this field may unmount (the operator leaves and comes back)
  // while reads still fail, and the remounted field must not resurrect the
  // pre-write row. Only a KNOWN full list is patched — one row is never
  // seeded as a complete list (every other key would read as unset). Save
  // is only offered once the list is known, so that case does not arise
  // from here.
  const reread = (write?: { value: string | null; at: number }) =>
    void qc.cancelQueries({ queryKey: settingsKeys.admin }).then(() => {
      if (write !== undefined) {
        qc.setQueryData<Setting[]>(
          settingsKeys.admin,
          (old) =>
            old === undefined
              ? undefined
              : [
                  ...old.filter((s) => s.key !== def.key),
                  ...(write.value === null
                    ? []
                    : [{ key: def.key, value: write.value }]),
                ],
          { updatedAt: write.at },
        );
      }
      return invalidateAdminSettings(qc);
    });

  const acknowledge = (value: string | null, adopt: boolean) => {
    const next = value ?? '';
    if (adopt) setDraft(next);
    synced.current = next;
    const write = { value, at: Date.now() };
    setAck(write);
    reread(write);
  };

  const fail = (action: 'save' | 'clear') => (e: unknown) => {
    const message = errorMessage(e);
    const definite = wasRejected(e);
    setOutcome({ kind: 'failed', action, message, definite, stored });
    toastErr(message);
    // It may have applied: let the list say what is stored now.
    if (!definite) reread();
  };

  const save = () => {
    const sent = draft;
    const value = draft.trim();
    const started = op.run(() => setSetting(def.key, value), {
      onSuccess: (res) => {
        // Show exactly what the server holds (the typed value, trimmed) —
        // unless the operator kept typing: that newer draft stays unsaved.
        acknowledge(res.value, latestDraft.current === sent);
        setOutcome({ kind: 'saved', value: res.value });
        setInFlight(null);
        toastOk(`${def.label} saved`);
      },
      onError: (e) => {
        setInFlight(null);
        fail('save')(e);
      },
    });
    if (started) {
      setOutcome(null);
      setInFlight({ action: 'save', sent });
    }
  };

  const clear = () => {
    const sent = draft;
    const started = op.run(() => deleteSetting(def.key), {
      onSuccess: () => {
        // The field empties only if it still showed the removed value; an
        // unsaved edit (typed before or during the Clear) stays, unsaved.
        acknowledge(null, latestDraft.current === synced.current);
        setOutcome({ kind: 'removed' });
        setInFlight(null);
        toastOk(`${def.label} cleared`);
      },
      onError: (e) => {
        setInFlight(null);
        fail('clear')(e);
      },
    });
    if (started) {
      setOutcome(null);
      setInFlight({ action: 'clear', sent });
    }
  };

  const edit = (v: string) => {
    setDraft(v);
    if (outcome?.kind === 'failed') setOutcome(null);
  };

  const dirty = guard.dirty;
  const status = ((): { tone: Tone; text: string } => {
    const unsavedTail = dirty ? ' Your edit is not saved yet.' : '';
    if (busy && inFlight !== null) {
      const newer =
        draft !== inFlight.sent
          ? ' Your newer edit is not included and stays unsaved.'
          : '';
      return inFlight.action === 'save'
        ? { tone: 'muted', text: `Saving…${newer}` }
        : {
            tone: 'muted',
            text: `Removing the stored value…${newer === '' ? unsavedTail : newer}`,
          };
    }
    if (outcome?.kind === 'failed' && outcome.definite) {
      return outcome.action === 'save'
        ? {
            tone: 'err',
            text: `Not saved — ${outcome.message}. Your input is kept.`,
          }
        : { tone: 'err', text: `Not cleared — ${outcome.message}.` };
    }
    if (outcome?.kind === 'failed' && outcome.stored === stored) {
      return outcome.action === 'save'
        ? {
            tone: 'warn',
            text: `Save not confirmed — ${outcome.message}. It may or may not have been stored; your input is kept.`,
          }
        : {
            tone: 'warn',
            text: `Clear not confirmed — ${outcome.message}. The stored value may or may not have been removed.`,
          };
    }
    if (stored === undefined) {
      return settingsQ.isError
        ? {
            tone: 'warn',
            text: `Stored value unknown — settings could not be loaded. Save waits until it is known.${unsavedTail}`,
          }
        : {
            tone: 'muted',
            text: `Loading the stored value… Save waits until it is known.${unsavedTail}`,
          };
    }
    // The list shown is older than it should be: say which source we show.
    const qualifier = !settingsQ.isError
      ? ''
      : fromAck
        ? ' Settings could not be reloaded; this is the change the server confirmed.'
        : ' Could not refresh — this is the last known value.';
    // What Clear leads to, stated while there is something to clear.
    const ifCleared = ` Clear deletes the stored value; then: ${def.unset}`;
    if (dirty) {
      const now =
        stored === null
          ? `Nothing stored yet. ${def.unset}`
          : `Stored now: ${describeStored(def, stored)}.${ifCleared}`;
      return {
        tone: 'warn',
        text: `Unsaved edit — Save stores this field only. ${now}${qualifier}`,
      };
    }
    if (stored === null) {
      return outcome?.kind === 'removed'
        ? {
            tone: 'ok',
            text: `Stored value removed. ${def.unset}${qualifier}`,
          }
        : { tone: 'muted', text: `Nothing stored. ${def.unset}${qualifier}` };
    }
    if (outcome?.kind === 'saved' && outcome.value === stored) {
      return { tone: 'ok', text: `Saved.${ifCleared}${qualifier}` };
    }
    return {
      tone: 'muted',
      text: `Stored on the server.${ifCleared}${qualifier}`,
    };
  })();

  const uid = useId();
  const hintId = `${uid}-hint`;
  const statusId = `${uid}-status`;
  const describedBy = def.hint != null ? `${hintId} ${statusId}` : statusId;

  return (
    <div>
      <Field label={def.label}>
        {def.multiline === true ? (
          <textarea
            aria-label={def.label}
            aria-describedby={describedBy}
            rows={3}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => edit(e.target.value)}
            className={`${INPUT_CLS} font-mono text-[13px]`}
          />
        ) : (
          <TextInput
            aria-label={def.label}
            aria-describedby={describedBy}
            type={def.secret === true ? 'password' : 'text'}
            placeholder={def.placeholder}
            value={draft}
            onChange={(e) => edit(e.target.value)}
            className={`${INPUT_CLS} font-mono text-[13px]`}
          />
        )}
      </Field>
      {def.hint != null && (
        <span id={hintId} className="mt-1 block text-xs text-ink-2">
          {def.hint}
        </span>
      )}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <p
          id={statusId}
          data-testid={`setting-status-${def.key}`}
          className={`min-w-0 flex-1 basis-40 text-[12px] leading-snug ${TONE_CLS[status.tone]}`}
        >
          {status.text}
        </p>
        <div className="flex flex-none gap-1.5">
          {stored === undefined && settingsQ.isError && (
            <Button
              variant="secondary"
              onClick={() => void settingsQ.refetch()}
              aria-label={`Retry loading ${def.label}`}
            >
              Retry
            </Button>
          )}
          <Button
            busy={busy && inFlight?.action === 'save'}
            disabled={
              busy ||
              stored === undefined ||
              draft.trim().length === 0 ||
              draft.trim() === stored
            }
            onClick={save}
            aria-label={`Save ${def.label}`}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            busy={busy && inFlight?.action === 'clear'}
            disabled={busy || stored == null}
            onClick={clear}
            aria-label={`Clear ${def.label}`}
          >
            Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The screen-level rule for a group of SettingFields. */
export function IndependentSaveNote({
  className = 'mx-6 mb-3',
}: {
  className?: string;
}) {
  return (
    <p className={`${className} text-[12.5px] text-ink-2`}>
      Each setting is saved on its own: <b>Save</b> stores only that field and{' '}
      <b>Clear</b> deletes only its stored value — the line under each field
      says what then applies. Edits in other fields stay unsaved until you save
      them.
    </p>
  );
}
