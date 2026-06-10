import { useEffect, useState } from 'react';
import { getToken, clearToken } from './auth';
import { TokenGate } from './components/TokenGate';
import { Table } from './components/Table';
import { TABS } from './tabs';

export function App() {
  const [hasToken, setHasToken] = useState(getToken() !== null);
  const [active, setActive] = useState(TABS[0].key);
  const [rows, setRows] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tab = TABS.find((t) => t.key === active)!;

  // Load the active tab's data. The `cancelled` flag discards a stale response
  // from a previously-active tab so a slow fetch can't overwrite the rows of
  // the tab the user has since switched to.
  useEffect(() => {
    if (!hasToken) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await tab.load();
        if (!cancelled) setRows(data);
      } catch (e) {
        // apiFetch clears the token on 401; reflect that in the gate. This runs
        // even for a cancelled (stale-tab) effect so a 401 redirects to the gate
        // immediately, without waiting for the new tab's request to 401 too.
        if (getToken() === null) {
          setHasToken(false);
          return;
        }
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [hasToken, tab]);

  if (!hasToken) return <TokenGate onSaved={() => setHasToken(true)} />;

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b px-4 py-3 flex items-center gap-4">
        <h1 className="font-semibold">books</h1>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              aria-current={t.key === active ? 'page' : undefined}
              className={`px-3 py-1 rounded text-sm ${
                t.key === active ? 'bg-black text-white' : 'hover:bg-gray-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button
          onClick={() => {
            clearToken();
            setHasToken(false);
          }}
          className="ml-auto text-sm text-gray-500 hover:text-black"
        >
          Sign out
        </button>
      </header>

      <main className="p-4">
        <div className="bg-white rounded shadow">
          {loading && <p className="p-4 text-gray-500">Loading…</p>}
          {error && <p className="p-4 text-red-600">{error}</p>}
          {!loading && !error && <Table columns={tab.columns} rows={rows} />}
        </div>
      </main>
    </div>
  );
}
