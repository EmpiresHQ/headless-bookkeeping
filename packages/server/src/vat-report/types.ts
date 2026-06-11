/**
 * One line in the VAT summary — aggregated base_amount for a single VAT code,
 * split into input (purchases) vs output (sales).
 */
export interface VatSummaryLine {
  vat_code: string | null;
  /** Input VAT amount aggregated from VAT_RECEIVABLE control lines (purchases). */
  input_vat: number;
  /** Output VAT amount aggregated from VAT_PAYABLE control lines (sales). */
  output_vat: number;
  /** Number of voucher lines contributing to this row. */
  line_count: number;
}

/**
 * A jurisdiction VAT-return (KMD) declaration, DERIVED on read from the posted
 * vouchers of a period — NOT a stored snapshot. The country plugin owns which
 * row each taxable-base VAT code feeds (ADR-0002); this service only aggregates.
 *
 * This is an aid for filing, not an authoritative form: `review_flags` lists
 * the spots the accountant must confirm (e.g. reverse-charge row 6 vs 7), and
 * the VD koondaruanne (EC Sales List) is filed MANUALLY — `vd_intra_eu_services`
 * surfaces the 3S total to copy across.
 */
export interface KmdDeclaration {
  reporting_period_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  /** Row 1 — 24% taxable supply base (incl. self-assessed reverse-charge supply). */
  row1_base_24: number;
  /** Row 2 — 9%/13% reduced-rate taxable supply base. */
  row2_base_reduced: number;
  /** Row 3 — 0% supply base (intra-EU services, exports). */
  row3_base_zero: number;
  /** Row 4 — total output VAT due (from VAT_PAYABLE control lines). */
  row4_output_vat: number;
  /** Row 5 — total deductible input VAT (from VAT_RECEIVABLE control lines). */
  row5_input_vat: number;
  /** Row 6 — intra-EU acquisition base reverse-charged (goods/services from another MS). */
  row6_intra_eu_acquisition: number;
  /** Row 7 — other reverse-charged acquisition base (e.g. imported non-EU service). */
  row7_other_acquisition: number;
  /** Net VAT due (row 4 − row 5); negative means reclaimable. */
  net_vat_due: number;
  /** Total 0% intra-EU service supplies to declare on the VD koondaruanne (tähis 3S). */
  vd_intra_eu_services: number;
  /** Spots requiring accountant review before filing. */
  review_flags: string[];
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
