import { apiFetch } from './auth';

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
}

export interface Entity {
  id: number;
  role: string;
  country: string;
  name: string;
  goods_vs_services: string | null;
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
  created_at: number;
}

export interface ReportingPeriod {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  filed_at: number | null;
}

export const getOrganization = () => apiFetch<Organization>('/api/organization');

export interface UpdateOrganizationDto {
  country?: string;
  // null clears the override → inherit the country plugin's base currency.
  base_currency?: string | null;
  vat_registered?: boolean;
  org_type?: 'company' | 'sole_proprietor';
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
  apiFetch<{ documents: DocumentRow[] }>('/api/documents').then(
    (r) => r.documents,
  );

// ── Document debug (OCR + LLM classification) ─────────────────────────────
export interface DebugTriageResult {
  kind: string;
  document_type: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  category: string;
  document_vat_marking: string | null;
  confidence: number;
}

export interface DocumentDebug {
  document_id: number;
  ocr:
    | { ok: true; markdown: string }
    | { ok: false; category: string; detail: string };
  classification:
    | { ok: true; result: DebugTriageResult }
    | { ok: false; category: string; detail: string }
    | null;
}

export const getDocumentDebug = (id: number) =>
  apiFetch<DocumentDebug>(`/api/documents/${id}/debug`);
export const getReportingPeriods = () =>
  apiFetch<{ reportingPeriods: ReportingPeriod[] }>(
    '/api/reporting-periods',
  ).then((r) => r.reportingPeriods);

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
export const deleteEntity = (id: number) =>
  apiFetch<Entity>(`/api/entities/${id}`, { method: 'DELETE' });

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

// ── Approvals (HITL) ──────────────────────────────────────────────────────
export interface Approval {
  id: number;
  object_type: string;
  object_id: number;
  status: string;
  requested_by: string;
  approved_by: string | null;
  rejected_reason: string | null;
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
  apiFetch<BankTransaction[]>(`/api/bank-statements/${statementId}/transactions`);

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

// The execute endpoint accepts the base MatchProposal fields. Strip the display
// extras before sending; the server also returns ledger data we deliberately
// ignore (ADR-0030) — typed as the match count only.
export const executeMatches = (
  statementId: number,
  proposals: MatchProposalView[],
) =>
  apiFetch<{ records: { id: number }[] }>(
    `/api/bank-statements/${statementId}/match`,
    {
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
    },
  );

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
