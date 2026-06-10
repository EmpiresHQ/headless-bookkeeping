import { apiFetch } from './auth';

/**
 * These interfaces are intentional DISPLAY SUBSETS of the backend response
 * objects — they declare only the fields the read tabs render, not every field
 * the server returns. TypeScript structural typing makes a subset a valid view
 * over the richer payload. Two deliberate exclusions:
 *  - audit/linkage fields we don't show (created_at/updated_at, document_id, …);
 *  - the ledger linkage `voucher_id` is omitted ON PURPOSE — ADR-0001/ADR-0030
 *    keep the double-entry ledger hidden from the operator UI.
 * Add a field here only when a tab actually displays it.
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
export const deleteEntity = (id: number) =>
  apiFetch<Entity>(`/api/entities/${id}`, { method: 'DELETE' });
