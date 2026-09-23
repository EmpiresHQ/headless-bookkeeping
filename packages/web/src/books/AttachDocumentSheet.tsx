import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useState } from 'react';
import {
  attachExpenseDocument,
  fmtCents,
  getExpense,
  listAttachableDocuments,
  type AttachDocumentResult,
  type AttachableDocument,
  type ExpenseDetail,
} from '../api';
import { absoluteDate } from '../inbox/format';
import {
  rethrowIfEnded,
  usePendingOperation,
  type OperationContext,
} from '../lib/pendingOperation';
import { useUnsavedChanges } from '../lib/unsavedChanges';
import { booksKeys, invalidateBooks } from '../queries/books';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Sheet } from '../ui/Sheet';
import { toastOk } from '../ui/toast';
import { READABLE } from '../ui/List';

/**
 * Issue #248 — attach a late receipt to an EXISTING expense ("Receipt coming
 * later"). Either a new file (the server stores and attaches it in one step;
 * it is never queued for intake, so no second expense can appear) or a
 * document the server lists as attachable. Only the empty source is filled:
 * amounts, status, entry and bank match stay as they are.
 *
 * Honesty contract: success is shown only once a fresh read of the expense
 * carries the returned document id. A failed attach keeps the chosen file or
 * document and shows the server's reason; an attach that succeeded but could
 * not be re-read is reported as exactly that, with a re-check — never as a
 * failure to retry blindly, never as a verified success.
 */

type Mode = 'upload' | 'existing';

type Phase =
  | { kind: 'idle' }
  | { kind: 'failed'; message: string }
  | { kind: 'unverified'; result: AttachDocumentResult; message: string };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AttachDocumentSheet({
  open,
  onOpenChange,
  detail,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: ExpenseDetail;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('upload');
  const [file, setFile] = useState<File | null>(null);
  // The chosen document itself, not just its id: if the server stops
  // offering it, its name and context stay on screen.
  const [chosen, setChosen] = useState<AttachableDocument | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const op = usePendingOperation('Attach receipt');
  const busy = op.pending;
  // Unsaved = a choice not yet accepted by the server. Once the attach was
  // accepted ('unverified' — only the re-read is pending) the document is on
  // the server: closing loses the re-check UI, not the operator's input.
  const guard = useUnsavedChanges({
    label: 'Attach receipt',
    active: open && phase.kind !== 'unverified',
    // Both choices survive a mode switch, so both count; the mode alone not.
    values: { file, chosen },
    baseline: { file: null, chosen: null },
  });

  const candidatesQ = useQuery({
    queryKey: booksKeys.attachable(detail.id),
    queryFn: () => listAttachableDocuments(detail.id),
    enabled: open && mode === 'existing',
  });
  const stillOffered =
    chosen !== null &&
    (candidatesQ.data === undefined ||
      candidatesQ.data.some((d) => d.id === chosen.id));

  const chosenName =
    mode === 'upload' ? (file?.name ?? null) : (chosen?.filename ?? null);
  const canAttach =
    phase.kind !== 'unverified' &&
    (mode === 'upload' ? file !== null : chosen !== null && stillOffered);

  const close = (o: boolean) => {
    if (!o && busy) return;
    onOpenChange(o);
  };

  /**
   * Re-read the expense; success only when it carries the new source. A
   * direct read, not the screen's detail query: a failed re-read must not put
   * the screen into its load-error state (that would unmount this sheet and
   * its recovery UI). The cache is written only with a confirmed read.
   */
  const expenseId = detail.id;
  type Verified =
    | { kind: 'confirmed'; result: AttachDocumentResult }
    | { kind: 'unverified'; result: AttachDocumentResult; message: string };

  /**
   * Re-read the expense; success only when it carries the new source. A
   * direct read, not the screen's detail query: a failed re-read must not
   * put the screen into its load-error state (that would unmount this sheet
   * and its recovery UI). The cache is written only with a confirmed read —
   * and only while the operation still owns its session.
   */
  const verify = async (
    ctx: OperationContext,
    result: AttachDocumentResult,
  ): Promise<Verified> => {
    ctx.check();
    let fresh: ExpenseDetail;
    try {
      fresh = await getExpense(expenseId);
    } catch (e) {
      rethrowIfEnded(e);
      return {
        kind: 'unverified',
        result,
        message: `The server accepted the document, but the expense could not be re-read to confirm it (${errText(e)}).`,
      };
    }
    if (fresh.document_id !== result.document.id) {
      // The server accepted the write; do not invite a second one.
      return {
        kind: 'unverified',
        result,
        message:
          fresh.document_id == null
            ? 'The server accepted the document, but the expense does not show it yet.'
            : `The server accepted the document, but the expense now shows source document #${fresh.document_id}.`,
      };
    }
    ctx.check();
    qc.setQueryData(booksKeys.expense(expenseId), fresh);
    await invalidateBooks(qc);
    return { kind: 'confirmed', result };
  };

  const settle = (v: Verified) => {
    if (v.kind === 'unverified') {
      setPhase(v);
      return;
    }
    toastOk(
      v.result.outcome === 'already_attached'
        ? 'This document was already attached'
        : `Attached · ${v.result.document.filename}`,
    );
    guard.release();
    onOpenChange(false);
  };

  const attach = () => {
    if (!canAttach) return;
    const source =
      mode === 'upload'
        ? { file: file as File }
        : { documentId: (chosen as AttachableDocument).id };
    const fromExisting = mode === 'existing';
    const started = op.run(
      async (ctx) => {
        const result = await attachExpenseDocument(expenseId, source);
        return verify(ctx, result);
      },
      {
        onSuccess: settle,
        onError: (e) => {
          setPhase({ kind: 'failed', message: errText(e) });
          // Eligibility may have changed (claimed by intake, used
          // elsewhere): refresh the list, but keep what the operator chose
          // on screen.
          if (fromExisting) {
            void qc.invalidateQueries({
              queryKey: booksKeys.attachable(expenseId),
            });
          }
        },
      },
    );
    if (started) setPhase({ kind: 'idle' });
  };

  const recheck = () => {
    if (phase.kind !== 'unverified') return;
    const { result } = phase;
    op.run((ctx) => verify(ctx, result), {
      onSuccess: settle,
      onError: (e) =>
        setPhase({
          kind: 'unverified',
          result,
          message: `The server accepted the document, but the expense could not be re-read to confirm it (${errText(e)}).`,
        }),
    });
  };

  const posted = detail.status === 'posted' || detail.status === 'reversed';

  return (
    <Sheet
      open={open}
      onOpenChange={close}
      title="Attach receipt"
      guard={guard}
      busy={busy}
    >
      <div className="space-y-3 px-5 pb-2">
        <SegmentedControl<Mode>
          options={[
            { value: 'upload', label: 'Upload file' },
            { value: 'existing', label: 'From Documents' },
          ]}
          value={mode}
          onChange={(m) => {
            if (busy || phase.kind === 'unverified') return;
            setMode(m);
            setPhase({ kind: 'idle' });
          }}
        />

        {mode === 'upload' ? (
          <label className="block rounded-2xl bg-surface px-3.5 py-3">
            <span className="text-[13px] text-ink-2">Receipt or invoice</span>
            <input
              type="file"
              aria-label="Receipt file"
              accept="application/pdf,image/*"
              disabled={busy || phase.kind === 'unverified'}
              className="mt-1 block w-full text-[13px]"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                // A cancelled picker keeps the file already chosen.
                if (f !== null) {
                  setFile(f);
                  setPhase({ kind: 'idle' });
                }
              }}
            />
            {file !== null && (
              <span
                className={`mt-1 block text-[13px] font-semibold ${READABLE}`}
              >
                {file.name}
              </span>
            )}
          </label>
        ) : (
          <CandidateList
            query={candidatesQ}
            selected={chosen?.id ?? null}
            disabled={busy || phase.kind === 'unverified'}
            onSelect={(d) => {
              setChosen(d);
              setPhase({ kind: 'idle' });
            }}
            noLongerOffered={chosen !== null && !stillOffered ? chosen : null}
          />
        )}

        <div className="rounded-2xl bg-surface px-3.5 py-3 text-[12.5px]">
          <p className="font-semibold text-ink">
            {chosenName != null
              ? `Attach “${chosenName}” to this expense`
              : 'Choose the receipt to attach'}
          </p>
          <p className="mt-0.5 text-ink-2">
            {fmtCents(detail.gross_amount)} {detail.currency} ·{' '}
            {detail.category}. Amounts, status and bank match stay as they are
            {posted ? '; the posted entry is not changed' : ''}.
          </p>
          {detail.vat_amount === 0 && (
            <p className="mt-0.5 text-ink-2">{vatZeroHint(detail.status)}</p>
          )}
        </div>

        {phase.kind === 'failed' && (
          <div role="alert" className="rounded-xl bg-err/10 px-3.5 py-2.5">
            <p className="text-[13px] font-semibold text-err">Not attached</p>
            <p className="mt-0.5 text-[12.5px] text-ink">{phase.message}</p>
            <p className="mt-0.5 text-[12px] text-ink-2">
              Your choice is kept — try again or pick another document.
            </p>
          </div>
        )}
        {phase.kind === 'unverified' && (
          <div role="status" className="rounded-xl bg-warn-bg px-3.5 py-2.5">
            <p className="text-[13px] font-semibold text-warn">
              Attached — not yet confirmed
            </p>
            <p className="mt-0.5 text-[12.5px] text-ink">{phase.message}</p>
            <p className="mt-0.5 text-[12px] text-ink-2">
              Do not attach it again; check the expense instead.
            </p>
          </div>
        )}

        {phase.kind === 'unverified' ? (
          <Button className="w-full" busy={busy} onClick={recheck}>
            Check the expense again
          </Button>
        ) : (
          <Button
            className="w-full"
            busy={busy}
            disabled={!canAttach}
            onClick={attach}
          >
            {mode === 'upload' ? 'Upload & attach' : 'Attach document'}
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** VAT stays 0 after an attach; say where it CAN be changed for this status. */
function vatZeroHint(status: string): string {
  const base = 'Attaching does not reclaim VAT';
  switch (status) {
    case 'draft':
      return `${base} — change it with Edit draft….`;
    case 'pending':
      return `${base} — it is awaiting approval; change it once it is decided.`;
    case 'posted':
      return `${base} — use Correct… for that.`;
    default:
      return `${base}; corrections are one-shot — issue a credit note or a new expense for further changes.`;
  }
}

function CandidateList({
  query,
  selected,
  disabled,
  onSelect,
  noLongerOffered,
}: {
  query: UseQueryResult<AttachableDocument[]>;
  selected: number | null;
  disabled: boolean;
  onSelect: (d: AttachableDocument) => void;
  noLongerOffered: AttachableDocument | null;
}) {
  if (query.isError) {
    return (
      <div className="rounded-2xl bg-err-bg px-4 py-3">
        <p className="text-[13px] font-semibold text-err">
          Could not load documents — {errText(query.error)}
        </p>
        <Button
          variant="secondary"
          className="mt-2"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (query.data === undefined) return <SkeletonRows count={2} />;
  const docs = query.data;
  return (
    <div>
      {noLongerOffered !== null && (
        <p className="mb-2 text-[12.5px] text-warn">
          “{noLongerOffered.filename}” is no longer offered for attaching — pick
          another document or upload the file.
        </p>
      )}
      {docs.length === 0 ? (
        <p className="rounded-2xl bg-surface px-3.5 py-3 text-[13px] text-ink-2">
          No unassigned documents can be attached. Documents already used by an
          expense, invoice or allowance, or still being processed, are not
          offered — upload the file instead.
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label="Documents"
          className="overflow-hidden rounded-2xl bg-surface"
        >
          {docs.map((d) => {
            const on = d.id === selected;
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={disabled}
                onClick={() => onSelect(d)}
                className="flex w-full items-center gap-3 border-b border-line px-3.5 py-2.5 text-left last:border-b-0"
              >
                <div className={`min-w-0 flex-1 ${READABLE}`}>
                  <div className="text-[14px] font-semibold">{d.filename}</div>
                  <div className="text-[12px] text-ink-2">
                    {d.status === 'needs_triage'
                      ? 'Needs review'
                      : 'Waiting for intake'}{' '}
                    · {absoluteDate(d.created_at)}
                    {d.reason != null ? ` · ${d.reason}` : ''}
                  </div>
                </div>
                <span
                  aria-hidden
                  className={`h-[22px] w-[22px] flex-none rounded-full border-2 ${
                    on
                      ? 'border-accent bg-[radial-gradient(circle,theme(colors.accent.DEFAULT)_42%,transparent_48%)]'
                      : 'border-chevron'
                  }`}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
