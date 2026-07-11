import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listBankStatements: vi.fn(),
  listBankTransactions: vi.fn(),
  getReconciliationStatus: vi.fn(),
  getStatementMatches: vi.fn(),
  proposeMatches: vi.fn(),
  getMatchCandidates: vi.fn(),
  getBankImportStatus: vi.fn(),
  executeMatches: vi.fn(),
  manualMatch: vi.fn(),
  unmatchMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getOrganization: vi.fn(),
}));

import * as api from '../api';
import { AppToaster } from '../ui/toast';
import { TxMatched } from './TxMatched';

const TX = {
  id: 9,
  transaction_date: '2026-06-24',
  description: 'ELISA arve 6/2026',
  amount: -3500,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as const;
const RECON = {
  bankTransactionId: 9,
  amountBase: 3500,
  matchedSum: 3500,
  remaining: 0,
  reconStatus: 'matched',
} as const;
const ACTIVE = {
  id: 41,
  bankTransactionId: 9,
  status: 'active',
  amountMatched: 3500,
  objectLabel: 'Expense #61',
  counterpartyName: 'Elisa Eesti AS',
} as const;

describe('TxMatched', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the match card with coverage and unmatches on demand', async () => {
    vi.mocked(api.unmatchMatch).mockResolvedValue({});
    const onChanged = vi.fn();
    render(
      <>
        <TxMatched
          statementId={3}
          tx={TX as never}
          active={[ACTIVE as never]}
          staged={[]}
          recon={RECON as never}
          onChanged={onChanged}
        />
        <AppToaster />
      </>,
    );
    expect(screen.getByText('Matched with')).toBeInTheDocument();
    expect(screen.getByText('Expense #61')).toBeInTheDocument();
    expect(screen.getByText('full · 35.00 of 35.00 €')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unmatch' }));
    await waitFor(() => expect(api.unmatchMatch).toHaveBeenCalledWith(3, 41));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // Settle: the success toast is the last update of the unmatch flow.
    expect(
      await screen.findByText('Match removed — the line is unmatched again'),
    ).toBeInTheDocument();
  });

  it('offers Confirm match as primary for staged drafts', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      {
        id: 88,
        object_type: 'reconciliation_match',
        object_id: 50,
        status: 'pending',
        requested_by: 'system',
        approved_by: null,
        rejected_reason: null,
        policy_reason: null,
        superseded_by: null,
        created_at: 0,
        resolved_at: null,
      },
    ]);
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: { id: 88 },
    } as never);
    const onChanged = vi.fn();
    render(
      <>
        <TxMatched
          statementId={3}
          tx={TX as never}
          active={[]}
          staged={[{ ...ACTIVE, id: 50, status: 'draft' } as never]}
          recon={
            {
              ...RECON,
              matchedSum: 0,
              remaining: 3500,
              reconStatus: 'open',
            } as never
          }
          onChanged={onChanged}
        />
        <AppToaster />
      </>,
    );
    expect(screen.getByText('staged')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm match' }));
    await waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(88, 'operator'),
    );
    expect(onChanged).toHaveBeenCalled();
    // Settle: the undo-toast is the last update of the confirm flow.
    expect(await screen.findByText('Confirmed · 35.00 €')).toBeInTheDocument();
  });
});
