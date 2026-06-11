import { createZodDto } from 'nestjs-zod';
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
    // Identifiers are ALL optional/nullable: a non-EU supplier may print none of
    // them. The model must NOT fabricate a registration key just to fill the
    // field (that was the duplicate-supplier bug). When every identifier is
    // null, resolveSupplier routes the document to operator triage.
    create_registration_key: z.string().nullable().default(null),
    create_email: z.string().nullable().default(null),
    create_phone: z.string().nullable().default(null),
    create_address: z.string().nullable().default(null),
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
  // Booking-critical fields stay REQUIRED — if the model omits them the document
  // genuinely cannot be booked and must go to a human.
  kind: z.enum(['new_expense', 'correction', 'duplicate', 'unknown']),
  gross_amount: z.number().int(),
  vat_amount: z.number().int(),
  tax_point_date: z.string(), // ISO date string (YYYY-MM-DD)
  category: z.string(),
  supplier_proposal: supplierProposalSchema.optional(),
  // Safely-defaultable metadata. Some OpenAI-compatible endpoints do NOT enforce
  // `required` in json_schema, so the model occasionally drops a field; defaults
  // keep a good extraction from failing the parse (which would lose ALL the
  // data to needs_triage). currency defaults to the EUR base; a dropped
  // confidence is treated as 0 (conservative — never auto-posts on a guess).
  document_type: z.enum(['receipt', 'invoice', 'unknown']).default('unknown'),
  currency: z.string().length(3).default('EUR'),
  document_vat_marking: z.string().nullable().default(null),
  // Supplier's own invoice/receipt number (opaque, for KMD INF Part B). Same
  // safely-defaultable treatment as document_vat_marking.
  supplier_invoice_number: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

/**
 * Request body for resolving the supplier on a parked (supplier-unresolved)
 * document: the operator-chosen Supplier Entity to book the draft against.
 */
export const resolveSupplierSchema = z.object({
  supplier_entity_id: z.number().int().positive(),
});

export class ResolveSupplierDto extends createZodDto(resolveSupplierSchema) {}

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

/**
 * The operator-facing view of a document parked on the supplier-unresolved
 * route: the AI's create-supplier proposal plus the draft figures it extracted,
 * so the resolve form can show what will be booked once a supplier is chosen.
 */
export interface PendingDraft {
  document_id: number;
  reason: string;
  supplier_proposal: {
    create_name: string;
    create_country: string;
    create_registration_key: string | null;
    create_email: string | null;
    create_phone: string | null;
    create_address: string | null;
  };
  draft: {
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    supplier_invoice_number: string | null;
  };
}

/**
 * Read-only debug snapshot for a document: what Pass-1 OCR transcribed and what
 * Pass-2 (the LLM) classified it as — for understanding a routing decision
 * (e.g. why a document was tagged 'correction'). Re-runs Pass-2 on the (cached)
 * OCR markdown; it never changes the document's status or routing.
 */
export interface DocumentDebug {
  document_id: number;
  ocr:
    | { ok: true; markdown: string }
    | { ok: false; category: string; detail: string };
  // null when OCR failed — there is nothing to classify.
  classification:
    | { ok: true; result: TriageResult }
    | { ok: false; category: string; detail: string }
    | null;
}
