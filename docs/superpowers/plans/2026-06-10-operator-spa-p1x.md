# Operator SPA — Phase 1.x (delete actions + KMD view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the operator SPA's deferred P1 pieces, now unblocked on `main`: row-level **delete** of probe garbage (draft expenses/invoices, unreferenced entities) and a **KMD declaration view** (period → VAT-return rows + VD 3S + review flags).

**Architecture:** Extends the existing `frontend/` SPA. Deletes go through the now-merged `DELETE /api/{expenses,sales-invoices,entities}/:id` endpoints (return the deleted object; **409** on non-draft/referenced). The KMD view consumes the merged `GET /api/reporting-periods/:id/kmd` (returns a `KmdDeclaration`). Generic tabs gain an optional per-row action; one tab (`kmd`) renders a custom component instead of the table.

**Tech Stack:** React 18 + TS + Tailwind + Vitest (existing `frontend/`).

---

## Endpoint contract (already on `main`)

| Action | Request | Response |
|---|---|---|
| Delete draft expense | `DELETE /api/expenses/:id` | `Expense` (200); **409** if not `draft` |
| Delete draft invoice | `DELETE /api/sales-invoices/:id` | `SalesInvoice` (200); **409** if not `draft` |
| Delete entity | `DELETE /api/entities/:id` | `Entity` (200); **409** if referenced |
| KMD declaration | `GET /api/reporting-periods/:id/kmd` | `KmdDeclaration` |

`KmdDeclaration` = `{ reporting_period_id, period_name, start_date, end_date, row1_base_24, row2_base_reduced, row3_base_zero, row4_output_vat, row5_input_vat, row6_intra_eu_acquisition, row7_other_acquisition, net_vat_due, vd_intra_eu_services, review_flags: string[] }`. All amount fields are integer **cents**.

`apiFetch` already throws on non-OK with `"<status> <statusText>: <body>"`, so a 409 surfaces as a catchable Error whose message carries the server's explanation.

## File Structure
- Modify `frontend/src/api.ts` — delete helpers; `KmdDeclaration` + `getKmd`.
- Create `frontend/src/api.test.ts` — vitest: delete helper issues a `DELETE`.
- Modify `frontend/src/components/Table.tsx` — optional `actions` trailing column.
- Create `frontend/src/components/Table.test.tsx` — vitest: actions cell renders.
- Modify `frontend/src/tabs.tsx` — `TabDef` gains `remove?`, `rowId?`, `Custom?`; set `remove`/`rowId` on expenses/invoices/entities; add `kmdTab`.
- Create `frontend/src/components/KmdView.tsx` — period picker + declaration render.
- Create `frontend/src/components/KmdView.test.tsx` — vitest: renders rows + flags from a mock.
- Modify `frontend/src/App.tsx` — reload-on-delete; render row delete buttons; render `Custom` tabs.

---

### Task 1: api.ts — delete helpers + KMD type/getter (TDD for the DELETE method)

**Files:** Modify `frontend/src/api.ts`; Create `frontend/src/api.test.ts`.

- [ ] **Step 1: Write the failing test** — create `frontend/src/api.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import { deleteExpense, getKmd } from './api';

describe('api delete + kmd', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('deleteExpense issues a DELETE to the expense path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"id":7}', { status: 200 }));
    await deleteExpense(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/expenses/7');
    expect(init?.method).toBe('DELETE');
  });

  it('getKmd fetches the period KMD declaration', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"reporting_period_id":3,"review_flags":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const d = await getKmd(3);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/reporting-periods/3/kmd');
    expect(d.reporting_period_id).toBe(3);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (no `deleteExpense`/`getKmd` exports yet)

Run: `cd frontend && npx vitest run src/api.test.ts`
Expected: FAIL — import error.

- [ ] **Step 3: Add to `frontend/src/api.ts`.** Append these AFTER the existing `fmtCents` export:
```ts
// ── KMD declaration (GET /api/reporting-periods/:id/kmd) ──────────────────
export interface KmdDeclaration {
  reporting_period_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  row1_base_24: number;
  row2_base_reduced: number;
  row3_base_zero: number;
  row4_output_vat: number;
  row5_input_vat: number;
  row6_intra_eu_acquisition: number;
  row7_other_acquisition: number;
  net_vat_due: number;
  vd_intra_eu_services: number;
  review_flags: string[];
}

export const getKmd = (periodId: number) =>
  apiFetch<KmdDeclaration>(`/api/reporting-periods/${periodId}/kmd`);

// ── Deletes (probe-garbage cleanup) ───────────────────────────────────────
// The endpoints return the deleted object (200) or 409 when the object cannot
// be deleted (a non-draft expense/invoice, or a referenced entity); apiFetch
// turns the 409 into a thrown Error carrying the server's message.
export const deleteExpense = (id: number) =>
  apiFetch<Expense>(`/api/expenses/${id}`, { method: 'DELETE' });
export const deleteInvoice = (id: number) =>
  apiFetch<SalesInvoice>(`/api/sales-invoices/${id}`, { method: 'DELETE' });
export const deleteEntity = (id: number) =>
  apiFetch<Entity>(`/api/entities/${id}`, { method: 'DELETE' });
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd frontend && npx vitest run src/api.test.ts`
Expected: PASS (2 tests). Also `cd frontend && npx tsc -b` → exit 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/api.ts frontend/src/api.test.ts
git commit -m "feat(spa): api delete helpers + KMD declaration getter"
```

---

### Task 2: Table.tsx — optional per-row actions column

**Files:** Modify `frontend/src/components/Table.tsx`; Create `frontend/src/components/Table.test.tsx`.

- [ ] **Step 1: Write the failing test** — create `frontend/src/components/Table.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Table } from './Table';

describe('Table actions column', () => {
  const rows = [{ id: 1, name: 'a' }];
  const columns = [{ header: 'Name', cell: (r: { name: string }) => r.name }];

  it('renders an Actions column header + cell when actions provided', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        actions={(r) => <button>del {r.id}</button>}
      />,
    );
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'del 1' })).toBeInTheDocument();
  });

  it('omits the Actions column when actions not provided', () => {
    render(<Table columns={columns} rows={rows} />);
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`actions` prop not supported)

Run: `cd frontend && npx vitest run src/components/Table.test.tsx`
Expected: FAIL — type error / no Actions column rendered.

- [ ] **Step 3: Replace `frontend/src/components/Table.tsx` with:**
```tsx
import type { ReactNode } from 'react';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

export function Table<T>({
  columns,
  rows,
  actions,
}: {
  columns: Column<T>[];
  rows: T[];
  /** Optional trailing per-row controls (e.g. a delete button). */
  actions?: (row: T) => ReactNode;
}) {
  if (rows.length === 0) {
    return <p className="text-gray-500 p-4">Nothing here yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm border-collapse">
        <thead>
          <tr className="border-b bg-gray-50 text-left">
            {columns.map((c) => (
              <th key={c.header} className="px-3 py-2 font-medium text-gray-700">
                {c.header}
              </th>
            ))}
            {actions && (
              <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b hover:bg-gray-50">
              {columns.map((c) => (
                <td key={c.header} className="px-3 py-2 align-top">
                  {c.cell(row)}
                </td>
              ))}
              {actions && (
                <td className="px-3 py-2 align-top">{actions(row)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd frontend && npx vitest run src/components/Table.test.tsx`
Expected: PASS (2 tests). `cd frontend && npx tsc -b` → exit 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/components/Table.tsx frontend/src/components/Table.test.tsx
git commit -m "feat(spa): Table optional per-row actions column"
```

---

### Task 3: tabs.tsx — TabDef remove/rowId/Custom + wire deletes

**Files:** Modify `frontend/src/tabs.tsx`.

- [ ] **Step 1: Extend the `TabDef` interface.** Replace the existing interface with:
```tsx
import type { ComponentType } from 'react';

export interface TabDef<T = unknown> {
  key: string;
  label: string;
  load: () => Promise<T[]>;
  columns: Column<T>[];
  /** Optional row delete; when set, the tab shows a Delete action per row. */
  remove?: (row: T) => Promise<unknown>;
  /** Row id for the delete confirm prompt (required when `remove` is set). */
  rowId?: (row: T) => number;
  /** When set, the tab renders this component instead of the data table. */
  Custom?: ComponentType;
}
```

- [ ] **Step 2: Import the delete helpers.** Add `deleteEntities`/`deleteExpense`/`deleteInvoice` to the existing import from `./api`. The import block becomes:
```tsx
import {
  Entity,
  Expense,
  SalesInvoice,
  DocumentRow,
  ReportingPeriod,
  Organization,
  fmtCents,
  getEntities,
  getExpenses,
  getInvoices,
  getDocuments,
  getReportingPeriods,
  getOrganization,
  deleteExpense,
  deleteInvoice,
  deleteEntity,
} from './api';
```

- [ ] **Step 3: Add `remove` + `rowId` to the three cleanup tabs.** In `entitiesTab`, after the `columns: [...]`, add:
```tsx
  remove: deleteEntity,
  rowId: (e) => e.id,
```
In `expensesTab`, after its `columns: [...]`, add:
```tsx
  remove: deleteExpense,
  rowId: (e) => e.id,
```
In `invoicesTab`, after its `columns: [...]`, add:
```tsx
  remove: deleteInvoice,
  rowId: (i) => i.id,
```
(Leave `orgTab`, `documentsTab`, `periodsTab` without `remove`.)

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: exit 0. (The KMD tab is added in Task 6, after `KmdView` exists.)

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/tabs.tsx
git commit -m "feat(spa): TabDef remove/rowId/Custom; wire deletes on expenses/invoices/entities"
```

---

### Task 4: App.tsx — reload-on-delete + per-row delete buttons

**Files:** Modify `frontend/src/App.tsx`.

- [ ] **Step 1: Add a reload trigger and the delete-aware Table render.** Replace the ENTIRE `frontend/src/App.tsx` with:
```tsx
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
```

- [ ] **Step 2: Build + existing tests**

Run: `cd frontend && npx tsc -b && npm test && npm run build`
Expected: tsc exit 0; vitest green (auth + api + Table suites); build exit 0.

- [ ] **Step 3: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/App.tsx
git commit -m "feat(spa): per-row delete buttons + reload; render Custom tabs"
```

---

### Task 5: KmdView component

**Files:** Create `frontend/src/components/KmdView.tsx`; Create `frontend/src/components/KmdView.test.tsx`.

- [ ] **Step 1: Write the failing test** — create `frontend/src/components/KmdView.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { KmdView } from './KmdView';
import * as api from '../api';

const period = {
  id: 3,
  name: '2026-05',
  start_date: '2026-05-01',
  end_date: '2026-05-31',
  status: 'open',
  filed_at: null,
};
const decl = {
  reporting_period_id: 3,
  period_name: '2026-05',
  start_date: '2026-05-01',
  end_date: '2026-05-31',
  row1_base_24: 0,
  row2_base_reduced: 0,
  row3_base_zero: 1174000,
  row4_output_vat: 0,
  row5_input_vat: 0,
  row6_intra_eu_acquisition: 0,
  row7_other_acquisition: 11500,
  net_vat_due: 0,
  vd_intra_eu_services: 1174000,
  review_flags: ['Verify KMD row 6 vs 7.'],
};

describe('KmdView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getReportingPeriods').mockResolvedValue([period]);
    vi.spyOn(api, 'getKmd').mockResolvedValue(decl);
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads the first period KMD and shows row 3 + VD + flags', async () => {
    render(<KmdView />);
    await waitFor(() => expect(api.getKmd).toHaveBeenCalledWith(3));
    expect(await screen.findByText(/11740\.00/)).toBeInTheDocument(); // row3 cents → €
    expect(screen.getByText(/Verify KMD row 6 vs 7\./)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (no `KmdView`)

Run: `cd frontend && npx vitest run src/components/KmdView.test.tsx`
Expected: FAIL — import error.

- [ ] **Step 3: Create `frontend/src/components/KmdView.tsx`:**
```tsx
import { useEffect, useState } from 'react';
import {
  getReportingPeriods,
  getKmd,
  fmtCents,
  type ReportingPeriod,
  type KmdDeclaration,
} from '../api';

const ROWS: { label: string; key: keyof KmdDeclaration }[] = [
  { label: 'Row 1 — 24% käive (base)', key: 'row1_base_24' },
  { label: 'Row 2 — 9/13% käive (base)', key: 'row2_base_reduced' },
  { label: 'Row 3 — 0% käive (base)', key: 'row3_base_zero' },
  { label: 'Row 4 — output VAT', key: 'row4_output_vat' },
  { label: 'Row 5 — input VAT', key: 'row5_input_vat' },
  { label: 'Row 6 — intra-EU acquisitions (base)', key: 'row6_intra_eu_acquisition' },
  { label: 'Row 7 — other acquisitions (base)', key: 'row7_other_acquisition' },
];

export function KmdView() {
  const [periods, setPeriods] = useState<ReportingPeriod[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [decl, setDecl] = useState<KmdDeclaration | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the period list once; default to the first period.
  useEffect(() => {
    getReportingPeriods()
      .then((ps) => {
        setPeriods(ps);
        if (ps.length > 0) setSelected(ps[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Fetch the declaration whenever the selected period changes.
  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setDecl(null);
    setError(null);
    getKmd(selected)
      .then((d) => {
        if (!cancelled) setDecl(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="p-4 space-y-4">
      <label className="text-sm flex items-center gap-2">
        <span className="text-gray-600">Period</span>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={selected ?? ''}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {periods.length === 0 && <option value="">(no periods)</option>}
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.start_date} → {p.end_date})
            </option>
          ))}
        </select>
      </label>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      {decl && (
        <div className="space-y-4">
          <table className="text-sm border-collapse">
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.key} className="border-b">
                  <td className="px-3 py-1 text-gray-700">{r.label}</td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {fmtCents(decl[r.key] as number)} €
                  </td>
                </tr>
              ))}
              <tr className="border-b font-medium">
                <td className="px-3 py-1">Net VAT due (row 4 − row 5)</td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {fmtCents(decl.net_vat_due)} €
                </td>
              </tr>
              <tr>
                <td className="px-3 py-1 text-gray-700">
                  VD koondaruanne — 3S (intra-EU services)
                </td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {fmtCents(decl.vd_intra_eu_services)} €
                </td>
              </tr>
            </tbody>
          </table>

          {decl.vd_intra_eu_services > 0 && (
            <p className="text-sm text-amber-700">
              File the VD koondaruanne (tähis 3S) manually in e-MTA — the system
              does not submit it.
            </p>
          )}

          {decl.review_flags.length > 0 && (
            <div className="text-sm">
              <p className="font-medium text-gray-700">Review before filing:</p>
              <ul className="list-disc ml-5 text-amber-700">
                {decl.review_flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd frontend && npx vitest run src/components/KmdView.test.tsx`
Expected: PASS (1 test). `cd frontend && npx tsc -b` → exit 0.

Note: `1174000` cents → `fmtCents` → `"11740.00"`, asserted in the test.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/components/KmdView.tsx frontend/src/components/KmdView.test.tsx
git commit -m "feat(spa): KMD declaration view (rows + VD 3S + review flags)"
```

---

### Task 6: add the KMD tab

**Files:** Modify `frontend/src/tabs.tsx`.

- [ ] **Step 1: Import `KmdView`.** Add to the top of `tabs.tsx` (below the `./api` import):
```tsx
import { KmdView } from './components/KmdView';
```

- [ ] **Step 2: Define the KMD tab.** Add this constant after `periodsTab`:
```tsx
const kmdTab: TabDef = {
  key: 'kmd',
  label: 'VAT / KMD',
  // Custom tabs render their own component; load/columns are unused but the
  // TabDef shape requires them.
  load: async () => [],
  columns: [],
  Custom: KmdView,
};
```

- [ ] **Step 3: Add it to the `TABS` array** (after `periodsTab`):
```tsx
export const TABS: TabDef[] = [
  orgTab,
  entitiesTab,
  expensesTab,
  invoicesTab,
  documentsTab,
  periodsTab,
  kmdTab,
] as unknown as TabDef[];
```

- [ ] **Step 4: Build + tests**

Run: `cd frontend && npx tsc -b && npm test && npm run build`
Expected: tsc 0; all vitest suites green; build 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/tabs.tsx
git commit -m "feat(spa): add VAT/KMD tab (custom view)"
```

---

### Task 7: final gate + push

- [ ] **Step 1: Backend gate** (the SPA build is bundled into Docker; confirm nothing regressed)

Run:
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
npm run build && npm run lint && npm run test:e2e
```
Expected: build clean; lint clean; e2e green (48).

- [ ] **Step 2: Frontend gate**

Run:
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes/frontend
npx tsc -b && npm test && npm run build
```
Expected: tsc 0; vitest green (auth, api, Table, KmdView); build produces `dist/`.

- [ ] **Step 3: Manual smoke (optional, local)**

`npm run start:dev` (backend) + `cd frontend && npm run dev`; mint a token via `cli token create`; confirm: Delete buttons appear on Expenses/Sales invoices/Entities, deleting a draft removes the row (and a non-draft/referenced delete shows the 409 message); the VAT/KMD tab lets you pick a period and shows the rows + VD 3S note + review flags.

- [ ] **Step 4: Push and hand off**
```bash
git push -u origin operator-spa-p1x
```
Then STOP — `main` is protected; open the PR for `operator-spa-p1x` manually.

---

## Self-Review

**Spec coverage:**
- Delete draft expense/invoice + unreferenced entity from the UI → Tasks 1 (helpers), 2 (Table actions), 3 (wire), 4 (buttons + reload + 409 alert). ✓
- KMD declaration view (rows, net, VD 3S, review flags, period picker) → Tasks 1 (getKmd/type), 5 (KmdView), 6 (tab). ✓
- 409 handling surfaces the server message (non-draft/referenced) → Task 4 `onDelete` catch → `window.alert`. ✓
- 401 during delete redirects to the gate → Task 4 `onDelete` catch checks `getToken()===null`. ✓

**Placeholder scan:** none — every step has full code + expected output.

**Type consistency:** `KmdDeclaration` (api.ts) ← `getKmd` ← KmdView; `TabDef.remove/rowId/Custom` (tabs.tsx) ← App.tsx `onDelete`/`Custom`; `Table.actions` (Table.tsx) ← App.tsx; `fmtCents` reused in KmdView. The `ROWS` map keys are typed `keyof KmdDeclaration`, so a renamed field fails to compile.

**Soft spots:**
- `decl[r.key] as number` — the `ROWS` keys are all numeric fields, but `KmdDeclaration` also has string/array fields, so the cast is needed; the `keyof` constraint keeps the key valid even if the cast is wide.
- The KMD tab reuses the same `as unknown as TabDef[]` cast already established for the heterogeneous tab list.
