import { useEffect, useState } from 'react';
import {
  getDocuments,
  getDocumentDebug,
  deleteDocument,
  type DocumentRow,
  type DocumentDebug,
} from '../api';

function Classification({ debug }: { debug: DocumentDebug }) {
  if (debug.classification === null) {
    return (
      <p className="text-gray-500">
        No classification — OCR did not produce text.
      </p>
    );
  }
  if (!debug.classification.ok) {
    return (
      <p className="text-red-600">
        Classification failed ({debug.classification.category}):{' '}
        {debug.classification.detail}
      </p>
    );
  }
  const r = debug.classification.result;
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

export function DocumentsView() {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [debug, setDebug] = useState<DocumentDebug | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () =>
    getDocuments()
      .then(setDocs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
  }, []);

  const onDelete = async (d: DocumentRow) => {
    if (!window.confirm(`Delete document #${d.id} "${d.filename}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDocument(d.id);
      if (selected === d.id) {
        setSelected(null);
        setDebug(null);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runDebug = async (id: number) => {
    setSelected(id);
    setDebug(null);
    setDebugBusy(true);
    setError(null);
    try {
      setDebug(await getDocumentDebug(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDebugBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-4 text-sm">
      {error && <p className="text-red-600">{error}</p>}

      <table className="min-w-full border-collapse">
        <thead>
          <tr className="border-b bg-gray-50 text-left">
            <th className="px-3 py-2 font-medium text-gray-700">ID</th>
            <th className="px-3 py-2 font-medium text-gray-700">Filename</th>
            <th className="px-3 py-2 font-medium text-gray-700">Type</th>
            <th className="px-3 py-2 font-medium text-gray-700">Size</th>
            <th className="px-3 py-2 font-medium text-gray-700">Status</th>
            <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className="border-b align-top">
              <td className="px-3 py-2">{d.id}</td>
              <td className="px-3 py-2">{d.filename}</td>
              <td className="px-3 py-2">{d.mime_type}</td>
              <td className="px-3 py-2">{(d.size_bytes / 1024).toFixed(1)} KB</td>
              <td className="px-3 py-2">{d.status}</td>
              <td className="px-3 py-2 space-x-3 whitespace-nowrap">
                <button
                  type="button"
                  disabled={debugBusy && selected === d.id}
                  onClick={() => void runDebug(d.id)}
                  className="text-blue-600 hover:underline disabled:opacity-50"
                >
                  Debug
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onDelete(d)}
                  className="text-red-600 hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected !== null && (
        <section className="space-y-3 border rounded p-3 bg-gray-50">
          <h2 className="font-medium text-gray-700">
            Debug — document #{selected}{' '}
            <span className="text-xs text-gray-400">
              (re-runs OCR + classification; does not change routing)
            </span>
          </h2>
          {debugBusy && <p className="text-gray-500">Running…</p>}
          {debug && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-gray-500 uppercase">
                  LLM classification
                </h3>
                <Classification debug={debug} />
              </div>
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-gray-500 uppercase">
                  OCR text (Pass-1)
                </h3>
                {debug.ocr.ok ? (
                  <pre className="text-xs whitespace-pre-wrap bg-white border rounded p-2 max-h-80 overflow-auto">
                    {debug.ocr.markdown}
                  </pre>
                ) : (
                  <p className="text-red-600">
                    OCR failed ({debug.ocr.category}): {debug.ocr.detail}
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
