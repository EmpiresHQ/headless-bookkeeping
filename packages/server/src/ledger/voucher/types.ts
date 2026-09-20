export interface VoucherLine {
  id: number;
  voucher_id: number;
  account_id: number;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  /**
   * Provenance of `fx_rate` (issue #203): the publication date the rate was
   * taken from, and the authority that published it. NULL on a line posted
   * before provenance existed — such a line is "source unknown", and stays
   * distinguishable as that rather than being retroactively blessed.
   */
  fx_rate_date: string | null;
  fx_rate_source: string | null;
  vat_code: string | null;
  is_debit: boolean;
}

export interface Voucher {
  id: number;
  voucher_number: string;
  tax_point_date: string;
  posted_at: number | null;
  previous_hash: string | null;
  reverses_id: number | null;
  corrects_object_type: string | null;
  corrects_object_id: number | null;
  reason: string | null;
  /**
   * The input-VAT deduction entitlement this voucher was POSTED at (issue
   * #211) — the EFFECTIVE fraction, after both the jurisdiction's right to
   * deduct and the company-addressed-receipt restriction. Null when the voucher
   * records no input-VAT decision (a sale, a system entry, anything posted
   * before the columns existed).
   */
  input_vat_entitlement_basis: string | null;
  input_vat_deduction_numerator: number | null;
  input_vat_deduction_denominator: number | null;
}

export interface DraftVoucherLine {
  account_code: string;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  /**
   * Provenance of `fx_rate` (issue #203). Optional on a DRAFT only because the
   * base-currency legs of some system-generated vouchers carry an identity
   * rate; a generator that resolved a real reference rate MUST pass both, or
   * the posted line becomes indistinguishable from a pre-#203 one.
   */
  fx_rate_date?: string | null;
  fx_rate_source?: string | null;
  vat_code?: string | null;
  is_debit: boolean;
  metadata?: Record<string, unknown>;
}

export interface DraftVoucher {
  /** Optional — the posting service mints the gapless sequential number at post time. */
  voucher_number?: string;
  tax_point_date: string;
  lines: DraftVoucherLine[];
  reverses_id?: number;
  corrects_object_type?: string;
  corrects_object_id?: number;
  reason?: string;
  /**
   * The effective input-VAT entitlement the purchase legs were composed from
   * (issue #211), frozen onto the posted voucher as provenance. A generator
   * that made no input-VAT decision omits it.
   *
   * A REVERSAL copies the original's value rather than re-resolving it: the
   * organisation's settings may have moved since, and a reversal must undo what
   * was posted, not what would be posted today.
   */
  input_vat_entitlement?: {
    numerator: number;
    denominator: number;
    basis: string;
  } | null;
}

export interface PostedVoucher extends Voucher {
  lines: VoucherLine[];
}
