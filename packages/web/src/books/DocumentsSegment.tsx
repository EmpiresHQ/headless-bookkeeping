import { useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { DocumentArchiveRow } from '../api';
import { triageChipLabel } from '../inbox/reason';
import { useDocumentsArchive } from '../queries/books';
import { relativeTime } from '../relativeTime';
import { Chip } from '../ui/Chip';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { ListGroup } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { BooksCreate, BooksEmpty, effectiveDateFilter } from './BooksEmpty';
import { useReturnPosition } from '../lib/listPosition';
import { BooksColumnsHeader, BooksRow, type BooksColumns } from './BooksRow';
import { DocThumb } from './DocThumb';
import { ActiveFilters, FilterChip, FilterStrip } from './chips';
import {
  BOOKS_RESET_NAME,
  BOOKS_SEARCH,
  useResetWithFocus,
  useSetFilterParam,
} from './filters';
import {
  DEFAULT_ORDER,
  inRange,
  localDay,
  type BooksOrderState,
} from './listOrder';

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

/** Desktop columns (xl, issue #283); the thumbnail stays the row's
 *  leading slot, outside the link. */
export const DOCUMENT_COLUMNS: BooksColumns = {
  grid: 'xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_7rem_7rem_minmax(0,1fr)_6rem_0.75rem]',
  labels: ['Supplier', 'File', 'Channel', 'Added', 'Claimant', 'Status'],
  leading: 'xl:w-9',
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

export function DocumentsSegment({
  q,
  order = DEFAULT_ORDER,
}: {
  q: string;
  order?: BooksOrderState;
}) {
  const [params] = useSearchParams();
  const raw = params.get('dstatus');
  const filter: DocFilter = DOC_FILTERS.some((f) => f.key === raw)
    ? (raw as DocFilter)
    : 'all';
  const setParam = useSetFilterParam();
  const { rootRef, onReset } = useResetWithFocus('documents');
  const create = useContext(BooksCreate);
  const docsQ = useDocumentsArchive();
  // Back from a row lands on that row again, once the rows are here (#283).
  useReturnPosition(rootRef, docsQ.isSuccess);

  // Applied restrictions from PARSED state (an unknown ?dstatus= is All).
  // Documents have no amount: an amount ?sort= arrives here as a
  // not-applied note from parseBooksOrder, never as an order.
  const applied = [
    ...(filter === 'all'
      ? []
      : DOC_FILTERS.filter((f) => f.key === filter).map((f) => f.label)),
    ...order.labels,
  ];
  const activeFilters = (result?: {
    shown: number;
    total: number;
    noun: string;
  }) => (
    <ActiveFilters
      filters={applied}
      q={q}
      searchScope={BOOKS_SEARCH.documents.scope}
      result={result}
      onReset={onReset}
      resetName={BOOKS_RESET_NAME}
    />
  );

  if (docsQ.isPending) {
    return (
      <div ref={rootRef} tabIndex={-1} className="outline-none">
        {activeFilters()}
        <SkeletonRows count={5} />
      </div>
    );
  }
  if (docsQ.isError) {
    return (
      <div ref={rootRef} tabIndex={-1} className="outline-none">
        {activeFilters()}
        <LoadError
          message={
            docsQ.error instanceof Error
              ? docsQ.error.message
              : 'Failed to load documents'
          }
          onRetry={() => void docsQ.refetch()}
        />
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  // The date range is on the day the document was added, in the viewer's
  // local calendar (#279); chip counts honour it like the search.
  const searched = (docsQ.data ?? []).filter(
    (d) =>
      inRange(localDay(d.created_at), order) &&
      (needle === '' ||
        d.filename.toLowerCase().includes(needle) ||
        (d.supplier_name ?? '').toLowerCase().includes(needle)),
  );
  const dir = order.order === 'oldest' ? -1 : 1;
  const rows = searched
    .filter((d) => matchesDocFilter(d, filter))
    .sort((a, b) => dir * (b.created_at - a.created_at || b.id - a.id));

  const total = (docsQ.data ?? []).length;

  return (
    <div ref={rootRef} tabIndex={-1} className="outline-none">
      <FilterStrip>
        {DOC_FILTERS.map((f) => {
          const count = searched.filter((d) =>
            matchesDocFilter(d, f.key),
          ).length;
          return (
            <FilterChip
              key={f.key}
              active={f.key === filter}
              onClick={() =>
                setParam('dstatus', f.key === 'all' ? null : f.key)
              }
            >
              {f.key === 'all' ? f.label : `${f.label} ${count}`}
            </FilterChip>
          );
        })}
      </FilterStrip>
      {activeFilters({ shown: rows.length, total, noun: 'documents' })}
      {rows.length === 0 && (
        <BooksEmpty
          icon="🗂"
          noun="documents"
          total={total}
          q={q}
          scope={BOOKS_SEARCH.documents.scope}
          // The search reads the archive row itself (file name, supplier
          // name): no auxiliary lookup takes part.
          filters={[
            ...(filter === 'all'
              ? []
              : DOC_FILTERS.filter((f) => f.key === filter).map(
                  (f) => f.label,
                )),
            ...effectiveDateFilter(order, order.labels[0]),
          ]}
          onReset={onReset}
          restricted={applied.length > 0 || q.trim() !== ''}
          initialHint="Upload a receipt or invoice to start."
          initialAction={
            create && (
              <Button className="min-h-11" onClick={() => create('upload')}>
                Upload document
              </Button>
            )
          }
        />
      )}
      {rows.length > 0 && (
        <ListGroup>
          <BooksColumnsHeader columns={DOCUMENT_COLUMNS} />
          {rows.map((d) => (
            <BooksRow
              key={d.id}
              to={`/books/documents/${d.id}`}
              columns={DOCUMENT_COLUMNS}
              leading={<DocThumb id={d.id} />}
              title={d.supplier_name ?? d.filename}
              titleXl={d.supplier_name == null ? 'Unrecognized' : undefined}
              cells={[
                // An unrecognized card is titled by its filename; the File
                // column always shows it.
                {
                  key: 'file',
                  value: d.filename,
                  xlOnly: d.supplier_name == null,
                },
                { key: 'channel', value: channelLabel(d.channel) },
                { key: 'added', value: relativeTime(d.created_at) },
                {
                  key: 'claimant',
                  value: d.claimant_name,
                  prefix: 'Claimant:',
                },
              ]}
              status={docStatusChip(d)}
            />
          ))}
        </ListGroup>
      )}
    </div>
  );
}
