# Operator SPA — Phase 1 (shell + auth + read tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a minimal React SPA at `/` from the NestJS kernel that authenticates with a pasted API token (localStorage → Bearer) and shows what is entered in the system across six read-only tabs.

**Architecture:** A standalone `frontend/` Vite+React+TS+Tailwind app builds to `frontend/dist`, copied into the Docker image and served by `@nestjs/serve-static` at `/` (static middleware runs ahead of the global `ApiTokenGuard`, so the page loads tokenless while `/api*`, `/admin*`, `/health*` stay guarded). The SPA is a single page with in-memory tab state (no client router). Every data request carries `Authorization: Bearer <token>`; a 401 clears the token and re-prompts. Implements ADR-0029 (scope: business objects only — no raw ledger).

**Tech Stack:** NestJS 11 / Express, `@nestjs/serve-static`; Vite 5, React 18, TypeScript, TailwindCSS 3, Vitest + @testing-library/react.

---

## Scope

In scope (P1): serve-static wiring + e2e; `frontend/` scaffold; token gate + Bearer fetch wrapper; read tabs Organization, Entities, Expenses, Sales invoices, Documents, Reporting periods; Dockerfile frontend build stage; dev proxy.

Out of scope (later phases / other branches): delete-garbage buttons (need `cli-delete-garbage` DELETE routes deployed — P1.x follow-up); document upload + triage/approvals (P2); bank-statement Mastra workflow (P3, ADR-0030); the VAT/KMD tab (needs `ee-vat-reverse-charge-kmd`'s `GET /api/reporting-periods/:id/kmd` merged — add after that lands).

## Endpoint contract (already on `main`, used by this plan)

| Tab | Request | Response shape |
|---|---|---|
| Organization | `GET /api/organization` | `Organization` = `{ id, country, base_currency, vat_registered, org_type, created_at }` |
| Entities | `GET /api/entities` | `{ entities: Entity[] }`, `Entity` = `{ id, role, country, name, goods_vs_services }` |
| Expenses | `GET /api/expenses` | `{ expenses: Expense[] }`, `Expense` = `{ id, supplier_id, category, gross_amount, vat_amount, currency, tax_point_date, status }` |
| Sales invoices | `GET /api/sales-invoices` | `{ invoices: SalesInvoice[] }`, `SalesInvoice` = `{ id, customer_id, invoice_number, gross_amount, vat_amount, currency, tax_point_date, status, sent_at }` |
| Documents | `GET /api/documents` | `{ documents: Document[] }`, `Document` = `{ id, filename, mime_type, size_bytes, status, created_at }` |
| Reporting periods | `GET /api/reporting-periods` | `{ reportingPeriods: ReportingPeriod[] }`, `ReportingPeriod` = `{ id, name, start_date, end_date, status, filed_at }` |

All monetary fields are integer **cents**. Auth: `Authorization: Bearer <token>`; missing/invalid → 401 (`ApiTokenGuard`).

## File Structure

**Backend (server):**
- Modify `package.json` — add `@nestjs/serve-static` dependency.
- Modify `src/app.module.ts` — register `ServeStaticModule` (rootPath `frontend/dist`, exclude `/api*`,`/admin*`,`/health*`).
- Create `test/operator-spa.e2e-spec.ts` — e2e: `/` not guarded + serves index, `/api/*` still guarded.

**Frontend (`frontend/`):**
- Create `frontend/package.json`, `frontend/tsconfig.json`, `frontend/tsconfig.node.json`, `frontend/vite.config.ts`, `frontend/tailwind.config.js`, `frontend/postcss.config.js`, `frontend/index.html`, `frontend/.gitignore`.
- Create `frontend/src/main.tsx` — React entry.
- Create `frontend/src/index.css` — Tailwind directives.
- Create `frontend/src/auth.ts` — token store + `apiFetch` Bearer wrapper (TDD).
- Create `frontend/src/auth.test.ts` — vitest unit tests.
- Create `frontend/src/api.ts` — typed read helpers + domain types.
- Create `frontend/src/App.tsx` — token gate + tab shell.
- Create `frontend/src/components/Table.tsx` — generic column-driven table.
- Create `frontend/src/components/TokenGate.tsx` — token entry screen.
- Create `frontend/src/tabs.tsx` — the six tab definitions (columns + fetcher).

**Deploy / dev:**
- Modify `Dockerfile` — frontend build stage + copy `frontend/dist`.
- Modify `.gitignore` (root) — ignore `frontend/dist`, `frontend/node_modules`.

---

### Task 1: Serve-static wiring + guard e2e (backend, TDD)

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/app.module.ts`
- Create: `test/operator-spa.e2e-spec.ts`

- [ ] **Step 1: Install the static-serving dependency**

Run:
```bash
npm install @nestjs/serve-static@^4
```
Expected: `@nestjs/serve-static` appears under `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Write the failing e2e test**

Create `test/operator-spa.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Operator SPA serve-static wiring (ADR-0029): the page is served at "/" by
 * static middleware that runs ahead of the global ApiTokenGuard, while the API
 * stays guarded. We don't run a real Vite build here — we drop a placeholder
 * frontend/dist/index.html so ServeStaticModule has a file to serve.
 */
describe('Operator SPA serving (e2e)', () => {
  let app: INestApplication;
  const distDir = path.join(process.cwd(), 'frontend', 'dist');
  const indexFile = path.join(distDir, 'index.html');
  let createdIndex = false;

  beforeAll(async () => {
    if (!fs.existsSync(indexFile)) {
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(indexFile, '<!doctype html><div id="root">spa</div>');
      createdIndex = true;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (createdIndex) fs.rmSync(indexFile, { force: true });
  });

  it('serves the SPA index at "/" without a token (not guarded)', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="root"');
  });

  it('still guards the API: GET /api/organization without a token is 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/organization');
    expect(res.status).toBe(401);
  });

  it('does not let static serving shadow the API path prefix', async () => {
    // /api/* must reach the guard (401), never the static 404/index.
    const res = await request(app.getHttpServer()).get('/api/expenses');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npx jest --config ./test/jest-e2e.json operator-spa
```
Expected: FAIL — `GET /` returns 404 (no `ServeStaticModule` registered yet), so the first assertion (`status === 200`) fails.

- [ ] **Step 4: Register ServeStaticModule in AppModule**

In `src/app.module.ts`, add the import at the top with the other imports:
```ts
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
```
Then add this as the FIRST entry of the `imports: [...]` array of the `@Module({...})` decorator:
```ts
    ServeStaticModule.forRoot({
      // Built Vite output; produced by `cd frontend && npm run build`.
      rootPath: join(process.cwd(), 'frontend', 'dist'),
      serveRoot: '/',
      // Never let static serving intercept the API / admin / health surfaces —
      // those must reach the global ApiTokenGuard (or the health route).
      exclude: ['/api*', '/admin*', '/health*'],
    }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npx jest --config ./test/jest-e2e.json operator-spa
```
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full e2e suite to confirm no regression**

Run:
```bash
npm run test:e2e
```
Expected: all suites pass (previous 44 + the 3 new = 47).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/app.module.ts test/operator-spa.e2e-spec.ts
git commit -m "feat(spa): serve frontend/dist at / via serve-static, API stays guarded"
```

---

### Task 2: Frontend scaffold (Vite + React + TS + Tailwind)

**Files:** all created under `frontend/`. No automated test — verified by a successful build.

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "operator-spa",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.45",
    "tailwindcss": "^3.4.10",
    "typescript": "^5.5.4",
    "vite": "^5.4.3",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>override OÜ — books</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 4: Create `frontend/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: Create `frontend/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy API + admin to the running Nest server so the SPA works against a
// local backend without a rebuild. Prod build is served by serve-static at /.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/admin': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
```

- [ ] **Step 6: Create `frontend/tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

- [ ] **Step 7: Create `frontend/postcss.config.js`**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 8: Create `frontend/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 9: Create `frontend/src/test-setup.ts`**

```ts
import '@testing-library/jest-dom';
```

- [ ] **Step 10: Create `frontend/.gitignore`**

```
node_modules
dist
```

- [ ] **Step 11: Create a placeholder `frontend/src/main.tsx` so the build succeeds**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="p-4">scaffold</div>
  </React.StrictMode>,
);
```

- [ ] **Step 12: Install and build to verify the scaffold**

Run:
```bash
cd frontend && npm install && npm run build
```
Expected: `frontend/dist/index.html` + hashed `assets/*.js`/`*.css` produced; exit 0.

- [ ] **Step 13: Commit**

```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/package.json frontend/package-lock.json frontend/index.html frontend/tsconfig.json frontend/tsconfig.node.json frontend/vite.config.ts frontend/tailwind.config.js frontend/postcss.config.js frontend/src/index.css frontend/src/test-setup.ts frontend/src/main.tsx frontend/.gitignore
git commit -m "feat(spa): scaffold frontend (vite+react+ts+tailwind)"
```

---

### Task 3: Auth — token store + Bearer fetch wrapper (TDD)

**Files:**
- Create: `frontend/src/auth.ts`
- Test: `frontend/src/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/auth.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getToken, setToken, clearToken, apiFetch, TOKEN_KEY } from './auth';

describe('auth token store', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips the token through localStorage', () => {
    expect(getToken()).toBeNull();
    setToken('abc123');
    expect(getToken()).toBe('abc123');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('abc123');
    clearToken();
    expect(getToken()).toBeNull();
  });
});

describe('apiFetch', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('attaches the Bearer header from the stored token', async () => {
    setToken('tok');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await apiFetch('/api/organization');

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });

  it('clears the token and throws Unauthorized on 401', async () => {
    setToken('bad');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 401 }),
    );

    await expect(apiFetch('/api/organization')).rejects.toThrow(/unauthorized/i);
    expect(getToken()).toBeNull();
  });

  it('parses and returns JSON on success', async () => {
    setToken('tok');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"country":"EE"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const body = await apiFetch<{ country: string }>('/api/organization');
    expect(body.country).toBe('EE');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontend && npx vitest run src/auth.test.ts
```
Expected: FAIL — cannot import from `./auth` (module does not exist).

- [ ] **Step 3: Write minimal `frontend/src/auth.ts`**

```ts
export const TOKEN_KEY = 'bk_api_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Raised on a 401 so the UI can drop back to the token gate. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized — token cleared');
    this.name = 'UnauthorizedError';
  }
}

/**
 * fetch wrapper that attaches the stored Bearer token, surfaces a 401 by
 * clearing the token and throwing UnauthorizedError, and returns parsed JSON.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd frontend && npx vitest run src/auth.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/auth.ts frontend/src/auth.test.ts
git commit -m "feat(spa): token store + Bearer apiFetch wrapper with 401 handling"
```

---

### Task 4: Typed API client (domain types + read helpers)

**Files:**
- Create: `frontend/src/api.ts`

No new test — these are thin typed wrappers over the tested `apiFetch`; they are exercised through the tab components and the e2e contract table above.

- [ ] **Step 1: Create `frontend/src/api.ts`**

```ts
import { apiFetch } from './auth';

export interface Organization {
  id: number;
  country: string;
  base_currency: string | null;
  vat_registered: boolean;
  org_type: string;
  created_at: number;
}

export interface Entity {
  id: number;
  role: string;
  country: string;
  name: string;
  goods_vs_services: string | null;
}

export interface Expense {
  id: number;
  supplier_id: number | null;
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: string;
}

export interface SalesInvoice {
  id: number;
  customer_id: number | null;
  invoice_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: string;
  sent_at: number | null;
}

export interface DocumentRow {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: number;
}

export interface ReportingPeriod {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  filed_at: number | null;
}

export const getOrganization = () => apiFetch<Organization>('/api/organization');
export const getEntities = () =>
  apiFetch<{ entities: Entity[] }>('/api/entities').then((r) => r.entities);
export const getExpenses = () =>
  apiFetch<{ expenses: Expense[] }>('/api/expenses').then((r) => r.expenses);
export const getInvoices = () =>
  apiFetch<{ invoices: SalesInvoice[] }>('/api/sales-invoices').then(
    (r) => r.invoices,
  );
export const getDocuments = () =>
  apiFetch<{ documents: DocumentRow[] }>('/api/documents').then(
    (r) => r.documents,
  );
export const getReportingPeriods = () =>
  apiFetch<{ reportingPeriods: ReportingPeriod[] }>(
    '/api/reporting-periods',
  ).then((r) => r.reportingPeriods);

/** Integer cents → display string, e.g. 615700 -> "6157.00". */
export const fmtCents = (cents: number): string => (cents / 100).toFixed(2);
```

- [ ] **Step 2: Type-check**

Run:
```bash
cd frontend && npx tsc -b
```
Expected: exit 0, no type errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/api.ts
git commit -m "feat(spa): typed API client + domain types for read tabs"
```

---

### Task 5: Generic Table + TokenGate components

**Files:**
- Create: `frontend/src/components/Table.tsx`
- Create: `frontend/src/components/TokenGate.tsx`

- [ ] **Step 1: Create `frontend/src/components/Table.tsx`**

```tsx
export interface Column<T> {
  header: string;
  cell: (row: T) => React.ReactNode;
}

export function Table<T>({
  columns,
  rows,
}: {
  columns: Column<T>[];
  rows: T[];
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Create `frontend/src/components/TokenGate.tsx`**

```tsx
import { useState } from 'react';
import { setToken } from '../auth';

/** Full-screen token entry shown when no token is stored (or after a 401). */
export function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <form
        className="bg-white p-6 rounded shadow w-96 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim().length === 0) return;
          setToken(value.trim());
          onSaved();
        }}
      >
        <h1 className="text-lg font-semibold">API token</h1>
        <p className="text-sm text-gray-500">
          Paste an API token. It is stored in this browser only and sent as a
          Bearer header.
        </p>
        <input
          className="w-full border rounded px-3 py-2 font-mono text-sm"
          type="password"
          placeholder="token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button
          className="w-full bg-black text-white rounded px-3 py-2 text-sm"
          type="submit"
        >
          Save
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run:
```bash
cd frontend && npx tsc -b
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/components/Table.tsx frontend/src/components/TokenGate.tsx
git commit -m "feat(spa): generic Table + TokenGate components"
```

---

### Task 6: Tab definitions (columns + fetchers)

**Files:**
- Create: `frontend/src/tabs.tsx`

- [ ] **Step 1: Create `frontend/src/tabs.tsx`**

```tsx
import { Column } from './components/Table';
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
} from './api';

export interface TabDef<T = unknown> {
  key: string;
  label: string;
  load: () => Promise<T[]>;
  columns: Column<T>[];
}

const orgTab: TabDef<Organization> = {
  key: 'org',
  label: 'Organization',
  load: () => getOrganization().then((o) => [o]),
  columns: [
    { header: 'Country', cell: (o) => o.country },
    { header: 'Org type', cell: (o) => o.org_type },
    { header: 'VAT registered', cell: (o) => (o.vat_registered ? 'yes' : 'no') },
    { header: 'Base currency', cell: (o) => o.base_currency ?? '(plugin default)' },
  ],
};

const entitiesTab: TabDef<Entity> = {
  key: 'entities',
  label: 'Entities',
  load: getEntities,
  columns: [
    { header: 'ID', cell: (e) => e.id },
    { header: 'Name', cell: (e) => e.name },
    { header: 'Role', cell: (e) => e.role },
    { header: 'Country', cell: (e) => e.country },
    { header: 'Goods/Services', cell: (e) => e.goods_vs_services ?? '—' },
  ],
};

const expensesTab: TabDef<Expense> = {
  key: 'expenses',
  label: 'Expenses',
  load: getExpenses,
  columns: [
    { header: 'ID', cell: (e) => e.id },
    { header: 'Category', cell: (e) => e.category },
    { header: 'Gross', cell: (e) => `${fmtCents(e.gross_amount)} ${e.currency}` },
    { header: 'VAT', cell: (e) => fmtCents(e.vat_amount) },
    { header: 'Tax point', cell: (e) => e.tax_point_date },
    { header: 'Status', cell: (e) => e.status },
  ],
};

const invoicesTab: TabDef<SalesInvoice> = {
  key: 'invoices',
  label: 'Sales invoices',
  load: getInvoices,
  columns: [
    { header: 'No.', cell: (i) => i.invoice_number },
    { header: 'Gross', cell: (i) => `${fmtCents(i.gross_amount)} ${i.currency}` },
    { header: 'VAT', cell: (i) => fmtCents(i.vat_amount) },
    { header: 'Tax point', cell: (i) => i.tax_point_date },
    { header: 'Status', cell: (i) => i.status },
    { header: 'Sent', cell: (i) => (i.sent_at ? 'yes' : 'no') },
  ],
};

const documentsTab: TabDef<DocumentRow> = {
  key: 'documents',
  label: 'Documents',
  load: getDocuments,
  columns: [
    { header: 'ID', cell: (d) => d.id },
    { header: 'Filename', cell: (d) => d.filename },
    { header: 'Type', cell: (d) => d.mime_type },
    { header: 'Size', cell: (d) => `${(d.size_bytes / 1024).toFixed(1)} KB` },
    { header: 'Status', cell: (d) => d.status },
  ],
};

const periodsTab: TabDef<ReportingPeriod> = {
  key: 'periods',
  label: 'Periods',
  load: getReportingPeriods,
  columns: [
    { header: 'Name', cell: (p) => p.name },
    { header: 'Start', cell: (p) => p.start_date },
    { header: 'End', cell: (p) => p.end_date },
    { header: 'Status', cell: (p) => p.status },
    { header: 'Filed', cell: (p) => (p.filed_at ? 'yes' : 'no') },
  ],
};

// Cast to a uniform TabDef<unknown> list — each tab is internally typed.
export const TABS: TabDef[] = [
  orgTab,
  entitiesTab,
  expensesTab,
  invoicesTab,
  documentsTab,
  periodsTab,
] as unknown as TabDef[];
```

- [ ] **Step 2: Type-check**

Run:
```bash
cd frontend && npx tsc -b
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/tabs.tsx
git commit -m "feat(spa): six read-tab definitions (columns + fetchers)"
```

---

### Task 7: App shell — gate + tabs + data loading

**Files:**
- Modify: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`

- [ ] **Step 1: Create `frontend/src/App.tsx`**

```tsx
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
```

- [ ] **Step 2: Replace `frontend/src/main.tsx` to mount App**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 3: Build the whole frontend to verify it compiles**

Run:
```bash
cd frontend && npm run build
```
Expected: exit 0; `frontend/dist/index.html` + assets produced.

- [ ] **Step 4: Run the frontend unit tests**

Run:
```bash
cd frontend && npm test
```
Expected: PASS (the `auth.test.ts` suite, 4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/App.tsx frontend/src/main.tsx
git commit -m "feat(spa): app shell — token gate, tabs, data loading"
```

---

### Task 8: Dockerfile frontend build stage + root .gitignore

**Files:**
- Modify: `Dockerfile`
- Modify: `.gitignore` (root)

- [ ] **Step 1: Add `frontend/` build artifacts to the root `.gitignore`**

Append to `.gitignore`:
```
# Operator SPA build artifacts
frontend/node_modules
frontend/dist
```

- [ ] **Step 2: Add a frontend build to the Dockerfile builder stage**

In `Dockerfile`, in the `builder` stage, AFTER the existing `RUN npm run build` line, add:
```dockerfile
# Build the operator SPA (separate package) into frontend/dist.
WORKDIR /app/frontend
RUN npm ci && npm run build
WORKDIR /app
```

- [ ] **Step 3: Copy the built SPA into the production image**

In `Dockerfile`, in the `production` stage, AFTER the existing `COPY --from=builder /app/dist ./dist` line, add:
```dockerfile
COPY --from=builder /app/frontend/dist ./frontend/dist
```

- [ ] **Step 4: Verify the Docker build (if Docker is available)**

Run:
```bash
docker build -t bk-spa-check . 2>&1 | tail -20
```
Expected: build succeeds; the `frontend/dist` copy step runs without error. (If Docker is unavailable in this environment, skip — the build stage is mechanical; flag it for CI to verify.)

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .gitignore
git commit -m "build(spa): build frontend/dist in Docker and ship it in the image"
```

---

### Task 9: Final full-gate verification

- [ ] **Step 1: Backend gate**

Run:
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
npm run build && npm run lint && npm test && npm run test:e2e
```
Expected: build clean; lint clean; all unit suites pass; e2e includes the 3 `operator-spa.e2e-spec.ts` tests, all green.

- [ ] **Step 2: Frontend gate**

Run:
```bash
cd frontend && npx tsc -b && npm test && npm run build
```
Expected: type-check clean; vitest green; build produces `dist/`.

- [ ] **Step 3: Manual smoke (optional, local)**

Run the server (`npm run start:dev`) in one shell and `cd frontend && npm run dev` in another; open the Vite dev URL, paste a token minted via `cli token create`, confirm the six tabs load real data and that a wrong token shows the gate again.

- [ ] **Step 4: Push the branch and hand off for PR**

```bash
git push -u origin operator-spa
```
Then STOP — `main` is protected; open the PR for `operator-spa` manually. Note in the PR description that the delete-garbage buttons and the VAT/KMD tab are deliberately deferred (cross-branch dependencies on `cli-delete-garbage` and `ee-vat-reverse-charge-kmd`).

---

## Self-Review

**Spec coverage (ADR-0029, P1 slice):**
- SPA served at `/` by serve-static, page tokenless, API guarded → Task 1. ✓
- Token in localStorage → Bearer; 401 → re-prompt → Task 3 (`auth.ts`) + Task 7 (gate switch on token clear). ✓
- Business-objects-only scope, six tabs, no raw ledger → Tasks 4/6/7 (only Organization/Entities/Expenses/Invoices/Documents/Periods; no vouchers/accounts). ✓
- Separate `frontend/package.json`, build to `frontend/dist`, Dockerfile builds + copies → Tasks 2/8. ✓
- Dev proxy → Task 2 (`vite.config.ts`). ✓
- Deferred (correctly out of P1): delete buttons (need `cli-delete-garbage`), VAT/KMD tab (need `ee-vat-reverse-charge-kmd`), document upload/triage (P2), bank statements (P3). Noted in Scope + Task 9 Step 4.

**Placeholder scan:** No TBD/TODO; every code step contains full file content; commands have expected output. ✓

**Type consistency:** `apiFetch<T>` (auth.ts) used by all helpers (api.ts); `Column<T>`/`Table<T>` (Table.tsx) consumed by `TabDef.columns` (tabs.tsx) and `App.tsx`; `fmtCents` defined in api.ts, used in tabs.tsx; response wrapper keys (`entities`/`expenses`/`invoices`/`documents`/`reportingPeriods`) match the controller contract table. ✓

**Known soft spots:**
- `TABS` uses an `as unknown as TabDef[]` cast to hold heterogeneously-typed tabs in one list; each tab is internally type-safe. Acceptable for a six-tab static list; revisit with a generic renderer if tabs grow.
- The serve-static e2e writes a placeholder `frontend/dist/index.html` when none exists so the test does not require a full Vite build; if a real `dist` is present it is used and left intact.
