import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BusinessObjectStatus } from '../common/types/business-object-status';
import {
  currencyCodeSchema,
  grossMinorSchema,
  isoDateSchema,
  optionalTextSchema,
  draftEditObject,
  vatMinorSchema,
} from '../common/draft-edit';

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
  supplier_invoice_number: string | null;
  asset_name: string | null;
  asset_useful_life_years: number | null;
  asset_residual_value_minor: number | null;
  claimant_id: number | null;
  company_addressed_receipt: boolean | null;
  // LLM classification facts preserved from triage (ADR-0039).
  ai_confidence: number | null;
  ai_document_type: string | null;
  ai_kind: string | null;
  created_at: number;
  updated_at: number;
}

export const createExpenseSchema = z.object({
  document_id: z.number().int().nullable().optional(),
  supplier_id: z.number().int().nullable().optional(),
  category: z.string(),
  // Reject a non-positive gross at CREATE rather than letting it post a junk
  // draft that only fails cryptically at approve-time (A1).
  gross_amount: z.number().positive(),
  vat_amount: z.number().nonnegative(),
  currency: z.string(),
  tax_point_date: z.string(),
  document_vat_marking: z.string().nullable().optional(),
  supplier_invoice_number: z.string().nullable().optional(),
  asset_name: z.string().nullable().optional(),
  asset_useful_life_years: z.number().int().positive().nullable().optional(),
  asset_residual_value_minor: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional(),
  claimant_id: z.number().int().positive().nullable().optional(),
  company_addressed_receipt: z.boolean().nullable().optional(),
  ai_confidence: z.number().min(0).max(1).nullable().optional(),
  ai_document_type: z.string().nullable().optional(),
  ai_kind: z.string().nullable().optional(),
  // Operator escape hatch for the duplicate guard (issue #195). Never
  // persisted on the expense row and never set by the AI intake path: only a
  // human deliberately re-posting a flagged document may pass it, and doing so
  // writes an audit_log entry.
  allow_duplicate: z.boolean().optional(),
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

/** The facts an operator may correct on a draft/pending expense (issue #247). */
export const EXPENSE_DRAFT_EDITABLE_FIELDS = [
  'category',
  'supplier_id',
  'gross_amount',
  'vat_amount',
  'currency',
  'tax_point_date',
  'supplier_invoice_number',
  'claimant_id',
  'company_addressed_receipt',
] as const;

/**
 * Fields a draft edit refuses BY NAME, with the reason — never silently
 * dropped. Provenance (the source document and what the AI read from it) is
 * evidence, not an opinion to overwrite; status/voucher move only through the
 * posting pipeline; the fixed-asset facts belong to the asset register flow.
 */
const EXPENSE_DRAFT_IMMUTABLE: Record<string, string> = {
  document_id:
    'document_id is the source document (provenance) and cannot be changed on an existing expense',
  document_vat_marking:
    'document_vat_marking is read from the source document and cannot be edited',
  ai_confidence: 'AI classification facts are preserved as recorded (ADR-0039)',
  ai_document_type:
    'AI classification facts are preserved as recorded (ADR-0039)',
  ai_kind: 'AI classification facts are preserved as recorded (ADR-0039)',
  asset_name:
    'fixed-asset facts are set when the expense is recorded and are not part of the draft-edit contract',
  asset_useful_life_years:
    'fixed-asset facts are set when the expense is recorded and are not part of the draft-edit contract',
  asset_residual_value_minor:
    'fixed-asset facts are set when the expense is recorded and are not part of the draft-edit contract',
  status: 'status changes only through submit/approve/reject, never by editing',
  voucher_id: 'voucher_id is owned by the posting pipeline',
  id: 'id is immutable',
};

/**
 * A draft-only edit of an expense's economic facts (issue #247). Draft or
 * pending only — a pending expense returns to draft and its approval is
 * superseded; a posted/reversed one is corrected via POST
 * /api/expenses/:id/correct, never edited. Saving never posts.
 */
export const patchExpenseDraftSchema = draftEditObject(
  {
    category: z.string().min(1).optional(),
    supplier_id: z.number().int().positive().nullable().optional(),
    gross_amount: grossMinorSchema.optional(),
    vat_amount: vatMinorSchema.optional(),
    currency: currencyCodeSchema.optional(),
    tax_point_date: isoDateSchema.optional(),
    supplier_invoice_number: optionalTextSchema.optional(),
    claimant_id: z.number().int().positive().nullable().optional(),
    company_addressed_receipt: z.boolean().nullable().optional(),
    // Same operator escape hatch as create (issue #195): only needed when the
    // edit moves the expense onto another expense's duplicate key.
    allow_duplicate: z.boolean().optional(),
  },
  EXPENSE_DRAFT_IMMUTABLE,
).refine((v) => EXPENSE_DRAFT_EDITABLE_FIELDS.some((k) => v[k] !== undefined), {
  message: `Supply at least one field to edit (${EXPENSE_DRAFT_EDITABLE_FIELDS.join(', ')})`,
});

export class PatchExpenseDraftDto extends createZodDto(
  patchExpenseDraftSchema,
) {}

export type PatchExpenseDraftInput = z.infer<typeof patchExpenseDraftSchema>;

export interface ExpenseWithVoucher extends Expense {
  voucher?: unknown;
}
