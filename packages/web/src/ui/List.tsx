import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { POSITION_ROW } from '../lib/listPosition';

export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mx-6 mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">
      {children}
    </p>
  );
}

export function ListGroup({
  label,
  children,
  className = '',
}: {
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div>
      {label != null && <GroupLabel>{label}</GroupLabel>}
      <div
        className={`mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/** Key identifiers (names, numbers, filenames) wrap instead of truncating
 *  (#275). `anywhere` also lowers min-content, so an unbroken reference
 *  breaks inside its column rather than overflowing the row. */
export const READABLE = '[overflow-wrap:anywhere]';

/** Identity + trailing (amount) layout (#275): the identity keeps at least
 *  8rem beside the trailing; when it cannot, the trailing wraps onto its own
 *  right-aligned line and the identity takes the full width — a huge amount
 *  never squeezes the name into a sliver. */
export const ROW_BODY =
  'flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-1';
export const ROW_IDENTITY = `min-w-0 flex-[1_1_8rem] ${READABLE}`;
export const ROW_TRAILING = 'max-w-full flex-none text-right';

const ROW_CLS =
  'flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left last:border-b-0';

export function ListRow({
  to,
  state,
  onClick,
  leading,
  title,
  subtitle,
  trailing,
  chip,
  positionRow = false,
}: {
  to?: string;
  /** History state for the push (e.g. the origin record, issue #252). */
  state?: unknown;
  /** The link is a row of a list that returns to it (`useReturnPosition`,
   *  identified by its href). */
  positionRow?: boolean;
  onClick?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  chip?: ReactNode;
}) {
  const interactive = to != null || onClick != null;
  const leadingSlot = leading != null && (
    <div className="flex-none">{leading}</div>
  );
  const content = (
    <>
      <div className={ROW_BODY}>
        <div className={ROW_IDENTITY}>
          <div className="text-[14.5px] font-semibold">{title}</div>
          {subtitle != null && (
            <div className="text-[12.5px] text-ink-2">{subtitle}</div>
          )}
          {chip != null && <div className="mt-0.5">{chip}</div>}
        </div>
        {trailing != null && <div className={ROW_TRAILING}>{trailing}</div>}
      </div>
      {interactive && (
        <span aria-hidden className="flex-none text-base text-chevron">
          ›
        </span>
      )}
    </>
  );
  if (to != null) {
    // Stretched link: `leading` is a sibling of the <Link>, never inside it,
    // so the slot may hold its own control (e.g. DocThumbLightbox's preview
    // button and its dialog) without nesting interactive content in the <a>
    // or bubbling clicks to it — in the DOM and in React's tree alike. The
    // link's ::after still covers the whole row, so a tap on a decorative
    // leading glyph navigates; a leading control opts out of that with
    // `relative z-10`.
    return (
      <div className={`relative ${ROW_CLS}`}>
        {leadingSlot}
        <Link
          to={to}
          state={state}
          {...(positionRow && { [POSITION_ROW]: '' })}
          className="flex min-w-0 flex-1 items-center gap-3 after:absolute after:inset-0"
        >
          {content}
        </Link>
      </div>
    );
  }
  const body = (
    <>
      {leadingSlot}
      {content}
    </>
  );
  if (onClick != null) {
    return (
      <button type="button" onClick={onClick} className={ROW_CLS}>
        {body}
      </button>
    );
  }
  return <div className={ROW_CLS}>{body}</div>;
}

/** A fact row. Key and value wrap instead of truncating (#275): a value
 *  that fits stays on the key's line; a longer one (reference, filename,
 *  exact amount) drops to its own right-aligned line at full width. */
export function KeyValue({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line px-3.5 py-2.5 text-sm last:border-b-0">
      <span className={`min-w-0 text-ink-2 ${READABLE}`}>{k}</span>
      <span
        className={`ml-auto min-w-0 max-w-full text-right font-semibold tabular-nums ${READABLE}`}
      >
        {v}
      </span>
    </div>
  );
}
