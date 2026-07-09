import { useSearchParams } from 'react-router-dom';
import type { DocumentArchiveRow } from '../api';
import { triageChipLabel } from '../inbox/reason';
import { useDocumentsArchive } from '../queries/books';
import { relativeTime } from '../relativeTime';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { DocThumb } from './DocThumb';

export function channelLabel(channel: string | null): string {
  switch (channel) {
    case 'telegram':
      return '💬 telegram';
    case 'email':
    case 'email_sync':
    case 'email_push':
      return '✉ email';
    case 'drive':
      return '☁ drive';
    case 'ios_photo_library':
      return '📷 iOS';
    case 'upload':
      return '⬆ upload';
    default:
      return channel ?? '—';
  }
}

/** REAL document statuses only (documents/types.ts:18-23). ADR-0038's
 *  `discarded` is not implemented server-side — no fake chip (Reality #7). */
type DocFilter = 'all' | 'needs_triage' | 'intake' | 'processed' | 'error';
const DOC_FILTERS: readonly { key: DocFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs_triage', label: 'Needs triage' },
  { key: 'intake', label: 'In intake' },
  { key: 'processed', label: 'Processed' },
  { key: 'error', label: 'Errors' },
];

const matchesDocFilter = (d: DocumentArchiveRow, f: DocFilter): boolean => {
  if (f === 'all') return true;
  if (f === 'intake') return d.status === 'pending' || d.status === 'triaged';
  return d.status === f;
};

function docStatusChip(d: DocumentArchiveRow) {
  switch (d.status) {
    case 'processed':
      return <Chip tone="ok">processed</Chip>;
    case 'needs_triage':
      return <Chip tone="warn">{triageChipLabel(d.reason_type)}</Chip>;
    case 'error':
      return <Chip tone="err">error</Chip>;
    default:
      return (
        <Chip tone="muted">
          {d.status === 'pending' || d.status === 'triaged'
            ? 'in intake'
            : d.status}
        </Chip>
      );
  }
}

export function DocumentsSegment({ q }: { q: string }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('dstatus');
  const filter: DocFilter = DOC_FILTERS.some((f) => f.key === raw)
    ? (raw as DocFilter)
    : 'all';
  const docsQ = useDocumentsArchive();

  if (docsQ.isPending) return <SkeletonRows count={5} />;
  if (docsQ.isError) {
    return (
      <LoadError
        message={
          docsQ.error instanceof Error
            ? docsQ.error.message
            : 'Failed to load documents'
        }
        onRetry={() => void docsQ.refetch()}
      />
    );
  }

  const needle = q.trim().toLowerCase();
  const searched = (docsQ.data ?? []).filter(
    (d) =>
      needle === '' ||
      d.filename.toLowerCase().includes(needle) ||
      (d.supplier_name ?? '').toLowerCase().includes(needle),
  );
  const rows = searched
    .filter((d) => matchesDocFilter(d, filter))
    .sort((a, b) => b.created_at - a.created_at);

  return (
    <div>
      <div className="flex gap-1.5 overflow-x-auto px-4 pb-2.5">
        {DOC_FILTERS.map((f) => {
          const count = searched.filter((d) =>
            matchesDocFilter(d, f.key),
          ).length;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                const next = new URLSearchParams(params);
                if (f.key === 'all') next.delete('dstatus');
                else next.set('dstatus', f.key);
                setParams(next, { replace: true });
              }}
              className={`flex-none whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${
                f.key === filter
                  ? 'bg-accent text-white'
                  : 'bg-surface text-ink-2'
              }`}
            >
              {f.key === 'all' ? f.label : `${f.label} ${count}`}
            </button>
          );
        })}
      </div>
      {rows.length === 0 && (
        <EmptyState
          icon="🗂"
          title="No documents match"
          hint="Upload one with + or adjust the filter"
        />
      )}
      {rows.length > 0 && (
        <ListGroup>
          {rows.map((d) => {
            const subtitleParts = [
              // Filename moves to the subtitle once the supplier is known.
              ...(d.supplier_name != null ? [d.filename] : []),
              channelLabel(d.channel),
              relativeTime(d.created_at),
              ...(d.claimant_name != null
                ? [`Claimant: ${d.claimant_name}`]
                : []),
            ];
            return (
              <ListRow
                key={d.id}
                to={`/books/documents/${d.id}`}
                leading={
                  <DocThumb id={d.id} hasPreview={d.preview_path != null} />
                }
                title={d.supplier_name ?? d.filename}
                subtitle={subtitleParts.join(' · ')}
                chip={docStatusChip(d)}
              />
            );
          })}
        </ListGroup>
      )}
    </div>
  );
}
