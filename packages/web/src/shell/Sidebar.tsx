import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './nav';

export function Sidebar({
  onSignOut,
  inboxCount = 0,
}: {
  onSignOut: () => void;
  inboxCount?: number;
}) {
  return (
    // sanctioned one-off (approved mockup), no token — Plan 06 Task 2
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col gap-0.5 border-r border-line bg-[#ECEEEA] p-3 lg:flex">
      <div className="flex items-center gap-2 px-3 pb-4 pt-1 text-sm font-extrabold">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent-deep text-xs text-signal">
          ◆
        </span>
        books
      </div>
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          viewTransition
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium ${
              isActive
                ? 'bg-surface font-bold text-accent-deep shadow-sm'
                : 'text-ink-2 hover:text-ink'
            }`
          }
        >
          <Icon size={17} strokeWidth={2} />
          {label}
          {to === '/inbox' && inboxCount > 0 && (
            <span className="ml-auto rounded-full bg-alert px-1.5 py-px text-[10px] font-bold text-white">
              {inboxCount}
            </span>
          )}
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onSignOut}
        className="mt-auto border-t border-line px-3 py-2.5 text-left text-xs text-ink-2 hover:text-ink"
      >
        Sign out
      </button>
    </aside>
  );
}
