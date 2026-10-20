import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getPendingDraft: vi.fn(),
  confirmEntityFact: vi.fn(),
  resolveSupplier: vi.fn(),
}));

vi.mock('../ui/toast', () => ({
  toastErr: vi.fn(),
  toastOk: vi.fn(),
}));

import * as api from '../api';
import type {
  MissingEntityFactDraft,
  NeedsTriageItem,
  TriageOutcome,
} from '../api';
import { toastErr, toastOk } from '../ui/toast';
import { MissingEntityFactPanel } from './MissingEntityFactPanel';
import { TriageDecisionPanel } from './TriageDecisionPanel';
import { usePendingOperation } from '../lib/pendingOperation';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';

/** The screen owns the document's operation; the panel borrows it. */
function PanelWithOp(
  props: Omit<React.ComponentProps<typeof TriageDecisionPanel>, 'op'>,
) {
  const op = usePendingOperation('Document triage');
  return <TriageDecisionPanel {...props} op={op} />;
}

const ITEM = (over: Partial<NeedsTriageItem> = {}): NeedsTriageItem => ({
  id: 12,
  filename: 'invoice-dk.pdf',
  created_at: 100,
  reason:
    'Cannot classify a purchase from a supplier in DK: the tax status is not recorded',
  reason_type: 'supplier_tax_status_unknown',
  ...over,
});

const MISSING_FACT = (
  fact: 'taxStatus' | 'goodsVsServices',
  over: Partial<MissingEntityFactDraft> = {},
): MissingEntityFactDraft => ({
  kind: 'missing_entity_fact',
  document_id: 12,
  reason: "the supplier's tax status is not recorded",
  fact,
  supplier: { id: 3, name: 'Nordisk Software ApS', country: 'DK' },
  draft: {
    category: 'software',
    gross_amount: 10000,
    vat_amount: 0,
    currency: 'EUR',
    tax_point_date: '2026-10-02',
    supplier_invoice_number: 'DK-404',
  },
  ...over,
});

function renderPanel(
  props: Partial<
    Omit<React.ComponentProps<typeof TriageDecisionPanel>, 'op'>
  > = {},
) {
  const onOpen = vi.fn();
  const onArchive = vi.fn();
  const onRetry = vi.fn();
  const onResolved = vi.fn<(outcome: TriageOutcome) => void>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <PanelWithOp
          documentId={12}
          item={ITEM()}
          onOpen={onOpen}
          onArchive={onArchive}
          onRetry={onRetry}
          onResolved={onResolved}
          {...props}
        />
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return { onOpen, onArchive, onRetry, onResolved };
}

const mockGetPendingDraft = vi.mocked(api.getPendingDraft);
const mockConfirm = vi.mocked(api.confirmEntityFact);

describe('TriageDecisionPanel — missing entity fact (issue #404)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the matched supplier and fact controls from the TYPED view (taxStatus)', async () => {
    mockGetPendingDraft.mockResolvedValue(MISSING_FACT('taxStatus'));
    renderPanel();
    await screen.findByText('Nordisk Software ApS');
    expect(screen.getByText('DK')).toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: 'Supplier tax status' }),
    ).toBeInTheDocument();
    // Typed copy for the family, from reason_type — never prose-parsed.
    expect(
      screen.getByRole('heading', {
        name: 'Supplier known — one fact missing',
      }),
    ).toBeInTheDocument();
  });

  it('renders the goodsVsServices variant with the same one-interaction pattern', async () => {
    mockGetPendingDraft.mockResolvedValue(MISSING_FACT('goodsVsServices'));
    renderPanel({
      item: ITEM({ reason_type: 'supplier_goods_vs_services_unknown' }),
    });
    await screen.findByText('Nordisk Software ApS');
    expect(
      screen.getByRole('radiogroup', { name: 'Supplier goods or services' }),
    ).toBeInTheDocument();
  });

  it('is actionable for a pre-fix hold mis-bucketed under a legacy generic reason', async () => {
    // A pre-fix production hold carries a generic classification_failed
    // finding; the typed VIEW says this family owns the document, so the
    // supplier + fact panel renders without an extra Retry.
    mockGetPendingDraft.mockResolvedValue(MISSING_FACT('taxStatus'));
    renderPanel({ item: ITEM({ reason_type: 'classification_failed' }) });
    await screen.findByText('Nordisk Software ApS');
    expect(
      screen.getByRole('radiogroup', { name: 'Supplier tax status' }),
    ).toBeInTheDocument();
  });

  it('confirms in one interaction and continues when the document resolves', async () => {
    mockGetPendingDraft.mockResolvedValue(MISSING_FACT('taxStatus'));
    mockConfirm.mockResolvedValue({
      document_id: 12,
      entity_id: 3,
      fact: 'taxStatus',
      value: 'taxable_business',
      fact_saved: true,
      outcome: {
        kind: 'expense',
        document_id: 12,
        expense_id: 7,
      },
    });
    const { onResolved } = renderPanel();
    await screen.findByText('Nordisk Software ApS');
    fireEvent.click(screen.getByRole('radio', { name: 'Taxable business' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save supplier fact and continue' }),
    );
    await waitFor(() =>
      expect(mockConfirm).toHaveBeenCalledWith(
        12,
        'taxStatus',
        'taxable_business',
      ),
    );
    await waitFor(() =>
      expect(toastOk).toHaveBeenCalledWith('Supplier fact saved'),
    );
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({
        kind: 'expense',
        document_id: 12,
        expense_id: 7,
      }),
    );
  });

  it('reports the saved fact AND the still-unresolved hold truthfully — never a posting claim', async () => {
    mockGetPendingDraft.mockResolvedValue(MISSING_FACT('taxStatus'));
    mockConfirm.mockResolvedValue({
      document_id: 12,
      entity_id: 3,
      fact: 'taxStatus',
      value: 'non_taxable',
      fact_saved: true,
      outcome: {
        kind: 'unknown',
        document_id: 12,
        reason:
          'The supplier in DK is recorded as a non-taxable person, so this purchase is not an intra-Community acquisition.',
      },
    });
    const { onResolved } = renderPanel();
    await screen.findByText('Nordisk Software ApS');
    fireEvent.click(screen.getByRole('radio', { name: 'Not taxable' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save supplier fact and continue' }),
    );
    await waitFor(() =>
      expect(mockConfirm).toHaveBeenCalledWith(12, 'taxStatus', 'non_taxable'),
    );
    // The operation result (the fact WAS saved) is acknowledged…
    await waitFor(() =>
      expect(toastOk).toHaveBeenCalledWith('Supplier fact saved'),
    );
    // …while the CURRENT state (still held) is reported as exactly that.
    await waitFor(() =>
      expect(toastErr).toHaveBeenCalledWith(
        expect.stringContaining('Still needs review'),
      ),
    );
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("does not leak the previous fact's choice across successive missing facts (same document)", async () => {
    // US supplier missing BOTH facts: confirming goodsVsServices parks the
    // document on the next genuine gate — taxStatus. The panel re-renders
    // with the new fact and must carry NO stale choice: nothing preselected,
    // Save disabled until a tax-status choice is made (root follow-up 1).
    mockGetPendingDraft
      .mockResolvedValueOnce(MISSING_FACT('goodsVsServices'))
      .mockResolvedValue(MISSING_FACT('taxStatus'));
    mockConfirm.mockResolvedValue({
      document_id: 12,
      entity_id: 3,
      fact: 'goodsVsServices',
      value: 'services',
      fact_saved: true,
      outcome: {
        kind: 'unknown',
        document_id: 12,
        reason: "the supplier's tax status is not recorded",
      },
    });
    renderPanel({
      item: ITEM({ reason_type: 'supplier_goods_vs_services_unknown' }),
    });
    await screen.findByRole('radiogroup', {
      name: 'Supplier goods or services',
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Services' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save supplier fact and continue' }),
    );
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    // The refreshed view carries the NEXT missing fact on the SAME document.
    await screen.findByRole('radiogroup', { name: 'Supplier tax status' });
    const taxable = screen.getByRole('radio', { name: 'Taxable business' });
    expect((taxable as HTMLInputElement).checked).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Save supplier fact and continue' }),
    ).toBeDisabled();
    // A choice for the CURRENT fact re-enables the (only) save path.
    fireEvent.click(taxable);
    expect(
      screen.getByRole('button', { name: 'Save supplier fact and continue' }),
    ).toBeEnabled();
  });

  it('clears the unsaved selection when the screen re-renders for another document/supplier with the SAME fact', () => {
    // The doc screen is not keyed by document, so navigating to another
    // held supplier re-renders this same component. An unsaved choice made
    // for the first supplier must never leak: nothing preselected, Save
    // disabled until a new choice is made (root follow-up 3).
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const op = { pending: false, run: vi.fn() };
    const props = {
      documentId: 12,
      draft: MISSING_FACT('taxStatus'),
      pending: false,
      error: null,
      busy: false,
      op,
      onRetry: vi.fn(),
      onResolved: vi.fn<(outcome: TriageOutcome) => void>(),
    };
    const view = render(
      <QueryClientProvider client={client}>
        <MissingEntityFactPanel {...props} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Taxable business' }));
    expect(
      screen.getByRole('button', { name: 'Save supplier fact and continue' }),
    ).toBeEnabled();
    const next = MISSING_FACT('taxStatus', {
      supplier: { id: 103, name: 'Another supplier', country: 'US' },
    });
    view.rerender(
      <QueryClientProvider client={client}>
        <MissingEntityFactPanel {...props} documentId={112} draft={next} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Another supplier')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Save supplier fact and continue' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('radio', { name: 'Taxable business' }),
    ).not.toBeChecked();
  });

  it("shows the draft amount in the draft's own currency, never a converted euro figure", async () => {
    mockGetPendingDraft.mockResolvedValue(
      MISSING_FACT('taxStatus', {
        draft: {
          category: 'software',
          gross_amount: 10000,
          vat_amount: 0,
          currency: 'USD',
          tax_point_date: '2026-10-02',
          supplier_invoice_number: 'US-404',
        },
      }),
    );
    renderPanel();
    await screen.findByText('Nordisk Software ApS');
    // The typed view's currency is retained as-is — no conversion, no
    // invented euro sign (root follow-up 2).
    expect(screen.getByText(/100\.00 USD/)).toBeInTheDocument();
  });

  it('is actionable for a legacy hold re-bucketed as a "duplicate" of its OWN first draft', async () => {
    // Production docs 260/284: a pre-fix hold's retry could re-bucket the
    // document as a possible duplicate of its OWN first draft. The typed
    // view is the authoritative check — it says this family owns the
    // document, so the supplier + fact panel renders under the duplicate
    // bucket too.
    mockGetPendingDraft.mockResolvedValue(MISSING_FACT('taxStatus'));
    renderPanel({
      item: ITEM({
        reason_type: 'possible_duplicate',
        reason:
          'possible duplicate of expense #7: same supplier and invoice number.',
      }),
    });
    await screen.findByText('Nordisk Software ApS');
    expect(
      screen.getByRole('radiogroup', { name: 'Supplier tax status' }),
    ).toBeInTheDocument();
  });

  it('keeps the ordinary duplicate-review path when the view does not own the document (a genuine different-document duplicate)', async () => {
    // A GENUINE vendor re-send is a different document with no chain draft
    // of its own: the view 404s and the duplicate-review decision stands.
    mockGetPendingDraft.mockRejectedValue(
      new Error('Document 12 has no pending supplier proposal'),
    );
    const { onOpen } = renderPanel({
      item: ITEM({
        reason_type: 'possible_duplicate',
        reason:
          'possible duplicate of expense #7: same supplier and invoice number.',
      }),
    });
    await waitFor(() => expect(mockGetPendingDraft).toHaveBeenCalled());
    expect(screen.queryByText('Nordisk Software ApS')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Review possible duplicate' }),
    );
    expect(onOpen).toHaveBeenCalledWith('duplicate');
  });

  it('surfaces a failed view load with the ordinary Retry AI path (no fact controls)', async () => {
    mockGetPendingDraft.mockRejectedValue(
      new Error('Document 12 has no pending supplier proposal'),
    );
    const { onRetry } = renderPanel();
    await screen.findByText(/no pending supplier proposal/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry AI' }));
    expect(onRetry).toHaveBeenCalled();
  });
});
