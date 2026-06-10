import { useEffect, useState, useCallback } from 'react';
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await tab.load());
    } catch (e) {
      // apiFetch clears the token on 401; reflect that in the gate.
      if (getToken() === null) {
        setHasToken(false);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    if (hasToken) void load();
  }, [hasToken, load]);

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
          {!loading && !error && (
            <Table columns={tab.columns} rows={rows} />
          )}
        </div>
      </main>
    </div>
  );
}
