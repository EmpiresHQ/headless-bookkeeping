import {
  Navigate,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router-dom';
import { CategoriesView } from '../components/CategoriesView';
import { EnrollView } from '../components/EnrollView';
import { EntitiesView } from '../components/EntitiesView';
import { OrgView } from '../components/OrgView';
import { SettingsView } from '../components/SettingsView';
import { ApprovalScreen } from '../inbox/ApprovalScreen';
import { InboxScreen } from '../inbox/InboxScreen';
import { TriageDocScreen } from '../inbox/TriageDocScreen';
import { ImportScreen } from '../bank/ImportScreen';
import { StatementScreen } from '../bank/StatementScreen';
import { StatementsScreen } from '../bank/StatementsScreen';
import { TxScreen } from '../bank/TxScreen';
import { BooksScreen } from '../books/BooksScreen';
import { CreditNoteCreateScreen } from '../books/CreditNoteCreateScreen';
import { CreditNoteScreen } from '../books/CreditNoteScreen';
import { DocumentScreen } from '../books/DocumentScreen';
import { ExpenseScreen } from '../books/ExpenseScreen';
import { InvoiceScreen } from '../books/InvoiceScreen';
import { PeriodScreen } from '../reports/PeriodScreen';
import { ReportsScreen } from '../reports/ReportsScreen';
import { SubmissionsScreen } from '../reports/SubmissionsScreen';
import { LegacyTabs } from './LegacyTabs';
import { Root } from './Root';

/** Old flat-tab URL → new section URL (tab preselected via ?tab=/?seg=). */
const LEGACY_REDIRECTS: Record<string, string> = {
  '/org': '/settings?tab=organization',
  '/entities': '/settings?tab=entities',
  '/categories': '/settings?tab=categories',
  '/enroll': '/settings?tab=enroll',
  '/expenses': '/books?seg=expenses',
  '/invoices': '/books?seg=invoices',
  '/documents': '/books?seg=documents',
  '/credit-notes': '/books?seg=credit-notes',
  '/intake': '/inbox?seg=triage',
  '/approvals': '/inbox?seg=approvals',
  '/kmd': '/reports',
  '/periods': '/reports',
};

/** Navigate that merges the target's ?tab with the incoming search params
 *  (keeps deep links like /intake?expand=5 working after redirect). */
function RedirectMergingSearch({ to }: { to: string }) {
  const location = useLocation();
  const [pathname, targetSearch] = to.split('?');
  const merged = new URLSearchParams(location.search);
  new URLSearchParams(targetSearch).forEach((v, k) => merged.set(k, v));
  const search = merged.toString();
  return <Navigate to={search ? `${pathname}?${search}` : pathname} replace />;
}

export function buildRoutes(): RouteObject[] {
  return [
    {
      element: <Root />,
      children: [
        { path: '/', element: <Navigate to="/inbox" replace /> },
        { path: '/inbox', element: <InboxScreen /> },
        { path: '/inbox/doc/:id', element: <TriageDocScreen /> },
        { path: '/inbox/approval/:id', element: <ApprovalScreen /> },
        { path: '/books', element: <BooksScreen /> },
        { path: '/books/expenses/:id', element: <ExpenseScreen /> },
        { path: '/books/invoices/:id', element: <InvoiceScreen /> },
        { path: '/books/documents/:id', element: <DocumentScreen /> },
        // Static 'new' outranks ':id' in v7 route ranking — order is not load-bearing.
        {
          path: '/books/credit-notes/new',
          element: <CreditNoteCreateScreen />,
        },
        { path: '/books/credit-notes/:id', element: <CreditNoteScreen /> },
        { path: '/bank', element: <StatementsScreen /> },
        { path: '/bank/import', element: <ImportScreen /> },
        { path: '/bank/statements/:id', element: <StatementScreen /> },
        { path: '/bank/statements/:id/tx/:txId', element: <TxScreen /> },
        { path: '/reports', element: <ReportsScreen /> },
        { path: '/reports/periods/:id', element: <PeriodScreen /> },
        {
          path: '/reports/periods/:id/submissions',
          element: <SubmissionsScreen />,
        },
        {
          path: '/settings',
          element: (
            <LegacyTabs
              title="Settings"
              tabs={[
                { key: 'organization', label: 'Organization', El: OrgView },
                { key: 'entities', label: 'Entities', El: EntitiesView },
                { key: 'categories', label: 'Categories', El: CategoriesView },
                { key: 'enroll', label: 'Enroll', El: EnrollView },
                { key: 'app', label: 'App', El: SettingsView },
              ]}
            />
          ),
        },
        ...Object.entries(LEGACY_REDIRECTS).map(([from, to]) => ({
          path: from,
          element: <RedirectMergingSearch to={to} />,
        })),
        { path: '*', element: <Navigate to="/inbox" replace /> },
      ],
    },
  ];
}

export function buildRouter() {
  return createBrowserRouter(buildRoutes());
}
