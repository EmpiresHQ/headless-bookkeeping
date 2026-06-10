import { useEffect, useRef, useState } from 'react';
import {
  importBankStatement,
  getBankImportStatus,
  listBankStatements,
  listBankTransactions,
  fmtCents,
  type BankImportJob,
  type BankStatement,
  type BankTransaction,
} from '../api';

const POLL_INTERVAL_MS = 1500;

const fmtDate = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export function BankView() {
  const [job, setJob] = useState<BankImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [accountCode, setAccountCode] = useState('BANK_EUR');
  // Holds the active poll timer so we can clear it on unmount / when polling stops.
  const timerRef = useRef<number | null>(null);
  // Guards against state updates from an in-flight poll resolving after unmount.
  const mountedRef = useRef(true);

  // Statements list + the selected statement's transactions.
  const [statements, setStatements] = useState<BankStatement[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [txns, setTxns] = useState<BankTransaction[]>([]);

  const stopPolling = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const loadStatements = async () => {
    try {
      const list = await listBankStatements();
      if (!mountedRef.current) return;
      setStatements(list);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const viewTransactions = async (id: number) => {
    setSelected(id);
    setTxns([]);
    try {
      const list = await listBankTransactions(id);
      if (!mountedRef.current) return;
      setTxns(list);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Stop polling and block late state updates when the component unmounts.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, []);

  // Load the existing statements once on mount.
  useEffect(() => {
    void loadStatements();
  }, []);

  // Fetches the job once. Returns true while the job is still running, false
  // once it reaches a terminal status (done/failed) or on error — in which case
  // it also stops polling and clears the busy flag.
  const poll = async (jobId: number): Promise<boolean> => {
    try {
      const j = await getBankImportStatus(jobId);
      if (!mountedRef.current) return false;
      setJob(j);
      if (j.status === 'running') return true;
      stopPolling();
      setBusy(false);
      // A finished import adds a statement — refresh the list.
      if (j.status === 'done') void loadStatements();
      return false;
    } catch (e) {
      stopPolling();
      if (!mountedRef.current) return false;
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const onImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    stopPolling();
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const { jobId } = await importBankStatement(file, accountCode);
      if (!mountedRef.current) return;
      // Poll once immediately (snappier UX; also lets the test resolve a
      // first-call `done` without fake timers). Only arm the interval if the
      // job is still running after that first poll.
      const stillRunning = await poll(jobId);
      if (stillRunning) {
        timerRef.current = window.setInterval(
          () => void poll(jobId),
          POLL_INTERVAL_MS,
        );
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="p-4 space-y-6">
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          aria-label="Bank statement CSV"
          className="text-sm"
        />
        <input
          type="text"
          aria-label="Account code"
          value={accountCode}
          onChange={(e) => setAccountCode(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void onImport()}
          className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-50"
        >
          Import
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {job && (
        <div className="text-sm">
          {job.status === 'running' && (
            <span className="text-gray-600">Import running…</span>
          )}
          {job.status === 'done' && (
            <span className="text-green-700">
              Created statement #{job.statement_id}
            </span>
          )}
          {job.status === 'failed' && (
            <span className="text-red-600">{job.error}</span>
          )}
          {job.status !== 'running' &&
            job.status !== 'done' &&
            job.status !== 'failed' && (
              <span className="text-gray-600">Status: {job.status}</span>
            )}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-gray-700">Statements</h2>
        {statements.length === 0 ? (
          <p className="text-sm text-gray-500">No statements yet.</p>
        ) : (
          <table className="min-w-full text-sm border-collapse">
            <thead>
              <tr className="border-b bg-gray-50 text-left">
                <th className="px-3 py-2 font-medium text-gray-700">ID</th>
                <th className="px-3 py-2 font-medium text-gray-700">Period</th>
                <th className="px-3 py-2 font-medium text-gray-700">Uploaded</th>
                <th className="px-3 py-2 font-medium text-gray-700"></th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.id} className="border-b">
                  <td className="px-3 py-2">{s.id}</td>
                  <td className="px-3 py-2">
                    {s.start_date} → {s.end_date}
                  </td>
                  <td className="px-3 py-2">{fmtDate(s.uploaded_at)}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => void viewTransactions(s.id)}
                      className="text-blue-600 hover:underline"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected !== null && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-gray-700">
            Transactions — statement #{selected}
          </h2>
          {txns.length === 0 ? (
            <p className="text-sm text-gray-500">No transactions.</p>
          ) : (
            <table className="min-w-full text-sm border-collapse">
              <thead>
                <tr className="border-b bg-gray-50 text-left">
                  <th className="px-3 py-2 font-medium text-gray-700">Date</th>
                  <th className="px-3 py-2 font-medium text-gray-700 text-right">
                    Amount
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-700">Cur</th>
                  <th className="px-3 py-2 font-medium text-gray-700">
                    Description
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-700">
                    Counterparty
                  </th>
                  <th className="px-3 py-2 font-medium text-gray-700">Ref</th>
                  <th className="px-3 py-2 font-medium text-gray-700">Status</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} className="border-b align-top">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {t.transaction_date}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        t.amount < 0 ? 'text-red-600' : 'text-green-700'
                      }`}
                    >
                      {fmtCents(t.amount)}
                    </td>
                    <td className="px-3 py-2">{t.currency}</td>
                    <td className="px-3 py-2">{t.description ?? '—'}</td>
                    <td className="px-3 py-2">
                      {t.counterparty_iban ??
                        t.counterparty_descriptor ??
                        '—'}
                    </td>
                    <td className="px-3 py-2">{t.reference ?? '—'}</td>
                    <td className="px-3 py-2">{t.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
