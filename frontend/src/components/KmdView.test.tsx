import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    expect(await screen.findByText(/11740\.00/)).toBeInTheDocument(); // row3 cents → €
    expect(screen.getByText(/Verify KMD row 6 vs 7\./)).toBeInTheDocument();
  });
});
