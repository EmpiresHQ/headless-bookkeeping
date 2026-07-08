import {
  Navigate,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router-dom';
import { ApprovalsView } from '../components/ApprovalsView';
import { BankView } from '../components/BankView';
import { CategoriesView } from '../components/CategoriesView';
import { CreditNotesView } from '../components/CreditNotesView';
import { DocumentsView } from '../components/DocumentsView';
import { EnrollView } from '../components/EnrollView';
import { EntitiesView } from '../components/EntitiesView';
import { ExpensesView } from '../components/ExpensesView';
import { IntakeView } from '../components/IntakeView';
import { InvoicesView } from '../components/InvoicesView';
import { KmdView } from '../components/KmdView';
import { OrgView } from '../components/OrgView';
import { SettingsView } from '../components/SettingsView';
import { LegacyTabs } from './LegacyTabs';
import { Root } from './Root';

/** Old flat-tab URL → new section URL (tab preselected via ?tab=). */
const LEGACY_REDIRECTS: Record<string, string> = {
  '/org': '/settings?tab=organization',
  '/entities': '/settings?tab=entities',
  '/categories': '/settings?tab=categories',
  '/enroll': '/settings?tab=enroll',
  '/expenses': '/books?tab=expenses',
  '/invoices': '/books?tab=invoices',
  '/documents': '/books?tab=documents',
  '/credit-notes': '/books?tab=credit-notes',
  '/intake': '/inbox?tab=triage',
  '/approvals': '/inbox?tab=approvals',
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
        {
          path: '/inbox',
          element: (
            <LegacyTabs
              title="Inbox"
              tabs={[
                { key: 'triage', label: 'Triage', El: IntakeView },
                { key: 'approvals', label: 'Approvals', El: ApprovalsView },
              ]}
            />
          ),
        },
        {
          path: '/books',
          element: (
            <LegacyTabs
              title="Books"
              tabs={[
                { key: 'expenses', label: 'Expenses', El: ExpensesView },
                { key: 'invoices', label: 'Invoices', El: InvoicesView },
                { key: 'documents', label: 'Documents', El: DocumentsView },
                {
                  key: 'credit-notes',
                  label: 'Credit notes',
                  El: CreditNotesView,
                },
              ]}
            />
          ),
        },
        {
          path: '/bank',
          element: (
            <LegacyTabs
              title="Bank"
              tabs={[{ key: 'bank', label: 'Bank', El: BankView }]}
            />
          ),
        },
        {
          path: '/reports',
          element: (
            <LegacyTabs
              title="Reports"
              tabs={[{ key: 'kmd', label: 'VAT / KMD', El: KmdView }]}
            />
          ),
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
