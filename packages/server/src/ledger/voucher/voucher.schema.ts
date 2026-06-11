import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const DraftVoucherLineSchema = z.object({
  account_code: z.string().min(1, 'account_code is required'),
  amount: z.number().int().positive('amount must be a positive integer'),
  currency: z.string().min(1, 'currency is required'),
  base_amount: z
    .number()
    .int()
    .positive('base_amount must be a positive integer'),
  fx_rate: z.number().positive('fx_rate must be positive'),
  vat_code: z.string().nullable().optional(),
  is_debit: z.boolean(),
});

export const DraftVoucherSchema = z.object({
  voucher_number: z.string().min(1, 'voucher_number is required').optional(),
  tax_point_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'tax_point_date must be YYYY-MM-DD'),
  lines: z
    .array(DraftVoucherLineSchema)
    .min(2, 'at least 2 lines required for double-entry'),
});

// createZodDto carries the Zod schema (static `schema`, validated by the global
// pipe) AND the OpenAPI metadata Swagger reads — one source of truth.
export class DraftVoucherDto extends createZodDto(DraftVoucherSchema) {}
