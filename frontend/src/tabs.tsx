import type { ComponentType } from 'react';
import { Column } from './components/Table';
import {
  Entity,
  Expense,
  SalesInvoice,
  DocumentRow,
  ReportingPeriod,
  Organization,
  fmtCents,
  getEntities,
  getExpenses,
  getInvoices,
  getDocuments,
  getReportingPeriods,
  getOrganization,
  deleteExpense,
  deleteInvoice,
  deleteEntity,
} from './api';
import { KmdView } from './components/KmdView';

export interface TabDef<T = unknown> {
  key: string;
  label: string;
  load: () => Promise<T[]>;
  columns: Column<T>[];
  /** Optional row delete; when set, the tab shows a Delete action per row. */
  remove?: (row: T) => Promise<unknown>;
  /** Row id for the delete confirm prompt (required when `remove` is set). */
  rowId?: (row: T) => number;
  /** When set, the tab renders this component instead of the data table. */
  Custom?: ComponentType;
}

const orgTab: TabDef<Organization> = {
  key: 'org',
  label: 'Organization',
  load: () => getOrganization().then((o) => [o]),
  columns: [
    { header: 'Country', cell: (o) => o.country },
    { header: 'Org type', cell: (o) => o.org_type },
    { header: 'VAT registered', cell: (o) => (o.vat_registered ? 'yes' : 'no') },
    { header: 'Base currency', cell: (o) => o.base_currency ?? '(plugin default)' },
  ],
};

const entitiesTab: TabDef<Entity> = {
  key: 'entities',
  label: 'Entities',
  load: getEntities,
  columns: [
    { header: 'ID', cell: (e) => e.id },
    { header: 'Name', cell: (e) => e.name },
    { header: 'Role', cell: (e) => e.role },
    { header: 'Country', cell: (e) => e.country },
    { header: 'Goods/Services', cell: (e) => e.goods_vs_services ?? '—' },
  ],
  remove: (e) => deleteEntity(e.id),
  rowId: (e) => e.id,
};

const expensesTab: TabDef<Expense> = {
  key: 'expenses',
  label: 'Expenses',
  load: getExpenses,
  columns: [
    { header: 'ID', cell: (e) => e.id },
    { header: 'Category', cell: (e) => e.category },
    { header: 'Gross', cell: (e) => `${fmtCents(e.gross_amount)} ${e.currency}` },
    { header: 'VAT', cell: (e) => fmtCents(e.vat_amount) },
    { header: 'Tax point', cell: (e) => e.tax_point_date },
    { header: 'Status', cell: (e) => e.status },
  ],
  remove: (e) => deleteExpense(e.id),
  rowId: (e) => e.id,
};

const invoicesTab: TabDef<SalesInvoice> = {
  key: 'invoices',
  label: 'Sales invoices',
  load: getInvoices,
  columns: [
    { header: 'No.', cell: (i) => i.invoice_number },
    { header: 'Gross', cell: (i) => `${fmtCents(i.gross_amount)} ${i.currency}` },
    { header: 'VAT', cell: (i) => fmtCents(i.vat_amount) },
    { header: 'Tax point', cell: (i) => i.tax_point_date },
    { header: 'Status', cell: (i) => i.status },
    { header: 'Sent', cell: (i) => (i.sent_at ? 'yes' : 'no') },
  ],
  remove: (i) => deleteInvoice(i.id),
  rowId: (i) => i.id,
};

const documentsTab: TabDef<DocumentRow> = {
  key: 'documents',
  label: 'Documents',
  load: getDocuments,
  columns: [
    { header: 'ID', cell: (d) => d.id },
    { header: 'Filename', cell: (d) => d.filename },
    { header: 'Type', cell: (d) => d.mime_type },
    { header: 'Size', cell: (d) => `${(d.size_bytes / 1024).toFixed(1)} KB` },
    { header: 'Status', cell: (d) => d.status },
  ],
};

const periodsTab: TabDef<ReportingPeriod> = {
  key: 'periods',
  label: 'Periods',
  load: getReportingPeriods,
  columns: [
    { header: 'Name', cell: (p) => p.name },
    { header: 'Start', cell: (p) => p.start_date },
    { header: 'End', cell: (p) => p.end_date },
    { header: 'Status', cell: (p) => p.status },
    { header: 'Filed', cell: (p) => (p.filed_at ? 'yes' : 'no') },
  ],
};

const kmdTab: TabDef = {
  key: 'kmd',
  label: 'VAT / KMD',
  // Custom tabs render their own component; load/columns are unused here but
  // the TabDef shape requires them.
  load: async () => [],
  columns: [],
  Custom: KmdView,
};

// Cast to a uniform TabDef<unknown> list — each tab is internally typed.
export const TABS: TabDef[] = [
  orgTab,
  entitiesTab,
  expensesTab,
  invoicesTab,
  documentsTab,
  periodsTab,
  kmdTab,
] as unknown as TabDef[];
