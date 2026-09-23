import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

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
}: {
  to?: string;
  /** History state for the push (e.g. the origin record, issue #252). */
  state?: unknown;
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
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold">{title}</div>
        {subtitle != null && (
          <div className="truncate text-[12.5px] text-ink-2">{subtitle}</div>
        )}
        {chip != null && <div className="mt-0.5">{chip}</div>}
      </div>
      {trailing != null && (
        <div className="flex-none text-right">{trailing}</div>
      )}
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

/** `wrap`: opt-in for facts that must stay fully readable (exact amounts,
 *  long references) — label and value wrap instead of truncating. */
export function KeyValue({
  k,
  v,
  wrap = false,
}: {
  k: ReactNode;
  v: ReactNode;
  wrap?: boolean;
}) {
  if (wrap)
    return (
      <div className="flex items-start justify-between gap-3 border-b border-line px-3.5 py-2.5 text-sm last:border-b-0">
        <span className="min-w-0 flex-1 text-ink-2 [overflow-wrap:anywhere]">
          {k}
        </span>
        <span className="min-w-0 max-w-[60%] text-right font-semibold tabular-nums [overflow-wrap:anywhere]">
          {v}
        </span>
      </div>
    );
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-3.5 py-2.5 text-sm last:border-b-0">
      <span className="text-ink-2">{k}</span>
      <span className="min-w-0 truncate text-right font-semibold tabular-nums">
        {v}
      </span>
    </div>
  );
}
