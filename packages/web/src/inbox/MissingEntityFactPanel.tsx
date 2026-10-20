import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, RefreshCw } from 'lucide-react';
import {
  confirmEntityFact,
  type MissingEntityFact,
  type MissingEntityFactDraft,
  type TriageOutcome,
} from '../api';
import { signedMoney } from '../lib/money';
import type { PendingOperation } from '../lib/pendingOperation';
import { inboxKeys, invalidateInbox } from '../queries/inbox';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { toastErr, toastOk } from '../ui/toast';
import { absoluteDateFromIso } from './format';
import { outcomeText } from './reason';

/**
 * The missing-entity-fact decision (issue #404): the supplier IS resolved —
 * its name and country are shown from the server's typed view — and only ONE
 * of its facts is missing. One interaction: the operator picks the fact's
 * value, the server records it through the legitimate entity-update path and
 * resumes the document's own first draft (no fresh OCR).
 *
 * The result is reported as the two truths it holds (GLOSSARY operation
 * result vs current state): a SAVED fact is acknowledged even when the
 * document still parks on the next genuine gate — never claimed as a
 * posting.
 */

const FACT_LABEL: Record<MissingEntityFact, string> = {
  taxStatus: 'tax status',
  goodsVsServices: 'goods or services',
};

const FACT_CHOICES: Record<
  MissingEntityFact,
  { value: string; label: string; help: string }[]
> = {
  taxStatus: [
    {
      value: 'taxable_business',
      label: 'Taxable business',
      help: 'A business acting as such — a taxable person of its country.',
    },
    {
      value: 'non_taxable',
      label: 'Not taxable',
      help: 'A consumer or a body that is not a taxable person.',
    },
  ],
  goodsVsServices: [
    {
      value: 'goods',
      label: 'Goods',
      help: 'An import — customs VAT is due at the border.',
    },
    {
      value: 'services',
      label: 'Services',
      help: 'A service bought from a foreign business — self-assessed reverse charge.',
    },
  ],
};

export function MissingEntityFactPanel({
  documentId,
  draft,
  pending,
  error,
  busy,
  op,
  onRetry,
  onResolved,
}: {
  documentId: number;
  draft: MissingEntityFactDraft | undefined;
  pending: boolean;
  error: Error | null;
  busy: boolean;
  /** The document's operation, owned by the screen (one at a time). */
  op: PendingOperation;
  /** Retry AI on the same document (the screen's reprocess path). */
  onRetry: () => void;
  /** Synchronous continuation for a document that resolved (issue #251). */
  onResolved: (outcome: TriageOutcome) => void;
}) {
  const qc = useQueryClient();
  // The selection is bound to the exact identity it was made for — the
  // document, the matched supplier, and the fact. A document held on
  // successive missing facts (confirm one → the kernel parks on the next)
  // re-renders this same component with a NEW fact, and the doc screen is
  // not keyed by document, so navigating to ANOTHER held supplier
  // re-renders it too. In neither case may the previous choice leak across
  // — neither as a preselected value nor as an enabled Save with no choice
  // made for the current fact.
  const [selection, setSelection] = useState<{
    documentId: number;
    supplierId: number;
    fact: MissingEntityFact;
    value: string;
  } | null>(null);
  const fact = draft?.fact;
  const choices = fact == null ? [] : FACT_CHOICES[fact];
  const value =
    selection != null &&
    fact != null &&
    draft != null &&
    selection.documentId === documentId &&
    selection.supplierId === draft.supplier.id &&
    selection.fact === fact
      ? selection.value
      : '';
  const setValue = (v: string) => {
    if (fact != null && draft != null) {
      setSelection({
        documentId,
        supplierId: draft.supplier.id,
        fact,
        value: v,
      });
    }
  };

  if (pending) {
    return <PanelMessage>Finding the supplier context…</PanelMessage>;
  }
  if (error) {
    return (
      <div className="mx-3.5 mb-3">
        <PanelMessage tone="error">{error.message}</PanelMessage>
        <div className="mt-2">
          <Button
            className="flex w-full items-center justify-center gap-2"
            disabled={busy}
            onClick={onRetry}
          >
            <RefreshCw className="size-4" /> Retry AI
          </Button>
        </div>
      </div>
    );
  }
  if (!draft || fact == null) return null;

  const confirm = () => {
    if (value === '') return;
    if (draft == null) return;
    op.run(
      () => confirmEntityFact(documentId, draft.supplier.id, fact, value),
      {
        onSuccess: (result) => {
          // Both truths, reported separately (GLOSSARY): the fact WAS saved
          // through the legitimate entity-update path; where the document now
          // stands is the outcome — a posting claim is never made from a
          // saved fact.
          if (result.fact_saved) {
            toastOk('Supplier fact saved');
          }
          if (result.outcome.kind === 'unknown') {
            // Still held — on the next genuine gate or a failed resume. Stay
            // here and refresh, so the operator reads the CURRENT reason.
            toastErr(`Still needs review: ${outcomeText(result.outcome)}`);
            void invalidateInbox(qc);
            void qc.invalidateQueries({
              queryKey: inboxKeys.pendingDraft(documentId),
            });
            return;
          }
          onResolved(result.outcome);
        },
        onError: (e) => toastErr(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  const help = choices.find((c) => c.value === value)?.help;

  return (
    <div className="mx-3.5 mb-3 rounded-lg bg-surface p-3.5">
      <p className="text-[11px] font-bold uppercase text-ink-2">
        Matched supplier
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-[16px] font-bold">
        <BadgeCheck className="size-4 text-accent" /> {draft.supplier.name}
      </p>
      <p className="text-[13px] text-ink-2">{draft.supplier.country}</p>
      <Evidence
        label="Amount"
        value={signedMoney(-draft.draft.gross_amount, draft.draft.currency)}
      />
      <Evidence
        label="Document number"
        value={draft.draft.supplier_invoice_number}
      />
      <Evidence
        label="Date"
        value={absoluteDateFromIso(draft.draft.tax_point_date)}
      />

      <div className="mt-3">
        <SegmentedControl
          label={`Supplier ${FACT_LABEL[fact]}`}
          options={choices}
          value={value}
          onChange={setValue}
          disabled={busy}
        />
        <p className="mt-1.5 text-[12px] leading-snug text-ink-2">
          {help ?? `Confirm the supplier's ${FACT_LABEL[fact]} to continue.`}
        </p>
      </div>

      <Button
        className="mt-3 flex w-full items-center justify-center gap-2"
        disabled={busy || value === ''}
        onClick={confirm}
      >
        Save supplier fact and continue
      </Button>
    </div>
  );
}

function Evidence({ label, value }: { label: string; value: string | null }) {
  if (value == null || value === '') return null;
  return (
    <p className="mt-1 text-[12px] text-ink-2">
      <span className="font-semibold">{label}:</span> {value}
    </p>
  );
}

function PanelMessage({
  tone,
  children,
}: {
  tone?: 'error';
  children: React.ReactNode;
}) {
  return (
    <div
      className={`mx-3.5 mb-3 rounded-lg px-3.5 py-3 text-[13px] ${
        tone === 'error' ? 'bg-err-bg text-err-deep' : 'bg-surface text-ink-2'
      }`}
    >
      {children}
    </div>
  );
}
