import { z } from 'zod';

/**
 * TriageResult — the structured output produced by the AI triage agent.
 * Represents the AI's interpretation of an incoming document.
 *
 * The `kind` discriminant determines what downstream action to take:
 * - 'new_expense': create an Expense and run the posting pipeline.
 * - 'correction': modify an existing business object (wired in Task 43).
 * - 'duplicate': flag as a likely duplicate (wired in Task 43).
 * - 'unknown': cannot classify — hold for human review.
 */
export const triageResultSchema = z.object({
  kind: z.enum(['new_expense', 'correction', 'duplicate', 'unknown']),
  document_type: z.enum(['receipt', 'invoice', 'unknown']),
  gross_amount: z.number().int(),
  vat_amount: z.number().int(),
  currency: z.string().length(3),
  tax_point_date: z.string(), // ISO date string (YYYY-MM-DD)
  supplier_proposal: z
    .object({
      match_entity_id: z.number().optional(),
      create_name: z.string().optional(),
      create_country: z.string().optional(),
    })
    .optional(),
  category: z.string(),
  document_vat_marking: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

export interface TriageOutcomeExpense {
  kind: 'expense';
  document_id: number;
  expense_id: number;
}

export interface TriageOutcomeInvoice {
  kind: 'invoice';
  document_id: number;
  invoice_id: number;
}

export interface TriageOutcomeUnknown {
  kind: 'unknown';
  document_id: number;
  reason: string;
}

export type TriageOutcome =
  | TriageOutcomeExpense
  | TriageOutcomeInvoice
  | TriageOutcomeUnknown;
