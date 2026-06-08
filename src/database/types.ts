import type { Generated } from 'kysely';

export interface Database {
  organization: OrganizationTable;
  account: AccountTable;
  voucher: VoucherTable;
  voucher_line: VoucherLineTable;
  voucher_sequence: VoucherSequenceTable;
  expense: ExpenseTable;
  sales_invoice: SalesInvoiceTable;
  override: OverrideTable;
  policy_config: PolicyConfigTable;
  reporting_period: ReportingPeriodTable;
  document: DocumentTable;
  document_source: DocumentSourceTable;
  entity: EntityTable;
  entity_identifier: EntityIdentifierTable;
  bank_statement: BankStatementTable;
  bank_transaction: BankTransactionTable;
  reconciliation_match: ReconciliationMatchTable;
  approval: ApprovalTable;
  audit_finding: AuditFindingTable;
  vat_report: VatReportTable;
  conversation: ConversationTable;
  message: MessageTable;
  artifact: ArtifactTable;
  conversation_document: ConversationDocumentTable;
  conversation_business_object: ConversationBusinessObjectTable;
  api_token: ApiTokenTable;
  ai_proposal: AiProposalTable;
  setting: SettingTable;
}

export interface OrganizationTable {
  id: Generated<number>;
  country: string;
  // Nullable override: NULL means "inherit base currency from the country
  // plugin" (ADR-0004).
  base_currency: string | null;
  vat_registered: number;
  // Legal form: 'company' | 'sole_proprietor' (ADR-0017/ADR-0023).
  // Generated because migration 017 adds DEFAULT 'company'.
  org_type: Generated<string>;
  created_at: number;
}

export interface AccountTable {
  id: Generated<number>;
  code: string;
  name: string;
  // enum: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  type: string;
  // Nullable: set only for foreign-currency accounts (e.g. BANK_USD).
  currency: string | null;
  // Self-referential FK for chart hierarchy; traversal is deferred (Wave 2
  // reserves the column only).
  parent_id: number | null;
  // SQLite boolean (0/1): 1 = system-managed, 0 = user-managed.
  is_system: number;
}

export interface VoucherTable {
  id: Generated<number>;
  voucher_number: string;
  // ISO date string; drives Reporting-period membership (CONTEXT: tax-point).
  tax_point_date: string;
  // Unix seconds, set when the voucher is posted; null while unposted.
  posted_at: number | null;
  // Reserved for the hash chain (ADR-0013). Wave 2 never writes it.
  previous_hash: string | null;
  // FK to another voucher; set by the reversal flow (Task 18), null here.
  reverses_id: number | null;
  corrects_object_type: string | null;
  corrects_object_id: number | null;
  reason: string | null;
}

export interface VoucherLineTable {
  id: Generated<number>;
  voucher_id: number;
  account_id: number;
  // Cents in the original currency.
  amount: number;
  currency: string;
  // Cents in base currency (EUR).
  base_amount: number;
  fx_rate: number;
  vat_code: string | null;
  // SQLite boolean (0/1): 1 = debit, 0 = credit.
  is_debit: number;
}

export interface SalesInvoiceTable {
  id: Generated<number>;
  customer_id: number | null;
  invoice_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  due_date: string | null;
  status: string;
  sent_at: number | null;
  voucher_id: number | null;
  // Raw VAT code/rate as printed on the counterparty's source document
  // (opaque evidence, never used for booking — ADR-0002).
  document_vat_marking: string | null;
  created_at: number;
  updated_at: number;
}

export interface ExpenseTable {
  id: Generated<number>;
  document_id: number | null;
  supplier_id: number | null;
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  // enum: 'draft' | 'pending' | 'posted' | 'reversed'
  status: string;
  voucher_id: number | null;
  // Raw VAT code/rate as printed on the counterparty's source document
  // (opaque evidence, never used for booking — ADR-0002).
  document_vat_marking: string | null;
  created_at: number;
  updated_at: number;
}

export interface OverrideTable {
  id: Generated<number>;
  business_object_type: string;
  business_object_id: number;
  rule_type: string;
  rule_name: string;
  reason: string;
  created_by: string;
  created_at: number;
}

export interface PolicyConfigTable {
  id: Generated<number>;
  key: string;
  value: string;
  updated_at: number;
}

export interface ReportingPeriodTable {
  id: Generated<number>;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  filed_at: number | null;
  vat_report_snapshot_id: number | null;
  created_at: number;
}

export interface DocumentTable {
  id: Generated<number>;
  hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  // enum: 'pending' | 'triaged' | 'needs_triage' | 'processed' | 'error'
  // (CHECK widened in migration 030; owned by IntakeWorkflowService, ADR-0024)
  status: string;
  created_at: number;
}

export interface DocumentSourceTable {
  id: Generated<number>;
  document_id: number;
  channel: string;
  source_identifier: string | null;
  received_at: number;
}

export interface VoucherSequenceTable {
  year: string;
  last_number: number;
}

// Entity: a counterparty (supplier or customer) identified by strong keys,
// never by raw name (ADR-0014). Stores ONLY intrinsic facts — no VAT code.
export interface EntityTable {
  id: Generated<number>;
  // 'supplier' | 'customer'
  role: string;
  // ISO 3166-1 alpha-2 country code
  country: string;
  name: string;
  // 'goods' | 'services' | 'unknown'
  goods_vs_services: string | null;
  created_at: number | null;
  updated_at: number | null;
}

// Identifiers anchored on a strong registration key (CVR/VAT number), IBAN,
// merchant descriptor, or name alias. The kind column determines the type.
export interface EntityIdentifierTable {
  id: Generated<number>;
  entity_id: number;
  // 'registration_key' | 'iban' | 'merchant_descriptor' | 'name_alias'
  kind: string;
  value: string;
  // SQLite boolean (0/1): 1 = confirmed by user, 0 = unconfirmed (e.g. raw
  // merchant_descriptor before user teaches it).
  confirmed: number;
}

// Bank statement: an uploaded statement file for a specific bank account,
// covering a date range.
export interface BankStatementTable {
  id: Generated<number>;
  account_id: number;
  start_date: string;
  end_date: string;
  uploaded_at: number;
  file_path: string | null;
}

// Bank transaction: a single line from a bank statement. Amount is signed
// cents: positive = incoming/credit, negative = outgoing/debit.
export interface BankTransactionTable {
  id: Generated<number>;
  statement_id: number;
  transaction_date: string;
  description: string | null;
  amount: number;
  currency: string;
  source_currency: string | null;
  source_amount: number | null;
  fx_rate: number | null;
  counterparty_iban: string | null;
  counterparty_descriptor: string | null;
  reference: string | null;
  status: string;
  created_at: number;
}

// Reconciliation match: N:M link between a bank transaction and a voucher.
// Match state (unmatched/partial/full) is DERIVED from SUM(amount_matched)
// vs |bank_transaction.amount| — never stored on the transaction itself.
export interface ReconciliationMatchTable {
  id: Generated<number>;
  bank_transaction_id: number;
  voucher_id: number;
  // 'exact' | 'partial' | 'prepayment'
  match_type: string;
  // Positive cents — the matched portion of this link.
  amount_matched: number;
  created_at: number;
}

// Approval: a Rules-valid submission held by Policy for a human decision.
// States: pending → approved | rejected | superseded (ADR-0012).
export interface ApprovalTable {
  id: Generated<number>;
  // 'expense' | 'sales_invoice'
  object_type: string;
  object_id: number;
  // 'pending' | 'approved' | 'rejected' | 'superseded'
  status: string;
  requested_by: string;
  approved_by: string | null;
  rejected_reason: string | null;
  // FK to the approval that superseded this one.
  superseded_by: number | null;
  created_at: number;
  resolved_at: number | null;
}

// AuditFinding: the persisted output of the AuditAgent — an attention item
// with dynamic severity that drives nag cadence (ADR-0018).
export interface AuditFindingTable {
  id: Generated<number>;
  // 'low' | 'medium' | 'high' | 'critical' — validated by AuditFindingsService
  severity: string;
  // one of the known FindingType kinds — validated by AuditFindingsService
  finding_type: string;
  description: string;
  // one of the known ReferencedObjectType kinds — validated on create
  referenced_object_type: string | null;
  referenced_object_id: number | null;
  // 'open' | 'resolved' | 'snoozed' — moved only via guarded transitions
  status: string;
  created_at: number;
  resolved_at: number | null;
  // lifecycle-transition audit trail (migration 029)
  snoozed_at: number | null;
  transitioned_by: string | null;
  transition_reason: string | null;
}

// Conversation: the durable, auditable thread of Messages on a single channel
// (ADR-0016/ADR-0018). Identified by (channel, thread_key) for deterministic
// router resolution. States: open → closed.
export interface ConversationTable {
  id: Generated<number>;
  // 'telegram' | 'email' | 'slack' | 'api'
  channel: string;
  thread_key: string;
  // 'open' | 'closed'
  status: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

// Message: one turn in a Conversation — direction, sender, body, threading keys.
export interface MessageTable {
  id: Generated<number>;
  conversation_id: number;
  // 'inbound' | 'outbound'
  direction: string;
  sender: string;
  body: string;
  threading_keys: string | null;
  // DKIM/SPF pass result (email only): 1 = pass, 0 = fail/null.
  dkim_spf_pass: number | null;
  created_at: number;
}

// Artifact: a file bound to a Conversation — inbound attachment, outbound output, or OCR markdown.
export interface ArtifactTable {
  id: Generated<number>;
  conversation_id: number;
  // 'inbound_attachment' | 'outbound_output' | 'ocr_markdown'
  kind: string;
  document_id: number | null;
  storage_path: string;
  created_at: number;
}

// M:N: Conversation ↔ Document
export interface ConversationDocumentTable {
  conversation_id: number;
  document_id: number;
}

// M:N: Conversation ↔ Business object (Expense, SalesInvoice, etc.)
export interface ConversationBusinessObjectTable {
  conversation_id: number;
  object_type: string;
  object_id: number;
}

// VatReport: an immutable snapshot generated when a reporting period is
// locked. Aggregates vouchers by VAT code into input vs output totals
// (Task 28). merkle_root is NULL until Task 29 computes it.
export interface VatReportTable {
  id: Generated<number>;
  reporting_period_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  // JSON string: array of VatSummaryLine objects grouped by vat_code.
  vat_summary: string;
  // Total input VAT in base-currency cents (negative = reclaimable).
  total_input_vat: number;
  // Total output VAT in base-currency cents (positive = payable).
  total_output_vat: number;
  // total_output_vat - total_input_vat (positive = net payable).
  total_payable: number;
  // total_input_vat - total_output_vat (positive = net receivable).
  total_receivable: number;
  // JSON string: array of voucher IDs included in this snapshot.
  voucher_ids: string;
  // Merkle root over included vouchers (NULL until computed).
  merkle_root: string | null;
  generated_at: number;
}

// ApiToken: table-backed API tokens for authenticating /api and /admin routes.
// token_hash is the SHA-256 hash of the plaintext token; no plaintext is stored.
export interface ApiTokenTable {
  id: Generated<number>;
  // SHA-256 hash of the plaintext token.
  token_hash: string;
  // Human-readable label (e.g. "init-token").
  label: string | null;
  created_at: Generated<number>;
  // Unix seconds when revoked; NULL = active.
  revoked_at: number | null;
}

// AiProposal: operational audit trail for AI-driven posting attempts.
// NOT part of the hash-chained ledger — stores model metadata, confidence,
// and the raw triage result for reproducibility.
export interface AiProposalTable {
  id: Generated<number>;
  business_object_type: string;
  business_object_id: number;
  model_id: string | null;
  model_version: string | null;
  raw_triage_result: string | null;
  ocr_artifact_id: number | null;
  confidence: number | null;
  created_at: number;
}

// Setting: generic key-value store for application configuration.
// Used for LLM model profiles and other tunable parameters.
export interface SettingTable {
  id: Generated<number>;
  key: string;
  value: string;
  updated_at: number;
}
