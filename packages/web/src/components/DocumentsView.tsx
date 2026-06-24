import { useEffect, useState } from 'react';
import {
  getDocuments,
  getDocumentDetails,
  deleteDocument,
  type DocumentArchiveRow,
  type DocumentDetails,
} from '../api';
import { reasonBadge } from '../reasonBadge';
import { Table, type Column } from './Table';

// ── Relative-time helper ────────────────────────────────────────────────────

/** Format a Unix-seconds timestamp as a relative string ("2h ago", "3d ago"). */
function relativeTime(unixSecs: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

// ── Channel labels ──────────────────────────────────────────────────────────

function channelLabel(channel: string | null): string {
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

// ── Thumbnail cell ──────────────────────────────────────────────────────────

function ThumbCell({ doc }: { doc: DocumentArchiveRow }) {
  const [errored, setErrored] = useState(!doc.preview_path);
  const fileUrl = `/api/documents/${doc.id}/file`;

  return (
    <a href={fileUrl} target="_blank" rel="noreferrer">
      {errored ? (
        <span
          aria-label="no preview"
          className="inline-flex items-center justify-center w-10 h-10 bg-gray-100 rounded text-gray-400 text-xs"
        >
          📄
        </span>
      ) : doc.preview_path ? (
        <img
          src={`/api/documents/${doc.id}/preview`}
          alt="preview"
          aria-label="preview"
          width={48}
          height={48}
          className="w-10 h-10 object-cover rounded border border-gray-200"
          onError={() => setErrored(true)}
        />
      ) : null}
    </a>
  );
}

// ── Linked cell ─────────────────────────────────────────────────────────────

function LinkedCell({ doc }: { doc: DocumentArchiveRow }) {
  if (!doc.expense_id && !doc.supplier_name) return <span className="text-gray-400">—</span>;
  return (
    <div className="space-y-0.5 text-xs">
      {doc.supplier_name && (
        <div className="font-medium">{doc.supplier_name}</div>
      )}
      {doc.expense_id && (
        <div>
          <a
            href={`#expense-${doc.expense_id}`}
            className="text-blue-600 hover:underline"
          >
            Expense #{doc.expense_id}
          </a>
        </div>
      )}
      {doc.claimant_name && (
        <div className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded inline-block">
          Claimant: {doc.claimant_name}
        </div>
      )}
    </div>
  );
}

// ── Details panel (read-only, replaces old Debug) ───────────────────────────

function ClassificationPanel({ details }: { details: DocumentDetails }) {
  if (details.classification === null) {
    return (
      <p className="text-gray-500">
        No classification — OCR did not produce text.
      </p>
    );
  }
  if (!details.classification.ok) {
    return (
      <p className="text-red-600">
        Classification failed ({details.classification.category}):{' '}
        {details.classification.detail}
      </p>
    );
  }
  const r = details.classification.result;
  const rows: [string, string][] = [
    ['kind', r.kind],
    ['confidence', r.confidence.toFixed(2)],
    ['document_type', r.document_type],
    ['category', r.category],
    ['gross', `${(r.gross_amount / 100).toFixed(2)} ${r.currency}`],
    ['vat', `${(r.vat_amount / 100).toFixed(2)} ${r.currency}`],
    ['tax_point_date', r.tax_point_date],
    ['vat_marking', r.document_vat_marking ?? '—'],
  ];
  return (
    <table className="text-xs border-collapse">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b">
            <td className="pr-3 py-0.5 text-gray-500">{k}</td>
            <td
              className={`py-0.5 font-mono ${
                k === 'kind' ? 'font-semibold text-amber-700' : ''
              }`}
            >
              {v}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

export function DocumentsView() {
  const [docs, setDocs] = useState<DocumentArchiveRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [details, setDetails] = useState<DocumentDetails | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () =>
    getDocuments()
      .then(setDocs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  const onDelete = async (d: DocumentArchiveRow) => {
    if (!window.confirm(`Delete document #${d.id} "${d.filename}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDocument(d.id);
      if (selected === d.id) {
        setSelected(null);
        setDetails(null);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDetails = async (id: number) => {
    setSelected(id);
    setDetails(null);
    setDetailsBusy(true);
    setError(null);
    try {
      setDetails(await getDocumentDetails(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailsBusy(false);
    }
  };

  const isDeleteLocked = (d: DocumentArchiveRow) =>
    d.expense_status === 'posted' || d.expense_status === 'reversed';

  const columns: Column<DocumentArchiveRow>[] = [
    {
      header: 'Thumb',
      cell: (d) => <ThumbCell doc={d} />,
    },
    {
      header: 'Filename',
      cell: (d) => (
        <a
          href={`/api/documents/${d.id}/file`}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline"
        >
          {d.filename}
        </a>
      ),
    },
    {
      header: 'Added',
      cell: (d) => (
        <span className="text-gray-500 text-xs">{relativeTime(d.created_at)}</span>
      ),
    },
    {
      header: 'Status',
      cell: (d) => (
        <div className="space-y-0.5">
          <span>{d.status}</span>
          {d.status === 'needs_triage' && d.reason_type && (
            <span className="block text-xs text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
              {reasonBadge(d.reason_type)}
            </span>
          )}
        </div>
      ),
    },
    {
      header: 'Channel',
      cell: (d) => (
        <span className="text-xs text-gray-500">{channelLabel(d.channel)}</span>
      ),
    },
    {
      header: 'Linked',
      cell: (d) => <LinkedCell doc={d} />,
    },
  ];

  return (
    <div className="p-4 space-y-4 text-sm">
      {error && <p className="text-red-600">{error}</p>}

      <Table
        columns={columns}
        rows={docs}
        actions={(d) => {
          const locked = isDeleteLocked(d);
          const showIntake =
            d.status === 'pending' || d.status === 'needs_triage';
          return (
            <div className="space-x-3 whitespace-nowrap">
              <a
                href={`/api/documents/${d.id}/file`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
              >
                View
              </a>
              {showIntake && (
                <a
                  href={`/intake?expand=${d.id}`}
                  className="text-blue-600 hover:underline"
                >
                  Open in Intake
                </a>
              )}
              <button
                type="button"
                disabled={detailsBusy && selected === d.id}
                onClick={() => void openDetails(d.id)}
                className="text-blue-600 hover:underline disabled:opacity-50"
              >
                Details
              </button>
              <button
                type="button"
                disabled={busy || locked}
                title={
                  locked
                    ? `Cannot delete: expense is ${d.expense_status}`
                    : undefined
                }
                aria-label={
                  locked
                    ? `Cannot delete — linked expense is ${d.expense_status}`
                    : 'Delete document'
                }
                onClick={() => void onDelete(d)}
                className="text-red-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Delete
              </button>
            </div>
          );
        }}
      />

      {selected !== null && (
        <section className="space-y-3 border rounded p-3 bg-gray-50">
          <h2 className="font-medium text-gray-700">
            Details — document #{selected}
          </h2>
          {detailsBusy && <p className="text-gray-500">Loading…</p>}
          {details && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-gray-500 uppercase">
                  Classification
                </h3>
                <ClassificationPanel details={details} />
              </div>
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-gray-500 uppercase">
                  OCR text
                </h3>
                {details.ocr.ok ? (
                  <pre className="text-xs whitespace-pre-wrap bg-white border rounded p-2 max-h-80 overflow-auto">
                    {details.ocr.markdown}
                  </pre>
                ) : (
                  <p className="text-red-600">
                    OCR failed ({details.ocr.category}): {details.ocr.detail}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
