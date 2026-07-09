import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSubmissionState: vi.fn(),
}));
import {
  getSubmissionState,
  type Expense,
  type ReportingPeriod,
  type SubmissionState,
} from '../api';
import {
  currentOpen,
  displayFlags,
  inPeriod,
  infGapCandidates,
  invalidateReports,
  isVdFlag,
  KMD_ROWS,
  netVatLabel,
  oldestOpen,
  periodExpenses,
  periodTitle,
  reportsKeys,
  sortPeriodsNewestFirst,
  submissionLine,
  SUBMISSION_STATUS,
  useSubmissionStates,
} from './reports';
import { sharedKeys } from './keys';

const period = (over: Partial<ReportingPeriod> = {}): ReportingPeriod => ({
  id: 7,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'open',
  filed_at: null,
  ...over,
});

const expense = (over: Partial<Expense> = {}): Expense =>
  ({
    id: 1,
    supplier_id: 3,
    category: 'rent',
    gross_amount: 122000,
    vat_amount: 22000,
    currency: 'EUR',
    tax_point_date: '2026-06-10',
    status: 'posted',
    reconciled: false,
    supplier_invoice_number: null,
    ...over,
  }) as Expense;

describe('period titles and ordering (pure)', () => {
  it('humanizes plugin-frequency names and passes overrides through', () => {
    expect(periodTitle('2026-06')).toBe('June 2026');
    expect(periodTitle('2026-Q1')).toBe('Q1 2026');
    expect(periodTitle('2026-H2')).toBe('H2 2026');
    expect(periodTitle('2026')).toBe('2026');
    expect(periodTitle('custom period')).toBe('custom period');
  });

  it('sorts newest first lexicographically and picks current/oldest open', () => {
    const ps = [
      period({
        id: 1,
        name: '2026-05',
        start_date: '2026-05-01',
        end_date: '2026-05-31',
        status: 'locked',
      }),
      period({
        id: 2,
        name: '2026-06',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
      }),
      period({
        id: 3,
        name: '2026-07',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
      }),
    ];
    expect(sortPeriodsNewestFirst(ps).map((p) => p.id)).toEqual([3, 2, 1]);
    // current = LATEST open (mirror of GET /current); oldest open = the only lockable one.
    expect(currentOpen(ps)?.id).toBe(3);
    expect(oldestOpen(ps)?.id).toBe(2);
    expect(currentOpen([ps[0]])).toBeNull();
  });

  it('inPeriod is inclusive lexicographic string math (no Date)', () => {
    const p = period();
    expect(inPeriod('2026-06-01', p)).toBe(true);
    expect(inPeriod('2026-06-30', p)).toBe(true);
    expect(inPeriod('2026-05-31', p)).toBe(false);
    expect(inPeriod('2026-07-01', p)).toBe(false);
  });
});

describe('in-period joins and INF gaps (pure)', () => {
  it('periodExpenses keeps live statuses in range, newest first', () => {
    const rows = [
      expense({ id: 1, tax_point_date: '2026-06-10' }),
      expense({ id: 2, tax_point_date: '2026-06-20', status: 'reversed' }),
      expense({ id: 3, tax_point_date: '2026-06-15', status: 'draft' }),
      expense({ id: 4, tax_point_date: '2026-07-02' }),
    ];
    expect(periodExpenses(rows, period()).map((e) => e.id)).toEqual([2, 1]);
  });

  it('infGapCandidates: supplier net ≥ 1000 € in-period AND missing number', () => {
    const rows = [
      // Supplier 3: net 2×(1220−220)€ = 2000 € ≥ threshold; one row lacks a number.
      expense({ id: 1, supplier_invoice_number: 'A-1' }),
      expense({ id: 2, tax_point_date: '2026-06-12' }),
      // Supplier 4: net 100 € — under threshold, missing number is NOT a gap.
      expense({
        id: 3,
        supplier_id: 4,
        gross_amount: 12200,
        vat_amount: 2200,
        tax_point_date: '2026-06-13',
      }),
      // No supplier — never an INF row (B2B only).
      expense({ id: 4, supplier_id: null, tax_point_date: '2026-06-14' }),
    ];
    expect(infGapCandidates(rows, period()).map((e) => e.id)).toEqual([2]);
  });
});

describe('declaration + submission display model (pure)', () => {
  it('KMD_ROWS covers the seven boxes with human-first labels', () => {
    expect(KMD_ROWS).toHaveLength(7);
    expect(KMD_ROWS[0]).toEqual({
      key: 'row1_base_24',
      label: 'Sales taxed at 24% — net (row 1)',
    });
    expect(KMD_ROWS.map((r) => r.key)).toContain('row5_input_vat');
    for (const r of KMD_ROWS) expect(r.label).not.toMatch(/^Row \d/);
  });

  it('netVatLabel is honest about reclaimable', () => {
    expect(netVatLabel(62407)).toBe('VAT to pay');
    expect(netVatLabel(-1)).toBe('VAT to reclaim');
    expect(netVatLabel(0)).toBe('VAT to pay');
  });

  it('filters ONLY the raw-cents VD server flag (Reality #6)', () => {
    const flags = [
      'Reverse charge on row 6 vs 7 — confirm the split',
      'File the VD koondaruanne manually (tähis 3S) for 48200 cents of 0% intra-EU services — the system does not submit it.',
    ];
    expect(isVdFlag(flags[1])).toBe(true);
    expect(displayFlags(flags)).toEqual([flags[0]]);
  });

  it('submissionLine folds status + ref into one honest line', () => {
    const state: SubmissionState = {
      status: 'accepted',
      lastExternalRef: 'KMD-2026-06-001',
      submissionCount: 1,
      history: [],
    };
    expect(submissionLine(state)).toBe('Accepted · ref KMD-2026-06-001');
    expect(
      submissionLine({
        ...state,
        status: 'not_started',
        lastExternalRef: null,
      }),
    ).toBe('No submission recorded');
    expect(SUBMISSION_STATUS.accepted.tone).toBe('ok');
    expect(SUBMISSION_STATUS.rejected.tone).toBe('err');
  });
});

describe('hooks', () => {
  const wrapper = (qc: QueryClient) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    };

  it('useSubmissionStates fans out one query per locked period and combines a Map', async () => {
    vi.mocked(getSubmissionState).mockImplementation(async (id: number) => ({
      status: id === 5 ? 'accepted' : 'prepared',
      lastExternalRef: id === 5 ? 'R-5' : null,
      submissionCount: id === 5 ? 1 : 0,
      history: [],
    }));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useSubmissionStates([5, 6]), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get(5)?.status).toBe('accepted');
    expect(result.current.get(6)?.status).toBe('prepared');
    expect(getSubmissionState).toHaveBeenCalledTimes(2);
  });

  it('invalidateReports covers the reports prefix + shared periods + shared expenses', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await invalidateReports(qc);
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(reportsKeys.all);
    expect(keys).toContainEqual(sharedKeys.reportingPeriods);
    expect(keys).toContainEqual(sharedKeys.expenses);
  });
});
