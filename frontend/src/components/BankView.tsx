import { useEffect, useRef, useState } from 'react';
import {
  importBankStatement,
  getBankImportStatus,
  type BankImportJob,
} from '../api';

const POLL_INTERVAL_MS = 1500;

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

  const stopPolling = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Stop polling and block late state updates when the component unmounts.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
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
    <div className="p-4 space-y-4">
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
    </div>
  );
}
