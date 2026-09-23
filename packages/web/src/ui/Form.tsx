import { isValidElement, cloneElement, useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

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
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  group?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const labelId = `${id}-label`;
  const hasDesc = error != null || hint != null;
  const child =
    !group && isValidElement(children) && hasDesc
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          'aria-describedby': descId,
          ...(error != null ? { 'aria-invalid': true } : {}),
        })
      : children;
  const labelSpan = (
    <span
      id={group ? labelId : undefined}
      className="mb-1 block text-[13px] font-semibold"
    >
      {label}
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
    return (
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={hasDesc ? descId : undefined}
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
