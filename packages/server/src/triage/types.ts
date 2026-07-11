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
    // The supplier identity the agent OBSERVED on the document, carried so the
    // kernel can corroborate the match deterministically (ADR-0014). A match to
    // an entity whose country/registration key positively contradicts the
    // document is routed to operator triage rather than booked against the wrong
    // supplier (field case: an EE rent invoice matched to a US software vendor).
    // Optional/nullable: a document may not print these, and an absent value
    // simply skips the corresponding check — it never forces a false reject.
    observed_country: z.string().nullable().optional(),
    observed_registration_key: z.string().nullable().optional(),
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

// Reuse the supplier discriminated-union shape for the customer counterparty —
// identical match/create semantics (ADR-0014). A 'create' proposal parks to
// needs_triage in v1 exactly like supplier 'create'.
export const customerProposalSchema = supplierProposalSchema;
export type CustomerProposal = SupplierProposal;

// Structured "is this OUR outgoing invoice?" signals the agent emits. They are
// confidence inputs ONLY — direction is decided in code from the IBAN match.
export const outgoingSignalsSchema = z.object({
  org_name_is_issuer: z.boolean().default(false),
  org_vat_is_issuer: z.boolean().default(false),
  has_buyer_block: z.boolean().default(false),
  self_identifies_as_invoice: z.boolean().default(false),
});
export type OutgoingSignals = z.infer<typeof outgoingSignalsSchema>;

/**
 * TriageResult — the structured output produced by the AI triage agent.
 * Represents the AI's interpretation of an incoming document.
 *
 * The `kind` discriminant determines what downstream action to take:
 * - 'new_expense': create an Expense and run the posting pipeline.
 * - 'new_sales_invoice': create a sales (outgoing) invoice draft.
 * - 'correction': modify an existing business object (wired in Task 43).
 * - 'duplicate': flag as a likely duplicate (wired in Task 43).
 * - 'not_a_document': the file is NOT a business accounting document at all
 *   (spam, marketing, personal correspondence, a blank/garbled page, an
 *   unrelated screenshot/PDF). The relevance gate: such a file must be filtered
 *   out BEFORE any voucher attempt — never booked — and held for human review.
 * - 'unknown': it looks like a document but cannot be classified — hold for
 *   human review.
 */
export const triageResultSchema = z.object({
  // Booking-critical fields stay REQUIRED — if the model omits them the document
  // genuinely cannot be booked and must go to a human.
  kind: z.enum([
    'new_expense',
    'new_sales_invoice',
    'correction',
    'duplicate',
    'not_a_document',
    'unknown',
  ]),
  gross_amount: z.number().int(),
  vat_amount: z.number().int(),
  tax_point_date: z.string(), // ISO date string (YYYY-MM-DD)
  category: z.string(),
  supplier_proposal: supplierProposalSchema.optional(),
  customer_proposal: customerProposalSchema.optional(),
  // Safely-defaultable metadata. Some OpenAI-compatible endpoints do NOT enforce
  // `required` in json_schema, so the model occasionally drops a field; defaults
  // keep a good extraction from failing the parse (which would lose ALL the
  // data to needs_triage). currency defaults to the EUR base; a dropped
  // confidence is treated as 0 (conservative — never auto-posts on a guess).
  // document_type now also drives routing (bank_statement → CSV path, etc.).
  document_type: z
    .enum(['receipt', 'invoice', 'bank_statement', 'credit_note', 'other'])
    .default('other'),
  currency: z.string().length(3).default('EUR'),
  document_vat_marking: z.string().nullable().default(null),
  // Supplier's own invoice/receipt number (opaque, for KMD INF Part B). Same
  // safely-defaultable treatment as document_vat_marking.
  supplier_invoice_number: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
  // Structured outgoing-invoice signals emitted by the agent. All default to
  // false so the field is always present on every TriageResult; the explicit
  // all-false default ensures inner field defaults are applied correctly.
  outgoing_signals: outgoingSignalsSchema.default({
    org_name_is_issuer: false,
    org_vat_is_issuer: false,
    has_buyer_block: false,
    self_identifies_as_invoice: false,
  }),
  // Pass 2 signal: did the document have a company address block (buyer block
  // addressed to the org)? True → VAT is recoverable (company-addressed);
  // false/null → personal receipt, VAT not recoverable (NULL_VAT_CODE path).
  company_addressed_receipt: z.boolean().nullable().optional(),
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

export interface TriageOutcomeBankStatement {
  kind: 'bank_statement';
  document_id: number;
  job_id: number;
}

export interface TriageOutcomeUnknown {
  kind: 'unknown';
  document_id: number;
  reason: string;
}

export type TriageOutcome =
  | TriageOutcomeExpense
  | TriageOutcomeInvoice
  | TriageOutcomeBankStatement
  | TriageOutcomeUnknown;

/**
 * Pass2Enrichment — the deterministic enrichment phase's captured output
 * (ADR-0024 / issue #179's split enrichment-then-classify trust boundary).
 *
 * Lives here (not in `ai/pass2-agent.service.ts`) so this module — and
 * DocumentsService, which persists it on `pending_triage_result` — never
 * needs to import from `ai/`. The AI layer imports this type FROM
 * `triage/types.ts`, not the other way around.
 *
 * `supplier.matchEntityId` is set ONLY when it came from the deterministic
 * `getClassificationContext` tool result captured during the enrichment call
 * — never from the model's free-text summary or its own guess. This is the
 * trusted value `propose-draft.service.ts`'s guard checks a model-emitted
 * `match_entity_id` against.
 */
const pass2EnrichmentSupplierSchema = z.object({
  matchEntityId: z.number().int().positive().optional(),
});

export const pass2EnrichmentSchema = z.object({
  summary: z.string(),
  supplier: pass2EnrichmentSupplierSchema.optional(),
});

export type Pass2Enrichment = z.infer<typeof pass2EnrichmentSchema>;

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
    | { ok: true; result: TriageResult; enrichment?: Pass2Enrichment }
    | { ok: false; category: string; detail: string }
    | null;
}

export type TriageReasonType =
  | 'supplier_unresolved'
  | 'outgoing_invoice'
  | 'low_confidence'
  | 'category_unresolved'
  | 'ocr_failed'
  | 'unimplemented'
  | 'not_a_document'
  | 'unknown';

export interface NeedsTriageItem {
  id: number;
  filename: string;
  created_at: number;
  reason: string;
  reason_type: TriageReasonType;
}

export function classifyReasonType(description: string): TriageReasonType {
  // Checked FIRST: a detected OUTGOING invoice that parked to needs_triage. The
  // routeSalesInvoice park reasons all carry the stable "outgoing invoice"
  // marker, so the SPA can reach the manual classify-as-sales-invoice form.
  if (description.toLowerCase().includes('outgoing invoice'))
    return 'outgoing_invoice';
  // Relevance gate: the file was judged not to be a business accounting document
  // at all. Checked before the supplier/confidence buckets because its reason
  // text is intentionally distinct (notADocumentReason()).
  if (description.toLowerCase().includes('not a business accounting document'))
    return 'not_a_document';
  if (description.includes('supplier')) return 'supplier_unresolved';
  if (
    description.includes('confidence') ||
    description.includes('below threshold')
  )
    return 'low_confidence';
  if (description.includes('unknown category')) return 'category_unresolved';
  if (
    description.includes('OCR') ||
    description.includes('transcription') ||
    description.includes('classification failed')
  )
    return 'ocr_failed';
  if (description.includes('not yet implemented')) return 'unimplemented';
  // 'AI could not classify the document' — the agent returned kind='unknown'.
  // Treated as low_confidence: the human action is the same (manually classify).
  if (description.includes('could not classify')) return 'low_confidence';
  return 'unknown';
}

/**
 * Manual-classify payload — target-discriminated, BACKWARD COMPATIBLE.
 *
 * The original payload was the EXPENSE shape with NO `target` field. To let an
 * operator manually classify a parked document as a SALES INVOICE too, the DTO
 * is now a union of two arms keyed on an OPTIONAL `target` discriminant:
 *
 * - the expense arm carries `target: z.literal('expense').optional()`, so a
 *   legacy no-target payload still validates (defaults to expense);
 * - the sales-invoice arm REQUIRES `target: z.literal('sales_invoice')`.
 *
 * The union is ordered SALES FIRST so a `target: 'sales_invoice'` payload is
 * never swallowed by the expense arm (the expense arm's `target` literal would
 * reject a 'sales_invoice' value anyway — sales-first is for clarity/safety).
 */
export const manualClassifyExpenseSchema = z.object({
  // Optional discriminant: absent → this arm matches (legacy expense payload).
  target: z.literal('expense').optional(),
  supplier_id: z.number().int().positive(),
  category: z.string().min(1),
  document_vat_marking: z.string().nullable(),
  gross_amount: z.number().int().positive(),
  vat_amount: z.number().int().min(0),
  currency: z.string().length(3),
  tax_point_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  supplier_invoice_number: z.string().nullable().optional(),
});

export const manualClassifySalesInvoiceSchema = z.object({
  target: z.literal('sales_invoice'),
  customer_id: z.number().int().nullable().optional(),
  invoice_number: z.string(),
  gross_amount: z.number().int(),
  vat_amount: z.number().int(),
  currency: z.string(),
  tax_point_date: z.string(),
  document_vat_marking: z.string().nullable().optional(),
});

export const manualClassifySchema = z.union([
  manualClassifySalesInvoiceSchema,
  manualClassifyExpenseSchema,
]);

export type ManualClassifyExpenseInput = z.infer<
  typeof manualClassifyExpenseSchema
>;
export type ManualClassifySalesInvoiceInput = z.infer<
  typeof manualClassifySalesInvoiceSchema
>;

/**
 * Discriminated manual-classify input the workflow narrows on `target`. The
 * expense arm's `target` is optional (absent on legacy payloads); the
 * sales-invoice arm's is the required `'sales_invoice'` literal.
 */
export type ManualClassifyInput =
  | ManualClassifySalesInvoiceInput
  | ManualClassifyExpenseInput;

/**
 * The endpoint DTO. `createZodDto` cannot be used as a base class for a UNION
 * schema (its instance type would not be a single object type — TS2509), so the
 * union DTO is created as a value and its instance type is declared separately
 * as the discriminated {@link ManualClassifyInput}. The ZodValidationPipe reads
 * the static `schema` to validate the body, exactly as for an object DTO.
 */
export const ManualClassifyDto = createZodDto(manualClassifySchema);
export type ManualClassifyDto = ManualClassifyInput;
