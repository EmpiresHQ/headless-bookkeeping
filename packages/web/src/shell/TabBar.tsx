import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './nav';

export function TabBar({ inboxCount = 0 }: { inboxCount?: number }) {
  return (
    <nav
      data-tabbar
      className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-line h-[var(--tabbar-h)] bg-surface/95 pb-[max(var(--safe-bottom),8px)] pt-0.5 backdrop-blur lg:hidden"
    >
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `relative flex min-w-[46px] flex-col items-center justify-center gap-0.5 text-[9.5px] ${
              isActive ? 'font-bold text-accent' : 'text-ink-2'
            }`
          }
        >
          <Icon size={22} strokeWidth={2} />
          {label}
          {to === '/inbox' && inboxCount > 0 && (
            <span className="absolute right-0 top-0 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-alert px-1 text-[9px] font-bold text-white">
              {inboxCount}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
