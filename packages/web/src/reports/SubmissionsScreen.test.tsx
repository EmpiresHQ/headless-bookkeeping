import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { SubmissionsScreen } from './SubmissionsScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getReportingPeriods: vi.fn(),
  getSubmissionState: vi.fn(),
  recordSubmissionEvent: vi.fn(),
}));
import {
  getReportingPeriods,
  getSubmissionState,
  recordSubmissionEvent,
} from '../api';

const LOCKED = {
  id: 6,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'locked' as const,
  filed_at: 1783080000,
};
const OPEN = {
  ...LOCKED,
  id: 7,
  name: '2026-07',
  status: 'open' as const,
  filed_at: null,
};

// All midday UTC so the local-time render keeps the date in any CI timezone.
const HISTORY = [
  {
    id: 1,
    reporting_period_id: 6,
    event_kind: 'prepared' as const,
    external_ref: null,
    occurred_at: 1783080000, // 03.07.2026 12:00 UTC
    actor: 'system',
    note: null,
  },
  {
    id: 2,
    reporting_period_id: 6,
    event_kind: 'submitted' as const,
    external_ref: 'KMD-2026-06-001',
    occurred_at: 1783166400, // 04.07.2026 12:00 UTC
    actor: 'operator',
    note: 'Uploaded via e-MTA',
  },
  {
    id: 3,
    reporting_period_id: 6,
    event_kind: 'rejected' as const,
    external_ref: null,
    occurred_at: 1783252800, // 05.07.2026 12:00 UTC
    actor: 'operator',
    note: 'Schema error in the XML',
  },
];

function mountAt(periodId: number, status = 'rejected', history = HISTORY) {
  vi.mocked(getReportingPeriods).mockResolvedValue([LOCKED, OPEN] as never);
  vi.mocked(getSubmissionState).mockResolvedValue({
    status,
    lastExternalRef: 'KMD-2026-06-001',
    submissionCount: 1,
    history,
  } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[`/reports/periods/${periodId}/submissions`]}
      >
        <AppToaster />
        <Routes>
          <Route
            path="/reports/periods/:id/submissions"
            element={<SubmissionsScreen />}
          />
          <Route
            path="/reports/periods/:id"
            element={<div>PERIOD DETAIL</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SubmissionsScreen', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the folded status and the chronological event timeline', async () => {
    mountAt(6);
    // 'Rejected' appears as BOTH the folded chip and the timeline event.
    expect(await screen.findAllByText('Rejected')).toHaveLength(2);
    expect(
      screen.getByText('Prepared — declaration frozen at close'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Submitted to the tax authority'),
    ).toBeInTheDocument();
    expect(screen.getByText(/03\.07\.2026 · system/)).toBeInTheDocument();
    expect(
      screen.getByText(/04\.07\.2026 · operator · ref KMD-2026-06-001/),
    ).toBeInTheDocument();
    expect(screen.getByText('Uploaded via e-MTA')).toBeInTheDocument();
  });

  it('rejected status shows the two-path guidance (never reopens the period)', async () => {
    mountAt(6);
    expect(
      await screen.findByText(/A rejection never reopens the period/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/download the XML again and resubmit/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/correct forward in the open period/i),
    ).toBeInTheDocument();
  });

  it('Add event records an operator-attested event with ref and note', async () => {
    vi.mocked(recordSubmissionEvent).mockResolvedValue({
      id: 4,
      reporting_period_id: 6,
      event_kind: 'accepted',
      external_ref: 'OK-1',
      occurred_at: 1783339200, // 06.07.2026 12:00 UTC
      actor: 'operator',
      note: null,
    } as never);
    mountAt(6);
    await screen.findAllByText('Rejected');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record what happened…' }),
    );
    fireEvent.change(await screen.findByLabelText('What happened'), {
      target: { value: 'accepted' },
    });
    fireEvent.change(screen.getByLabelText('Confirmation reference'), {
      target: { value: 'OK-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record: Accepted' }));
    await waitFor(() =>
      expect(recordSubmissionEvent).toHaveBeenCalledWith(6, {
        event_kind: 'accepted',
        external_ref: 'OK-1',
      }),
    );
    expect(await screen.findByText('Recorded — Accepted')).toBeInTheDocument();
  });

  it('an OPEN period gets an honest gate instead of the timeline', async () => {
    mountAt(7, 'not_started', []);
    expect(
      await screen.findByText(/Close the period first/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Record what happened…' }),
    ).toBeNull();
    // The state query never fires pre-lock (the events attach to the snapshot).
    expect(getSubmissionState).not.toHaveBeenCalled();
  });
});
