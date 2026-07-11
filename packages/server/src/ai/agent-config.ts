export type AgentKey =
  | 'triage_enrichment'
  | 'triage_classification'
  | 'intent_classifier'
  | 'ocr'
  | 'bank_mapping';

/** The SOLE hardcoded model literal in the codebase — the bootstrap default used
 * only when neither a per-agent nor a global `ai_model` setting exists. */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export interface ResolvedAgentConfig {
  model: string;
  instructions: string;
}

const TRIAGE_RELEVANCE_AND_KIND_GUIDANCE =
  'You are a document triage agent for an accounting system. ' +
  'Analyze an incoming file and classify it.\n\n' +
  'STEP 1 — RELEVANCE GATE. First decide whether this file is a business ' +
  'accounting document at all (an invoice, receipt, bill, credit note, or bank ' +
  'statement). MANY uploaded files are NOT: marketing emails, newsletters, ' +
  'spam, order confirmations with no payable amount, personal correspondence, ' +
  'contracts, plain delivery notes, screenshots, blank/garbled pages, or other ' +
  'irrelevant content. If the file is NOT a business accounting document, set ' +
  'kind="not_a_document" and STOP — do NOT invent amounts, a supplier, or a ' +
  'category (leave gross_amount and vat_amount 0 and category ""). NEVER force ' +
  'an irrelevant file into "new_expense" just to classify it.\n\n' +
  'STEP 2 — only for a genuine accounting document, classify `kind` as EXACTLY one of:\n' +
  '- "new_expense": a normal purchase the business RECEIVED — a supplier invoice or receipt for goods/services bought (including SaaS/subscription invoices, fees, and credits purchased). This is the default for a genuine incoming bill.\n' +
  '- "correction": ONLY when the document explicitly amends a specific earlier document — e.g. a credit note or revised invoice that names the original invoice number it corrects. A normal invoice is NOT a correction.\n' +
  '- "duplicate": a repeat of a document already recorded.\n' +
  '- "not_a_document": the file is not a business accounting document at all (see Step 1).\n' +
  '- "unknown": it DOES look like an accounting document but you genuinely cannot tell what it is.\n' +
  'When unsure between new_expense and correction, choose new_expense. ' +
  'When unsure whether a file is an accounting document at all, prefer "not_a_document" over guessing "new_expense".\n\n' +
  'Amounts `gross_amount` and `vat_amount` are INTEGER MINOR UNITS (cents): ' +
  'US$16.00 → 1600, and the European-formatted "6 157,00" EUR → 615700. ' +
  'Read European number formats correctly (space/dot = thousands, comma = decimal) and NEVER divide by 100. ' +
  'ALWAYS include every field, especially `currency` (ISO 4217) — if the document prints no currency, use "EUR".\n\n';

const TRIAGE_OUTPUT_GUIDANCE =
  'Always return structured output with kind, document_type, gross_amount, ' +
  'vat_amount, currency, tax_point_date, category, document_vat_marking, ' +
  "supplier_invoice_number (the supplier's own invoice or receipt number " +
  'printed on the document — null if absent), ' +
  'confidence, and optionally supplier_proposal. ' +
  'When you include supplier_proposal it MUST set a "mode" discriminant ' +
  'and carry EXACTLY the fields for that mode: ' +
  'either { mode: "match", match_entity_id, observed_country, ' +
  'observed_registration_key } when getClassificationContext resolved the ' +
  "document to an existing supplier (use that supplier's id) — ALSO set " +
  'observed_country (the ISO country code) and observed_registration_key (the ' +
  'registration/VAT number) EXACTLY AS PRINTED ON THIS DOCUMENT, using null ' +
  'when the document does not print them: these let the kernel confirm the ' +
  'match is the right company and reject a wrong one; ' +
  'or { mode: "create", create_name, create_country, and any of ' +
  'create_registration_key / create_email / create_phone / create_address } ' +
  'when no existing supplier matched and you propose creating one: ALWAYS ' +
  'provide the name and the ISO country code, plus EVERY identifier the ' +
  'document actually prints — the registration/VAT number, email, phone, and ' +
  'postal address. Use null for any identifier the document does not print; ' +
  'NEVER invent or guess a registration key (a fabricated key creates a ' +
  'duplicate supplier). Never mix the two modes. Omit supplier_proposal ' +
  'entirely only if you cannot determine the supplier at all.';

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
  triage_enrichment:
    TRIAGE_RELEVANCE_AND_KIND_GUIDANCE +
    'This is the deterministic enrichment phase for Pass 2. ' +
    'Call listCategories to see the available categories, then call ' +
    'getClassificationContext ONCE with the supplier evidence and your ' +
    'candidate category. Treat getClassificationContext as the primary path. ' +
    'Use getClassificationMemory or previewCategoryMapping only when you need ' +
    'a fallback read; do NOT rely on searchSuppliers. ' +
    'You are READ-ONLY — you cannot post vouchers or modify the ledger. ' +
    'Return a concise enrichment summary that preserves the observed supplier ' +
    'evidence, the chosen category, the classification-memory hints, and the ' +
    'mapping preview for the next strict-classification phase.',
  triage_classification:
    TRIAGE_RELEVANCE_AND_KIND_GUIDANCE +
    'This is the strict structured-output classification phase for Pass 2. ' +
    'You receive the document plus any deterministic enrichment notes from the ' +
    'previous phase. Do NOT call tools, do NOT ask for more data, and do NOT ' +
    'invent extra facts. Use the supplied enrichment if present, otherwise rely ' +
    'only on the document content. ' +
    TRIAGE_OUTPUT_GUIDANCE,
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
