import type { ReactNode } from 'react';
import { useOriginState } from '../lib/returnNavigation';
import { pendingApprovalFor, usePendingApprovals } from '../queries/inbox';
import { checkError, checkState } from '../reports/checkStatus';
import { Button } from '../ui/Button';
import { LinkButton } from '../ui/LinkButton';
import { LoadError } from '../ui/LoadError';

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-center text-[12.5px] text-ink-2">
      {children}
    </p>
  );
}

/**
 * A pending Books record → ITS OWN approval (issue #262), opened as a single
 * item whose origin is this record (#252/#253): a decision returns here, with
 * this entry's own state (e.g. a period origin, #261) intact.
 *
 * The join is the exact typed pair over the pending list, re-checked by this
 * observer on every mount (`staleTime: 0`: mounting after draft→pending over
 * a fresh shared cache must still fetch, #261). Absence is only stated from
 * that fresh result, and even then only as "not pending" — never as approved
 * or posted.
 */
export function PendingApproval({
  objectType,
  objectId,
  noun,
  onReload,
}: {
  objectType: 'expense' | 'sales_invoice';
  objectId: number;
  /** "expense" / "invoice" for the copy. */
  noun: string;
  /** Re-read the record itself (its status may have moved on). */
  onReload: () => void;
}) {
  const approvalsQ = usePendingApprovals({
    refetchOnMount: 'always',
    staleTime: 0,
  });
  const originState = useOriginState();
  const state = checkState([approvalsQ], true);
  const message = checkError([approvalsQ]);
  const approval =
    approvalsQ.data !== undefined
      ? pendingApprovalFor(
          { object_type: objectType, object_id: objectId },
          approvalsQ.data,
        )
      : null;
  const open = (a: { id: number }) => (
    <LinkButton
      to={`/inbox/approval/${a.id}`}
      state={originState}
      className="w-full"
    >
      Open approval #{a.id}
    </LinkButton>
  );

  if (state === 'checking') {
    return <Note>Waiting for approval — finding its approval…</Note>;
  }
  if (state === 'unavailable') {
    return (
      <>
        <Note>Waiting for approval.</Note>
        <LoadError
          message={`Couldn't find its approval${message !== null ? ` — ${message}` : ''}`}
          onRetry={() => void approvalsQ.refetch()}
        />
      </>
    );
  }
  if (state === 'stale') {
    return (
      <>
        <div className="rounded-2xl bg-warn-bg px-4 py-3">
          <p className="text-[13px] text-warn">
            Couldn't refresh approvals
            {message !== null ? ` — ${message}` : ''}.{' '}
            {approval !== null
              ? `Approval #${approval.id} is from the last loaded list.`
              : `No pending approval for this ${noun} in the last loaded list — not confirmed current.`}
          </p>
          <Button
            variant="secondary"
            className="mt-2"
            onClick={() => void approvalsQ.refetch()}
          >
            Retry
          </Button>
        </div>
        {approval !== null && open(approval)}
      </>
    );
  }
  if (approval === null) {
    return (
      <>
        <Note>
          No pending approval found for this {noun} right now — it may just have
          been decided or withdrawn. Reload for its current status.
        </Note>
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => {
            onReload();
            void approvalsQ.refetch();
          }}
        >
          Reload
        </Button>
      </>
    );
  }
  return (
    <>
      <Note>Waiting for approval #{approval.id} — decide it there.</Note>
      {open(approval)}
    </>
  );
}
