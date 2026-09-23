import {
  isValidElement,
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type {
  FormEvent,
  FormHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { HttpError } from '../auth';

export const INPUT_CLS =
  'w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-[15px] outline-none focus:border-accent disabled:opacity-50';

/**
 * Label + control + hint/error. hint/error are wired to the control via
 * aria-describedby when the child is a single element (P01 triage item).
 * `group` renders a role="group" with aria-labelledby instead of a <label>
 * — for chip/radio clusters where a <label> would click-forward to the
 * first labelable descendant (P03 triage item).
 */
export function Field({
  label,
  error,
  hint,
  group = false,
  required = false,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  group?: boolean;
  /** Marks the field required (issue #265) — muted, never red by itself.
   *  A control gets aria-required and is named by the label text alone
   *  (explicit aria-labelledby; the visible marker is aria-hidden). A
   *  group (no aria-required role) gets the marker as a description. */
  required?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const labelId = `${id}-label`;
  const reqId = `${id}-req`;
  const hasDesc = error != null || hint != null;
  const child =
    !group && isValidElement(children) && (hasDesc || required)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          ...(hasDesc ? { 'aria-describedby': descId } : {}),
          ...(error != null ? { 'aria-invalid': true } : {}),
          ...(required
            ? { 'aria-required': true, 'aria-labelledby': labelId }
            : {}),
        })
      : children;
  const labelSpan = (
    <span className="mb-1 block text-[13px] font-semibold">
      <span id={group || required ? labelId : undefined}>{label}</span>
      {required && (
        <span
          id={group ? reqId : undefined}
          aria-hidden={group ? undefined : true}
          className="ml-1.5 text-[11px] font-normal text-ink-2"
        >
          required
        </span>
      )}
    </span>
  );
  const desc = (
    <>
      {hint != null && error == null && (
        <span id={descId} className="mt-1 block text-xs text-ink-2">
          {hint}
        </span>
      )}
      {error != null && (
        <span id={descId} className="mt-1 block text-xs text-err">
          {error}
        </span>
      )}
    </>
  );
  if (group) {
    const describedBy =
      [hasDesc ? descId : null, required ? reqId : null]
        .filter((x) => x !== null)
        .join(' ') || undefined;
    return (
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={error != null ? true : undefined}
      >
        {labelSpan}
        {child}
        {desc}
      </div>
    );
  }
  return (
    <div>
      <label className="block">
        {labelSpan}
        {child}
      </label>
      {desc}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={INPUT_CLS} {...props} />;
}

export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={INPUT_CLS} {...props} />;
}

/**
 * Locks a form while its operation is in flight (issue #251): every native
 * control inside is disabled, so what was submitted is what the success
 * continuation releases — nothing typed mid-request is silently dropped.
 * The status line is a live region that exists before it has text, so the
 * progress is announced as well as shown. Deliberately NO aria-busy on the
 * fieldset: assistive tech may defer a busy subtree's live announcements
 * until busy clears — exactly when this text disappears.
 */
export function PendingFieldset({
  pending,
  status = 'Saving… the form is locked until the server answers.',
  className = '',
  children,
}: {
  pending: boolean;
  status?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset
      disabled={pending}
      className={`m-0 min-w-0 border-0 p-0 ${className}`}
    >
      {children}
      <p role="status" className="text-center text-[12.5px] text-ink-2">
        {pending ? status : ''}
      </p>
    </fieldset>
  );
}

/**
 * A form's ONE submit path (issue #266): the submit button's click, Enter in
 * a field (the browser's implicit submission through the default button)
 * and `requestSubmit()` all arrive here — never a page load. `noValidate`:
 * the form's own checks (useFormErrors) decide, never a browser bubble. The
 * caller's `onSubmit` holds every guard (blocker, field errors, the pending
 * operation's duplicate lock), since a programmatic submit ignores the
 * disabled button. A submit of ANOTHER form that bubbles here through the
 * React tree (a portalled inner form, see CounterpartyField) is not ours.
 * An Enter that belongs to an IME composition never submits it.
 */
export function SubmitForm({
  onSubmit,
  onKeyDown,
  children,
  ...rest
}: Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'noValidate'> & {
  onSubmit: () => void;
}) {
  return (
    <form
      {...rest}
      noValidate
      onKeyDown={(e) => {
        blockComposingEnter(e);
        onKeyDown?.(e);
      }}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (e.target !== e.currentTarget) return;
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/**
 * onKeyDown for an ancestor of a form's controls: an Enter that belongs to
 * an IME composition (it commits the candidate) must not submit the form.
 * Browsers are not uniform — Chromium can report the Enter keydown of an
 * active composition as `isComposing` with keyCode 13 and then submit;
 * Safari fires compositionend BEFORE the committing keydown, so that one has
 * `isComposing` false and only keyCode 229 tells it. Only that Enter is
 * cancelled: a plain Enter (submit, or a textarea's newline) is untouched.
 * No compositionstart/end tracking: with Safari's order it would already be
 * cleared when the keydown arrives, and the event itself carries both marks.
 */
export function blockComposingEnter(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Enter') return;
  if (e.nativeEvent.isComposing || e.keyCode === 229) e.preventDefault();
}

/** onKeyDown for a field whose Enter must NOT submit its form (e.g. a
 *  search that only narrows a list). */
export function noImplicitSubmit(e: KeyboardEvent<HTMLElement>) {
  if (e.key === 'Enter') e.preventDefault();
}

const isBlank = (v: unknown) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

type ServerFeedback<K extends string> = {
  /** Mapped field errors, each held only while the field still holds the
   *  value that was sent. */
  fields: Partial<Record<K, { message: string; sent: unknown }>>;
  /** Everything that names no known field — shown whole, never guessed. */
  messages: string[];
  /** What is known about the refused/failed attempt, stated truthfully by
   *  the caller (refused, unknown outcome, partly saved…). */
  heading: string;
};

/** Neutral default: the outcome is not claimed — a network failure or a
 *  later stage of a chain may leave something saved. */
export const REFUSED_HEADING =
  'Not saved — the server refused these values. Your input is kept.';

export const DEFAULT_FAILURE_HEADING =
  'That did not complete — your input is kept. Check the message below before trying again.';

/**
 * Field-level validation feedback for a form (issue #265).
 *
 * - `errors` are the CURRENT client errors, recomputed by the caller every
 *   render — so an error clears the moment its field is fixed, and the
 *   summary never lists a corrected field.
 * - An error is revealed after a submit attempt, or after the field is left
 *   (blur) holding a non-blank value: a blank required field is never red
 *   before the operator tried to submit.
 * - `attempt()` is the submit click's gate: false (and nothing sent) while
 *   any client error exists; the first invalid field is focused.
 * - `failed(e, sent)` records a refused request: the Zod pipe's structured
 *   400 is mapped key by key through `serverFields`; anything else — an
 *   unmapped key, `_errors`, a free-text Nest message — stays as a
 *   persistent form-level message. Call it only from a live operation
 *   continuation (usePendingOperation's onError).
 * - Focus moves only in answer to the operator's own submit (or its live
 *   failure), and only onto an element still in this mounted form.
 */
export function useFormErrors<K extends string>(cfg: {
  errors: Record<K, string | null>;
  values: Record<K, unknown>;
  labels: Record<K, string>;
  /** Server payload key → field. */
  serverFields?: Partial<Record<string, K>>;
  /** No client checks at all (e.g. the facts are the server's already). */
  off?: boolean;
}) {
  const base = useId();
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<K>>(() => new Set());
  const [server, setServer] = useState<ServerFeedback<K> | null>(null);
  const [focusReq, setFocusReq] = useState(0);
  const handledFocus = useRef(0);
  const keys = Object.keys(cfg.errors) as K[];
  const idOf = (k: K) => `${base}-f-${k}`;
  const summaryId = `${base}-summary`;

  const clientError = (k: K) => (cfg.off ? null : cfg.errors[k]);
  const revealed = (k: K) =>
    attempted || (touched.has(k) && !isBlank(cfg.values[k]));
  const serverError = (k: K) => {
    const s = server?.fields[k];
    return s !== undefined && Object.is(s.sent, cfg.values[k])
      ? s.message
      : null;
  };
  const error = (k: K) =>
    (revealed(k) ? clientError(k) : null) ?? serverError(k);
  const invalid = keys.filter((k) => clientError(k) !== null);

  const firstShown = keys.find((k) => error(k) !== null);
  const summaryShown = server !== null;
  // Runs after every commit of this (mounted) form: a request made while
  // the pending fieldset still disables the target waits for the commit
  // that releases it, instead of being dropped.
  useEffect(() => {
    if (focusReq === handledFocus.current) return;
    const target =
      firstShown !== undefined
        ? document.getElementById(idOf(firstShown))
        : summaryShown
          ? document.getElementById(summaryId)
          : null;
    if (target === null || !target.isConnected) {
      handledFocus.current = focusReq;
      return;
    }
    // Not yet focusable (locked while the operation settles): try again
    // on the next commit.
    if (target.closest('fieldset:disabled') !== null) return;
    handledFocus.current = focusReq;
    target.focus();
  });

  return {
    /** The error to show at field k (client or server), or null. */
    error,
    /** Props for the field's focusable control. */
    bind: (k: K) => ({
      id: idOf(k),
      onBlur: () => setTouched((t) => (t.has(k) ? t : new Set([...t, k]))),
    }),
    idOf,
    summaryId,
    /** No client error (revealed or not). */
    valid: invalid.length === 0,
    attempted,
    /** Submit click gate: reveal, focus the first error, false = don't send. */
    attempt: (): boolean => {
      setAttempted(true);
      setServer(null);
      if (invalid.length > 0) {
        setFocusReq((n) => n + 1);
        return false;
      }
      return true;
    },
    /** Reveal every client error without an attempt (a summary link). */
    reveal: () => setAttempted(true),
    /** A refused request. `sent` = the field values it carried; null maps
     *  nothing to a field (e.g. a later stage of a chain failed). */
    failed: (
      e: unknown,
      sent: Partial<Record<K, unknown>> | null,
      heading?: string,
    ) => {
      const fields: ServerFeedback<K>['fields'] = {};
      const messages: string[] = [];
      const v = e instanceof HttpError ? e.validation : null;
      const map = cfg.serverFields ?? {};
      if (v !== null) {
        for (const [key, msgs] of Object.entries(v.fields)) {
          // Only an OWN mapping to one of this form's fields counts — a
          // key like "constructor" stays a message, never vanishes.
          const k = Object.prototype.hasOwnProperty.call(map, key)
            ? map[key]
            : undefined;
          if (
            sent !== null &&
            k !== undefined &&
            keys.includes(k) &&
            fields[k] === undefined
          ) {
            fields[k] = { message: msgs.join('; '), sent: sent[k] };
          } else {
            messages.push(`${key}: ${msgs.join('; ')}`);
          }
        }
        messages.push(...v.formErrors);
      } else {
        messages.push(e instanceof Error ? e.message : String(e));
      }
      // The Zod pipe answers before any handler runs: nothing was stored.
      // Anything else is the caller's to state (or stays neutral).
      setServer({
        fields,
        messages,
        heading:
          heading ?? (v !== null ? REFUSED_HEADING : DEFAULT_FAILURE_HEADING),
      });
      setFocusReq((n) => n + 1);
    },
    /** Summary rows: current errors (all after an attempt, else those the
     *  server raised), then the server's unmapped messages. */
    summary: {
      id: summaryId,
      fields: keys
        .filter((k) =>
          attempted ? error(k) !== null : serverError(k) !== null,
        )
        .map((k) => ({
          key: k,
          id: idOf(k),
          label: cfg.labels[k],
          message: error(k) as string,
        })),
      /** Still-invalid fields while the submit is structurally blocked —
       *  what else needs doing, stated without red. */
      pending: attempted
        ? []
        : invalid.map((k) => ({ key: k, id: idOf(k), label: cfg.labels[k] })),
      messages: server?.messages ?? [],
      /** The last attempt failed (its heading is shown). */
      failed: server !== null,
      heading: server?.heading ?? DEFAULT_FAILURE_HEADING,
    },
  };
}

export type FormErrors = ReturnType<typeof useFormErrors<string>>;

function focusField(id: string) {
  const el = document.getElementById(id);
  if (el !== null && el.closest('fieldset:disabled') === null) el.focus();
}

/**
 * What stops the submit, next to it (issue #265): after an attempt, the
 * current field errors (each a link to its field) and any server message
 * the form could not tie to a field (input kept). While a structural
 * blocker (`blocked`) disables the submit, the fields still to fix are
 * listed too, muted — a blocker never hides what else needs correcting.
 */
export function FormErrorSummary({
  form,
  blocked = false,
}: {
  form: Pick<FormErrors, 'summary' | 'reveal'>;
  blocked?: boolean;
}) {
  const { fields, pending, messages, failed } = form.summary;
  const showPending = blocked && pending.length > 0;
  if (fields.length === 0 && !failed && !showPending) {
    return null;
  }
  const link = (id: string, text: string) => (
    <button
      type="button"
      className="text-left font-semibold underline"
      onClick={() => {
        form.reveal();
        focusField(id);
      }}
    >
      {text}
    </button>
  );
  return (
    <div
      id={form.summary.id}
      tabIndex={-1}
      className="space-y-1.5 outline-none"
    >
      {failed && (
        <div
          role="alert"
          className="rounded-xl bg-err-bg px-3 py-2 text-[12.5px] text-err"
        >
          <p className="font-semibold">{form.summary.heading}</p>
          {messages.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {messages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {fields.length > 0 && (
        <div className="rounded-xl bg-err-bg px-3 py-2 text-[12.5px] text-err">
          <p className="font-semibold">
            {fields.length === 1
              ? 'Fix 1 field to continue:'
              : `Fix ${fields.length} fields to continue:`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {fields.map((f) => (
              <li key={f.key}>{link(f.id, `${f.label} — ${f.message}`)}</li>
            ))}
          </ul>
        </div>
      )}
      {showPending && (
        <p className="text-center text-[12.5px] text-ink-2">
          {'Also still needed: '}
          {pending.map((f, i) => (
            <span key={f.key}>
              {i > 0 && ', '}
              {link(f.id, f.label)}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
