import { ReceiptText, Search } from 'lucide-react';
import type { PendingDraft } from '../api';
import { Button } from '../ui/Button';
import { signedEuros } from '../lib/money';
import { absoluteDateFromIso } from './format';

/**
 * The supplier_unresolved decision: a server-resolved suggestion (booked
 * directly), a create proposal, or a fallback to search — plus the draft
 * figures that will be booked. The stale AI-proposed entity id never reaches
 * this panel; only the observed identifiers and the deterministic suggestion
 * the server resolved from them (issue #179 trust boundary).
 */
export function SupplierDecisionPanel({
  draft,
  pending,
  error,
  busy,
  onResolve,
  onChoose,
}: {
  draft: PendingDraft | undefined;
  pending: boolean;
  error: Error | null;
  busy: boolean;
  onResolve: () => void;
  onChoose: () => void;
}) {
  if (pending) return <PanelMessage>Finding supplier context…</PanelMessage>;
  if (error) return <PanelMessage tone="error">{error.message}</PanelMessage>;
  if (!draft) return null;
  const proposal = draft.supplier_proposal;
  const suggestion =
    proposal.kind === 'invalid_match' ? proposal.suggested_supplier : null;

  return (
    <div className="mx-3.5 mb-3 rounded-lg bg-surface p-3.5">
      {suggestion ? (
        <>
          <p className="text-[11px] font-bold uppercase text-ink-2">
            Suggested supplier
          </p>
          <p className="mt-1 text-[16px] font-bold">{suggestion.name}</p>
          <p className="text-[13px] text-ink-2">{suggestion.country}</p>
          <Evidence
            label="Registration key match"
            value={suggestion.registration_key}
          />
        </>
      ) : proposal.kind === 'create' ? (
        <>
          <p className="text-[11px] font-bold uppercase text-ink-2">
            New supplier from document
          </p>
          <p className="mt-1 text-[16px] font-bold">{proposal.create_name}</p>
          <Evidence
            label={proposal.create_country}
            value={proposal.create_registration_key}
          />
        </>
      ) : (
        <PanelMessage>
          No supplier matched the observed identifiers.
        </PanelMessage>
      )}

      <div className="my-3 border-t border-line pt-3 text-[13px] text-ink-2">
        {draft.draft.category} · {signedEuros(-draft.draft.gross_amount)} ·{' '}
        {absoluteDateFromIso(draft.draft.tax_point_date)}
      </div>
      {suggestion ? (
        <Button
          className="flex w-full items-center justify-center gap-2"
          busy={busy}
          onClick={onResolve}
        >
          <ReceiptText className="size-4" />
          Use {suggestion.name} and book ·{' '}
          {signedEuros(-draft.draft.gross_amount)}
        </Button>
      ) : (
        <Button
          className="flex w-full items-center justify-center gap-2"
          disabled={busy}
          onClick={onChoose}
        >
          <Search className="size-4" />
          {proposal.kind === 'create'
            ? 'Review and create supplier'
            : 'Search suppliers'}
        </Button>
      )}
      {suggestion && (
        <Button
          variant="secondary"
          className="mt-2 w-full"
          disabled={busy}
          onClick={onChoose}
        >
          Choose another supplier
        </Button>
      )}
    </div>
  );
}

function Evidence({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="mt-2 flex flex-wrap justify-between gap-2 border-t border-line pt-2 text-[12.5px]">
      <span className="text-ink-2">{label}</span>
      <span className="font-semibold">{value ?? 'Not observed'}</span>
    </div>
  );
}

function PanelMessage({
  children,
  tone = 'muted',
}: {
  children: string;
  tone?: 'muted' | 'error';
}) {
  return (
    <p
      className={`mx-3.5 mb-3 rounded-lg bg-surface p-3.5 text-[13px] ${tone === 'error' ? 'text-err' : 'text-ink-2'}`}
    >
      {children}
    </p>
  );
}
