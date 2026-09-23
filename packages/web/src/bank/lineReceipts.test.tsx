import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
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
  onboardEntity: vi.fn(),
  addEntityAlias: vi.fn(),
  markPersonal: vi.fn(),
  createPrepayment: vi.fn(),
  getAdvanceVatTreatments: vi.fn(),
}));

import * as api from '../api';
import { AppToaster } from '../ui/toast';
import { TxScreen } from './TxScreen';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { RESULT_LOG_KEY, ResultLogProvider } from '../lib/resultLog';
import { RecentResults } from '../shell/RecentResults';
import { setToken } from '../auth';

const BASE_TX = {
  id: 9,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
};

function mockLine(
  over: Partial<typeof BASE_TX> = {},
  extra?: {
    matches?: unknown[];
    candidates?: unknown[];
    proposals?: unknown[];
  },
) {
  const tx = { ...BASE_TX, ...over };
  vi.mocked(api.listBankTransactions).mockResolvedValue([tx] as never);
  vi.mocked(api.getReconciliationStatus).mockResolvedValue([
    {
      bankTransactionId: 9,
      amountBase: Math.abs(tx.amount),
      matchedSum: 0,
      remaining: Math.abs(tx.amount),
      reconStatus: 'open',
    },
  ]);
  vi.mocked(api.getStatementMatches).mockResolvedValue(
    (extra?.matches ?? []) as never,
  );
  vi.mocked(api.getMatchCandidates).mockResolvedValue({
    bankTransactionId: 9,
    lineRemaining: Math.abs(tx.amount),
    candidates: (extra?.candidates ?? []) as never,
  });
  vi.mocked(api.proposeMatches).mockResolvedValue(
    (extra?.proposals ?? []) as never,
  );
  vi.mocked(api.getCategories).mockResolvedValue([
    { key: 'meals', label: 'Meals', accountCode: 'EXPENSE_MEALS' },
    { key: 'bank fee', label: 'Bank Fee', accountCode: 'EXPENSE_BANK_FEE' },
  ]);
  vi.mocked(api.getEntities).mockResolvedValue([]);
  vi.mocked(api.getAdvanceVatTreatments).mockResolvedValue([
    { vat_code: 'EE_OUTPUT_24', rate_permille: 240 },
  ]);
  vi.mocked(api.getOrganization).mockResolvedValue({
    id: 1,
    country: 'EE',
    base_currency: 'EUR',
    vat_registered: true,
    vat_registration_kind: 'ordinary',
    input_vat_entitlement: 'full',
    input_vat_deduction_permille: null,
    org_type: 'company',
    created_at: 0,
    name: null,
    registry_code: null,
    vat_registration_number: null,
    iban: null,
  });
}

function renderTx(path = '/bank/statements/3/tx/9') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/bank/statements/:id', element: <p>statement screen</p> },
      {
        path: '/bank/statements/:id/tx/:txId',
        element: (
          <>
            <RecentResults />
            <TxScreen />
          </>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={client}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <ResultLogProvider>
          <RouterProvider router={router} />
          <AppToaster />
        </ResultLogProvider>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

type Stored = {
  entries: { outcome: string; tone: string; links: { to: string }[] }[];
};
const stored = (): Stored =>
  JSON.parse(sessionStorage.getItem(RESULT_LOG_KEY) ?? '{"entries":[]}');

async function submitCreate() {
  await screen.findByText('Meals');
  fireEvent.change(screen.getByLabelText('Category'), {
    target: { value: 'meals' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Create & match · −18.60 €' }),
  );
}

const candidateFor = (expenseId: number) => ({
  bankTransactionId: 9,
  lineRemaining: 1860,
  candidates: [
    {
      voucherId: 70,
      objectType: 'expense',
      objectId: expenseId,
      objectLabel: `Expense #${expenseId}`,
      counterpartyName: null,
      voucherRemaining: 1860,
    },
  ],
});

describe('bank line durable receipts (issue #259)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    setToken('t');
  });

  it('create → post failure: the accepted draft is recorded, and after a reload the line says Expense #24 already exists', async () => {
    mockLine();
    vi.mocked(api.createExpense).mockResolvedValue({ id: 24 } as never);
    vi.mocked(api.postExpense).mockRejectedValue(
      new Error('503 Service Unavailable'),
    );
    const first = renderTx();
    await submitCreate();
    await screen.findByRole('button', { name: 'Finish · expense #24' });
    const [rec] = stored().entries;
    expect(rec.tone).toBe('partial');
    expect(rec.outcome).toMatch(
      /Draft Expense #24 was created; posting it was not confirmed/,
    );
    expect(rec.outcome).not.toMatch(/matched to this line/);
    expect(rec.links.map((l) => l.to)).toContain('/books/expenses/24');
    expect(stored().entries).toHaveLength(1);

    // Reload: the in-memory progress (Finish) is gone; the record is not.
    first.unmount();
    renderTx();
    const notice = await screen.findByText(/Recorded earlier in this session/);
    const box = notice.closest('[role="status"]') as HTMLElement;
    expect(box).toHaveTextContent(/Draft Expense #24 was created/);
    expect(box).toHaveTextContent(/do not create another expense/);
    expect(
      Array.from(box.querySelectorAll('a')).map((a) => a.getAttribute('href')),
    ).toContain('/books/expenses/24');
    // Nothing was replayed by the reload.
    expect(api.createExpense).toHaveBeenCalledTimes(1);
    expect(api.postExpense).toHaveBeenCalledTimes(1);
  });

  it('a retry that finishes supersedes the partial record — one entry, the final outcome', async () => {
    mockLine();
    vi.mocked(api.createExpense).mockResolvedValue({ id: 24 } as never);
    // A draft is no match candidate; the posted expense is.
    vi.mocked(api.postExpense)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockImplementation(async () => {
        vi.mocked(api.getMatchCandidates).mockResolvedValue(
          candidateFor(24) as never,
        );
        return {
          expense: { id: 24, status: 'posted' },
          policy: { action: 'auto-post', reason: 'ok' },
        } as never;
      });
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    vi.mocked(api.approveApproval).mockResolvedValue({ approval: {} } as never);
    renderTx();
    await submitCreate();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Finish · expense #24' }),
    );
    await waitFor(() => expect(stored().entries[0]?.tone).toBe('ok'));
    expect(stored().entries).toHaveLength(1);
    expect(stored().entries[0].outcome).toBe(
      'Expense #24 created, posted and matched to this line.',
    );
  });

  it('records the staged match BEFORE its approval answers; a failed approval is never recorded as matched', async () => {
    mockLine();
    vi.mocked(api.createExpense).mockImplementation(async () => {
      vi.mocked(api.getMatchCandidates).mockResolvedValue(
        candidateFor(24) as never,
      );
      return { id: 24 } as never;
    });
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 24, status: 'posted' },
      policy: { action: 'auto-post', reason: 'ok' },
    } as never);
    vi.mocked(api.manualMatch).mockResolvedValue({
      records: [{ id: 88 }],
      approvals: [{ id: 12, matchId: 88 }],
    });
    let reject!: (e: unknown) => void;
    vi.mocked(api.approveApproval).mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      }) as never,
    );
    renderTx();
    await submitCreate();
    // The approval is held: the staged stage is already on record.
    await waitFor(() =>
      expect(stored().entries[0]?.outcome).toMatch(
        /match to this line is staged — the approval's outcome is not known yet/,
      ),
    );
    expect(stored().entries[0].tone).toBe('running');
    await act(async () => reject(new Error('503 Service Unavailable')));
    await waitFor(() => expect(stored().entries[0]?.tone).toBe('partial'));
    const final = stored().entries[0].outcome;
    expect(final).toMatch(/was staged; the match's approval was not confirmed/);
    expect(final).not.toMatch(/matched to this line\./);
    expect(stored().entries).toHaveLength(1);
  });

  it('a first-stage failure records "not confirmed", with Books expenses to look for a draft', async () => {
    mockLine();
    vi.mocked(api.createExpense).mockRejectedValue(
      new Error('502 Bad Gateway'),
    );
    renderTx();
    await submitCreate();
    await waitFor(() => expect(stored().entries).toHaveLength(1));
    const [rec] = stored().entries;
    expect(rec.tone).toBe('error');
    expect(rec.outcome).toMatch(
      /was not confirmed — no expense ID was received/,
    );
    expect(rec.outcome).toMatch(/may exist as a draft/);
    expect(rec.links.map((l) => l.to)).toContain('/books?seg=expenses');
  });

  it('an Undo that removes some matches and then fails says so — never still "Matched"', async () => {
    mockLine(
      { amount: 50000, description: 'ETTEMAKS Baltic Trade' },
      {
        candidates: [
          {
            voucherId: 70,
            objectType: 'sales_invoice',
            objectId: 14,
            objectLabel: 'Invoice 2026-014',
            counterpartyName: null,
            voucherRemaining: 30000,
          },
          {
            voucherId: 71,
            objectType: 'sales_invoice',
            objectId: 15,
            objectLabel: 'Invoice 2026-015',
            counterpartyName: null,
            voucherRemaining: 20000,
          },
        ],
        proposals: [70, 71].map((voucherId) => ({
          bankTransactionId: 9,
          voucherId,
          matchType: 'partial',
          amountMatched: 1,
          confidence: 'high',
          signal: 'counterparty',
          objectType: 'sales_invoice',
          objectId: voucherId - 56,
          objectLabel: 'x',
          counterpartyName: null,
          voucherRemaining: 1,
        })),
      },
    );
    let n = 90;
    vi.mocked(api.manualMatch).mockImplementation(async () => {
      n += 1;
      return { records: [{ id: n }], approvals: [{ id: n, matchId: n }] };
    });
    vi.mocked(api.approveApproval).mockResolvedValue({ approval: {} } as never);
    vi.mocked(api.unmatchMatch)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('409 Conflict'));
    renderTx();
    fireEvent.click(await screen.findByRole('button', { name: /^Match / }));
    await waitFor(() => expect(stored().entries[0]?.tone).toBe('ok'));
    expect(stored().entries[0].outcome).toMatch(
      /Matched to Invoice 2026-014, Invoice 2026-015/,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(stored().entries[0]?.tone).toBe('partial'));
    expect(stored().entries[0].outcome).toMatch(
      /Undo did not complete: 1 of 2 matches removed; removing the rest was not confirmed/,
    );
    expect(stored().entries).toHaveLength(1);
  });
});
