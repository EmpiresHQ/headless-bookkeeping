import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { PeriodScreen } from './PeriodScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getReportingPeriods: vi.fn(),
  getKmd: vi.fn(),
  getSubmissionState: vi.fn(),
  downloadStatutoryReport: vi.fn(),
  // Read by the Task 6 sections (mounted from this screen from Task 6 on):
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getPeriodWarnings: vi.fn(),
  lockPeriod: vi.fn(),
}));
import {
  downloadStatutoryReport,
  getEntities,
  getExpenses,
  getInvoices,
  getKmd,
  getPeriodWarnings,
  getReportingPeriods,
  getSubmissionState,
} from '../api';

const OPEN_PERIOD = {
  id: 7,
  name: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  status: 'open' as const,
  filed_at: null,
};
const LOCKED_PERIOD = {
  id: 6,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'locked' as const,
  // 2026-07-03 12:00 UTC — midday so the local-time render is 03.07.2026
  // in any CI timezone (absoluteDate uses the local clock).
  filed_at: 1783080000,
};

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
  vd_intra_eu_services: 48200,
  review_flags: [
    'Reverse charge on row 6 vs 7 — confirm the split',
    'File the VD koondaruanne manually (tähis 3S) for 48200 cents of 0% intra-EU services — the system does not submit it.',
  ],
};

function mountAt(
  periodId: number,
  periods = [OPEN_PERIOD, LOCKED_PERIOD],
  kmd = KMD,
) {
  vi.mocked(getReportingPeriods).mockResolvedValue(periods as never);
  vi.mocked(getKmd).mockResolvedValue({
    ...kmd,
    reporting_period_id: periodId,
  } as never);
  vi.mocked(getSubmissionState).mockResolvedValue({
    status: 'submitted',
    lastExternalRef: 'KMD-2026-06-001',
    submissionCount: 1,
    history: [],
  } as never);
  vi.mocked(getExpenses).mockResolvedValue([] as never);
  vi.mocked(getInvoices).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue([] as never);
  vi.mocked(getPeriodWarnings).mockResolvedValue([] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/reports/periods/${periodId}`]}>
        <AppToaster />
        <Routes>
          <Route path="/reports/periods/:id" element={<PeriodScreen />} />
          <Route path="/reports" element={<div>REPORTS LIST</div>} />
          <Route
            path="/reports/periods/:id/submissions"
            element={<div>SUBMISSIONS</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PeriodScreen', () => {
  it('open period: LIVE marking, human-labeled boxes, highlighted net line', async () => {
    mountAt(7);
    expect(await screen.findByText('July 2026')).toBeInTheDocument();
    expect(screen.getByText(/Live preview/)).toBeInTheDocument();
    expect(
      screen.getByText('Sales taxed at 24% — net (row 1)'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('VAT deductible on purchases (row 5)'),
    ).toBeInTheDocument();
    expect(screen.getByText('4830.00 €')).toBeInTheDocument();
    expect(screen.getByText('438.53 €')).toBeInTheDocument();
    // Net line: human label + amount, tonal highlight.
    expect(screen.getByText('VAT to pay')).toBeInTheDocument();
    expect(screen.getByText('624.07 €')).toBeInTheDocument();
    // Legacy vocabulary is dead:
    expect(screen.queryByText(/Row 1 —/)).toBeNull();
  });

  it('VD 3S renders as the client row + manual notice; the raw-cents server flag is filtered', async () => {
    mountAt(7);
    expect(
      await screen.findByText('Intra-EU services for the VD report (3S)'),
    ).toBeInTheDocument();
    expect(screen.getByText('482.00 €')).toBeInTheDocument();
    expect(
      screen.getByText(
        /File the VD koondaruanne \(tähis 3S\) manually in e-MTA/,
      ),
    ).toBeInTheDocument();
    // The plugin flag survives; the raw-cents VD flag does not (Reality #6).
    expect(
      screen.getByText('Reverse charge on row 6 vs 7 — confirm the split'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/48200 cents/)).toBeNull();
  });

  it('locked period: FROZEN marking with the filing date and a submission-history row', async () => {
    mountAt(6);
    expect(await screen.findByText('June 2026')).toBeInTheDocument();
    expect(
      screen.getByText(/Frozen — closed 03\.07\.2026/),
    ).toBeInTheDocument();
    const row = await screen.findByRole('link', {
      name: /Submission history/,
    });
    expect(row).toHaveAttribute('href', '/reports/periods/6/submissions');
    expect(
      screen.getByText(
        'Submitted — awaiting confirmation · ref KMD-2026-06-001',
      ),
    ).toBeInTheDocument();
    // The irreversible close action never appears on an already-locked
    // period (there is no unlock — ADR-0015).
    expect(screen.queryByRole('button', { name: 'Close period…' })).toBeNull();
  });

  it('negative net VAT reads as reclaimable', async () => {
    mountAt(7, [OPEN_PERIOD, LOCKED_PERIOD], { ...KMD, net_vat_due: -12345 });
    expect(await screen.findByText('VAT to reclaim')).toBeInTheDocument();
    expect(screen.getByText('123.45 €')).toBeInTheDocument();
  });

  it('downloads call the statutory endpoint per format and surface a failure', async () => {
    vi.mocked(downloadStatutoryReport)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(
        new Error(
          'Cannot generate a final KMD without a declarant VAT registration number',
        ),
      );
    mountAt(7);
    await screen.findByText('July 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Download XML' }));
    await waitFor(() =>
      expect(downloadStatutoryReport).toHaveBeenCalledWith(7, 'xml'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(
      await screen.findByText(/declarant VAT registration number/),
    ).toBeInTheDocument();
    // Open period → files are honestly labeled draft.
    expect(
      screen.getByText(/Draft files — the declaration can still change/),
    ).toBeInTheDocument();
  });

  it('unknown period id gets an honest not-found state, not a spinner', async () => {
    mountAt(99);
    expect(
      await screen.findByText('This period does not exist'),
    ).toBeInTheDocument();
  });

  it('the OLDEST open period offers "Close period…"', async () => {
    // June (id 6) is open and oldest-open when July is also open.
    mountAt(6, [
      {
        ...LOCKED_PERIOD,
        id: 5,
        name: '2026-05',
        start_date: '2026-05-01',
        end_date: '2026-05-31',
      },
      {
        ...LOCKED_PERIOD,
        id: 6,
        name: '2026-06',
        status: 'open',
        filed_at: null,
      },
      OPEN_PERIOD,
    ]);
    expect(await screen.findByText('June 2026')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close period…' }),
    ).toBeInTheDocument();
  });

  it('a LATER open period gets the honest file-first hint instead of a lock button', async () => {
    mountAt(7, [
      {
        ...LOCKED_PERIOD,
        id: 6,
        name: '2026-06',
        status: 'open',
        filed_at: null,
      },
      OPEN_PERIOD,
    ]);
    expect(await screen.findByText('July 2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close period…' })).toBeNull();
    expect(
      screen.getByText(/File June 2026 first — filing proceeds oldest-first/),
    ).toBeInTheDocument();
  });

  it('Lock sheet resets the typed confirmation across open/close/reopen', async () => {
    // June (id 6) is open and oldest-open when July is also open.
    mountAt(6, [
      {
        ...LOCKED_PERIOD,
        id: 5,
        name: '2026-05',
        start_date: '2026-05-01',
        end_date: '2026-05-31',
      },
      {
        ...LOCKED_PERIOD,
        id: 6,
        name: '2026-06',
        status: 'open',
        filed_at: null,
      },
      OPEN_PERIOD,
    ]);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close period…' }),
    );
    fireEvent.change(await screen.findByLabelText(/to confirm/), {
      target: { value: 'half of the name' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByLabelText(/to confirm/)).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close period…' }));
    expect(await screen.findByLabelText(/to confirm/)).toHaveValue('');
  });
});
