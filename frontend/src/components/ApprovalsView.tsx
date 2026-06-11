import { useEffect, useState } from 'react';
import {
  getPendingApprovals,
  approveApproval,
  rejectApproval,
  type Approval,
} from '../api';

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

  const objectLabel = (a: Approval) => {
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
        <div className="overflow-x-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2 font-medium text-gray-700">ID</th>
              <th className="px-3 py-2 font-medium text-gray-700">Object</th>
              <th className="px-3 py-2 font-medium text-gray-700">Requested by</th>
              <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id} className="border-b">
                <td className="px-3 py-2">{a.id}</td>
                <td className="px-3 py-2">{objectLabel(a)}</td>
                <td className="px-3 py-2">{a.requested_by}</td>
                <td className="px-3 py-2 space-x-2">
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
