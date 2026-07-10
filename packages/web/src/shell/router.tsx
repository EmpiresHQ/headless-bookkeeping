import { lazy } from 'react';
import {
  Navigate,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router-dom';
import { Root } from './Root';

/* Route-level code-split (Plan 07 Task 8): every screen is its own chunk;
 * the shell (Root/TokenGate/AppLayout) stays eager so first paint and the
 * sign-in surface never wait on a screen chunk. The Suspense boundary
 * lives in AppLayout around the Outlet. The explicit
 * `.then((m) => ({ default: m.X }))` shape is deliberate — named exports
 * stay named, and tsc verifies each screen still exports its name. */
const InboxScreen = lazy(() =>
  import('../inbox/InboxScreen').then((m) => ({ default: m.InboxScreen })),
);
const TriageDocScreen = lazy(() =>
  import('../inbox/TriageDocScreen').then((m) => ({
    default: m.TriageDocScreen,
  })),
);
const ApprovalScreen = lazy(() =>
  import('../inbox/ApprovalScreen').then((m) => ({
    default: m.ApprovalScreen,
  })),
);
const BooksScreen = lazy(() =>
  import('../books/BooksScreen').then((m) => ({ default: m.BooksScreen })),
);
const ExpenseScreen = lazy(() =>
  import('../books/ExpenseScreen').then((m) => ({ default: m.ExpenseScreen })),
);
const InvoiceScreen = lazy(() =>
  import('../books/InvoiceScreen').then((m) => ({ default: m.InvoiceScreen })),
);
const DocumentScreen = lazy(() =>
  import('../books/DocumentScreen').then((m) => ({
    default: m.DocumentScreen,
  })),
);
const CreditNoteCreateScreen = lazy(() =>
  import('../books/CreditNoteCreateScreen').then((m) => ({
    default: m.CreditNoteCreateScreen,
  })),
);
const CreditNoteScreen = lazy(() =>
  import('../books/CreditNoteScreen').then((m) => ({
    default: m.CreditNoteScreen,
  })),
);
const StatementsScreen = lazy(() =>
  import('../bank/StatementsScreen').then((m) => ({
    default: m.StatementsScreen,
  })),
);
const ImportScreen = lazy(() =>
  import('../bank/ImportScreen').then((m) => ({ default: m.ImportScreen })),
);
const StatementScreen = lazy(() =>
  import('../bank/StatementScreen').then((m) => ({
    default: m.StatementScreen,
  })),
);
const TxScreen = lazy(() =>
  import('../bank/TxScreen').then((m) => ({ default: m.TxScreen })),
);
const ReportsScreen = lazy(() =>
  import('../reports/ReportsScreen').then((m) => ({
    default: m.ReportsScreen,
  })),
);
const PeriodScreen = lazy(() =>
  import('../reports/PeriodScreen').then((m) => ({ default: m.PeriodScreen })),
);
const SubmissionsScreen = lazy(() =>
  import('../reports/SubmissionsScreen').then((m) => ({
    default: m.SubmissionsScreen,
  })),
);
const SettingsScreen = lazy(() =>
  import('../settings/SettingsScreen').then((m) => ({
    default: m.SettingsScreen,
  })),
);
const OrganizationScreen = lazy(() =>
  import('../settings/OrganizationScreen').then((m) => ({
    default: m.OrganizationScreen,
  })),
);
const EntitiesScreen = lazy(() =>
  import('../settings/EntitiesScreen').then((m) => ({
    default: m.EntitiesScreen,
  })),
);
const EntityScreen = lazy(() =>
  import('../settings/EntityScreen').then((m) => ({ default: m.EntityScreen })),
);
const CategoriesScreen = lazy(() =>
  import('../settings/CategoriesScreen').then((m) => ({
    default: m.CategoriesScreen,
  })),
);
const EnrollScreen = lazy(() =>
  import('../settings/EnrollScreen').then((m) => ({ default: m.EnrollScreen })),
);
const MailboxScreen = lazy(() =>
  import('../settings/MailboxScreen').then((m) => ({
    default: m.MailboxScreen,
  })),
);
const TelegramScreen = lazy(() =>
  import('../settings/TelegramScreen').then((m) => ({
    default: m.TelegramScreen,
  })),
);
const LlmScreen = lazy(() =>
  import('../settings/LlmScreen').then((m) => ({ default: m.LlmScreen })),
);
const PolicyScreen = lazy(() =>
  import('../settings/PolicyScreen').then((m) => ({ default: m.PolicyScreen })),
);

/** Old flat-tab URL → new section URL (?seg= preselects the tab where the
 *  target screen has one). */
const LEGACY_REDIRECTS: Record<string, string> = {
  '/org': '/settings/organization',
  '/entities': '/settings/entities',
  '/categories': '/settings/categories',
  '/enroll': '/settings/enroll',
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

/** The mailbox OAuth callback bounces the browser to `/?mailbox=connected`
 *  or `/?mailbox_error=…` (mailbox.controller.ts:119-164). Route the result
 *  to the Mailbox screen instead of dropping it at the Inbox redirect. */
function RootRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const to =
    params.has('mailbox') || params.has('mailbox_error')
      ? `/settings/mailbox${location.search}`
      : '/inbox';
  return <Navigate to={to} replace />;
}

export function buildRoutes(): RouteObject[] {
  return [
    {
      element: <Root />,
      children: [
        { path: '/', element: <RootRedirect /> },
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
        { path: '/settings', element: <SettingsScreen /> },
        { path: '/settings/organization', element: <OrganizationScreen /> },
        { path: '/settings/entities', element: <EntitiesScreen /> },
        { path: '/settings/entities/:id', element: <EntityScreen /> },
        { path: '/settings/categories', element: <CategoriesScreen /> },
        { path: '/settings/enroll', element: <EnrollScreen /> },
        { path: '/settings/mailbox', element: <MailboxScreen /> },
        { path: '/settings/telegram', element: <TelegramScreen /> },
        { path: '/settings/llm', element: <LlmScreen /> },
        { path: '/settings/policy', element: <PolicyScreen /> },
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
