import {
  Navigate,
  createBrowserRouter,
  useLocation,
  type RouteObject,
} from 'react-router-dom';
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
import { CategoriesScreen } from '../settings/CategoriesScreen';
import { EnrollScreen } from '../settings/EnrollScreen';
import { EntitiesScreen } from '../settings/EntitiesScreen';
import { EntityScreen } from '../settings/EntityScreen';
import { LlmScreen } from '../settings/LlmScreen';
import { MailboxScreen } from '../settings/MailboxScreen';
import { OrganizationScreen } from '../settings/OrganizationScreen';
import { PolicyScreen } from '../settings/PolicyScreen';
import { SettingsScreen } from '../settings/SettingsScreen';
import { TelegramScreen } from '../settings/TelegramScreen';
import { Root } from './Root';

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
