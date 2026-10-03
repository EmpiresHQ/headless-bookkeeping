import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  interruptedText,
  recordedAt,
  useResultLog,
  type ResultEntry,
  type ResultTone,
} from '../lib/resultLog';

const TONE: Record<ResultTone, { box: string; label: string; icon: string }> = {
  ok: { box: 'bg-surface text-ink', label: 'Done', icon: '✓' },
  pending: {
    box: 'bg-surface text-ink',
    label: 'Waiting for approval',
    icon: '⏳',
  },
  partial: { box: 'bg-warn-bg text-warn', label: 'Partly done', icon: '◐' },
  warn: { box: 'bg-warn-bg text-warn', label: 'Needs attention', icon: '!' },
  error: { box: 'bg-err-bg text-err', label: 'Failed', icon: '✕' },
  running: { box: 'bg-surface text-ink', label: 'In progress', icon: '…' },
};

function EntryRow({
  entry,
  compact = false,
  onDismiss,
}: {
  entry: ResultEntry;
  /** Phone width, folded: the outcome is clamped so the strip never
   *  takes over the working screen ("Details" unfolds it). */
  compact?: boolean;
  onDismiss: () => void;
}) {
  const tone = entry.interrupted
    ? { ...TONE.warn, label: 'Interrupted' }
    : TONE[entry.tone];
  return (
    <li
      className={`flex items-start gap-3 rounded-2xl px-3.5 py-2.5 ${tone.box}`}
      aria-label={`${entry.action}: ${entry.title}`}
    >
      <span aria-hidden className="mt-0.5 w-4 flex-none text-center font-bold">
        {tone.icon}
      </span>
      <div className="min-w-0 flex-1 text-[13px] leading-snug [overflow-wrap:anywhere]">
        {/* A title can be one long unbroken filename: folded, it is
            clamped to two lines (the row's label keeps it in full). */}
        <p
          className={`font-semibold ${compact ? 'line-clamp-2' : ''}`}
          title={compact ? entry.title : undefined}
        >
          {entry.title}
        </p>
        <p className="text-[12px] opacity-80">
          {entry.action} · {tone.label}
        </p>
        <p className={compact ? 'line-clamp-3 sm:line-clamp-none' : undefined}>
          {entry.interrupted ? interruptedText(entry.outcome) : entry.outcome}
        </p>
        <p className="mt-0.5 text-[11.5px] opacity-70">
          Recorded {recordedAt(entry.at)} in this session
          <span className={compact ? 'hidden sm:inline' : undefined}>
            {' '}
            — open the item for its current state
          </span>
        </p>
        {entry.links.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {entry.links.map((l) => (
              <Link
                key={`${l.to}|${l.label}`}
                to={l.to}
                className="min-w-0 font-semibold text-accent underline [overflow-wrap:anywhere]"
              >
                {l.label}
              </Link>
            ))}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="flex-none rounded-full px-1.5 text-[15px] leading-none opacity-70 hover:opacity-100"
        aria-label={`Dismiss result: ${entry.title}`}
      >
        ×
      </button>
    </li>
  );
}

/** The session's recorded operation results (issue #259): the newest one
 *  stays visible on every screen until dismissed; earlier ones fold. */
export function RecentResults() {
  const log = useResultLog();
  const [expanded, setExpanded] = useState(false);
  if (log.entries.length === 0) return null;
  const [latest, ...earlier] = log.entries;
  return (
    <section
      aria-label="Recent results"
      className="mx-auto max-w-3xl px-3.5 pt-3"
    >
      <ul className="space-y-1.5">
        <EntryRow
          entry={latest}
          compact={!expanded}
          onDismiss={() => log.dismiss(latest.id)}
        />
        {expanded &&
          earlier.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              onDismiss={() => log.dismiss(e.id)}
            />
          ))}
      </ul>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 px-1 text-[12px] text-ink-2">
        <button
          type="button"
          // Unfolds the clamped title/outcome, and any earlier results.
          className="font-semibold text-accent"
          aria-expanded={expanded}
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded
            ? 'Show less'
            : earlier.length > 0
              ? `Details · ${earlier.length} earlier result${earlier.length === 1 ? '' : 's'}`
              : 'Details'}
        </button>
        {log.entries.length > 1 && (
          <button
            type="button"
            className="font-semibold text-accent"
            onClick={() => {
              setExpanded(false);
              log.clear();
            }}
          >
            Clear all
          </button>
        )}
        {!log.persistent && (
          <span>Browser storage is unavailable — not kept across a reload</span>
        )}
      </div>
    </section>
  );
}
