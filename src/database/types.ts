import type { Generated } from 'kysely';

export interface Database {
  organization: OrganizationTable;
  account: AccountTable;
  voucher: VoucherTable;
  voucher_line: VoucherLineTable;
  expense: ExpenseTable;
  sales_invoice: SalesInvoiceTable;
  override: OverrideTable;
  policy_config: PolicyConfigTable;
  reporting_period: ReportingPeriodTable;
  document: DocumentTable;
  document_source: DocumentSourceTable;
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
  // SQLite boolean (0/1): 1 = system-managed, 0 = user-managed.
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

export interface SalesInvoiceTable {
  id: Generated<number>;
  customer_id: number | null;
  invoice_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  due_date: string | null;
  status: string;
  sent_at: number | null;
  voucher_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface ExpenseTable {
  id: Generated<number>;
  document_id: number | null;
  supplier_id: number | null;
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  // enum: 'draft' | 'pending' | 'posted' | 'reversed'
  status: string;
  voucher_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface OverrideTable {
  id: Generated<number>;
  business_object_type: string;
  business_object_id: number;
  rule_type: string;
  rule_name: string;
  reason: string;
  created_by: string;
  created_at: number;
}

export interface PolicyConfigTable {
  id: Generated<number>;
  key: string;
  value: string;
  updated_at: number;
}

export interface ReportingPeriodTable {
  id: Generated<number>;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  filed_at: number | null;
  vat_report_snapshot_id: number | null;
  created_at: number;
}

export interface DocumentTable {
  id: Generated<number>;
  hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  status: string;
  created_at: number;
}

export interface DocumentSourceTable {
  id: Generated<number>;
  document_id: number;
  channel: string;
  source_identifier: string | null;
  received_at: number;
}
