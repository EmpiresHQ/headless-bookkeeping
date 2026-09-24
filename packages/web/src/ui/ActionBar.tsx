import { useLayoutEffect, useRef, type ReactNode } from 'react';

// Mounted bars → their current height. The tallest one is published as
// --actionbar-h on <html>, where index.css adds it to scroll-padding-bottom.
const heights = new Map<HTMLElement, number>();

function publish() {
  const root = document.documentElement.style;
  if (heights.size === 0) root.removeProperty('--actionbar-h');
  else root.setProperty('--actionbar-h', `${Math.max(...heights.values())}px`);
}

/** Sticky primary-action row at the foot of a screen. On phones it rests on
 *  top of the fixed TabBar (+ safe area) via --tabbar-h (index.css) — a plain
 *  `bottom-0` parks it UNDER the tab bar, where taps land on the nav instead
 *  (UI-001). On lg: the tab bar is hidden and the offset is 0.
 *
 *  While mounted it reports its height as --actionbar-h, so the page's
 *  scroll-padding keeps a Tab-focused row from resting fully hidden behind
 *  the bar (QA-012, #305 D1; WCAG 2.4.11). */
export function ActionBar({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      heights.set(el, el.offsetHeight);
      publish();
    };
    measure();
    // The height changes with the error summary / blocked reason inside.
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      heights.delete(el);
      publish();
    };
  }, []);
  return (
    <div
      ref={ref}
      className={`sticky bottom-[var(--tabbar-h)] z-20 bg-gradient-to-t from-bg via-bg/95 to-transparent px-4 pb-3.5 pt-3 ${className}`}
    >
      {children}
    </div>
  );
}
