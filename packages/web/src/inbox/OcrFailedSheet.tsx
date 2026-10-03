import { useRef, useState } from 'react';
import {
  completeDocument,
  retryDocument,
  triageDocument,
  uploadDocument,
  type TriageOutcome,
} from '../api';
import { usePendingOperation } from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { Button } from '../ui/Button';
import { PendingFieldset } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';
import { ChosenFileReview } from '../upload/ChosenFileReview';

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
  // The chosen File itself (identity), not a flag: a new selection after a
  // discard or a failed attempt is a new, unsaved choice.
  const [file, setFile] = useState<File | null>(null);
  const hasFile = file !== null;
  const op = usePendingOperation('Fix file');
  const busy = op.pending;
  // Partial success (issue #251): stages of a replacement the server has
  // already accepted, bound to the exact File — a retry of the SAME file
  // resumes (no second upload, no second triage); another file starts over.
  const landed = useRef<{
    file: File;
    documentId: number;
    outcome: TriageOutcome | null;
  } | null>(null);
  const [landedShown, setLandedShown] = useState<number | null>(null);
  const partial =
    landed.current !== null && landed.current.file === file
      ? landed.current
      : null;
  const guard = useUnsavedChanges({
    label: 'Fix file',
    active: open,
    values: file,
    baseline: null,
  });

  const onReplace = () => {
    if (file === null) return;
    const chosen = file;
    const resume = partial;
    op.run(
      async (ctx) => {
        let up = resume;
        if (up === null) {
          const { document } = await uploadDocument(chosen);
          up = { file: chosen, documentId: document.id, outcome: null };
          landed.current = up;
        }
        if (up.outcome === null) {
          ctx.check();
          up.outcome = await triageDocument(up.documentId);
        }
        ctx.check();
        await completeDocument(documentId); // archive the unreadable original
        return up.outcome;
      },
      {
        onSuccess: (outcome) => {
          landed.current = null;
          guard.release();
          onReplaced(outcome);
        },
        onError: (e) => {
          const up = landed.current;
          const message = e instanceof Error ? e.message : String(e);
          if (up !== null && up.file === chosen) {
            setLandedShown(up.documentId);
            toastErr(
              `The replacement is uploaded as document #${up.documentId}, but ${up.outcome === null ? 'processing it' : 'archiving the original'} failed: ${message}`,
            );
          } else {
            toastErr(message);
          }
        },
      },
    );
  };

  const onRetry = async () => {
    // Retrying the ORIGINAL abandons a chosen replacement: ask first, before
    // anything irreversible runs (confirmDiscard releases on "Discard").
    if (!(await guard.confirmDiscard())) return;
    // Discarded: clear the choice, so a failed retry leaves a clean form
    // and any later selection reads as new input.
    setFile(null);
    op.run(() => retryDocument(documentId), { onSuccess: onRetried });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Fix file"
      guard={guard}
      busy={busy}
    >
      <PendingFieldset pending={busy} className="space-y-3 px-5 pb-2">
        <p className="text-[13px] text-ink-2">
          OCR could not read this file. Upload a clearer scan of the SAME
          document (the broken one is archived), or retry on this file.
        </p>
        {/* Checked locally before anything is sent (#293) — the same
            chooser as "Upload a document". */}
        <ChosenFileReview
          label="Replacement file"
          file={file}
          onChoose={setFile}
          onRemove={() => setFile(null)}
          submitLabel="Upload replacement"
          uploadedAs={partial?.documentId ?? null}
        />
        <Button
          className="w-full"
          busy={busy}
          disabled={!hasFile}
          onClick={onReplace}
        >
          {partial !== null ? 'Finish replacement' : 'Upload replacement'}
        </Button>
        {partial !== null && landedShown === partial.documentId && (
          <p className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            This file is already uploaded as document #{partial.documentId}
            {partial.outcome !== null ? ' and processed' : ''}. Finishing
            continues from there — it does not upload it again.
          </p>
        )}
        <Button
          variant="secondary"
          className="w-full"
          disabled={busy}
          onClick={() => void onRetry()}
        >
          Retry OCR on this file
        </Button>
      </PendingFieldset>
    </Sheet>
  );
}
