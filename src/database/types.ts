import type { Generated } from 'kysely';

export interface Database {
  organization: OrganizationTable;
  account: AccountTable;
  voucher: VoucherTable;
  voucher_line: VoucherLineTable;
}

export interface OrganizationTable {
  id: Generated<number>;
  country: string;
  // Nullable override: NULL means "inherit base currency from the country
  // plugin" (ADR-0004).
  base_currency: string | null;
  vat_registered: number;
  created_at: number;
}

export interface AccountTable {
  id: Generated<number>;
  code: string;
  name: string;
  // enum: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  type: string;
  // Nullable: set only for foreign-currency accounts (e.g. BANK_USD).
  currency: string | null;
  // Self-referential FK for chart hierarchy; traversal is deferred (Wave 2
  // reserves the column only).
  parent_id: number | null;
  // SQLite boolean (0/1): 1 = debit, 0 = credit.
  is_system: number;
}

export interface VoucherTable {
  id: Generated<number>;
  voucher_number: string;
  // ISO date string; drives Reporting-period membership (CONTEXT: tax-point).
  tax_point_date: string;
  // Unix seconds, set when the voucher is posted; null while unposted.
  posted_at: number | null;
  // Reserved for the hash chain (ADR-0013). Wave 2 never writes it.
  previous_hash: string | null;
  // FK to another voucher; set by the reversal flow (Task 18), null here.
  reverses_id: number | null;
  corrects_object_type: string | null;
  corrects_object_id: number | null;
  reason: string | null;
}

export interface VoucherLineTable {
  id: Generated<number>;
  voucher_id: number;
  account_id: number;
  // Cents in the original currency.
  amount: number;
  currency: string;
  // Cents in base currency (EUR).
  base_amount: number;
  fx_rate: number;
  vat_code: string | null;
  // SQLite boolean (0/1): 1 = debit, 0 = credit.
  is_debit: number;
}
