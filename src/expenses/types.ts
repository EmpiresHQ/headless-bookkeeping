export type ExpenseStatus = 'draft' | 'pending' | 'posted' | 'reversed';

export interface Expense {
  id: number;
  document_id: number | null;
  supplier_id: number | null;
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: ExpenseStatus;
  voucher_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateExpenseDto {
  document_id?: number | null;
  supplier_id?: number | null;
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
}

export interface ExpenseWithVoucher extends Expense {
  voucher?: unknown;
}
