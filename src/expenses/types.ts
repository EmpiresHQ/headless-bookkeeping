import { BusinessObjectStatus } from '../common/types/business-object-status';

export type ExpenseStatus = BusinessObjectStatus;

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
  document_vat_marking: string | null;
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
  document_vat_marking?: string | null;
}

export interface ExpenseWithVoucher extends Expense {
  voucher?: unknown;
}
