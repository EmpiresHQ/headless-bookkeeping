import type { ReactNode } from 'react';
import { Chip } from '../ui/Chip';
import { STATUS_FILTERS, type StatusFilter } from '../queries/books';

/** Status → chip. `reversed` reads as CORRECTED (Reality #1: the corrected
 *  figures are what is live in the books — it is not a dead state). */
export function statusChip(status: string): ReactNode {
  switch (status) {
    case 'draft':
      return <Chip tone="muted">draft</Chip>;
    case 'pending':
      return <Chip tone="warn">pending</Chip>;
    case 'posted':
      return <Chip tone="ok">posted</Chip>;
    case 'reversed':
      return <Chip tone="ok">corrected</Chip>;
    default:
      return <Chip tone="muted">{status}</Chip>;
  }
}

const LABELS: Record<StatusFilter, string> = {
  all: 'All',
  draft: 'Draft',
  pending: 'Pending',
  posted: 'Posted',
  corrected: 'Corrected',
};

/** Horizontal filter-chip row. Counts are computed by the CALLER under the
 *  active search so chips stay honest (data rule 6). `extra` hosts
 *  segment-specific chips (📎 No document). */
export function StatusChipRow({
  counts,
  active,
  onChange,
  extra,
}: {
  counts: Record<StatusFilter, number>;
  active: StatusFilter;
  onChange: (f: StatusFilter) => void;
  extra?: ReactNode;
}) {
  return (
    <div className="flex gap-1.5 overflow-x-auto px-4 pb-2.5">
      {STATUS_FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          className={`flex-none whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${
            f === active ? 'bg-accent text-white' : 'bg-surface text-ink-2'
          }`}
        >
          {f === 'all' ? LABELS[f] : `${LABELS[f]} ${counts[f]}`}
        </button>
      ))}
      {extra}
    </div>
  );
}
