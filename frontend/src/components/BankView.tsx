import { useEffect, useRef, useState } from 'react';
import {
  importBankStatement,
  getBankImportStatus,
  listBankStatements,
  listBankTransactions,
  deleteBankStatement,
  proposeMatches,
  getReconciliationStatus,
  executeMatches,
  createPrepayment,
  markPersonal,
  fmtCents,
  type BankImportJob,
  type BankStatement,
  type BankTransaction,
  type MatchProposalView,
  type ReconciliationStatusRow,
} from '../api';
import { Table, type Column } from './Table';

/** Proposal selection key — voucherId is an internal key only, NEVER displayed. */
const proposalKey = (p: MatchProposalView): string =>
  `${p.bankTransactionId}:${p.voucherId}`;

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

  // Reconciliation: per-txn status (badges + over-allocation cap), proposed
  // matches grouped by bank txn, and the set of selected proposal keys.
  const [recon, setRecon] = useState<ReconciliationStatusRow[]>([]);
  const [proposals, setProposals] = useState<MatchProposalView[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Inline, transient note for a blocked selection (over-allocation cap).
  const [capNote, setCapNote] = useState<string | null>(null);

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

  const onDelete = async (id: number) => {
    if (!window.confirm(`Delete statement #${id} and its transactions?`))
      return;
    try {
      await deleteBankStatement(id);
      if (!mountedRef.current) return;
      if (selected === id) {
        setSelected(null);
        setTxns([]);
      }
      await loadStatements();
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadRecon = async (id: number) => {
    try {
      const rows = await getReconciliationStatus(id);
      if (!mountedRef.current) return;
      setRecon(rows);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const viewTransactions = async (id: number) => {
    setSelected(id);
    setTxns([]);
    setProposals([]);
    setSelectedKeys(new Set());
    setCapNote(null);
    try {
      const list = await listBankTransactions(id);
      if (!mountedRef.current) return;
      setTxns(list);
      void loadRecon(id);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const reconFor = (txnId: number): ReconciliationStatusRow | undefined =>
    recon.find((r) => r.bankTransactionId === txnId);

  const onPropose = async () => {
    if (selected === null) return;
    setError(null);
    setCapNote(null);
    try {
      const list = await proposeMatches(selected);
      if (!mountedRef.current) return;
      setProposals(list);
      setSelectedKeys(new Set());
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Toggle a proposal's selection. Turning one ON must not push the selected
  // total for its bank line past that line's `remaining` (from the status read)
  // — block it with an inline note instead (server enforces the same guard).
  const toggleProposal = (p: MatchProposalView) => {
    const key = proposalKey(p);
    setCapNote(null);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      const remaining = reconFor(p.bankTransactionId)?.remaining ?? 0;
      const selectedForTxn = proposals
        .filter(
          (q) =>
            q.bankTransactionId === p.bankTransactionId &&
            next.has(proposalKey(q)),
        )
        .reduce((sum, q) => sum + q.amountMatched, 0);
      if (selectedForTxn + p.amountMatched > remaining) {
        setCapNote(
          `Selecting this match would over-allocate bank line ` +
            `#${p.bankTransactionId}: only ${fmtCents(remaining)} remains.`,
        );
        return prev;
      }
      next.add(key);
      return next;
    });
  };

  const onBook = async () => {
    if (selected === null) return;
    const chosen = proposals.filter((p) => selectedKeys.has(proposalKey(p)));
    if (chosen.length === 0) return;
    setError(null);
    setCapNote(null);
    try {
      await executeMatches(selected, chosen);
      if (!mountedRef.current) return;
      setProposals([]);
      setSelectedKeys(new Set());
      await loadRecon(selected);
      await viewTransactions(selected);
    } catch (e) {
      if (!mountedRef.current) return;
      // The server may reject with a ConflictException over-allocation message.
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onPrepayment = async (txnId: number) => {
    if (selected === null) return;
    if (!window.confirm(`Book bank line #${txnId} as a prepayment?`)) return;
    setError(null);
    try {
      await createPrepayment(txnId);
      if (!mountedRef.current) return;
      await loadRecon(selected);
      await viewTransactions(selected);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onPersonal = async (txnId: number) => {
    if (selected === null) return;
    if (!window.confirm(`Mark bank line #${txnId} as personal (out of scope)?`))
      return;
    setError(null);
    try {
      await markPersonal(txnId);
      if (!mountedRef.current) return;
      await loadRecon(selected);
      await viewTransactions(selected);
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

  const statementColumns: Column<BankStatement>[] = [
    { header: 'ID', cell: (s) => s.id },
    { header: 'Period', cell: (s) => `${s.start_date} → ${s.end_date}` },
    { header: 'Uploaded', cell: (s) => fmtDate(s.uploaded_at) },
  ];

  const transactionColumns: Column<BankTransaction>[] = [
    { header: 'Date', cell: (t) => <span className="whitespace-nowrap">{t.transaction_date}</span> },
    {
      header: 'Amount',
      cell: (t) => (
        <div className={`text-right sm:text-left tabular-nums ${t.amount < 0 ? 'text-red-600' : 'text-green-700'}`}>
          {fmtCents(t.amount)}
        </div>
      ),
    },
    { header: 'Cur', cell: (t) => t.currency },
    {
      header: 'Description',
      cell: (t) => {
        const status = reconFor(t.id);
        const txnProposals = proposals.filter((p) => p.bankTransactionId === t.id);
        const isOpen = status?.reconStatus === 'open';
        return (
          <div>
            <div>{t.description ?? '—'}</div>
            {txnProposals.length > 0 && (
              <ul className="mt-1 space-y-1">
                {txnProposals.map((p) => (
                  <li key={proposalKey(p)} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`Select match ${p.objectLabel}`}
                      checked={selectedKeys.has(proposalKey(p))}
                      onChange={() => toggleProposal(p)}
                    />
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        p.confidence === 'high'
                          ? 'bg-green-100 text-green-800'
                          : p.confidence === 'medium'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {p.confidence}
                    </span>
                    <span className="font-medium">{p.objectLabel}</span>
                    <span className="text-gray-600">{p.counterpartyName ?? '—'}</span>
                    <span className="tabular-nums">{fmtCents(p.amountMatched)}</span>
                  </li>
                ))}
              </ul>
            )}
            {isOpen && (
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  onClick={() => void onPrepayment(t.id)}
                  className="text-blue-600 hover:underline text-xs"
                >
                  Prepayment
                </button>
                <button
                  type="button"
                  disabled={t.amount > 0}
                  onClick={() => void onPersonal(t.id)}
                  className="text-blue-600 hover:underline text-xs disabled:opacity-50 disabled:no-underline disabled:text-gray-400"
                >
                  Personal
                </button>
              </div>
            )}
          </div>
        );
      },
    },
    { header: 'Counterparty', cell: (t) => t.counterparty_iban ?? t.counterparty_descriptor ?? '—' },
    { header: 'Ref', cell: (t) => t.reference ?? '—' },
    { header: 'Status', cell: (t) => t.status },
    {
      header: 'Match',
      cell: (t) => {
        const status = reconFor(t.id);
        return (
          <div className="whitespace-nowrap">
            {status === undefined ? (
              <span className="text-gray-400">—</span>
            ) : status.reconStatus === 'matched' ? (
              <span className="rounded px-1.5 py-0.5 bg-green-100 text-green-800 text-xs">
                Matched
              </span>
            ) : status.reconStatus === 'partial' ? (
              <span className="rounded px-1.5 py-0.5 bg-amber-100 text-amber-800 text-xs">
                {fmtCents(status.remaining)} left
              </span>
            ) : (
              <span className="rounded px-1.5 py-0.5 bg-gray-100 text-gray-700 text-xs">
                Open
              </span>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="p-4 space-y-6">
      <div className="flex flex-wrap items-center gap-2">
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
          <Table
            columns={statementColumns}
            rows={statements}
            actions={(s) => (
              <div className="space-x-3 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => void viewTransactions(s.id)}
                  className="text-blue-600 hover:underline"
                >
                  View
                </button>
                <button
                  type="button"
                  onClick={() => void onDelete(s.id)}
                  className="text-red-600 hover:underline"
                >
                  Delete
                </button>
              </div>
            )}
          />
        )}
      </section>

      {selected !== null && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-gray-700">
            Transactions — statement #{selected}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onPropose()}
              className="bg-black text-white rounded px-3 py-1 text-sm"
            >
              Propose matches
            </button>
            <button
              type="button"
              disabled={selectedKeys.size === 0}
              onClick={() => void onBook()}
              className="border rounded px-3 py-1 text-sm disabled:opacity-50"
            >
              Book selected ({selectedKeys.size})
            </button>
          </div>
          {capNote && <p className="text-sm text-amber-700">{capNote}</p>}
          {txns.length === 0 ? (
            <p className="text-sm text-gray-500">No transactions.</p>
          ) : (
            <Table columns={transactionColumns} rows={txns} />
          )}
        </section>
      )}
    </div>
  );
}
