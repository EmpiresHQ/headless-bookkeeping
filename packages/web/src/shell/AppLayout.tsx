import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

export function AppLayout({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Sidebar onSignOut={onSignOut} />
      <div className="pb-24 lg:pb-6 lg:pl-56">
        <Outlet />
      </div>
      <TabBar />
    </div>
  );
}
