import { apiFetch } from './auth';

/**
 * These interfaces are intentional DISPLAY SUBSETS of the backend response
 * objects — they declare only the fields the read tabs render, not every field
 * the server returns. TypeScript structural typing makes a subset a valid view
 * over the richer payload. Two deliberate exclusions:
 *  - audit/linkage fields we don't show (created_at/updated_at, document_id, …);
 *  - the ledger linkage `voucher_id` is omitted ON PURPOSE — ADR-0001/ADR-0029
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
