import { useRef, useState } from 'react';
import {
  completeDocument,
  retryDocument,
  triageDocument,
  uploadDocument,
  type TriageOutcome,
} from '../api';
import { useUnsavedChanges } from '../lib/unsavedChanges';
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
  // The chosen File itself (identity), not a flag: a new selection after a
  // discard or a failed attempt is a new, unsaved choice.
  const [file, setFile] = useState<File | null>(null);
  const hasFile = file !== null;
  const [busy, setBusy] = useState(false);
  const guard = useUnsavedChanges({
    label: 'Fix file',
    active: open,
    values: file,
    baseline: null,
  });

  const onReplace = async () => {
    if (file === null) return;
    setBusy(true);
    try {
      const { document } = await uploadDocument(file);
      const outcome = await triageDocument(document.id);
      await completeDocument(documentId); // archive the unreadable original
      guard.release();
      onReplaced(outcome);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const onRetry = async () => {
    // Retrying the ORIGINAL abandons a chosen replacement: ask first, before
    // anything irreversible runs (confirmDiscard releases on "Discard").
    if (!(await guard.confirmDiscard())) return;
    // Discarded: clear the choice, so a failed retry leaves a clean form
    // and any later selection reads as new input.
    if (fileRef.current !== null) fileRef.current.value = '';
    setFile(null);
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
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Fix file"
      guard={guard}
      busy={busy}
    >
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
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
