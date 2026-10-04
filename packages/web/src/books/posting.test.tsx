import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyDecisionView } from '../api';
import { setToken } from '../auth';
import { usePendingOperation } from '../lib/pendingOperation';
import {
  RESULT_LOG_KEY,
  ResultLogProvider,
  type ResultEntry,
} from '../lib/resultLog';
import { UnsavedChangesProvider } from '../lib/unsavedChanges';
import { AppToaster } from '../ui/toast';
import { usePosting, type PostingCopy, type PostingRequest } from './posting';

const COPY: PostingCopy = {
  key: 'post:12',
  title: 'Expense #12',
  links: [{ label: 'Expense #12', to: '/books/expenses/12' }],
  amount: '−650.00 €',
};

function Harness(props: PostingRequest) {
  const op = usePendingOperation('Posting test');
  const posting = usePosting(op);
  return (
    <>
      <button type="button" onClick={() => posting.submit(props)}>
        Submit for posting
      </button>
      <p>{op.pending ? 'pending' : 'idle'}</p>
    </>
  );
}

const stored = (): ResultEntry[] => {
  const raw = sessionStorage.getItem(RESULT_LOG_KEY);
  if (raw === null) return [];
  return (JSON.parse(raw) as { entries: ResultEntry[] }).entries;
};

function mount(props: PostingRequest) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UnsavedChangesProvider onUnauthorized={() => undefined}>
        <ResultLogProvider>
          <AppToaster />
          <Harness {...props} />
        </ResultLogProvider>
      </UnsavedChangesProvider>
    </QueryClientProvider>,
  );
}

const policy = (action: PolicyDecisionView['action'], reason = 'ok') =>
  ({ action, reason }) as PolicyDecisionView;

describe('usePosting (the shared posting protocol)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setToken('t');
  });

  it('classifies an accepted auto-post and records the posted receipt', async () => {
    const request = vi.fn().mockResolvedValue({ policy: policy('auto-post') });
    const refresh = vi.fn().mockResolvedValue(undefined);
    mount({ request, refresh, copy: COPY });

    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({
      action: 'Submit for posting',
      title: 'Expense #12',
      outcome: 'Posted · −650.00 €',
      tone: 'ok',
      links: [{ label: 'Expense #12', to: '/books/expenses/12' }],
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Posted · −650.00 €')).toBeInTheDocument();
  });

  it('classifies hold-for-approval itself — the caller does not', async () => {
    const request = vi.fn().mockResolvedValue({
      policy: policy(
        'hold-for-approval',
        'Voucher amount 65000 exceeds ceiling 5000',
      ),
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    mount({ request, refresh, copy: COPY });

    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({
      tone: 'pending',
      outcome:
        'Held for approval — 650.00 € above the 50.00 € auto-post limit. Not posted until approved.',
    });
    // The notification humanizes the same persisted reason.
    expect(
      await screen.findByText(
        'Held for approval — 650.00 € above the 50.00 € auto-post limit',
      ),
    ).toBeInTheDocument();
  });

  it('records the accepted result BEFORE the books refresh', async () => {
    const atRefresh: ResultEntry[][] = [];
    const request = vi.fn().mockResolvedValue({ policy: policy('auto-post') });
    const refresh = vi.fn().mockImplementation(async () => {
      atRefresh.push(stored());
    });
    mount({ request, refresh, copy: COPY });

    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(atRefresh).toHaveLength(1));
    expect(atRefresh[0][0]).toMatchObject({ tone: 'ok' });
    expect(atRefresh[0][0].outcome).toBe('Posted · −650.00 €');
  });

  it('a failed refresh keeps the confirmed result and does not rewrite it as unconfirmed', async () => {
    const request = vi.fn().mockResolvedValue({ policy: policy('auto-post') });
    const refresh = vi.fn().mockRejectedValue(new Error('refresh boom'));
    mount({ request, refresh, copy: COPY });

    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({
      tone: 'ok',
      outcome: 'Posted · −650.00 €',
    });
    // The refresh failure is still reported.
    expect(await screen.findByText('refresh boom')).toBeInTheDocument();
    expect(stored()[0].outcome).not.toMatch(/not confirmed/);
  });

  it('records an unconfirmed request as such and does not refresh', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error('503 Service Unavailable'));
    const refresh = vi.fn().mockResolvedValue(undefined);
    mount({ request, refresh, copy: COPY });

    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({
      tone: 'error',
      outcome:
        'Submitting for posting was not confirmed (503 Service Unavailable). Open it for its current state before trying again.',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a retry supersedes the earlier failure with one entry', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ policy: policy('auto-post') });
    const refresh = vi.fn().mockResolvedValue(undefined);
    mount({ request, refresh, copy: COPY });

    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(stored()[0]?.tone).toBe('error'));
    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(stored()[0]?.tone).toBe('ok'));
    expect(stored()).toHaveLength(1);
    expect(stored()[0].outcome).toBe('Posted · −650.00 €');
  });

  it('a session change before the response ends the attempt without a receipt or refresh', async () => {
    let resolveRequest!: (v: { policy: PolicyDecisionView }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ policy: PolicyDecisionView }>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const refresh = vi.fn().mockResolvedValue(undefined);
    mount({ request, refresh, copy: COPY });

    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    expect(screen.getByText('pending')).toBeInTheDocument();
    // The sign-in is replaced while the POST is in flight.
    setToken('another');
    resolveRequest({ policy: policy('auto-post') });
    await waitFor(() => expect(screen.getByText('idle')).toBeInTheDocument());
    expect(stored()).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
  });
});
