import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
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

export const createExpenseSchema = z.object({
  document_id: z.number().int().nullable().optional(),
  supplier_id: z.number().int().nullable().optional(),
  category: z.string(),
  gross_amount: z.number(),
  vat_amount: z.number(),
  currency: z.string(),
  tax_point_date: z.string(),
  document_vat_marking: z.string().nullable().optional(),
});

export class CreateExpenseDto extends createZodDto(createExpenseSchema) {}

// Optional override body: when the client posts no body at all (the common
// case) the request must still validate, so both fields are optional and an
// absent body (undefined/null) is treated as an empty object. When an override
// IS supplied it carries both ruleType and reason.
export const postOverrideSchema = z.preprocess(
  (v) => v ?? {},
  z.object({
    ruleType: z.string().optional(),
    reason: z.string().optional(),
  }),
);

export class PostOverrideDto extends createZodDto(postOverrideSchema) {}

export interface ExpenseWithVoucher extends Expense {
  voucher?: unknown;
}
