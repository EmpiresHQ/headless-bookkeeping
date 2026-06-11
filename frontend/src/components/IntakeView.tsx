import { Fragment, useEffect, useRef, useState } from 'react';
import {
  uploadDocument,
  getTriagePending,
  getDocuments,
  triageDocument,
  completeDocument,
  type DocumentRow,
  type TriageOutcome,
} from '../api';
import { ResolveSupplierForm } from './ResolveSupplierForm';

function outcomeLabel(o: TriageOutcome): string {
  if (o.kind === 'expense') return `→ draft expense #${o.expense_id}`;
  if (o.kind === 'invoice') return `→ draft invoice #${o.invoice_id}`;
  return `→ needs triage: ${o.reason}`;
}

export function IntakeView() {
  const [pending, setPending] = useState<DocumentRow[]>([]);
  // Documents the workflow parked for a human (status 'needs_triage').
  const [needsTriage, setNeedsTriage] = useState<DocumentRow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Per-document triage outcome, keyed by document id.
  const [outcomes, setOutcomes] = useState<Record<number, string>>({});
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    Promise.all([getTriagePending(), getDocuments()])
      .then(([p, all]) => {
        setPending(p);
        setNeedsTriage(all.filter((d) => d.status === 'needs_triage'));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUpload = () =>
    run(async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) return;
      const { document, deduplicated } = await uploadDocument(file);
      setNote(
        deduplicated
          ? `Document #${document.id} already existed (deduplicated).`
          : `Uploaded document #${document.id}.`,
      );
      if (fileRef.current) fileRef.current.value = '';
      await refresh();
    });

  const onTriage = (id: number) =>
    run(async () => {
      const outcome = await triageDocument(id);
      setOutcomes((m) => ({ ...m, [id]: outcomeLabel(outcome) }));
      await refresh();
    });

  const onComplete = (id: number) =>
    run(async () => {
      await completeDocument(id);
      await refresh();
    });

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          aria-label="Upload document"
          className="text-sm"
        />
        <button
          type="button"
          disabled={busy}
          onClick={onUpload}
          className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-50"
        >
          Upload
        </button>
        {note && <span className="text-sm text-green-700">{note}</span>}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-1">
          Pending documents
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing pending.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="min-w-full text-sm border-collapse">
            <thead>
              <tr className="border-b bg-gray-50 text-left">
                <th className="px-3 py-2 font-medium text-gray-700">ID</th>
                <th className="px-3 py-2 font-medium text-gray-700">Filename</th>
                <th className="px-3 py-2 font-medium text-gray-700">Status</th>
                <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr key={d.id} className="border-b align-top">
                  <td className="px-3 py-2">{d.id}</td>
                  <td className="px-3 py-2">{d.filename}</td>
                  <td className="px-3 py-2">
                    {d.status}
                    {outcomes[d.id] && (
                      <span className="block text-gray-500">
                        {outcomes[d.id]}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 space-x-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onTriage(d.id)}
                      className="text-blue-600 hover:underline disabled:opacity-50"
                    >
                      Run triage
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onComplete(d.id)}
                      className="text-gray-600 hover:underline disabled:opacity-50"
                    >
                      Complete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-1">
          Needs triage
          <span className="ml-2 text-xs font-normal text-gray-400">
            parked for a human — the kernel could not act on it automatically
          </span>
        </h2>
        {needsTriage.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing to triage.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead>
                <tr className="border-b bg-gray-50 text-left">
                  <th className="px-3 py-2 font-medium text-gray-700">ID</th>
                  <th className="px-3 py-2 font-medium text-gray-700">
                    Filename
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-700">Reason</th>
                  <th className="px-3 py-2 font-medium text-gray-700">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {needsTriage.map((d) => (
                  <Fragment key={d.id}>
                    <tr className="border-b align-top">
                      <td className="px-3 py-2">{d.id}</td>
                      <td className="px-3 py-2">{d.filename}</td>
                      <td className="px-3 py-2 text-gray-500">
                        {outcomes[d.id] ?? (
                          <span className="text-gray-400">
                            (click Why? to load)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 space-x-2 whitespace-nowrap">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setResolvingId(d.id)}
                          className="text-green-700 hover:underline disabled:opacity-50"
                        >
                          Resolve
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onTriage(d.id)}
                          className="text-blue-600 hover:underline disabled:opacity-50"
                        >
                          Why?
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onComplete(d.id)}
                          className="text-gray-600 hover:underline disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </td>
                    </tr>
                    {resolvingId === d.id && (
                      <tr>
                        <td colSpan={4} className="px-3 py-2">
                          <ResolveSupplierForm
                            documentId={d.id}
                            onCancel={() => setResolvingId(null)}
                            onDone={() => {
                              setResolvingId(null);
                              void refresh();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
