import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { ReportsScreen } from './ReportsScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getReportingPeriods: vi.fn(),
  getKmd: vi.fn(),
  getSubmissionState: vi.fn(),
  getPeriodConfig: vi.fn(),
  createNextPeriod: vi.fn(),
}));
import {
  createNextPeriod,
  getKmd,
  getPeriodConfig,
  getReportingPeriods,
  getSubmissionState,
} from '../api';

const PERIODS = [
  {
    id: 4,
    name: '2026-04',
    start_date: '2026-04-01',
    end_date: '2026-04-30',
    status: 'locked' as const,
    filed_at: 1747100000,
  },
  {
    id: 5,
    name: '2026-05',
    start_date: '2026-05-01',
    end_date: '2026-05-31',
    status: 'locked' as const,
    filed_at: 1749800000,
  },
  {
    id: 6,
    name: '2026-06',
    start_date: '2026-06-01',
    end_date: '2026-06-30',
    status: 'open' as const,
    filed_at: null,
  },
  {
    id: 7,
    name: '2026-07',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    status: 'open' as const,
    filed_at: null,
  },
];

const KMD = {
  reporting_period_id: 7,
  period_name: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  row1_base_24: 483000,
  row2_base_reduced: 0,
  row3_base_zero: 0,
  row4_output_vat: 106260,
  row5_input_vat: 43853,
  row6_intra_eu_acquisition: 0,
  row7_other_acquisition: 0,
  net_vat_due: 62407,
  vd_intra_eu_services: 0,
  review_flags: [],
};

function mountList(periods = PERIODS) {
  vi.mocked(getReportingPeriods).mockResolvedValue(periods as never);
  vi.mocked(getKmd).mockResolvedValue(KMD as never);
  // Per-period submission state — two locked periods in the fixture (ids 4
  // and 5) each get a distinct ref, so their folded status lines don't
  // collide on the same rendered text.
  vi.mocked(getSubmissionState).mockImplementation((id) =>
    Promise.resolve({
      status: 'accepted',
      lastExternalRef: id === 4 ? 'KMD-2026-04-01' : 'KMD-2026-05-01',
      submissionCount: 1,
      history: [],
    } as never),
  );
  vi.mocked(getPeriodConfig).mockResolvedValue({
    frequency_options: ['monthly'],
    default_frequency: 'monthly',
  } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/reports']}>
        <AppToaster />
        <Routes>
          <Route path="/reports" element={<ReportsScreen />} />
          <Route
            path="/reports/periods/:id"
            element={<div>PERIOD DETAIL</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReportsScreen', () => {
  it('hero = the LATEST open period with a live net-VAT line, linking to its detail', async () => {
    mountList();
    expect(await screen.findByText('July 2026')).toBeInTheDocument();
    expect(screen.getByText('01.07.2026 – 31.07.2026')).toBeInTheDocument();
    expect(await screen.findByText(/VAT to pay so far/)).toBeInTheDocument();
    expect(screen.getByText(/624\.07 €/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /July 2026/ })).toHaveAttribute(
      'href',
      '/reports/periods/7',
    );
  });

  it('an EARLIER open period wears "open — file first"; locked rows fold submission state', async () => {
    mountList();
    expect(await screen.findByText('open — file first')).toBeInTheDocument();
    // June (earlier open) links to its detail too.
    expect(screen.getByRole('link', { name: /June 2026/ })).toHaveAttribute(
      'href',
      '/reports/periods/6',
    );
    // May is locked: one folded status line, with the ref (asset §7 decision 6).
    expect(
      await screen.findByText('Accepted · ref KMD-2026-05-01'),
    ).toBeInTheDocument();
    // No raw ids, no raw server names as titles.
    expect(screen.queryByText('2026-05')).toBeNull();
  });

  it('NewPeriodSheet: opens from the header, submits the server-computed next period', async () => {
    vi.mocked(createNextPeriod).mockResolvedValue({
      id: 8,
      name: '2026-08',
      start_date: '2026-08-01',
      end_date: '2026-08-31',
      status: 'open',
      filed_at: null,
    } as never);
    mountList();
    await screen.findByText('July 2026');
    fireEvent.click(screen.getByRole('button', { name: /New period/ }));
    expect(
      await screen.findByText(/computed from your monthly filing frequency/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open next period' }));
    await waitFor(() => expect(createNextPeriod).toHaveBeenCalledWith({}));
    expect(
      await screen.findByText('Period August 2026 opened'),
    ).toBeInTheDocument();
  });

  it('NewPeriodSheet: the legacy override fields still reach the endpoint', async () => {
    vi.mocked(createNextPeriod).mockResolvedValue({
      id: 9,
      name: 'special',
      start_date: '2026-08-01',
      end_date: '2026-08-15',
      status: 'open',
      filed_at: null,
    } as never);
    mountList();
    await screen.findByText('July 2026');
    fireEvent.click(screen.getByRole('button', { name: /New period/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Override dates/ }),
    );
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-08-15' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'special' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open next period' }));
    await waitFor(() =>
      expect(createNextPeriod).toHaveBeenCalledWith({
        start_date: '2026-08-01',
        end_date: '2026-08-15',
        name: 'special',
      }),
    );
  });

  it('folds submission state with exactly one request per LOCKED period (fan-out pin)', async () => {
    // This file has no shared beforeEach/mockClear — clear this mock's own
    // call history so earlier tests' mounts don't inflate the count.
    vi.mocked(getSubmissionState).mockClear();
    mountList();
    await screen.findByText('July 2026');
    await waitFor(() =>
      expect(getSubmissionState).toHaveBeenCalledTimes(
        2 /* locked periods in fixture */,
      ),
    );
  });

  it('NewPeriodSheet resets across open/close/reopen', async () => {
    mountList();
    await screen.findByText('July 2026');
    fireEvent.click(screen.getByRole('button', { name: /New period/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Override dates/ }),
    );
    fireEvent.change(await screen.findByLabelText('Start date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByLabelText('Start date')).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New period/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Override dates/ }),
    );
    expect(await screen.findByLabelText('Start date')).toHaveValue('');
  });

  it('empty state offers opening the first period', async () => {
    mountList([]);
    expect(
      await screen.findByText('No reporting periods yet'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open first period' }),
    ).toBeInTheDocument();
  });
});
