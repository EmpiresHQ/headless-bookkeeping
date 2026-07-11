import type { ReactNode } from 'react';

/** Section-header content for a ListGroup `label`: name left, right-aligned
 *  tabular figure (per-section totals recomputed under the active filter —
 *  data rule 6). Extracted in Plan 05 after two inline Books copies; Reports
 *  is the third consumer. */
export function GroupHeader({
  label,
  trailing,
}: {
  label: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <span className="flex w-full items-baseline justify-between">
      <span>{label}</span>
      {trailing != null && (
        <span className="whitespace-nowrap tabular-nums">{trailing}</span>
      )}
    </span>
  );
}
