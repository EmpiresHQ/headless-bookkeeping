import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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

export const LABELS: Record<StatusFilter, string> = {
  all: 'All',
  draft: 'Draft',
  pending: 'Pending',
  posted: 'Posted',
  corrected: 'Corrected',
};

/** One filter chip: a 44×44-minimum native button (DESIGN.md touch minimum,
 *  #273) around the compact visual pill, so the pill keeps its size while
 *  neighbouring buttons (gap-1.5) never overlap. */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="flex min-h-11 min-w-11 flex-none items-center justify-center"
    >
      <span
        className={`whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${
          active ? 'bg-accent text-white' : 'bg-surface text-ink-2'
        }`}
      >
        {children}
      </span>
    </button>
  );
}

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
    <FilterStrip>
      {STATUS_FILTERS.map((f) => (
        <FilterChip key={f} active={f === active} onClick={() => onChange(f)}>
          {f === 'all' ? LABELS[f] : `${LABELS[f]} ${counts[f]}`}
        </FilterChip>
      ))}
      {extra}
    </FilterStrip>
  );
}

/** Horizontal filter strip (issue #274). Stays a strip, but:
 *  - when chips overflow, labelled 44px scroll buttons sit BESIDE the strip
 *    (not over it, so they never take a chip's hits) on both ends, and are
 *    aria-disabled at an end rather than unmounted (layout and focus stay
 *    put);
 *  - a filter restored from the URL is scrolled into the strip's own view
 *    (its scrollLeft only — no page/Sheet scroll, no focus change) when the
 *    SET of active chips changes, not on count/search refreshes, so a
 *    user's horizontal scrolling is left alone. */
export function FilterStrip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({
    overflow: false,
    left: false,
    right: false,
  });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const next = {
      overflow: el.scrollWidth > el.clientWidth + 1,
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    };
    setEdges((e) =>
      e.overflow === next.overflow &&
      e.left === next.left &&
      e.right === next.right
        ? e
        : next,
    );
  };

  // Which chips are pressed (labels without their counts), read from the
  // DOM after each render; only a change of that set re-scrolls.
  const [activeKey, setActiveKey] = useState('');
  useLayoutEffect(() => {
    const pressed = ref.current?.querySelectorAll('[aria-pressed="true"]');
    const key = Array.from(pressed ?? [], (b) => b.textContent ?? '')
      .map((t) => t.replace(/\s*\d+$/, ''))
      .join('|');
    setActiveKey((k) => (k === key ? k : key));
    measure();
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pressed = el.querySelectorAll<HTMLElement>('[aria-pressed="true"]');
    const last = pressed[pressed.length - 1];
    if (!last) return;
    const start = last.offsetLeft;
    const end = start + last.offsetWidth;
    if (end > el.scrollLeft + el.clientWidth)
      el.scrollLeft = end - el.clientWidth + 16;
    else if (start < el.scrollLeft) el.scrollLeft = Math.max(0, start - 16);
    measure();
  }, [activeKey]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const page = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollLeft += dir * Math.max(44, el.clientWidth - 64);
    measure();
  };
  const arrow = (dir: -1 | 1) => {
    const enabled = dir < 0 ? edges.left : edges.right;
    return (
      <button
        type="button"
        aria-label={dir < 0 ? 'Earlier filters' : 'More filters'}
        aria-disabled={!enabled}
        onClick={() => enabled && page(dir)}
        className="flex min-h-11 w-11 flex-none items-center justify-center"
      >
        <span
          aria-hidden
          className={`flex h-7 w-7 items-center justify-center rounded-full text-[15px] font-semibold ${
            enabled ? 'bg-fill text-accent' : 'text-chevron'
          }`}
        >
          {dir < 0 ? '‹' : '›'}
        </span>
      </button>
    );
  };

  return (
    <div className="flex items-start pb-1">
      {edges.overflow && arrow(-1)}
      <div
        ref={ref}
        data-filter-strip=""
        onScroll={measure}
        className={`relative flex min-w-0 flex-1 gap-1.5 overflow-x-auto ${
          edges.overflow ? '' : 'px-4'
        }`}
      >
        {children}
      </div>
      {edges.overflow && arrow(1)}
    </div>
  );
}

/** What is APPLIED to the list right now (issue #274), one line under the
 *  strip, with an explicit Reset — so a URL-restored filter chip scrolled
 *  out of the strip, or a search, can never limit the list invisibly.
 *  Rendered in loading/error states too (without counts). Nothing applied →
 *  nothing rendered. A long search shows as a bounded excerpt (the full
 *  value stays in the search field and the excerpt's title) so Reset stays
 *  on the first lines at 320px. */
export function ActiveFilters({
  filters,
  q,
  result,
  onReset,
  resetLabel = 'Reset',
  resetName = 'Reset filters and search',
}: {
  /** Applied segment filters, already parsed (never raw params). */
  filters: readonly string[];
  /** The active search; matched trimmed, as the segments do. */
  q: string;
  /** Rendered rows vs all loaded rows of the segment — only with data. */
  result?: { shown: number; total: number; noun: string };
  onReset: () => void;
  resetLabel?: string;
  /** Accessible name; starts with the visible label. */
  resetName?: string;
}) {
  const needle = q.trim();
  if (filters.length === 0 && needle === '') return null;
  const excerpt =
    needle.length > SEARCH_EXCERPT
      ? `${needle.slice(0, SEARCH_EXCERPT)}…`
      : needle;
  const lead = result
    ? `Showing ${result.shown} of ${result.total} ${result.noun}`
    : 'Filtered by';
  return (
    <div
      role="group"
      aria-label="Active filters"
      className="flex items-center gap-2 px-4 pb-1"
    >
      <p className="min-w-0 flex-1 text-[12px] text-ink-2 [overflow-wrap:anywhere]">
        <span className="font-semibold text-ink">{lead}</span>
        {result ? ' · ' : ': '}
        {filters.join(' · ')}
        {filters.length > 0 && needle !== '' && ' · '}
        {needle !== '' && <span title={needle}>Search “{excerpt}”</span>}
      </p>
      <button
        type="button"
        aria-label={resetName}
        onClick={onReset}
        className="flex min-h-11 min-w-11 flex-none items-center justify-center"
      >
        <span className="whitespace-nowrap rounded-full bg-fill px-3 py-1 text-[12px] font-semibold text-accent">
          {resetLabel}
        </span>
      </button>
    </div>
  );
}

const SEARCH_EXCERPT = 32;
