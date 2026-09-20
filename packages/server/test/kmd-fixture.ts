import { KmdDeclaration } from '../src/vat-report/types';

export const emptyKmdDeclaration: KmdDeclaration = {
  reporting_period_id: 1,
  period_name: '2026-05',
  start_date: '2026-05-01',
  end_date: '2026-05-31',
  row1_base_24: 0,
  row2_base_reduced: 0,
  row2_base_9: 0,
  row2_base_13: 0,
  row3_base_zero: 0,
  row3_1_intra_eu_supply: 0,
  row4_output_vat: 0,
  row5_input_vat: 0,
  row6_intra_eu_acquisition: 0,
  row7_other_acquisition: 0,
  net_vat_due: 0,
  vd_intra_eu_services: 0,
  review_flags: [],
};
