import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export type CreditNoteKind = 'sales' | 'purchase';
export type CreditNoteStatus = 'draft' | 'posted' | 'reversed';

export interface CreditNote {
  id: number;
  kind: CreditNoteKind;
  credits_object_type: 'sales_invoice' | 'expense';
  credits_object_id: number;
  credit_note_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: CreditNoteStatus;
  voucher_id: number | null;
  created_at: number;
  updated_at: number;
}

export const createCreditNoteSchema = z.object({
  credits_object_type: z.enum(['sales_invoice', 'expense']),
  credits_object_id: z.number().int(),
  credit_note_number: z.string(),
  gross_amount: z.number().int(),
  vat_amount: z.number().int(),
  tax_point_date: z.string(),
});

export class CreateCreditNoteDto extends createZodDto(createCreditNoteSchema) {}
