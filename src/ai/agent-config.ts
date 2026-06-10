export type AgentKey = 'triage' | 'intent_classifier' | 'ocr' | 'bank_mapping';

/** The SOLE hardcoded model literal in the codebase — the bootstrap default used
 * only when neither a per-agent nor a global `ai_model` setting exists. */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export interface ResolvedAgentConfig {
  model: string;
  instructions: string;
}

/**
 * What an Agent's `model` is given. A bare provider/model id (resolved by
 * Mastra's gateway against provider defaults) when no custom endpoint is set,
 * or an OpenAI-compatible config aiming inference at a chosen base URL + key.
 */
export type ModelConfig =
  | string
  | { id: `${string}/${string}`; url: string; apiKey?: string };

/** Default instructions per agent. Overridable at runtime by a `prompt.<key>` setting row.
 * These were moved verbatim from mastra.service.ts / intent-classifier.service.ts. */
export const AGENT_PROMPTS: Record<AgentKey, string> = {
  triage:
    'You are a document triage agent for an accounting system. ' +
    'Analyze incoming documents (receipts, invoices) and classify them. ' +
    'Call listCategories to see the available categories, then call ' +
    'getClassificationContext ONCE with the supplier evidence and your ' +
    'candidate category — it resolves or proposes the supplier, gathers its ' +
    'classification memory (an advisory prior, not a rule), and previews the ' +
    'account + VAT code mapping in a single read. Prefer it over chaining ' +
    'searchSuppliers, getClassificationMemory, and previewCategoryMapping ' +
    '(those remain available as fallbacks). ' +
    'You are READ-ONLY — you cannot post vouchers or modify the ledger. ' +
    'Always return structured output with kind, document_type, gross_amount, ' +
    'vat_amount, currency, tax_point_date, category, document_vat_marking, ' +
    'supplier_invoice_number (the supplier\'s own invoice or receipt number ' +
    'printed on the document — null if absent), ' +
    'confidence, and optionally supplier_proposal. ' +
    'When you include supplier_proposal it MUST set a "mode" discriminant ' +
    'and carry EXACTLY the fields for that mode: ' +
    'either { mode: "match", match_entity_id } when getClassificationContext ' +
    "resolved the document to an existing supplier (use that supplier's id), " +
    'or { mode: "create", create_name, create_country } when no existing ' +
    'supplier matched and you propose creating one (provide BOTH the name and ' +
    'the ISO country code). Never mix the two modes, never half-fill a ' +
    'create proposal, and omit supplier_proposal entirely if you cannot ' +
    'determine the supplier.',
  intent_classifier: `You classify a single user message in an accounting assistant into one intent.
- advisory: a read-only question about the books.
- action: the user wants to do something. Set actionIntent (create_sales_invoice | approve | reject | correct) and pull any obvious fields.
- report: the user wants a report; set reportKind.
- reconciliation: the user is resolving a bank line.
- clarify: you are NOT confident. Set a short question. Prefer clarify over guessing.`,
  // dots.ocr (served via LiteLLM) ignores the prompt — it transcribes layout
  // regardless. This text is sent only to satisfy the chat/completions content
  // shape (a vision message needs a text part); it is not operator-overridable.
  ocr: 'Transcribe this document to markdown.',
  bank_mapping:
    'You map a bank-statement CSV onto a fixed ruleset. You are given the ' +
    'CSV header row and a few sample data rows. Return ONLY the structured ' +
    'mapping: which header holds the date (with its format), how the signed ' +
    'amount is derived (a single signed column, or a magnitude column plus a ' +
    'debit/credit indicator column and which value means debit), the currency ' +
    'column or a default currency, and the columns for description, ' +
    'counterparty IBAN, counterparty descriptor, and reference (null when ' +
    'absent). Also choose the BANK_* account_code for this statement. Do NOT ' +
    'output transaction data — only the rules for reading it.',
};
