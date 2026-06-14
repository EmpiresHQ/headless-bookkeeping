import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BusinessObjectStatus } from '../common/types/business-object-status';

export type SalesInvoiceStatus = BusinessObjectStatus;

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
  document_vat_marking: string | null;
  document_id: number | null;
  created_at: number;
  updated_at: number;
}

export const createSalesInvoiceSchema = z.object({
  customer_id: z.number().int().nullable().optional(),
  invoice_number: z.string(),
  // Reject a non-positive document at CREATE — a zero/negative gross cannot be a
  // real invoice, and letting it through only surfaces a cryptic "amount must be
  // positive" at approve-time after the object is already stuck in pending (A1).
  gross_amount: z.number().positive(),
  vat_amount: z.number().nonnegative(),
  currency: z.string(),
  tax_point_date: z.string(),
  due_date: z.string().nullable().optional(),
  document_vat_marking: z.string().nullable().optional(),
  document_id: z.number().int().nullable().optional(),
});

export class CreateSalesInvoiceDto extends createZodDto(
  createSalesInvoiceSchema,
) {}

// Optional override body: a plain POST with no body must still validate, so an
// absent body (undefined/null) is treated as an empty object and both fields
// are optional. When supplied, an override carries both fields.
export const salesInvoicePostOverrideSchema = z.preprocess(
  (v) => v ?? {},
  z.object({
    ruleType: z.string().optional(),
    reason: z.string().optional(),
  }),
);

export class SalesInvoicePostOverrideDto extends createZodDto(
  salesInvoicePostOverrideSchema,
) {}
