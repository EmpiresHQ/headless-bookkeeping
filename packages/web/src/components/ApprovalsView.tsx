import { useEffect, useState } from 'react';
import {
  getPendingApprovals,
  approveApproval,
  rejectApproval,
  type Approval,
} from '../api';
import { Table, type Column } from './Table';

const objectLabel = (a: Approval): string => {
  switch (a.object_type) {
    case 'reconciliation_match':
      return `Bank match #${a.object_id}`;
    case 'sales_invoice':
      return `Invoice #${a.object_id}`;
    case 'expense':
      return `Expense #${a.object_id}`;
    default:
      return `${a.object_type} #${a.object_id}`;
  }
};

const columns: Column<Approval>[] = [
  { header: 'ID', cell: (a) => a.id },
  { header: 'Object', cell: (a) => objectLabel(a) },
  { header: 'Requested by', cell: (a) => a.requested_by },
  { header: 'Reason', cell: (a) => a.policy_reason ?? '—' },
];

export function ApprovalsView() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    getPendingApprovals()
      .then(setApprovals)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onApprove = (id: number) => {
    const who = window.prompt('Approve as (name):', 'operator');
    if (!who) return;
    void run(() => approveApproval(id, who));
  };

  const onReject = (id: number) => {
    const reason = window.prompt('Reject reason:');
    if (!reason) return;
    void run(() => rejectApproval(id, reason));
  };

  return (
    <div className="p-4 space-y-3">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {approvals.length === 0 ? (
        <p className="text-sm text-gray-500">No pending approvals.</p>
      ) : (
        <Table
          columns={columns}
          rows={approvals}
          actions={(a) => (
            <div className="space-x-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => onApprove(a.id)}
                className="text-green-700 hover:underline disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onReject(a.id)}
                className="text-red-600 hover:underline disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          )}
        />
      )}
    </div>
  );
}
