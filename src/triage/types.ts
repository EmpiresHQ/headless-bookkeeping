import { z } from 'zod';

/**
 * SupplierProposal — the AI's Supplier-identity proposal carried on a
 * TriageResult (ADR-0024 Pass 2, ADR-0014 supplier identity).
 *
 * A discriminated union on `mode` that admits EXACTLY ONE of two shapes — the
 * Zod schema makes a half-filled / ambiguous proposal structurally impossible
 * (an invalid one fails validation, feeding the bounded-retry → needs_triage
 * path; "only schema-validated structured output crosses into the kernel"):
 *
 * - `{ mode: 'match', match_entity_id }` — the agent resolved the document to
 *   an existing Supplier Entity (matched on a strong registration key /
 *   alias). The id is required; resolution is a direct lookup.
 * - `{ mode: 'create', create_name, create_country }` — the agent found no
 *   existing Supplier and proposes creating one. BOTH the name and the country
 *   (the intrinsic, context-free facts a Supplier is anchored with, ADR-0014)
 *   are required; a create proposal can never be half-filled.
 *
 * Actual Supplier CREATION from a 'create' proposal is deferred (Task 43); for
 * now the kernel must route a 'create' proposal to needs_triage rather than
 * silently dropping it into a null-supplier draft.
 */
export const supplierProposalSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('match'),
    match_entity_id: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal('create'),
    create_name: z.string().min(1),
    create_country: z.string().min(1),
  }),
]);

export type SupplierProposal = z.infer<typeof supplierProposalSchema>;

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
  supplier_proposal: supplierProposalSchema.optional(),
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
