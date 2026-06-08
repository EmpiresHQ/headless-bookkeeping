/**
 * One line in the VAT summary — aggregated base_amount for a single VAT code,
 * split into input (purchases) vs output (sales).
 */
export interface VatSummaryLine {
  vat_code: string | null;
  /** Sum of base_amount for lines where is_debit=1 (purchases → input VAT). */
  input_vat: number;
  /** Sum of base_amount for lines where is_debit=0 (sales → output VAT). */
  output_vat: number;
  /** Number of voucher lines contributing to this row. */
  line_count: number;
}

/**
 * A complete VAT report snapshot — the immutable output produced when a
 * reporting period is locked (Task 28).
 */
export interface VatReport {
  id: number;
  reporting_period_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  vat_summary: VatSummaryLine[];
  total_input_vat: number;
  total_output_vat: number;
  total_payable: number;
  total_receivable: number;
  voucher_ids: number[];
  merkle_root: string | null;
  generated_at: number;
}
