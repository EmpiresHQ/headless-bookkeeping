import { Outlet } from 'react-router-dom';
import { useInboxCount } from '../queries/inbox';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

export function AppLayout({ onSignOut }: { onSignOut: () => void }) {
  // Live decision-queue badge. NO polling here — the hook shares the Inbox
  // queue's cache keys and refreshes via staleTime/focus + Inbox refetches.
  const inboxCount = useInboxCount();
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Sidebar onSignOut={onSignOut} inboxCount={inboxCount} />
      <div className="pb-24 lg:pb-6 lg:pl-56">
        <Outlet />
      </div>
      <TabBar inboxCount={inboxCount} />
    </div>
  );
}
