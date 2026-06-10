import type { ComponentType } from 'react';
import { Column } from './components/Table';
import { ReportingPeriod, getReportingPeriods } from './api';
import { KmdView } from './components/KmdView';
import { IntakeView } from './components/IntakeView';
import { BankView } from './components/BankView';
import { ApprovalsView } from './components/ApprovalsView';
import { SettingsView } from './components/SettingsView';
import { CreditNotesView } from './components/CreditNotesView';
import { OrgView } from './components/OrgView';
import { EntitiesView } from './components/EntitiesView';
import { DocumentsView } from './components/DocumentsView';
import { ExpensesView } from './components/ExpensesView';
import { InvoicesView } from './components/InvoicesView';

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

const orgTab: TabDef = {
  key: 'org',
  label: 'Organization',
  load: async () => [],
  columns: [],
  Custom: OrgView,
};

const entitiesTab: TabDef = {
  key: 'entities',
  label: 'Entities',
  load: async () => [],
  columns: [],
  Custom: EntitiesView,
};

const expensesTab: TabDef = {
  key: 'expenses',
  label: 'Expenses',
  load: async () => [],
  columns: [],
  Custom: ExpensesView,
};

const invoicesTab: TabDef = {
  key: 'invoices',
  label: 'Sales invoices',
  load: async () => [],
  columns: [],
  Custom: InvoicesView,
};

const documentsTab: TabDef = {
  key: 'documents',
  label: 'Documents',
  load: async () => [],
  columns: [],
  Custom: DocumentsView,
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

const bankTab: TabDef = {
  key: 'bank',
  label: 'Bank',
  load: async () => [],
  columns: [],
  Custom: BankView,
};

const intakeTab: TabDef = {
  key: 'intake',
  label: 'Intake',
  load: async () => [],
  columns: [],
  Custom: IntakeView,
};

const approvalsTab: TabDef = {
  key: 'approvals',
  label: 'Approvals',
  load: async () => [],
  columns: [],
  Custom: ApprovalsView,
};

const settingsTab: TabDef = {
  key: 'settings',
  label: 'Settings',
  load: async () => [],
  columns: [],
  Custom: SettingsView,
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

const creditNotesTab: TabDef = {
  key: 'credit-notes',
  label: 'Credit Notes',
  load: async () => [],
  columns: [],
  Custom: CreditNotesView,
};

// Cast to a uniform TabDef<unknown> list — each tab is internally typed.
export const TABS: TabDef[] = [
  orgTab,
  entitiesTab,
  expensesTab,
  invoicesTab,
  documentsTab,
  bankTab,
  intakeTab,
  approvalsTab,
  periodsTab,
  kmdTab,
  creditNotesTab,
  settingsTab,
] as unknown as TabDef[];
