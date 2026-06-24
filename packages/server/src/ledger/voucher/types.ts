export interface VoucherLine {
  id: number;
  voucher_id: number;
  account_id: number;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
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
}

export interface DraftVoucherLine {
  account_code: string;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
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
}

export interface PostedVoucher extends Voucher {
  lines: VoucherLine[];
}
