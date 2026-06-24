import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { getToken, clearToken } from './auth';
import { TokenGate } from './components/TokenGate';
import { Table } from './components/Table';
import { TABS, type TabDef } from './tabs';

/**
 * A non-Custom tab page: loads the tab's rows, renders the generic Table, and
 * wires the optional per-row delete. Extracted from App so each route owns its
 * own load/loading/error state instead of one shared block keyed on the active
 * tab (the pre-router design). `onUnauthorized` lets a 401 drop back to the
 * token gate (apiFetch clears the token on 401).
 */
function TabPage({
  tab,
  onUnauthorized,
}: {
  tab: TabDef;
  onUnauthorized: () => void;
}) {
  const [rows, setRows] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped after a successful delete to re-run the tab's load.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await tab.load();
        if (!cancelled) setRows(data);
      } catch (e) {
        if (getToken() === null) {
          onUnauthorized();
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
  }, [tab, reloadKey, onUnauthorized]);

  const onDelete = async (row: unknown) => {
    if (!tab.remove) return;
    const id = tab.rowId ? tab.rowId(row) : undefined;
    if (!window.confirm(`Delete #${id ?? ''}? This cannot be undone.`)) return;
    try {
      await tab.remove(row);
      // Drop the now-stale rows immediately so the just-deleted row can't be
      // clicked again before the refetch lands.
      setRows([]);
      setReloadKey((k) => k + 1);
    } catch (e) {
      if (getToken() === null) {
        onUnauthorized();
        return;
      }
      window.alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
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
                    type="button"
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
  );
}

export function App() {
  const [hasToken, setHasToken] = useState(getToken() !== null);
  const onUnauthorized = useCallback(() => setHasToken(false), []);

  if (!hasToken) return <TokenGate onSaved={() => setHasToken(true)} />;

  const defaultPath = `/${TABS[0].key}`;

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b">
        <div className="px-4 py-3 flex items-center justify-between gap-4">
          <h1 className="font-semibold">books</h1>
          <button
            onClick={() => {
              clearToken();
              setHasToken(false);
            }}
            className="text-sm text-gray-500 hover:text-black"
          >
            Sign out
          </button>
        </div>
        <nav className="flex gap-1 px-2 pb-2 overflow-x-auto">
          {TABS.map((t) => (
            <NavLink
              key={t.key}
              to={`/${t.key}`}
              className={({ isActive }) =>
                `px-3 py-1 rounded text-sm whitespace-nowrap ${
                  isActive ? 'bg-black text-white' : 'hover:bg-gray-100'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="p-4">
        <div className="bg-white rounded shadow">
          <Routes>
            <Route path="/" element={<Navigate to={defaultPath} replace />} />
            {TABS.map((t) => {
              const Custom = t.Custom;
              return (
                <Route
                  key={t.key}
                  path={`/${t.key}`}
                  element={
                    Custom ? (
                      <Custom />
                    ) : (
                      <TabPage tab={t} onUnauthorized={onUnauthorized} />
                    )
                  }
                />
              );
            })}
            {/* Unknown path → land on the first tab rather than a blank screen. */}
            <Route path="*" element={<Navigate to={defaultPath} replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
