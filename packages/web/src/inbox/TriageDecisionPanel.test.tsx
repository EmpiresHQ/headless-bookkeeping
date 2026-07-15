import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getPendingDraft: vi.fn(),
  resolveSupplier: vi.fn(),
}));

import * as api from '../api';
import type { NeedsTriageItem, PendingDraft } from '../api';
import { TriageDecisionPanel } from './TriageDecisionPanel';

const ITEM = (over: Partial<NeedsTriageItem> = {}): NeedsTriageItem => ({
  id: 12,
  filename: 'doc.jpg',
  created_at: 100,
  reason: 'AI confidence 0.41 below threshold 0.8',
  reason_type: 'low_confidence',
  ...over,
});

const DRAFT = (
  proposal: PendingDraft['supplier_proposal'],
  over: Partial<PendingDraft['draft']> = {},
): PendingDraft => ({
  document_id: 12,
  reason: 'supplier could not be resolved automatically',
  supplier_proposal: proposal,
  draft: {
    category: 'transport',
    gross_amount: 1599,
    vat_amount: 288,
    currency: 'EUR',
    tax_point_date: '2026-07-08',
    supplier_invoice_number: 'EECTB1805772',
    ...over,
  },
});

function renderPanel(
  props: Partial<React.ComponentProps<typeof TriageDecisionPanel>> = {},
) {
  const onOpen = vi.fn();
  const onArchive = vi.fn();
  const onResolved = vi
    .fn<(outcome: import('../api').TriageOutcome) => Promise<void>>()
    .mockResolvedValue(undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TriageDecisionPanel
        documentId={12}
        item={ITEM()}
        busy={false}
        onOpen={onOpen}
        onArchive={onArchive}
        onResolved={onResolved}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onOpen, onArchive, onResolved };
}

describe('TriageDecisionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the raw machine reason under a collapsed technical disclosure', () => {
    renderPanel({
      item: ITEM({ reason: 'AI confidence 0.41 below threshold 0.8' }),
    });
    const details = screen.getByText('Technical details').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('AI confidence 0.41 below threshold 0.8');
  });

  describe('supplier_unresolved', () => {
    const supplierItem = ITEM({
      reason_type: 'supplier_unresolved',
      reason: 'match proposal references entity 705731, which does not exist',
    });

    it('leads with semantic copy and never exposes the stale AI entity id', async () => {
      vi.mocked(api.getPendingDraft).mockResolvedValue(
        DRAFT({
          kind: 'invalid_match',
          observed_country: 'EE',
          observed_registration_key: 'EE102139798',
          suggested_supplier: {
            id: 37,
            name: 'Citybee Eesti OÜ',
            country: 'EE',
            registration_key: 'EE102139798',
          },
        }),
      );
      renderPanel({ item: supplierItem });

      expect(
        screen.getByRole('heading', {
          name: 'Supplier could not be confirmed',
        }),
      ).toBeInTheDocument();
      // The stale id only ever lives in the collapsed technical reason.
      const details = screen.getByText('Technical details').closest('details');
      expect(details).toHaveTextContent(/705731/);
      // ...and NOT in the visible decision panel content.
      const suggestion = await screen.findByText('Citybee Eesti OÜ');
      expect(suggestion.closest('details')).toBeNull();
    });

    it('offers a strong match with its evidence and books it directly', async () => {
      vi.mocked(api.getPendingDraft).mockResolvedValue(
        DRAFT({
          kind: 'invalid_match',
          observed_country: 'EE',
          observed_registration_key: 'EE102139798',
          suggested_supplier: {
            id: 37,
            name: 'Citybee Eesti OÜ',
            country: 'EE',
            registration_key: 'EE102139798',
          },
        }),
      );
      vi.mocked(api.resolveSupplier).mockResolvedValue({
        kind: 'expense',
        document_id: 12,
        expense_id: 500,
      });
      const { onResolved } = renderPanel({ item: supplierItem });

      expect(await screen.findByText('Suggested supplier')).toBeInTheDocument();
      expect(screen.getByText('Citybee Eesti OÜ')).toBeInTheDocument();
      expect(screen.getByText('Registration key match')).toBeInTheDocument();
      expect(screen.getByText('EE102139798')).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Use Citybee Eesti OÜ and book · −15.99 €',
        }),
      );
      await waitFor(() =>
        expect(api.resolveSupplier).toHaveBeenCalledWith(12, 37),
      );
      await waitFor(() =>
        expect(onResolved).toHaveBeenCalledWith({
          kind: 'expense',
          document_id: 12,
          expense_id: 500,
        }),
      );
    });

    it('lets the operator choose another supplier instead of the suggestion', async () => {
      vi.mocked(api.getPendingDraft).mockResolvedValue(
        DRAFT({
          kind: 'invalid_match',
          observed_country: 'EE',
          observed_registration_key: 'EE102139798',
          suggested_supplier: {
            id: 37,
            name: 'Citybee Eesti OÜ',
            country: 'EE',
            registration_key: 'EE102139798',
          },
        }),
      );
      const { onOpen } = renderPanel({ item: supplierItem });
      fireEvent.click(
        await screen.findByRole('button', { name: 'Choose another supplier' }),
      );
      expect(onOpen).toHaveBeenCalledWith('resolve');
    });

    it('presents a create proposal and routes to review/create', async () => {
      vi.mocked(api.getPendingDraft).mockResolvedValue(
        DRAFT({
          kind: 'create',
          create_name: 'New Vendor OÜ',
          create_country: 'EE',
          create_registration_key: 'EE123',
          create_email: null,
          create_phone: null,
          create_address: null,
        }),
      );
      const { onOpen } = renderPanel({ item: supplierItem });
      expect(
        await screen.findByText('New supplier from document'),
      ).toBeInTheDocument();
      expect(screen.getByText('New Vendor OÜ')).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole('button', { name: 'Review and create supplier' }),
      );
      expect(onOpen).toHaveBeenCalledWith('resolve');
    });

    it('falls back to supplier search when no identifier matched', async () => {
      vi.mocked(api.getPendingDraft).mockResolvedValue(
        DRAFT({
          kind: 'invalid_match',
          observed_country: null,
          observed_registration_key: null,
          suggested_supplier: null,
        }),
      );
      const { onOpen } = renderPanel({ item: supplierItem });
      fireEvent.click(
        await screen.findByRole('button', { name: 'Search suppliers' }),
      );
      expect(onOpen).toHaveBeenCalledWith('resolve');
    });
  });

  describe('non-supplier scenarios present one primary domain action', () => {
    const cases = [
      ['low_confidence', 'Review extracted data', 'classify'],
      ['category_unresolved', 'Choose category', 'classify'],
      ['outgoing_invoice', 'Review sales invoice', 'invoice'],
      ['ocr_failed', 'Replace or retry file', 'ocr'],
      ['classification_failed', 'Classify manually', 'classify'],
    ] as const;

    it.each(cases)('%s → %s opens %s', (reason_type, label, sheet) => {
      const { onOpen } = renderPanel({ item: ITEM({ reason_type }) });
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(onOpen).toHaveBeenCalledWith(sheet);
    });

    it('not_a_document leads with Archive without booking', () => {
      const { onArchive } = renderPanel({
        item: ITEM({ reason_type: 'not_a_document' }),
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Archive without booking' }),
      );
      expect(onArchive).toHaveBeenCalled();
    });
  });
});
