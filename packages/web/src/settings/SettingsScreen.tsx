import { Navigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useEntities } from '../queries/shared';
import { useMailboxConnectors, useOrganization } from '../queries/settings';
import { LargeTitleHeader } from '../shell/Headers';
import type { ShellOutletContext } from '../shell/AppLayout';
import { Button } from '../ui/Button';
import { ListGroup, ListRow } from '../ui/List';

/** Bookmarks from the old tabbed Settings shell: /settings?tab=<key>. `app`
 *  was the combined settings tab (LLM + Telegram + mailbox + policy) — the
 *  closest single target is the AI screen; the rest are one hub tap away. */
const TAB_ROUTES: Record<string, string> = {
  organization: '/settings/organization',
  entities: '/settings/entities',
  categories: '/settings/categories',
  enroll: '/settings/enroll',
  app: '/settings/llm',
};

/** /settings — the iOS grouped-list hub (spec IA). Rows are push routes;
 *  subtitles are honest cache reads (no extra fetches beyond the shared
 *  entries the rest of the app already populates). */
export function SettingsScreen() {
  const [params] = useSearchParams();
  const { onSignOut } = useOutletContext<ShellOutletContext>();
  const orgQ = useOrganization();
  const entitiesQ = useEntities();
  const connectorsQ = useMailboxConnectors();

  const tab = params.get('tab');
  // Own-key check (not `TAB_ROUTES[tab] !== undefined`): a prototype-chain
  // key like ?tab=toString would otherwise Navigate to a function and crash.
  // hasOwnProperty.call, not Object.hasOwn — the tsconfig lib predates es2022.
  if (tab !== null && Object.prototype.hasOwnProperty.call(TAB_ROUTES, tab)) {
    return <Navigate to={TAB_ROUTES[tab]} replace />;
  }

  const entityCount = entitiesQ.data?.length;
  const connectorCount = connectorsQ.data?.length;

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader title="Settings" />
      {/* No group label here (deviation from the brief's literal code): the
          brief's own test asserts a single "Organization" text node, but
          `ListGroup label="Organization"` above a `ListRow title="Organization"`
          renders the string twice and fails getByText. iOS Settings
          conventionally leaves the first grouped section unlabeled. */}
      <ListGroup>
        <ListRow
          to="/settings/organization"
          title="Organization"
          subtitle={orgQ.data?.name ?? undefined}
        />
        <ListRow
          to="/settings/entities"
          title="Entities"
          subtitle={
            entityCount === undefined
              ? 'Suppliers, customers, team'
              : `${entityCount} — suppliers, customers, team`
          }
        />
        <ListRow
          to="/settings/categories"
          title="Categories"
          subtitle="Read-only — owned by the country plugin"
        />
      </ListGroup>
      <ListGroup label="Intake">
        <ListRow
          to="/settings/mailbox"
          title="Mail intake"
          subtitle={
            connectorCount === undefined
              ? 'Mailbox connectors'
              : connectorCount === 0
                ? 'No mailboxes connected'
                : `${connectorCount} connected`
          }
        />
        <ListRow
          to="/settings/policy"
          title="Posting policy"
          subtitle="Risk gate & ingest policy"
        />
      </ListGroup>
      <ListGroup label="System">
        <ListRow
          to="/settings/llm"
          title="AI models"
          subtitle="Models, endpoint, prompts"
        />
        <ListRow
          to="/settings/telegram"
          title="Telegram & approvers"
          subtitle="Bot, allowlist, approver identities"
        />
        <ListRow
          to="/settings/enroll"
          title="Mobile device"
          subtitle="Enrollment QR"
        />
      </ListGroup>
      <div className="mx-3.5 mt-2">
        <Button variant="secondary" className="w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
