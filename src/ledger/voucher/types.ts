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
}

export interface DraftVoucher {
  voucher_number: string;
  tax_point_date: string;
  lines: DraftVoucherLine[];
}

export interface PostedVoucher extends Voucher {
  lines: VoucherLine[];
}

export interface NewVoucher {
  voucher_number: string;
  tax_point_date: string;
  posted_at: number | null;
}

export interface NewVoucherLine {
  voucher_id: number;
  account_id: number;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  vat_code: string | null;
  is_debit: boolean;
}
