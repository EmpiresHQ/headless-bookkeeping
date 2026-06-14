import { useEffect, useRef, useState } from 'react';
import {
  uploadDocument,
  getTriagePending,
  getNeedsTriageItems,
  triageDocument,
  completeDocument,
  type DocumentRow,
  type NeedsTriageItem,
  type TriageOutcome,
} from '../api';
import { TriageManualInvoiceForm } from './TriageManualInvoiceForm';
import { Table, type Column } from './Table';
import { ResolveSupplierForm } from './ResolveSupplierForm';
import { TriageManualForm } from './TriageManualForm';
import { TriageOcrFailedForm } from './TriageOcrFailedForm';

function outcomeLabel(o: TriageOutcome): string {
  if (o.kind === 'expense') return `→ draft expense #${o.expense_id}`;
  if (o.kind === 'invoice') return `Sales invoice #${o.invoice_id}`;
  if (o.kind === 'bank_statement')
    return `Bank import started (job #${o.job_id})`;
  return `→ needs triage: ${o.reason}`;
}

function reasonBadge(item: NeedsTriageItem): string {
  switch (item.reason_type) {
    case 'supplier_unresolved':
      return '⚠ Unknown supplier';
    case 'outgoing_invoice':
      return '⚠ Outgoing invoice';
    case 'low_confidence':
      return '⚠ Low AI confidence';
    case 'category_unresolved':
      return '⚠ Unknown category';
    case 'ocr_failed':
      return '✗ OCR failed';
    case 'unimplemented':
      return 'ℹ Not yet implemented';
    default:
      return '⚠ Needs review';
  }
}

export function IntakeView() {
  const [pending, setPending] = useState<DocumentRow[]>([]);
  const [needsTriageItems, setNeedsTriageItems] = useState<NeedsTriageItem[]>(
    [],
  );
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-document loading state — OCR + LLM can take a minute or two.
  const [processing, setProcessing] = useState<Set<number>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<number, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    Promise.all([getTriagePending(), getNeedsTriageItems()])
      .then(([p, items]) => {
        setPending(p);
        setNeedsTriageItems(items);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUpload = () =>
    run(async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) return;
      const { document, deduplicated } = await uploadDocument(file);
      if (fileRef.current) fileRef.current.value = '';
      const outcome = await triageDocument(document.id);
      setOutcomes((m) => ({ ...m, [document.id]: outcomeLabel(outcome) }));
      setNote(
        (deduplicated
          ? `Document #${document.id} already existed.`
          : `Uploaded document #${document.id}.`) + ` ${outcomeLabel(outcome)}`,
      );
      await refresh();
    });

  const onTriage = (id: number) => {
    setProcessing((prev) => new Set(prev).add(id));
    void run(async () => {
      const outcome = await triageDocument(id);
      setOutcomes((m) => ({ ...m, [id]: outcomeLabel(outcome) }));
      await refresh();
    }).finally(() => {
      setProcessing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  };

  const onComplete = (id: number) =>
    run(async () => {
      await completeDocument(id);
      if (expandedId === id) setExpandedId(null);
      await refresh();
    });

  const onFormDone = () => {
    setExpandedId(null);
    void refresh();
  };

  const pendingColumns: Column<DocumentRow>[] = [
    { header: 'ID', cell: (d) => d.id },
    { header: 'Filename', cell: (d) => d.filename },
    {
      header: 'Status',
      cell: (d) => (
        <>
          {d.status}
          {outcomes[d.id] && (
            <span className="block text-gray-500">{outcomes[d.id]}</span>
          )}
        </>
      ),
    },
  ];

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
          disabled={processing.size > 0}
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
          <Table
            columns={pendingColumns}
            rows={pending}
            actions={(d) => {
              const isProcessing =
                processing.has(d.id) || d.processing_since !== null;
              return (
                <div className="space-x-2">
                  {isProcessing ? (
                    <span className="text-blue-400 italic">Processing…</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onTriage(d.id)}
                      className="text-blue-600 hover:underline"
                    >
                      Retry
                    </button>
                  )}
                </div>
              );
            }}
          />
        )}
      </div>

      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-1">
          Needs triage
          <span className="ml-2 text-xs font-normal text-gray-400">
            parked for a human — the kernel could not act on it automatically
          </span>
        </h2>
        {needsTriageItems.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing to triage.</p>
        ) : (
          <div className="border rounded divide-y text-sm">
            {needsTriageItems.map((item) => {
              const isExpanded = expandedId === item.id;
              return (
                <div key={item.id}>
                  <div
                    className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-gray-50"
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400 text-xs w-6">
                        {item.id}
                      </span>
                      <span>{item.filename}</span>
                      <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                        {reasonBadge(item)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onComplete(item.id);
                        }}
                        className="text-gray-500 hover:underline text-xs"
                      >
                        Dismiss
                      </button>
                      <span className="text-gray-400 text-xs">
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    </div>
                  </div>

                  {isExpanded && (
                    <>
                      {item.reason_type === 'supplier_unresolved' && (
                        <ResolveSupplierForm
                          documentId={item.id}
                          onDone={onFormDone}
                          onCancel={() => setExpandedId(null)}
                        />
                      )}
                      {(item.reason_type === 'low_confidence' ||
                        item.reason_type === 'category_unresolved') && (
                        <TriageManualForm
                          documentId={item.id}
                          onDone={onFormDone}
                          onCancel={() => setExpandedId(null)}
                        />
                      )}
                      {item.reason_type === 'ocr_failed' && (
                        <TriageOcrFailedForm
                          documentId={item.id}
                          onDone={onFormDone}
                          onCancel={() => setExpandedId(null)}
                        />
                      )}
                      {item.reason_type === 'outgoing_invoice' && (
                        <TriageManualInvoiceForm
                          documentId={item.id}
                          onDone={onFormDone}
                          onCancel={() => setExpandedId(null)}
                        />
                      )}
                      {(item.reason_type === 'unimplemented' ||
                        item.reason_type === 'unknown') && (
                        <div className="px-3 py-2 bg-gray-50 text-xs text-gray-500">
                          {item.reason}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
