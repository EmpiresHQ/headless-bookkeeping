import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigationType } from 'react-router-dom';
import { INPUT_CLS } from '../ui/Form';
import {
  isCalendarDate,
  longDate,
  ORDER_LABELS,
  type BooksOrder,
  type BooksOrderState,
} from './listOrder';
import { BOOKS_ORDER, useSetFilterParam } from './filters';

/**
 * Books › date range + order (issue #279): native date inputs and a native
 * select, each writing its own URL param (replace-history, entry state kept
 * — a filter change is not a navigation). Inside a native <details> so the
 * list stays near the top at 320px; its summary names what is applied while
 * closed, and it starts open when the URL carries any of the params.
 */
export function DateOrderControls({
  segment,
  state,
  params,
  resets,
}: {
  segment: keyof typeof BOOKS_ORDER;
  state: BooksOrderState;
  params: URLSearchParams;
  /** Bumped by every Reset (see BooksResetSignal). */
  resets: number;
}) {
  const sem = BOOKS_ORDER[segment];
  const setParam = useSetFilterParam();
  const [open, setOpen] = useState(state.present);
  const id = useId();
  const noteId = `${id}-note`;
  const errId = `${id}-err`;

  // The inputs show the URL's bound when it is a real date (a reversed
  // range keeps both, marked invalid); a non-date shows empty + invalid.
  const shown = (key: 'from' | 'to') => {
    const v = params.get(key) ?? '';
    return isCalendarDate(v) ? v : '';
  };
  const fromBad = state.fromInvalid || state.reversed;
  const toBad = state.toInvalid || state.reversed;
  const error = state.reversed
    ? 'From is after To — no date range applied.'
    : state.fromInvalid || state.toInvalid
      ? 'A date in the link is not a real date — it is not applied.'
      : null;

  const orders: BooksOrder[] = sem.amounts
    ? ['newest', 'oldest', 'largest', 'smallest']
    : ['newest', 'oldest'];
  const summary = [
    state.from !== null && state.to !== null
      ? `${longDate(state.from)} – ${longDate(state.to)}`
      : state.from !== null
        ? `from ${longDate(state.from)}`
        : state.to !== null
          ? `until ${longDate(state.to)}`
          : null,
    state.reversed
      ? 'dates not applied'
      : state.fromInvalid || state.toInvalid
        ? 'a date not applied'
        : null,
    state.order !== 'newest' ? ORDER_LABELS[state.order].toLowerCase() : null,
  ].filter((s): s is string => s !== null);

  const cls = `${INPUT_CLS} block min-h-11 min-w-0`;
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="rounded-xl"
    >
      {/* A block summary (not flex) so the state text wraps with the
          disclosure marker at 320px; min-h keeps the 44px target. */}
      <summary className="min-h-11 cursor-pointer py-3 text-[13px] font-semibold leading-5 text-accent [overflow-wrap:anywhere]">
        Dates &amp; order
        {summary.length > 0 && (
          <span className="font-normal text-ink-2">
            {' '}
            · {summary.join(' · ')}
          </span>
        )}
      </summary>
      <div className="space-y-2 pt-1">
        <div className="grid grid-cols-2 gap-2">
          <label className="block min-w-0">
            <span className="mb-1 block text-[12px] font-semibold text-ink-2">
              From
            </span>
            <DateInput
              className={cls}
              value={shown('from')}
              invalid={fromBad}
              describedBy={error ? `${errId} ${noteId}` : noteId}
              resets={resets}
              onCommit={(v) => setParam('from', v)}
            />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-[12px] font-semibold text-ink-2">
              To
            </span>
            <DateInput
              className={cls}
              value={shown('to')}
              invalid={toBad}
              describedBy={error ? `${errId} ${noteId}` : noteId}
              resets={resets}
              onCommit={(v) => setParam('to', v)}
            />
          </label>
        </div>
        {error && (
          <p id={errId} className="text-[12px] text-err">
            {error}
          </p>
        )}
        <label className="block min-w-0">
          <span className="mb-1 block text-[12px] font-semibold text-ink-2">
            Order
          </span>
          <select
            className={cls}
            value={state.order}
            onChange={(e) =>
              setParam(
                'sort',
                e.target.value === 'newest' ? null : e.target.value,
              )
            }
          >
            {orders.map((o) => (
              <option key={o} value={o}>
                {ORDER_LABELS[o]}
                {o === 'largest' || o === 'smallest'
                  ? segment === 'credit-notes'
                    ? ' (face value, per currency)'
                    : ' (per currency)'
                  : ''}
              </option>
            ))}
          </select>
        </label>
        <p id={noteId} className="text-[12px] text-ink-2">
          Both dates included, on the {sem.dateField}
          {segment === 'documents' ? '' : ', drafts included'}. This is a
          calendar filter, not a reporting period: period figures are in{' '}
          <Link to="/reports" className="font-semibold text-accent underline">
            Reports
          </Link>
          .
        </p>
      </div>
    </details>
  );
}

/**
 * A native date input that never has its value written back while the user
 * types (issue #279 rework). A controlled date input gets its value
 * re-synced on every render after a URL write, which resets the browser's
 * segment-typing buffer: typing the year 2026 after the first digit commits
 * year 0002, then the next digit starts a fresh year 0000 and the bound is
 * lost. So it is UNCONTROLLED:
 * - it commits a complete date, or a deliberate clear (empty and not
 *   `validity.badInput`); an incomplete entry (badInput) commits nothing, so
 *   the applied bound stays until the entry is complete or cleared;
 * - it takes `value` into the DOM only when the URL changes from ELSEWHERE
 *   (Back/Forward, a deep link) or on a Reset (even one that leaves its
 *   bound absent → clears an entry never committed) — never on its own
 *   write or another filter's replace-write.
 */
function DateInput({
  value,
  invalid,
  describedBy,
  className,
  resets,
  onCommit,
}: {
  value: string;
  resets: number;
  invalid: boolean;
  describedBy: string;
  className: string;
  onCommit: (value: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // What the URL holds as far as this field knows (its own last write or
  // the last external value it took).
  const known = useRef(value);
  // Pinned to mount: React re-syncs the value ATTRIBUTE when defaultValue
  // changes, which would reset the typing buffer just the same.
  const [initial] = useState(value);
  // A history move (Back/Forward, a link: POP/PUSH) is external even when
  // the bound equals what this field last wrote — the field may hold an
  // incomplete entry since. Filter writes are REPLACE and move nothing.
  const { key } = useLocation();
  const navType = useNavigationType();
  const seenKey = useRef(key);
  const seenResets = useRef(resets);
  useEffect(() => {
    const moved = key !== seenKey.current && navType !== 'REPLACE';
    const reset = resets !== seenResets.current;
    seenKey.current = key;
    seenResets.current = resets;
    // Reset always removes both bounds, and the signal can render before
    // the router's URL update lands: go straight to empty, so the old bound
    // is not re-assigned in between (the URL's '' then matches `known`).
    const next = reset ? '' : value;
    if (next === known.current && !moved && !reset) return;
    known.current = next;
    // Always assign: an incomplete native entry reads as '' already, yet
    // still shows its typed segments until the value is set.
    if (ref.current) ref.current.value = next;
  }, [value, key, navType, resets]);
  return (
    <input
      ref={ref}
      type="date"
      className={className}
      defaultValue={initial}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => {
        const el = e.currentTarget;
        if (el.value === '' && el.validity.badInput) return;
        if (el.value === known.current) return;
        known.current = el.value;
        onCommit(el.value === '' ? null : el.value);
      }}
    />
  );
}
