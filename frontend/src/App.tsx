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
  // Bumped after a successful delete to re-run the active tab's load.
  const [reloadKey, setReloadKey] = useState(0);

  const tab = TABS.find((t) => t.key === active)!;

  // Load the active tab's data (skipped for Custom tabs, which fetch their own).
  // The `cancelled` flag discards a stale response from a previously-active tab.
  useEffect(() => {
    if (!hasToken || tab.Custom) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await tab.load();
        if (!cancelled) setRows(data);
      } catch (e) {
        // apiFetch clears the token on 401; reflect that in the gate even for a
        // cancelled effect so a 401 redirects immediately.
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
  }, [hasToken, tab, reloadKey]);

  const onDelete = async (row: unknown) => {
    if (!tab.remove) return;
    const id = tab.rowId ? tab.rowId(row) : undefined;
    if (!window.confirm(`Delete #${id ?? ''}? This cannot be undone.`)) return;
    try {
      await tab.remove(row);
      setReloadKey((k) => k + 1);
    } catch (e) {
      if (getToken() === null) {
        setHasToken(false);
        return;
      }
      window.alert(e instanceof Error ? e.message : String(e));
    }
  };

  if (!hasToken) return <TokenGate onSaved={() => setHasToken(true)} />;

  const Custom = tab.Custom;

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
          {Custom ? (
            <Custom />
          ) : (
            <>
              {loading && <p className="p-4 text-gray-500">Loading…</p>}
              {error && <p className="p-4 text-red-600">{error}</p>}
              {!loading && !error && (
                <Table
                  columns={tab.columns}
                  rows={rows}
                  actions={
                    tab.remove
                      ? (row) => (
                          <button
                            onClick={() => void onDelete(row)}
                            className="text-red-600 text-sm hover:underline"
                          >
                            Delete
                          </button>
                        )
                      : undefined
                  }
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
