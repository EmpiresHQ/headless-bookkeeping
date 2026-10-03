import type { ReactNode } from 'react';

/** Section-header content for a ListGroup `label`: name left, right-aligned
 *  tabular figure (per-section totals recomputed under the active filter —
 *  data rule 6). Extracted in Plan 05 after two inline Books copies; Reports
 *  is the third consumer. */
export function GroupHeader({
  label,
  trailing,
  wrap = false,
}: {
  label: ReactNode;
  trailing?: ReactNode;
  /** Let a long figure (per-currency totals, issue #279) wrap onto its own
   *  right-aligned line(s) at narrow widths instead of overflowing; it
   *  breaks only at its own spaces. Off by default (Reports). */
  wrap?: boolean;
}) {
  if (wrap) {
    return (
      <span className="flex w-full flex-wrap items-baseline justify-between gap-x-2">
        <span className="min-w-0">{label}</span>
        {trailing != null && (
          <span className="ml-auto min-w-0 text-right tabular-nums [overflow-wrap:anywhere]">
            {trailing}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="flex w-full items-baseline justify-between">
      <span>{label}</span>
      {trailing != null && (
        <span className="whitespace-nowrap tabular-nums">{trailing}</span>
      )}
    </span>
  );
}
