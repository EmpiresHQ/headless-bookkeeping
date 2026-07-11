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

/**
 * The server's identifier kind union is wider than the three addable-alias
 * kinds (Reality #5, entities/types.ts identifier union): `email`/`tg_user_id`
 * arrive on employee/director entities (onboarding identity, ADR-0036),
 * `phone`/`address` exist server-side but no UI writes them.
 */
export interface EntityIdentifier {
  id: number;
  entity_id: number;
  kind:
    | 'registration_key'
    | 'iban'
    | 'merchant_descriptor'
    | 'name_alias'
    | 'email'
    | 'phone'
    | 'address'
    | 'tg_user_id';
  value: string;
  confirmed: boolean;
}

/** The server's entity role enum — verified entities/types.ts:4. Employees
 *  and directors are the ADR-0036 claimants (there is NO 'claimant' role). */
export type EntityRole = 'supplier' | 'customer' | 'employee' | 'director';

export interface Entity {
  id: number;
  role: EntityRole;
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
  // Present on every list row (expenses/types.ts:19) — the Reports INF join
  // derives "missing invoice number" gaps from it (Plan 05 Reality #11).
  supplier_invoice_number: string | null;
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
  due_date: string | null;
  // Present on every list row (sales-invoices/types.ts:20) — the invoice
  // detail links its source document with it.
  document_id: number | null;
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
  status: 'open' | 'locked';
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

/**
 * Single-expense detail (GET /api/expenses/:id). Display subset for the
 * approval detail screen: adds document_id + ai_confidence, which the list
 * subset (Expense) deliberately omits. NOT extending Expense: the single
 * fetch carries no `reconciled` flag (that is a list-endpoint enrichment).
 * voucher_id stays off the typed surface (ADR-0001/ADR-0030).
 */
export interface ExpenseDetail {
  id: number;
  document_id: number | null;
  supplier_id: number | null;
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: string;
  supplier_invoice_number: string | null;
  ai_confidence: number | null;
  claimant_id: number | null;
  created_at: number;
}

export const getExpense = (id: number) =>
  apiFetch<ExpenseDetail>(`/api/expenses/${id}`);

/** Set the supplier invoice number on a POSTED expense — no ledger impact;
 *  400 when the expense's reporting period is locked (expenses.service.ts:
 *  217-233). The Reports INF-gap fix goes through this. */
export const setExpenseDocumentMetadata = (
  id: number,
  patch: { supplier_invoice_number: string | null },
) =>
  apiFetch<ExpenseDetail>(`/api/expenses/${id}/document-metadata`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

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

/**
 * Advisory pre-lock warnings (GET /api/reporting-periods/:id/warnings) —
 * ADR-0015 warn-and-confirm: the server NEVER blocks locking on these.
 * NOTE: `description` embeds raw cents ("EUR 65000") — do not render it;
 * join object_id against the shared lists instead (Plan 05 Reality #8).
 */
export interface PeriodWarning {
  type: 'pending_approval' | 'unposted_draft';
  object_type: 'expense' | 'sales_invoice';
  object_id: number;
  description: string;
}

export const getPeriodWarnings = (periodId: number) =>
  apiFetch<{ warnings: PeriodWarning[] }>(
    `/api/reporting-periods/${periodId}/warnings`,
  ).then((r) => r.warnings);

/**
 * File (lock) a period — ONE atomic act: freezes the VAT snapshot AND flips
 * the period to locked (ADR-0009/0037). Idempotent; 409 when an EARLIER
 * period is still open (filing proceeds oldest-first). There is NO unlock
 * endpoint — corrections go forward into the open period.
 */
export const lockPeriod = (periodId: number) =>
  apiFetch<ReportingPeriod>(`/api/reporting-periods/${periodId}/lock`, {
    method: 'POST',
  });

// ── Statutory submission lifecycle (ADR-0037: append-only event log) ──────
/** Folded filing status — the kind of the latest event (fold.ts). */
export type SubmissionStatus =
  | 'not_started'
  | 'prepared'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'correction_submitted'
  | 'correction_accepted';

export type SubmissionEventKind = Exclude<SubmissionStatus, 'not_started'>;

/** Operator-recordable kinds — `prepared` is system-emitted at lock only
 *  (statutory-submission/types.ts:15-22; the server zod-rejects it). */
export type RecordableSubmissionKind = Exclude<SubmissionEventKind, 'prepared'>;

/** Display subset of a persisted event — the snapshot linkage columns
 *  (report_kind, source_snapshot_*) stay off the typed surface: internal
 *  artifact plumbing, not operator data (ADR-0001/0030 discipline). */
export interface SubmissionEvent {
  id: number;
  reporting_period_id: number;
  event_kind: SubmissionEventKind;
  external_ref: string | null;
  occurred_at: number;
  actor: string;
  note: string | null;
}

/** Folded state + full ordered history. `currentSnapshotId` deliberately
 *  omitted (internal artifact id). A period with no events folds to
 *  status 'not_started' with an empty history. */
export interface SubmissionState {
  status: SubmissionStatus;
  lastExternalRef: string | null;
  submissionCount: number;
  history: SubmissionEvent[];
}

export const getSubmissionState = (periodId: number) =>
  apiFetch<SubmissionState>(
    `/api/reporting-periods/${periodId}/submission-state`,
  );

export interface RecordSubmissionEventInput {
  event_kind: RecordableSubmissionKind;
  external_ref?: string;
  note?: string;
}

/** Operator-attested lifecycle event (POST …/submission-events). 404s for a
 *  period with no frozen snapshot ("lock it before recording"). */
export const recordSubmissionEvent = (
  periodId: number,
  input: RecordSubmissionEventInput,
) =>
  apiFetch<SubmissionEvent>(
    `/api/reporting-periods/${periodId}/submission-events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

/** Euro display formatting: integer cents → "48.20". Negatives carry the
 *  TYPOGRAPHIC minus U+2212 (figure-width under tabular-nums — aligns with
 *  '+'-signed inflows). App-wide decision, Plan 06 Task 2. */
export const fmtCents = (cents: number): string =>
  (cents < 0 ? '−' : '') + (Math.abs(cents) / 100).toFixed(2);

// ── KMD declaration (GET /api/reporting-periods/:id/kmd) ──────────────────
// Derived on EVERY read from the period's posted vouchers — a live preview
// while the period is open; stable once locked only because locked periods
// reject postings. API TRAP (Plan 05 Reality #7): never add a wrapper for
// POST /api/reporting-periods/:id/vat-report — generating a snapshot on an
// OPEN period freezes it early and lock() would silently file the STALE
// snapshot (vat-report.service.ts:44-52 + reporting-periods.service.ts:203).
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

/**
 * Correction result (corrections/types.ts:24-38). `redirected` is true when
 * the original date sat in a LOCKED period and the reversal + correction were
 * re-dated into the current open period (ADR-0009). Voucher ids stay off the
 * typed surface (ADR-0001/0030). NOTE: the server's `kind:'credit_note'`
 * branch needs a creditNote payload this client deliberately never sends —
 * credit notes go through POST /api/credit-notes (see CorrectSheet).
 */
export interface CorrectionOutcome {
  outcome: string;
  redirected?: boolean;
  redirectedToPeriodId?: number;
}

export const correctExpense = (id: number, req: CorrectionRequest) =>
  apiFetch<CorrectionOutcome>(`/api/expenses/${id}/correct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });

export const correctInvoice = (id: number, req: CorrectionRequest) =>
  apiFetch<CorrectionOutcome>(`/api/sales-invoices/${id}/correct`, {
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

/** Draft → Rules → Policy → post or hold, for sales invoices (mirror of
 *  postExpense; 409 on non-draft). Voucher stays untyped (ADR-0001/0030). */
export const postInvoice = (id: number) =>
  apiFetch<{ invoice: SalesInvoice; policy: PolicyDecisionView }>(
    `/api/sales-invoices/${id}/post`,
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

/**
 * POST /api/entities body. Identity is PER-ROLE (entities.service.ts:42-85):
 * supplier/customer REQUIRE registrationKey (400
 * 'registrationKey is required for supplier/customer entities'); employee/
 * director REQUIRE email (400 'email is required for employee/director
 * entities'), optional tgUserId. The server stores these as identifiers
 * (registration_key / email / tg_user_id); none is editable afterwards.
 */
export interface OnboardEntityInput {
  role: EntityRole;
  country: string;
  name: string;
  registrationKey?: string;
  goodsVsServices?: 'goods' | 'services' | 'unknown';
  email?: string;
  tgUserId?: string;
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

export const uploadDocument = (
  file: File,
  opts: { claimantId?: number | null } = {},
) => {
  // Multipart: set NO content-type so the browser adds the boundary.
  const body = new FormData();
  body.append('file', file);
  // ADR-0036: the employee/director who paid out-of-pocket. The server takes
  // it as a multipart string field (documents.controller.ts:79,109).
  if (opts.claimantId != null)
    body.append('claimant_id', String(opts.claimantId));
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
 *
 * Deliberately NOT passing 'noopener'/'noreferrer' to window.open: per the
 * HTML spec, either flag makes window.open() return null (no reference to
 * hand back), which silently broke this into always taking the `else`
 * branch below and navigating the CURRENT tab away instead of opening a new
 * one (smoke-tested — Task 16). The target is same-origin (our own
 * /api/documents/:id/shared), so the opener-access trade-off is acceptable.
 */
export async function openSignedDocument(id: number): Promise<void> {
  const tab = window.open('', '_blank');
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
  reason_type: TriageReasonType;
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

export interface SuggestedSupplier {
  id: number;
  name: string;
  country: string;
  registration_key: string | null;
}

export type PendingSupplierProposal =
  | {
      kind: 'create';
      create_name: string;
      create_country: string;
      create_registration_key: string | null;
      create_email: string | null;
      create_phone: string | null;
      create_address: string | null;
    }
  | {
      kind: 'invalid_match';
      observed_country: string | null;
      observed_registration_key: string | null;
      suggested_supplier: SuggestedSupplier | null;
    };

export interface PendingDraft {
  document_id: number;
  reason: string;
  supplier_proposal: PendingSupplierProposal;
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

/** Approvals LOG (GET /api/approvals?status=&object_type=) — the Books
 *  detail joins the newest rejected approval to show WHY a draft came back
 *  (rejecting returns the object to draft, ADR-0015). */
export interface ListApprovalsQuery {
  status?: 'pending' | 'approved' | 'rejected' | 'superseded';
  object_type?:
    | 'expense'
    | 'sales_invoice'
    | 'allowance'
    | 'reconciliation_match';
}

export const listApprovals = (query: ListApprovalsQuery = {}) => {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.object_type) params.set('object_type', query.object_type);
  const qs = params.toString();
  return apiFetch<{ approvals: Approval[] }>(
    qs ? `/api/approvals?${qs}` : '/api/approvals',
  ).then((r) => r.approvals);
};

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
  gross_amount: number; // integer cents
  vat_amount: number; // integer cents
  currency: string;
  tax_point_date: string;
  created_at: number;
  credits_object_type: string;
  credits_object_id: number;
}

export const getCreditNote = (id: number) =>
  apiFetch<CreditNote>(`/api/credit-notes/${id}`);

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
