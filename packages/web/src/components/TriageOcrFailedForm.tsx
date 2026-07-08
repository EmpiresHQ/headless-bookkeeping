import { useRef, useState } from 'react';
import {
  uploadDocument,
  triageDocument,
  completeDocument,
  retryDocument,
} from '../api';

export function TriageOcrFailedForm({
  documentId,
  onDone,
  onCancel,
}: {
  documentId: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onReplace = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Select a file first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { document } = await uploadDocument(file);
      await triageDocument(document.id);
      await completeDocument(documentId); // dismiss the broken original
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const onDismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await completeDocument(documentId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const onRetry = async () => {
    setBusy(true);
    setError(null);
    try {
      await retryDocument(documentId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="p-3 space-y-3 text-sm bg-red-50 border-t border-red-200">
      <p className="text-red-800 text-xs">
        OCR failed — the file could not be read. Upload a clearer scan of the
        same document, or dismiss.
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          ref={fileRef}
          type="file"
          aria-label="Replacement file"
          className="text-sm"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void onReplace()}
          className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-50"
        >
          Upload replacement
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onDismiss()}
          className="text-gray-600 hover:underline text-sm disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRetry()}
          className="bg-green-600 text-white rounded px-3 py-1 text-sm disabled:opacity-50"
        >
          Retry
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="text-gray-400 hover:underline text-sm disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {error && <p className="text-red-600 text-xs">{error}</p>}
    </div>
  );
}
