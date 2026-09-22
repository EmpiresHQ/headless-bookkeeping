import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import {
  UnsavedChangesProvider,
  useConfirmLeave,
  useRouteDiscardEpoch,
} from '../lib/unsavedChanges';
import { useInboxCount } from '../queries/inbox';
import { SkeletonRows } from '../ui/Feedback';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

/** Screens reach shell affordances through Outlet context (react-router).
 *  Today that is only sign-out (Settings hub row — the sidebar is lg:-only,
 *  so phones had NO sign-out until Plan 06). */
export interface ShellOutletContext {
  onSignOut: () => void;
}

/** The unsaved-changes guard lives with the authenticated shell: explicit
 *  sign-out asks before dropping a dirty form, while a forced 401 (Root's
 *  onUnauthorized, called directly by the query client) unmounts this whole
 *  tree — every draft and the guard itself — without asking. */
export function AppLayout({ onSignOut }: { onSignOut: () => void }) {
  return (
    <UnsavedChangesProvider>
      <Shell onSignOut={onSignOut} />
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
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Sidebar onSignOut={onSignOut} inboxCount={inboxCount} />
      <div className="pb-[calc(var(--tabbar-h)+2.5rem)] lg:pb-6 lg:pl-56">
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
      </div>
      <TabBar inboxCount={inboxCount} />
    </div>
  );
}
