import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { completeDocument, type NeedsTriageItem } from '../api';
import {
  errorMessage,
  rethrowIfEnded,
  usePendingOperation,
} from '../lib/pendingOperation';
import { inboxKeys, invalidateInbox } from '../queries/inbox';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';

export function useInboxBulkArchive(documents: NeedsTriageItem[]) {
  const qc = useQueryClient();
  const op = usePendingOperation('Archiving selected documents');
  const [ids, setIds] = useState<Set<number>>(() => new Set());
  const [confirmation, setConfirmation] = useState<NeedsTriageItem[] | null>(
    null,
  );
  const [result, setResult] = useState<{
    archived: number;
    failed: { filename: string; message: string }[];
  } | null>(null);
  const selected = documents.filter((doc) => ids.has(doc.id));
  const toggle = (id: number) => {
    if (op.pending) return;
    setIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const archive = () => {
    if (!confirmation?.length) return;
    const targets = confirmation;
    op.run(
      async (ctx) => {
        const archived: number[] = [];
        const failed: { filename: string; message: string }[] = [];
        for (const doc of targets) {
          ctx.check();
          try {
            await completeDocument(doc.id);
            ctx.check();
            archived.push(doc.id);
            // Confirmed successes disappear immediately, including from the badge.
            qc.setQueryData<NeedsTriageItem[]>(inboxKeys.needsTriage, (rows) =>
              rows?.filter((row) => row.id !== doc.id),
            );
          } catch (error) {
            rethrowIfEnded(error);
            failed.push({
              filename: doc.filename,
              message: errorMessage(error),
            });
          }
        }
        return { archived, failed };
      },
      {
        onSuccess: ({ archived, failed }) => {
          setIds(
            (previous) =>
              new Set([...previous].filter((id) => !archived.includes(id))),
          );
          setResult({ archived: archived.length, failed });
          setConfirmation(null);
          void invalidateInbox(qc);
        },
        onError: (error) => {
          setResult({
            archived: 0,
            failed: [
              { filename: 'Archive interrupted', message: errorMessage(error) },
            ],
          });
          setConfirmation(null);
          void invalidateInbox(qc);
        },
      },
    );
  };

  return {
    selected,
    busy: op.pending,
    isSelected: (id: number) => ids.has(id),
    toggle,
    clear: () => {
      if (!op.pending) setIds(new Set());
    },
    toggleVisible: (visible: NeedsTriageItem[]) => {
      if (op.pending) return;
      const allSelected = visible.every((doc) => ids.has(doc.id));
      setIds((previous) => {
        const next = new Set(previous);
        for (const doc of visible) {
          if (allSelected) next.delete(doc.id);
          else next.add(doc.id);
        }
        return next;
      });
    },
    requestArchive: () => setConfirmation([...selected]),
    confirmation,
    closeConfirmation: () => {
      if (!op.pending) setConfirmation(null);
    },
    archive,
    result,
  };
}

export function InboxBulkArchive({
  bulk,
  visible,
}: {
  bulk: ReturnType<typeof useInboxBulkArchive>;
  visible: NeedsTriageItem[];
}) {
  const selectedVisible = visible.filter((doc) =>
    bulk.isSelected(doc.id),
  ).length;
  const hidden = bulk.selected.length - selectedVisible;
  return (
    <>
      {(visible.length > 0 || bulk.selected.length > 0) && (
        <div className="sticky top-0 z-20 mx-3.5 mb-3.5 rounded-xl border border-line bg-surface p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[13px] font-semibold">
              <input
                ref={(node) => {
                  if (node)
                    node.indeterminate =
                      selectedVisible > 0 && selectedVisible < visible.length;
                }}
                type="checkbox"
                className="size-5 accent-accent"
                aria-label="Select all visible documents"
                checked={
                  visible.length > 0 && selectedVisible === visible.length
                }
                disabled={bulk.busy || visible.length === 0}
                onChange={() => bulk.toggleVisible(visible)}
              />
              Select visible
            </label>
            {bulk.selected.length > 0 && (
              <>
                <span className="text-[13px] text-ink-2">
                  {bulk.selected.length} selected
                  {hidden > 0 ? ` · ${hidden} hidden by filters` : ''}
                </span>
                <button
                  type="button"
                  className="min-h-11 text-[13px] font-semibold text-accent"
                  disabled={bulk.busy}
                  onClick={bulk.clear}
                >
                  Clear selection
                </button>
                <Button
                  className="ml-auto"
                  disabled={bulk.busy}
                  onClick={bulk.requestArchive}
                >
                  Archive selected · {bulk.selected.length}
                </Button>
              </>
            )}
          </div>
          {bulk.selected.length === 0 && (
            <p className="text-[12px] text-ink-2">
              Preview documents, then select those to archive without booking.
            </p>
          )}
        </div>
      )}
      {bulk.result && (
        <div className="mx-4 mb-3 text-[13px]">
          <p role="status">
            {bulk.result.archived}{' '}
            {bulk.result.archived === 1 ? 'document' : 'documents'} archived
            without booking.
          </p>
          {bulk.result.failed.length > 0 && (
            <div role="alert" className="mt-1 text-err">
              <p>
                {bulk.result.failed.length} could not be confirmed as archived.
                Check their status before retrying.
              </p>
              <ul className="list-inside list-disc [overflow-wrap:anywhere]">
                {bulk.result.failed.map((failure, i) => (
                  <li key={i}>
                    {failure.filename}: {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={bulk.confirmation !== null}
        onOpenChange={(open) => {
          if (!open) bulk.closeConfirmation();
        }}
        title={`Archive ${bulk.confirmation?.length ?? 0} documents without booking?`}
        body="The selected documents will leave the Inbox. Their files will stay in Books. No accounting entries will be created. There is no undo."
        confirmLabel="Archive documents"
        busy={bulk.busy}
        onConfirm={bulk.archive}
      />
    </>
  );
}
