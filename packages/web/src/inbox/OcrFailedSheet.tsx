import { useRef, useState } from 'react';
import {
  completeDocument,
  retryDocument,
  triageDocument,
  uploadDocument,
  type TriageOutcome,
} from '../api';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';

/**
 * Triage flow 4 — OCR failed. Replacement = upload a clearer scan (the NEW
 * file auto-triages; the broken original is archived), or re-run OCR on the
 * same file (result lands via queue polling). Dismiss lives on the screen
 * behind a ConfirmDialog, not here.
 */
export function OcrFailedSheet({
  documentId,
  open,
  onOpenChange,
  onReplaced,
  onRetried,
}: {
  documentId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReplaced: (o: TriageOutcome) => void;
  onRetried: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [hasFile, setHasFile] = useState(false);
  const [busy, setBusy] = useState(false);

  const onReplace = async () => {
    const file = fileRef.current?.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    try {
      const { document } = await uploadDocument(file);
      const outcome = await triageDocument(document.id);
      await completeDocument(documentId); // archive the unreadable original
      onReplaced(outcome);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const onRetry = async () => {
    setBusy(true);
    try {
      await retryDocument(documentId);
      onRetried();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Fix file">
      <div className="space-y-3 px-5 pb-2">
        <p className="text-[13px] text-ink-2">
          OCR could not read this file. Upload a clearer scan of the SAME
          document (the broken one is archived), or retry on this file.
        </p>
        <input
          ref={fileRef}
          type="file"
          aria-label="Replacement file"
          className="w-full text-[13px]"
          onChange={(e) => setHasFile((e.target.files?.length ?? 0) > 0)}
        />
        <Button
          className="w-full"
          busy={busy}
          disabled={!hasFile}
          onClick={() => void onReplace()}
        >
          Upload replacement
        </Button>
        <Button
          variant="secondary"
          className="w-full"
          disabled={busy}
          onClick={() => void onRetry()}
        >
          Retry OCR on this file
        </Button>
      </div>
    </Sheet>
  );
}
