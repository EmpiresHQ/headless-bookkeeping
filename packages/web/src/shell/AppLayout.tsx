import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import type { UnauthorizedError } from '../auth';
import {
  UnsavedChangesProvider,
  useConfirmLeave,
  useRouteDiscardEpoch,
} from '../lib/unsavedChanges';
import { ResultLogProvider } from '../lib/resultLog';
import { useInboxCount } from '../queries/inbox';
import { SkeletonRows } from '../ui/Feedback';
import { RecentResults } from './RecentResults';
import { ScreenBoundary } from './ScreenFailure';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

/** Screens reach shell affordances through Outlet context (react-router).
 *  Today that is only sign-out (Settings hub row — the sidebar is lg:-only,
 *  so phones had NO sign-out until Plan 06). */
export interface ShellOutletContext {
  onSignOut: () => void;
}

/** The unsaved-changes guard lives with the authenticated shell: explicit
 *  sign-out asks before dropping a dirty form (and is refused while an
 *  operation is in flight), while a forced 401 (Root's onUnauthorized,
 *  called by the query client or an operation) unmounts this whole tree —
 *  every draft, every pending operation's continuation and the guard
 *  itself — without asking. */
export function AppLayout({
  onSignOut,
  onUnauthorized,
}: {
  onSignOut: () => void;
  onUnauthorized: (error: UnauthorizedError) => void;
}) {
  return (
    <UnsavedChangesProvider onUnauthorized={onUnauthorized}>
      <ResultLogProvider>
        <Shell onSignOut={onSignOut} />
      </ResultLogProvider>
    </UnsavedChangesProvider>
  );
}

function Shell({ onSignOut: signOutNow }: { onSignOut: () => void }) {
  const confirmLeave = useConfirmLeave();
  // A confirmed route discard remounts the routed screen from its baseline
  // (lib/unsavedChanges RouteLeaveGuard) — the shell itself stays mounted.
  const discardEpoch = useRouteDiscardEpoch();
  const onSignOut = () => confirmLeave(signOutNow);
  // Live decision-queue badge. NO polling here — the hook shares the Inbox
  // queue's cache keys and refreshes via staleTime/focus + Inbox refetches.
  const inboxCount = useInboxCount();
  const { key: locationKey } = useLocation();
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Sidebar onSignOut={onSignOut} inboxCount={inboxCount} />
      {/* The one main landmark (#378): screens render inside it and never
          add their own. */}
      <main className="pb-[calc(var(--tabbar-h)+2.5rem)] lg:pb-6 lg:pl-56">
        {/* Recorded operation results (#259) — outside the Outlet, so a
            route change or a route discard never drops them. */}
        <RecentResults />
        {/* A screen that fails to load or render (#292) fails in place:
            the shell, its guards and the results above stay. */}
        <ScreenBoundary resetKey={locationKey}>
          <Suspense
            fallback={
              <div className="mx-auto max-w-3xl pt-6">
                <SkeletonRows count={4} />
              </div>
            }
          >
            <Outlet
              key={discardEpoch}
              context={{ onSignOut } satisfies ShellOutletContext}
            />
          </Suspense>
        </ScreenBoundary>
      </main>
      <TabBar inboxCount={inboxCount} />
    </div>
  );
}
