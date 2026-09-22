import { useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Keep-mounted sheet state (Plan 07 Task 7). The sheet element stays in the
 * tree so Radix/vaul run their graceful close lifecycle — exit animation,
 * aria-hidden lifted, THEN focus restoration. The old `{flag && <Sheet
 * open/>}` unmount-to-close pattern raced these and logged "Blocked
 * aria-hidden on an element because its descendant retained focus"
 * (ui/Sheet.tsx residual-gap note — closed by this migration).
 *
 * State reset happens by REMOUNT-ON-OPEN instead of unmount-on-close:
 * `epoch` bumps on every open(); key the sheet element with it (plus the
 * payload's id where the sheet is object-bound) and internal state can
 * never leak across open/close/reopen or across objects — the P03 T13
 * discipline, preserved. `payload` is RETAINED after close() so the exit
 * animation renders the same object it opened with.
 *
 * A sheet belongs to the route it was opened on (issue #250): when the
 * pathname changes under a screen that stays mounted — Back/forward or a
 * move to another object id on the same screen, after the unsaved-changes
 * guard allowed it — the sheet closes instead of reappearing over the next
 * object (its epoch/id key already guarantees fresh state on reopen).
 */
export function useSheet<T = undefined>() {
  const { pathname } = useLocation();
  const [s, setS] = useState<{
    isOpen: boolean;
    epoch: number;
    payload: T | null;
    pathname: string;
  }>({ isOpen: false, epoch: 0, payload: null, pathname });
  if (s.isOpen && s.pathname !== pathname) {
    // Adjust-state-during-render (React docs pattern): no stale open frame.
    setS({ ...s, isOpen: false });
  }
  return {
    isOpen: s.isOpen,
    epoch: s.epoch,
    payload: s.payload,
    open: (payload?: T) =>
      setS((prev) => ({
        isOpen: true,
        epoch: prev.epoch + 1,
        payload: (payload ?? null) as T | null,
        pathname,
      })),
    close: () =>
      setS((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev)),
  };
}
