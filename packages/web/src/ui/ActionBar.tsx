import type { ReactNode } from 'react';

/** Sticky primary-action row at the foot of a screen. On phones it rests on
 *  top of the fixed TabBar (+ safe area) via --tabbar-h (index.css) — a plain
 *  `bottom-0` parks it UNDER the tab bar, where taps land on the nav instead
 *  (UI-001). On lg: the tab bar is hidden and the offset is 0. */
export function ActionBar({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`sticky bottom-[var(--tabbar-h)] z-20 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3 ${className}`}
    >
      {children}
    </div>
  );
}
