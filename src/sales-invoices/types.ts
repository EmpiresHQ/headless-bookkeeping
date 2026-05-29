export type SalesInvoiceStatus = 'draft' | 'pending' | 'posted' | 'reversed';

export interface SalesInvoice {
  id: number;
  customer_id: number | null;
  invoice_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  due_date: string | null;
  status: SalesInvoiceStatus;
  sent_at: number | null;
  voucher_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateSalesInvoiceDto {
  customer_id?: number | null;
  invoice_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  due_date?: string | null;
}
