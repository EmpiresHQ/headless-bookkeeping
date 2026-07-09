import { Outlet } from 'react-router-dom';
import { useInboxCount } from '../queries/inbox';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

/** Screens reach shell affordances through Outlet context (react-router).
 *  Today that is only sign-out (Settings hub row — the sidebar is lg:-only,
 *  so phones had NO sign-out until Plan 06). */
export interface ShellOutletContext {
  onSignOut: () => void;
}

export function AppLayout({ onSignOut }: { onSignOut: () => void }) {
  // Live decision-queue badge. NO polling here — the hook shares the Inbox
  // queue's cache keys and refreshes via staleTime/focus + Inbox refetches.
  const inboxCount = useInboxCount();
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Sidebar onSignOut={onSignOut} inboxCount={inboxCount} />
      <div className="pb-24 lg:pb-6 lg:pl-56">
        <Outlet context={{ onSignOut } satisfies ShellOutletContext} />
      </div>
      <TabBar inboxCount={inboxCount} />
    </div>
  );
}
