import { apiFetch, apiFetchRaw } from './auth';

/**
 * The business-object interfaces below (Organization, Entity, Expense,
 * SalesInvoice, DocumentRow, ReportingPeriod) are intentional DISPLAY SUBSETS
 * of the backend response objects — they declare only the fields the read tabs
 * render, not every field the server returns. TypeScript structural typing
 * makes a subset a valid view over the richer payload. Two deliberate
 * exclusions:
 *  - audit/linkage fields we don't show (created_at/updated_at, document_id, …);
 *  - the ledger linkage `voucher_id` is omitted ON PURPOSE — ADR-0001/ADR-0030
 *    keep the double-entry ledger hidden from the operator UI.
 * Add a field to those only when a tab actually displays it.
 *
 * The config interfaces (Setting, PolicyConfig) are full mirrors of their
 * backend schemas — the Settings page edits every field.
 */
export interface Organization {
  id: number;
  country: string;
  base_currency: string | null;
  vat_registered: boolean;
  org_type: string;
  created_at: number;
  name: string | null;
  vat_registration_number: string | null;
  iban: string | null;
}

export interface EntityIdentifier {
  id: number;
  entity_id: number;
  kind: 'registration_key' | 'iban' | 'merchant_descriptor' | 'name_alias';
  value: string;
  confirmed: boolean;
}

export interface Entity {
  id: number;
  role: string;
  country: string;
  name: string;
  goods_vs_services: string | null;
  // Present on a single-entity fetch (getEntity); absent on the list.
  identifiers?: EntityIdentifier[];
}

export interface Expense {
  id: number;
  supplier_id: number | null;
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: string;
  // True when the posted voucher is matched to a bank transaction.
  reconciled: boolean;
}

export interface SalesInvoice {
  id: number;
  customer_id: number | null;
  invoice_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: string;
  sent_at: number | null;
  // True when the posted voucher is matched to a bank transaction.
  reconciled: boolean;
}

export interface DocumentRow {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  processing_since: number | null;
  created_at: number;
}

export type DocumentChannel =
  | 'upload'
  | 'telegram'
  | 'email'
  | 'drive'
  | 'ios_photo_library'
  | 'email_sync'
  | 'email_push';

export type TriageReasonType =
  | 'supplier_unresolved'
  | 'outgoing_invoice'
  | 'low_confidence'
  | 'category_unresolved'
  | 'ocr_failed'
  | 'unimplemented'
  | 'not_a_document'
  | 'unknown';

/**
 * Enriched archive row returned by GET /api/documents (Task 6).
 * Extends DocumentRow with linkage, channel, and triage reason.
 */
export interface DocumentArchiveRow extends DocumentRow {
  preview_path: string | null;
  channel: DocumentChannel | null;
  reason: string | null;
  reason_type: TriageReasonType | null;
  expense_id: number | null;
  supplier_name: string | null;
  claimant_name: string | null;
  expense_status: string | null;
}

export interface ReportingPeriod {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  filed_at: number | null;
}

export const getOrganization = () =>
  apiFetch<Organization>('/api/organization');

export interface UpdateOrganizationDto {
  country?: string;
  // null clears the override → inherit the country plugin's base currency.
  base_currency?: string | null;
  vat_registered?: boolean;
  org_type?: 'company' | 'sole_proprietor';
  name?: string | null;
  vat_registration_number?: string | null;
  iban?: string | null;
}

export const updateOrganization = (dto: UpdateOrganizationDto) =>
  apiFetch<Organization>('/api/organization', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dto),
  });
export const getEntities = () =>
  apiFetch<{ entities: Entity[] }>('/api/entities').then((r) => r.entities);
export const getExpenses = () =>
  apiFetch<{ expenses: Expense[] }>('/api/expenses').then((r) => r.expenses);
export const getInvoices = () =>
  apiFetch<{ invoices: SalesInvoice[] }>('/api/sales-invoices').then(
    (r) => r.invoices,
  );
export const getDocuments = () =>
  apiFetch<{ documents: DocumentArchiveRow[] }>('/api/documents').then(
    (r) => r.documents,
  );

export interface CategoryDef {
  key: string;
  label: string;
  accountCode: string;
}

export const getCategories = () =>
  apiFetch<{ categories: CategoryDef[] }>('/api/categories').then(
    (r) => r.categories,
  );

// ── Document details (OCR + persisted classification — no LLM re-run) ────────
export interface DebugTriageResult {
  kind: string;
  document_type: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  category: string;
  document_vat_marking: string | null;
  supplier_invoice_number: string | null;
  confidence: number;
}

/** Read-only details for a document: cached OCR + classification from the
 *  linked Expense. Never re-invokes the LLM (ADR-0039). */
export interface DocumentDetails {
  document_id: number;
  ocr:
    | { ok: true; markdown: string }
    | { ok: false; category: string; detail: string };
  classification:
    | { ok: true; result: DebugTriageResult }
    | { ok: false; category: string; detail: string }
    | null;
}

export const getDocumentDetails = (id: number) =>
  apiFetch<DocumentDetails>(`/api/documents/${id}/details`);

/** Re-run OCR+LLM classification for a needs_triage document.
 *  Use in the /intake work queue to pre-fill the manual-triage form.
 *  Never call from read-only views — use getDocumentDetails instead. */
export const getDocumentReclassify = (id: number) =>
  apiFetch<DocumentDetails>(`/api/documents/${id}/reclassify`);

export const deleteDocument = (id: number) =>
  apiFetch<{ deleted: number }>(`/api/documents/${id}`, { method: 'DELETE' });
export const getReportingPeriods = () =>
  apiFetch<{ reportingPeriods: ReportingPeriod[] }>(
    '/api/reporting-periods',
  ).then((r) => r.reportingPeriods);

export interface CreateReportingPeriodInput {
  name: string;
  start_date: string;
  end_date: string;
}

export const createReportingPeriod = (input: CreateReportingPeriodInput) =>
  apiFetch<ReportingPeriod>('/api/reporting-periods', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

export interface PeriodConfig {
  frequency_options: string[];
  default_frequency: string;
}

export const getPeriodConfig = () =>
  apiFetch<PeriodConfig>('/api/organization/period-config');

export interface CreateNextPeriodInput {
  start_date?: string;
  end_date?: string;
  name?: string;
}

export const createNextPeriod = (input: CreateNextPeriodInput = {}) =>
  apiFetch<ReportingPeriod>('/api/reporting-periods/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

/** Integer cents → display string, e.g. 615700 -> "6157.00". */
export const fmtCents = (cents: number): string => (cents / 100).toFixed(2);

// ── KMD declaration (GET /api/reporting-periods/:id/kmd) ──────────────────
export interface KmdDeclaration {
  reporting_period_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  row1_base_24: number;
  row2_base_reduced: number;
  row3_base_zero: number;
  row4_output_vat: number;
  row5_input_vat: number;
  row6_intra_eu_acquisition: number;
  row7_other_acquisition: number;
  net_vat_due: number;
  vd_intra_eu_services: number;
  review_flags: string[];
}

export const getKmd = (periodId: number) =>
  apiFetch<KmdDeclaration>(`/api/reporting-periods/${periodId}/kmd`);

// ── Deletes (probe-garbage cleanup) ───────────────────────────────────────
// The endpoints return the deleted object (200) or 409 when the object cannot
// be deleted (a non-draft expense/invoice, or a referenced entity); apiFetch
// turns the 409 into a thrown Error carrying the server's message.
export const deleteExpense = (id: number) =>
  apiFetch<Expense>(`/api/expenses/${id}`, { method: 'DELETE' });
export const deleteInvoice = (id: number) =>
  apiFetch<SalesInvoice>(`/api/sales-invoices/${id}`, { method: 'DELETE' });

// ── Manual create (amounts are integer cents) ─────────────────────────────
export interface CreateExpenseInput {
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  supplier_id?: number | null;
  document_vat_marking?: string | null;
}

export const createExpense = (input: CreateExpenseInput) =>
  apiFetch<Expense>('/api/expenses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

export interface CreateInvoiceInput {
  invoice_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  customer_id?: number | null;
  due_date?: string | null;
  document_vat_marking?: string | null;
}

export const createInvoice = (input: CreateInvoiceInput) =>
  apiFetch<SalesInvoice>('/api/sales-invoices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

// ── Corrections (reversal + corrected voucher of a POSTED object) ──────────
export interface CorrectionRequest {
  kind: 'cosmetic' | 'financial' | 'credit_note';
  reason: string;
  patch?: { gross_amount?: number; vat_amount?: number; category?: string };
}

export const correctExpense = (id: number, req: CorrectionRequest) =>
  apiFetch<{ outcome: string }>(`/api/expenses/${id}/correct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });

export const correctInvoice = (id: number, req: CorrectionRequest) =>
  apiFetch<{ outcome: string }>(`/api/sales-invoices/${id}/correct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });

// ── Expense posting pipeline (draft → Rules → Policy → post or hold) ───────
// The endpoint also returns the posted voucher; it stays off the typed surface
// on purpose (ADR-0001/ADR-0030 — the operator UI never consumes ledger data).
export interface PolicyDecisionView {
  action: 'auto-post' | 'hold-for-approval';
  reason: string;
}

export const postExpense = (id: number) =>
  apiFetch<{ expense: Expense; policy: PolicyDecisionView }>(
    `/api/expenses/${id}/post`,
    { method: 'POST' },
  );

export const deleteEntity = (id: number) =>
  apiFetch<Entity>(`/api/entities/${id}`, { method: 'DELETE' });

// Single entity WITH its identifiers (the list endpoint omits them).
export const getEntity = (id: number) =>
  apiFetch<Entity>(`/api/entities/${id}`);

// Add a matching alias (IBAN / card merchant descriptor) so reconciliation's
// counterparty signal can resolve this entity. confirmed defaults to true so it
// participates in matching immediately.
export interface AddAliasInput {
  kind: 'iban' | 'merchant_descriptor' | 'name_alias';
  value: string;
  confirmed?: boolean;
}

export const addEntityAlias = (id: number, input: AddAliasInput) =>
  apiFetch<EntityIdentifier>(`/api/entities/${id}/aliases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true, ...input }),
  });

export interface OnboardEntityInput {
  role: 'supplier' | 'customer';
  country: string;
  name: string;
  // The strong identity key (e.g. VAT / registry no.) used to match the entity.
  registrationKey: string;
  goodsVsServices?: 'goods' | 'services' | 'unknown';
}

export const onboardEntity = (input: OnboardEntityInput) =>
  apiFetch<Entity>('/api/entities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

// Update only the mutable facts; role + registration key are immutable identity.
export interface UpdateEntityInput {
  name?: string;
  country?: string;
  goodsVsServices?: 'goods' | 'services' | 'unknown';
}

export const updateEntity = (id: number, input: UpdateEntityInput) =>
  apiFetch<Entity>(`/api/entities/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

// ── Intake / triage (POST /api/documents, /triage, /complete) ─────────────
export type TriageOutcome =
  | { kind: 'expense'; document_id: number; expense_id: number }
  | { kind: 'invoice'; document_id: number; invoice_id: number }
  | { kind: 'bank_statement'; document_id: number; job_id: number }
  | { kind: 'unknown'; document_id: number; reason: string };

export const uploadDocument = (file: File) => {
  // Multipart: set NO content-type so the browser adds the boundary.
  const body = new FormData();
  body.append('file', file);
  return apiFetch<{ document: DocumentRow; deduplicated: boolean }>(
    '/api/documents',
    { method: 'POST', body },
  );
};

export const getTriagePending = () =>
  apiFetch<{ pending: DocumentRow[] }>('/api/triage/pending').then(
    (r) => r.pending,
  );

export const triageDocument = (id: number) =>
  apiFetch<TriageOutcome>(`/api/documents/${id}/triage`, { method: 'POST' });

export const completeDocument = (id: number) =>
  apiFetch<{ id: number; status: string }>(`/api/documents/${id}/complete`, {
    method: 'POST',
  });

/** Re-queue a needs_triage document for a fresh OCR + classification run. */
export const retryDocument = (id: number) =>
  apiFetch<{ ok: true }>(`/api/documents/${id}/retry`, { method: 'POST' });

/**
 * Mint a short-lived, token-free URL for a document's file. The raw
 * `/api/documents/:id/file` endpoint is Bearer-only, so a plain <a href> the
 * browser navigates to (or a link you copy/share) cannot open it — the token
 * lives in localStorage, not a cookie. This returns a signed `/shared` URL that
 * streams the file without a token for a bounded window (~1h).
 */
export const getSignedDocumentUrl = (id: number) =>
  apiFetch<{ url: string }>(`/api/documents/${id}/signed-url`);

/**
 * Fetch a document's preview PNG as an object URL. The /preview endpoint needs
 * the Bearer header, which an <img src> cannot send — so we fetch the bytes
 * (token attached) and hand back a blob: URL. The CALLER must revoke it with
 * URL.revokeObjectURL when the image unmounts.
 */
export async function fetchDocumentPreviewObjectUrl(
  id: number,
): Promise<string> {
  const res = await apiFetchRaw(`/api/documents/${id}/preview`);
  return URL.createObjectURL(await res.blob());
}

/**
 * Open a document's file in a new tab via a freshly-minted signed URL. Opens a
 * blank tab synchronously (inside the click gesture, so the popup blocker does
 * not eat it), then points it at the token-free /shared link once minted.
 */
export async function openSignedDocument(id: number): Promise<void> {
  const tab = window.open('', '_blank', 'noreferrer');
  try {
    const { url } = await getSignedDocumentUrl(id);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/**
 * Copy a token-free shareable link to a document's file onto the clipboard.
 * Prefixes the current origin so the copied URL is absolute and openable
 * anywhere the link's bounded lifetime allows.
 */
export async function copyDocumentShareLink(id: number): Promise<void> {
  const { url } = await getSignedDocumentUrl(id);
  await navigator.clipboard.writeText(`${window.location.origin}${url}`);
}

export interface NeedsTriageItem {
  id: number;
  filename: string;
  created_at: number;
  reason: string;
  reason_type:
    | 'supplier_unresolved'
    | 'outgoing_invoice'
    | 'low_confidence'
    | 'category_unresolved'
    | 'ocr_failed'
    | 'unimplemented'
    | 'not_a_document'
    | 'unknown';
}

export const getNeedsTriageItems = () =>
  apiFetch<{ items: NeedsTriageItem[] }>('/api/triage/needs-triage').then(
    (r) => r.items,
  );

export interface ManualClassifyBody {
  supplier_id: number;
  category: string;
  document_vat_marking: string | null;
  gross_amount: number; // minor units (cents)
  vat_amount: number; // minor units (cents)
  currency: string;
  tax_point_date: string; // YYYY-MM-DD
  supplier_invoice_number?: string | null;
}

export const manualClassify = (id: number, body: ManualClassifyBody) =>
  apiFetch<TriageOutcome>(`/api/documents/${id}/manual-classify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export interface ManualClassifyInvoiceBody {
  target: 'sales_invoice';
  customer_id?: number | null;
  invoice_number: string;
  gross_amount: number; // minor units (cents)
  vat_amount: number; // minor units (cents)
  currency: string;
  tax_point_date: string; // YYYY-MM-DD
  document_vat_marking?: string | null;
}

export const manualClassifyInvoice = (
  id: number,
  body: ManualClassifyInvoiceBody,
) =>
  apiFetch<TriageOutcome>(`/api/documents/${id}/manual-classify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export interface PendingDraft {
  document_id: number;
  reason: string;
  supplier_proposal: {
    create_name: string;
    create_country: string;
    create_registration_key: string;
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

export const getPendingDraft = (id: number) =>
  apiFetch<PendingDraft>(`/api/documents/${id}/pending-draft`);

export const resolveSupplier = (id: number, supplierEntityId: number) =>
  apiFetch<TriageOutcome>(`/api/documents/${id}/resolve-supplier`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ supplier_entity_id: supplierEntityId }),
  });

// ── Approvals (HITL) ──────────────────────────────────────────────────────
export interface Approval {
  id: number;
  object_type: string;
  object_id: number;
  status: string;
  requested_by: string;
  approved_by: string | null;
  rejected_reason: string | null;
  policy_reason: string | null;
  superseded_by: number | null;
  created_at: number;
  resolved_at: number | null;
}

export const getPendingApprovals = () =>
  apiFetch<{ approvals: Approval[] }>('/api/approvals/pending').then(
    (r) => r.approvals,
  );

// Typed to `{ approval }` only — the approve endpoint also returns the posted
// voucher, but the operator UI deliberately never consumes ledger data
// (ADR-0001/ADR-0030), so it stays off the client's typed surface.
export const approveApproval = (id: number, approvedBy: string) =>
  apiFetch<{ approval: Approval }>(`/api/approvals/${id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved_by: approvedBy }),
  });

export const rejectApproval = (id: number, reason: string) =>
  apiFetch<{ approval: Approval }>(`/api/approvals/${id}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rejected_reason: reason }),
  });

// ── Settings (admin/settings key/value) ───────────────────────────────────
export interface Setting {
  key: string;
  value: string;
}

export const getSettings = () =>
  apiFetch<{ settings: Setting[] }>('/admin/settings').then((r) => r.settings);

export const setSetting = (key: string, value: string) =>
  apiFetch<{ key: string; value: string }>(
    `/admin/settings/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    },
  );

export const deleteSetting = (key: string) =>
  apiFetch<{ key: string; deleted: true }>(
    `/admin/settings/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );

// ── Policy / risk gate (GET|PUT /api/policy-config) ───────────────────────
export interface PolicyConfig {
  auto_post_amount_ceiling: number;
  auto_post_min_confidence: number;
  unknown_supplier_requires_approval: boolean;
  always_approve_operations: string[];
}

export const getPolicyConfig = () =>
  apiFetch<PolicyConfig>('/api/policy-config');

export const updatePolicyConfig = (patch: Partial<PolicyConfig>) =>
  apiFetch<PolicyConfig>('/api/policy-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

// ── Bank statement import (async) ─────────────────────────────────────────
export interface BankImportJob {
  id: number;
  status: string;
  account_code: string;
  statement_id: number | null;
  error: string | null;
}

export const importBankStatement = (file: File, accountCode: string) => {
  const body = new FormData();
  body.append('file', file);
  body.append('account_code', accountCode);
  return apiFetch<{ jobId: number }>('/api/bank-statements/import', {
    method: 'POST',
    body,
  });
};

export const getBankImportStatus = (jobId: number) =>
  apiFetch<BankImportJob>(`/api/bank-statements/import/${jobId}`);

// ── Credit notes ─────────────────────────────────────────────────────────
export interface CreditNote {
  id: number;
  credit_note_number: string;
  status: string;
  gross_amount: number;
  vat_amount: number;
  credits_object_type: string;
  credits_object_id: number;
}

export async function createCreditNote(body: {
  credits_object_type: 'sales_invoice' | 'expense';
  credits_object_id: number;
  credit_note_number: string;
  gross_amount: number;
  vat_amount: number;
  tax_point_date: string;
}): Promise<CreditNote> {
  return apiFetch('/api/credit-notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function listCreditNotes(): Promise<CreditNote[]> {
  return apiFetch<{ credit_notes: CreditNote[] }>('/api/credit-notes').then(
    (r) => r.credit_notes,
  );
}

// ── Statutory report download (binary blob) ───────────────────────────────
// GET /api/reporting-periods/:id/statutory-report?format=xml|csv|all
// The server responds with the file as a binary body and a content-disposition
// header carrying the filename.  We use apiFetchRaw (not apiFetch) so that we
// receive the raw Response and can call .blob() on it instead of .json().
export async function downloadStatutoryReport(
  periodId: number,
  format: 'xml' | 'csv' | 'all',
): Promise<void> {
  const res = await apiFetchRaw(
    `/api/reporting-periods/${periodId}/statutory-report?format=${format}`,
    { method: 'GET' },
  );
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cd = res.headers.get('content-disposition') ?? '';
  a.download =
    cd.match(/filename="(.+?)"/)?.[1] ??
    `kmd-${periodId}.${format === 'all' ? 'zip' : format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Bank statements + transactions (read) ─────────────────────────────────
// Display subsets — account_id (a ledger-internal FK) is intentionally omitted
// per ADR-0001 (the UI shows business objects, never ledger internals).
export interface BankStatement {
  id: number;
  start_date: string;
  end_date: string;
  uploaded_at: number; // unix seconds
}

export interface BankTransaction {
  id: number;
  transaction_date: string;
  description: string | null;
  amount: number; // signed integer cents
  currency: string;
  counterparty_iban: string | null;
  counterparty_descriptor: string | null;
  reference: string | null;
  status: string;
}

export const listBankStatements = () =>
  apiFetch<BankStatement[]>('/api/bank-statements');

export const listBankTransactions = (statementId: number) =>
  apiFetch<BankTransaction[]>(
    `/api/bank-statements/${statementId}/transactions`,
  );

export const deleteBankStatement = (statementId: number) =>
  apiFetch<{ deleted: number }>(`/api/bank-statements/${statementId}`, {
    method: 'DELETE',
  });

// ── Reconciliation ────────────────────────────────────────────────────────
// Proposals describe vouchers in BUSINESS-OBJECT terms (ADR-0030); voucherId is
// carried for the /match round-trip only and is never rendered.
export interface MatchProposalView {
  bankTransactionId: number;
  voucherId: number;
  matchType: 'exact' | 'partial' | 'prepayment';
  amountMatched: number; // BASE cents
  confidence: 'high' | 'medium' | 'low';
  signal: 'invoice_number' | 'counterparty' | 'amount_date';
  objectType: 'sales_invoice' | 'expense' | 'prepayment';
  objectId: number | null;
  objectLabel: string;
  counterpartyName: string | null;
  voucherRemaining: number;
}

export interface ReconciliationStatusRow {
  bankTransactionId: number;
  amountBase: number;
  matchedSum: number;
  remaining: number;
  reconStatus: 'matched' | 'partial' | 'open';
}

export const proposeMatches = (statementId: number) =>
  apiFetch<MatchProposalView[]>(
    `/api/bank-statements/${statementId}/propose-matches`,
    { method: 'POST' },
  );

export const getReconciliationStatus = (statementId: number) =>
  apiFetch<ReconciliationStatusRow[]>(
    `/api/bank-statements/${statementId}/reconciliation`,
  );

// The match endpoint stages DRAFT matches and creates one pending approval per
// match (settlement happens at approval → activation). The client needs the
// approval ids to approve-on-the-spot, and the match ids to Undo.
export interface ExecuteMatchesResult {
  records: { id: number }[];
  approvals: { id: number; matchId: number }[];
}

// The execute endpoint accepts the base MatchProposal fields. Strip the display
// extras before sending; the server also returns ledger data we deliberately
// ignore (ADR-0030) — typed as ExecuteMatchesResult (staged records + their
// pending approvals, not the ledger data).
export const executeMatches = (
  statementId: number,
  proposals: MatchProposalView[],
) =>
  apiFetch<ExecuteMatchesResult>(`/api/bank-statements/${statementId}/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      matches: proposals.map((p) => ({
        bankTransactionId: p.bankTransactionId,
        voucherId: p.voucherId,
        matchType: p.matchType,
        amountMatched: p.amountMatched,
        confidence: p.confidence,
        signal: p.signal,
      })),
    }),
  });

// Recorded matches (draft + active) on a statement's lines.
export interface MatchRowView {
  id: number;
  bankTransactionId: number;
  status: 'draft' | 'active';
  amountMatched: number;
  objectLabel: string;
  counterpartyName: string | null;
}

export const getStatementMatches = (statementId: number) =>
  apiFetch<MatchRowView[]>(`/api/bank-statements/${statementId}/matches`);

// Undo a match (deletes the sub-ledger link; reverses any FX voucher server-side).
export const unmatchMatch = (statementId: number, matchId: number) =>
  apiFetch<unknown>(`/api/bank-statements/${statementId}/matches/${matchId}`, {
    method: 'DELETE',
  });

// Manual-match candidates: open business objects a bank line can settle, plus
// the line's remaining unallocated amount (BASE cents). voucherId is for the
// execute round-trip only (ADR-0030).
export interface MatchCandidateView {
  voucherId: number;
  objectType: 'sales_invoice' | 'expense' | 'prepayment';
  objectId: number | null;
  objectLabel: string;
  counterpartyName: string | null;
  voucherRemaining: number;
}

export interface MatchCandidatesResult {
  bankTransactionId: number;
  lineRemaining: number;
  candidates: MatchCandidateView[];
}

export const getMatchCandidates = (
  statementId: number,
  bankTransactionId: number,
) =>
  apiFetch<MatchCandidatesResult>(
    `/api/bank-statements/${statementId}/match-candidates?bankTransactionId=${bankTransactionId}`,
  );

// Stage a manual match (signal 'manual'); it becomes a draft pending approval.
export const manualMatch = (
  statementId: number,
  m: {
    bankTransactionId: number;
    voucherId: number;
    amountMatched: number;
    matchType: 'exact' | 'partial';
  },
) =>
  apiFetch<ExecuteMatchesResult>(`/api/bank-statements/${statementId}/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ matches: [{ ...m, signal: 'manual' }] }),
  });

// Prepayment / Personal post ledger vouchers; the UI ignores the returned
// voucher (ADR-0030) and only needs success/failure.
export const createPrepayment = (bankTransactionId: number) =>
  apiFetch<unknown>(`/api/bank-transactions/${bankTransactionId}/prepayment`, {
    method: 'POST',
  });

export const markPersonal = (bankTransactionId: number) =>
  apiFetch<unknown>(`/api/bank-transactions/${bankTransactionId}/personal`, {
    method: 'POST',
  });

// ── Device enrollment ─────────────────────────────────────────────────────
export interface DeviceEnrollment {
  apiBaseUrl: string;
  enrollmentToken: string;
  expiresAt: string;
}

export const createDeviceEnrollment = () =>
  apiFetch<DeviceEnrollment>('/api/device-enrollments', { method: 'POST' });

// ── Mailbox connectors (GET|POST|DELETE /api/mailbox/connectors, OAuth start) ──
export type MailboxChannel = 'email_sync' | 'email_push';
export type MailboxProvider = 'gmail' | 'outlook' | 'imap';
export type MailboxStatus =
  | 'connected'
  | 'auth_failed'
  | 'disconnected'
  | 'error';

export interface MailboxConnector {
  id: number;
  channel: MailboxChannel;
  auth_mode: 'password' | 'oauth';
  provider: MailboxProvider;
  host: string;
  port: number;
  username: string;
  folder: string;
  status: MailboxStatus;
  last_synced_at: number | null;
  last_error: string | null;
}

export interface CreateMailboxConnectorBody {
  channel: MailboxChannel;
  provider: MailboxProvider;
  host: string;
  port: number;
  username: string;
  secret: string;
  folder?: string;
}

export const getMailboxConnectors = () =>
  apiFetch<MailboxConnector[]>('/api/mailbox/connectors');

export const createMailboxConnector = (body: CreateMailboxConnectorBody) =>
  apiFetch<MailboxConnector>('/api/mailbox/connectors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// DELETE returns 200 with an empty body — use apiFetchRaw so we don't try to
// parse JSON out of it (apiFetch always parses).
export const deleteMailboxConnector = (id: number) =>
  apiFetchRaw(`/api/mailbox/connectors/${id}`, { method: 'DELETE' }).then(
    () => undefined,
  );

export const startMailboxOAuth = (params: {
  provider: 'gmail' | 'outlook';
  channel: MailboxChannel;
}) =>
  apiFetch<{ url: string }>(
    `/api/mailbox/oauth/start?${new URLSearchParams(params).toString()}`,
  );

export const syncMailboxConnector = (id: number) =>
  apiFetch<MailboxConnector>(`/api/mailbox/connectors/${id}/sync`, {
    method: 'POST',
  });
