import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  createExpense: vi.fn(),
  postExpense: vi.fn(),
  getMatchCandidates: vi.fn(),
  manualMatch: vi.fn(),
  approveApproval: vi.fn(),
  getPendingApprovals: vi.fn(),
}));

import * as api from '../api';
import type { BankTransaction } from '../api';
import { setToken } from '../auth';
import { usePendingOperation } from '../lib/pendingOperation';
import {
  RESULT_LOG_KEY,
  ResultLogProvider,
  type ResultEntry,
} from '../lib/resultLog';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import type {
  CreateFromLineInput,
  CreateFromLineResult,
} from '../queries/bank';
import {
  useBankExpense,
  type BankExpenseErrorInfo,
  type BankExpenseKind,
} from './bankExpense';

const TX = {
  id: 9,
  transaction_date: '2026-06-27',
  description: 'WOLT 220627',
  amount: -1860,
  currency: 'EUR',
  counterparty_iban: null,
  counterparty_descriptor: null,
  reference: null,
  status: 'open',
} as BankTransaction;

const INPUT: CreateFromLineInput = {
  statementId: 3,
  bankTransactionId: 9,
  category: 'meals',
  grossCents: 1860,
  vatCents: 335,
  currency: 'EUR',
  taxPointDate: '2026-06-27',
  supplierId: null,
};

function Harness({
  kind,
  input,
  onSuccess,
  onError,
}: {
  kind: BankExpenseKind;
  input: CreateFromLineInput;
  onSuccess: (r: CreateFromLineResult) => void;
  onError: (i: BankExpenseErrorInfo) => void;
}) {
  const op = usePendingOperation('Bank line');
  const { run, landed } = useBankExpense({ statementId: 3, tx: TX, op });
  const progress =
    landed === null
      ? 'none'
      : `${landed.expenseId ?? 'none'}|${
          landed.posted === null
            ? 'null'
            : landed.posted.held
              ? 'held'
              : 'posted'
        }|${landed.stagedMatchIds === null ? 'null' : landed.stagedMatchIds.join(',')}`;
  return (
    <>
      <button
        type="button"
        onClick={() => run({ kind, input, onSuccess, onError })}
      >
        Run
      </button>
      <p>{op.pending ? 'pending' : 'idle'}</p>
      <p data-testid="landed">{progress}</p>
    </>
  );
}

const stored = (): ResultEntry[] => {
  const raw = sessionStorage.getItem(RESULT_LOG_KEY);
  if (raw === null) return [];
  return (JSON.parse(raw) as { entries: ResultEntry[] }).entries;
};

function mount(props: Parameters<typeof Harness>[0]): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <ResultLogProvider>
          <Harness {...props} />
        </ResultLogProvider>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
  return qc;
}

function happyPath() {
  vi.mocked(api.createExpense).mockResolvedValue({ id: 55 } as never);
  vi.mocked(api.postExpense).mockResolvedValue({
    expense: { id: 55, status: 'posted' },
    policy: { action: 'auto-post', reason: 'ok' },
  } as never);
  vi.mocked(api.getMatchCandidates).mockResolvedValue({
    bankTransactionId: 9,
    lineRemaining: 1860,
    candidates: [
      {
        voucherId: 70,
        objectType: 'expense',
        objectId: 55,
        objectLabel: 'Expense #55',
        counterpartyName: null,
        voucherRemaining: 1860,
      },
    ],
  } as never);
  vi.mocked(api.manualMatch).mockResolvedValue({
    records: [{ id: 88 }],
    approvals: [{ id: 12, matchId: 88 }],
  } as never);
  vi.mocked(api.approveApproval).mockResolvedValue({
    approval: { id: 12 },
  } as never);
}

describe('useBankExpense (the shared bank-line Expense lifecycle)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    setToken('t');
  });

  it('a retry after a failed post resumes at post — the SAME expense, never a second create', async () => {
    happyPath();
    vi.mocked(api.postExpense).mockRejectedValueOnce(
      new Error('503 Service Unavailable'),
    );
    const onSuccess = vi.fn();
    const onError = vi.fn();
    mount({ kind: 'create', input: INPUT, onSuccess, onError });

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toMatchObject({ createConfirmed: true });
    expect(onError.mock.calls[0][0].error).toBeInstanceOf(Error);
    // The confirmed progress is exposed for the form to lock on.
    await waitFor(() =>
      expect(screen.getByTestId('landed')).toHaveTextContent('55|null|null'),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({
        outcome: 'matched',
        expenseId: 55,
        matchId: 88,
      }),
    );
    expect(api.createExpense).toHaveBeenCalledTimes(1);
    expect(api.postExpense).toHaveBeenCalledTimes(2);
    expect(api.postExpense).toHaveBeenLastCalledWith(55);
  });

  it('an awaiting-Approval outcome does not proceed to match', async () => {
    vi.mocked(api.createExpense).mockResolvedValue({ id: 56 } as never);
    vi.mocked(api.postExpense).mockResolvedValue({
      expense: { id: 56, status: 'pending' },
      policy: { action: 'hold-for-approval', reason: 'over ceiling' },
    } as never);
    const onSuccess = vi.fn();
    mount({ kind: 'create', input: INPUT, onSuccess, onError: vi.fn() });

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({
        outcome: 'held',
        expenseId: 56,
        reason: 'over ceiling',
      }),
    );
    expect(api.getMatchCandidates).not.toHaveBeenCalled();
    expect(api.manualMatch).not.toHaveBeenCalled();
    // The durable receipt says the line is NOT matched.
    expect(stored()[0]).toMatchObject({
      action: 'Create & match',
      tone: 'pending',
    });
    expect(stored()[0].outcome).toMatch(/The line is NOT matched/);
  });

  it('a staged match is not staged again on retry and its approval is not retried', async () => {
    happyPath();
    vi.mocked(api.approveApproval).mockRejectedValueOnce(
      new Error('409 Conflict'),
    );
    const onError = vi.fn();
    const qc = mount({
      kind: 'create',
      input: INPUT,
      onSuccess: vi.fn(),
      onError,
    });
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toMatchObject({ createConfirmed: true });
    expect(onError.mock.calls[0][0].progress.stagedMatchIds).toEqual([88]);
    await waitFor(() =>
      expect(screen.getByTestId('landed')).toHaveTextContent('55|posted|88'),
    );
    // The staged match changed the line — the form's scenario refreshes.
    expect(spy).toHaveBeenCalledWith({ queryKey: ['bank', 'statements', 3] });

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(String(onError.mock.calls[1][0].error)).toMatch(/already staged/);
    expect(api.manualMatch).toHaveBeenCalledTimes(1);
    expect(api.approveApproval).toHaveBeenCalledTimes(1);
  });

  it('the ordinary form does NOT refresh after an unconfirmed create', async () => {
    vi.mocked(api.createExpense).mockRejectedValue(
      new Error('502 Bad Gateway'),
    );
    const onError = vi.fn();
    const qc = mount({
      kind: 'create',
      input: INPUT,
      onSuccess: vi.fn(),
      onError,
    });
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toMatchObject({ createConfirmed: false });
    expect(spy).not.toHaveBeenCalled();
    // The unconfirmed attempt is recorded (no expense id was received).
    expect(stored()[0]).toMatchObject({
      action: 'Create & match',
      tone: 'error',
    });
    expect(stored()[0].outcome).toMatch(
      /Creating the expense was not confirmed — no expense ID was received/,
    );
  });

  it('the bank-fee action refreshes on every handled error, even before any expense exists', async () => {
    vi.mocked(api.createExpense).mockRejectedValue(
      new Error('502 Bad Gateway'),
    );
    const onError = vi.fn();
    const qc = mount({
      kind: 'bank-fee',
      input: INPUT,
      onSuccess: vi.fn(),
      onError,
    });
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toMatchObject({ createConfirmed: false });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['bank', 'statements', 3] });
    // The receipt names the fee action, not the form's.
    expect(stored()[0]).toMatchObject({ action: 'Bank fee', tone: 'error' });
  });

  it('a confirmed chain followed by a failed refresh keeps the matched result', async () => {
    happyPath();
    const refreshError = new Error('refresh boom');
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const qc = mount({ kind: 'create', input: INPUT, onSuccess, onError });
    const real = qc.invalidateQueries.bind(qc);
    let failed = false;
    vi.spyOn(qc, 'invalidateQueries').mockImplementation((...args) => {
      if (!failed) {
        failed = true;
        return Promise.reject(refreshError);
      }
      return real(...args);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].error).toBe(refreshError);
    expect(onError.mock.calls[0][0].createConfirmed).toBe(true);
    expect(stored()[0]).toMatchObject({
      action: 'Create & match',
      tone: 'ok',
      outcome: 'Expense #55 created, posted and matched to this line.',
    });
  });

  it('records the staged match before its approval answers, then supersedes it as partial', async () => {
    happyPath();
    let rejectApproval!: (e: unknown) => void;
    vi.mocked(api.approveApproval).mockReturnValue(
      new Promise((_, reject) => {
        rejectApproval = reject;
      }) as never,
    );
    mount({
      kind: 'create',
      input: INPUT,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(stored()[0]?.tone).toBe('running'));
    expect(stored()[0].outcome).toMatch(/match to this line is staged/);
    await act(async () => rejectApproval(new Error('503 Service Unavailable')));
    await waitFor(() => expect(stored()[0]?.tone).toBe('partial'));
    expect(stored()[0].outcome).toMatch(
      /the match's approval was not confirmed/,
    );
    expect(stored()).toHaveLength(1);
  });

  it('a session change mid-create stops the chain: no later request, receipt or continuation', async () => {
    let resolveCreate!: (v: { id: number }) => void;
    vi.mocked(api.createExpense).mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }) as never,
    );
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const qc = mount({ kind: 'create', input: INPUT, onSuccess, onError });
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('pending')).toBeInTheDocument();
    // The sign-in is replaced while the create request is in flight.
    setToken('another');
    await act(async () => resolveCreate({ id: 55 }));
    await waitFor(() => expect(screen.getByText('idle')).toBeInTheDocument());

    // The old session's chain sent nothing after the boundary and recorded
    // nothing; its continuation is dropped whole.
    expect(api.postExpense).not.toHaveBeenCalled();
    expect(api.getMatchCandidates).not.toHaveBeenCalled();
    expect(api.manualMatch).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a background error refresh does not hold the operation pending (form, known expense)', async () => {
    happyPath();
    vi.mocked(api.postExpense).mockRejectedValue(
      new Error('503 Service Unavailable'),
    );
    const onError = vi.fn();
    const qc = mount({
      kind: 'create',
      input: INPUT,
      onSuccess: vi.fn(),
      onError,
    });
    let releaseRefresh!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.spyOn(qc, 'invalidateQueries').mockReturnValue(gate as never);

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    // The chain has failed; its refresh is still in flight but is background
    // work — the line is NOT blocked (unlike the awaited post-success one).
    expect(screen.getByText('idle')).toBeInTheDocument();
    // A retry can start while that refresh is outstanding.
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(api.postExpense).toHaveBeenCalledTimes(2));
    releaseRefresh();
  });

  it('a background error refresh does not hold the operation pending (fee, no expense yet)', async () => {
    vi.mocked(api.createExpense).mockRejectedValue(
      new Error('502 Bad Gateway'),
    );
    const onError = vi.fn();
    const qc = mount({
      kind: 'bank-fee',
      input: INPUT,
      onSuccess: vi.fn(),
      onError,
    });
    let releaseRefresh!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.spyOn(qc, 'invalidateQueries').mockReturnValue(gate as never);

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByText('idle')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(api.createExpense).toHaveBeenCalledTimes(2));
    releaseRefresh();
  });
});
