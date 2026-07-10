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
  onClick,
  leading,
  title,
  subtitle,
  trailing,
  chip,
}: {
  to?: string;
  onClick?: () => void;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  chip?: ReactNode;
}) {
  const interactive = to != null || onClick != null;
  const body = (
    <>
      {leading != null && <div className="flex-none">{leading}</div>}
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
    return (
      <Link to={to} viewTransition className={ROW_CLS}>
        {body}
      </Link>
    );
  }
  if (onClick != null) {
    return (
      <button type="button" onClick={onClick} className={ROW_CLS}>
        {body}
      </button>
    );
  }
  return <div className={ROW_CLS}>{body}</div>;
}

export function KeyValue({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-3.5 py-2.5 text-sm last:border-b-0">
      <span className="text-ink-2">{k}</span>
      <span className="min-w-0 truncate text-right font-semibold tabular-nums">
        {v}
      </span>
    </div>
  );
}
