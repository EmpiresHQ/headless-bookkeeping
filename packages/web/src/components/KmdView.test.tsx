import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { KmdView } from './KmdView';
import * as api from '../api';

const period = {
  id: 3,
  name: '2026-05',
  start_date: '2026-05-01',
  end_date: '2026-05-31',
  status: 'open',
  filed_at: null,
};
const decl = {
  reporting_period_id: 3,
  period_name: '2026-05',
  start_date: '2026-05-01',
  end_date: '2026-05-31',
  row1_base_24: 0,
  row2_base_reduced: 0,
  row3_base_zero: 1174000,
  row4_output_vat: 0,
  row5_input_vat: 0,
  row6_intra_eu_acquisition: 0,
  row7_other_acquisition: 11500,
  net_vat_due: 0,
  vd_intra_eu_services: 1174000,
  review_flags: ['Verify KMD row 6 vs 7.'],
};

describe('KmdView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getReportingPeriods').mockResolvedValue([period]);
    vi.spyOn(api, 'getKmd').mockResolvedValue(decl);
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads the first period KMD and shows row 3 + VD + flags', async () => {
    render(<KmdView />);
    await waitFor(() => expect(api.getKmd).toHaveBeenCalledWith(3));

    // Row 3 (0% käive) and the VD 3S total legitimately share the same value —
    // the 0% käive IS the intra-EU services — so assert each within its own row
    // rather than with a global text query (which would match both).
    const row3 = (await screen.findByText('Row 3 — 0% käive (base)')).closest(
      'tr',
    )!;
    expect(within(row3).getByText(/11740\.00/)).toBeInTheDocument(); // cents → €

    const vd = screen.getByText(/VD koondaruanne — 3S/).closest('tr')!;
    expect(within(vd).getByText(/11740\.00/)).toBeInTheDocument();

    expect(screen.getByText(/Verify KMD row 6 vs 7\./)).toBeInTheDocument();
  });

  it('toggles the create form when "New period" is clicked', async () => {
    render(<KmdView />);
    // Form is hidden initially.
    expect(screen.queryByPlaceholderText(/e\.g\. 2026/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New period' }));
    expect(screen.getByPlaceholderText(/e\.g\. 2026/)).toBeInTheDocument();

    // Button label flips to "Cancel".
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText(/e\.g\. 2026/)).not.toBeInTheDocument();
  });

  it('creates a period, appends it to the list, and auto-selects it', async () => {
    const newPeriod = {
      id: 7,
      name: '2026-06',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      status: 'open',
      filed_at: null,
    };
    vi.spyOn(api, 'createReportingPeriod').mockResolvedValue(newPeriod);

    render(<KmdView />);
    fireEvent.click(screen.getByRole('button', { name: 'New period' }));

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 2026/), {
      target: { value: '2026-06' },
    });
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-06-01' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-06-30' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(api.createReportingPeriod).toHaveBeenCalledWith({
        name: '2026-06',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
      }),
    );

    // Form closes after success.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/e\.g\. 2026/)).not.toBeInTheDocument(),
    );

    // New period appears in the select and is selected.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('7');
    expect(
      screen.getByRole('option', { name: /2026-06/ }),
    ).toBeInTheDocument();
  });
});
