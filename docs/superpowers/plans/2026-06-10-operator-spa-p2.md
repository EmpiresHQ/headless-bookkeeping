# Operator SPA — Phase 2 (document intake + triage + approvals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator drive the intake pipeline from the SPA: upload a document (счёт), run triage on pending documents (which the server's AI pipeline turns into a draft expense/invoice or an audit finding), and resolve the HITL approvals queue (approve/reject).

**Architecture:** Two new Custom tabs on the existing operator SPA (same mechanism the KMD tab uses): **Intake** (upload + pending-triage queue with per-doc "Run triage" / "Complete") and **Approvals** (pending approvals with approve/reject). All over the existing guarded REST API via `apiFetch`. Triage itself runs server-side (AI pipeline); the UI only triggers it and renders the outcome. Read-then-act with reload-after-action.

**Tech Stack:** React 18 + TS + Tailwind + Vitest/@testing-library (existing `frontend/`).

---

## Endpoint contract (already on `main`)

| Action | Request | Response |
|---|---|---|
| Upload document | `POST /api/documents` — multipart, field `file` | `{ document: Document, deduplicated: boolean }` (201) |
| Pending triage | `GET /api/triage/pending` | `{ pending: Document[] }` |
| Run triage | `POST /api/documents/:id/triage` | `TriageOutcome` |
| Complete document | `POST /api/documents/:id/complete` | `{ id, status: 'processed' }` (201) |
| Pending approvals | `GET /api/approvals/pending` | `{ approvals: Approval[] }` |
| Approve | `POST /api/approvals/:id/approve` — JSON `{ approved_by }` | `{ approval, voucher }` |
| Reject | `POST /api/approvals/:id/reject` — JSON `{ rejected_reason }` | `{ approval }` |

- `Document` is the existing `DocumentRow` (`{ id, filename, mime_type, size_bytes, status, created_at }`).
- `TriageOutcome` (discriminated on `kind`):
  - `{ kind: 'expense', document_id, expense_id }`
  - `{ kind: 'invoice', document_id, invoice_id }`
  - `{ kind: 'unknown', document_id, reason }`
- `Approval` = `{ id, object_type, object_id, status, requested_by, approved_by, rejected_reason, superseded_by, created_at, resolved_at }`.
- `apiFetch` attaches the Bearer token, throws on non-OK (now surfacing the NestJS `message`), clears the token + throws on 401, and parses JSON on success. For the multipart upload, pass a `FormData` body and set NO `Content-Type` (the browser adds the multipart boundary). For JSON POSTs, set `Content-Type: application/json` (the backend's ZodValidationPipe needs it).

> **Operational note:** triage invokes the server's Mastra AI pipeline (OCR + classify). On a deployment without AI credentials it returns `needs_triage`/errors; the UI just renders whatever the server returns. Not a UI concern.

## File Structure
- Modify `frontend/src/api.ts` — `TriageOutcome` + `Approval` types; `uploadDocument`, `getTriagePending`, `triageDocument`, `completeDocument`, `getPendingApprovals`, `approveApproval`, `rejectApproval`.
- Modify `frontend/src/api.test.ts` — upload uses FormData (no JSON content-type); triage/approve POST paths + bodies.
- Create `frontend/src/components/IntakeView.tsx` + `IntakeView.test.tsx`.
- Create `frontend/src/components/ApprovalsView.tsx` + `ApprovalsView.test.tsx`.
- Modify `frontend/src/tabs.tsx` — add `intakeTab` + `approvalsTab` (Custom).
- Modify `frontend/.gitignore` — ignore `*.tsbuildinfo` (a tracked build artifact is currently dirtying the tree).

---

### Task 1: api.ts — intake + approvals helpers (TDD)

**Files:** Modify `frontend/src/api.ts`; Modify `frontend/src/api.test.ts`; Modify `frontend/.gitignore`.

- [ ] **Step 1: Stop tracking the build artifact.** Append to `frontend/.gitignore`:
```
*.tsbuildinfo
```
Then run `git rm --cached frontend/tsconfig.tsbuildinfo` (untrack it; it stays on disk). If the file is not tracked, skip — report it.

- [ ] **Step 2: Write failing tests** — append to `frontend/src/api.test.ts` (inside the existing top-level `describe`, after the last test, before its closing `});`):
```ts
  it('uploadDocument POSTs multipart FormData (no JSON content-type)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"document":{"id":5},"deduplicated":false}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { uploadDocument } = await import('./api');
    const file = new File(['x'], 'invoice.pdf', { type: 'application/pdf' });
    await uploadDocument(file);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/documents');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const headers = new Headers(init?.headers);
    // Must NOT set a JSON content-type — the browser sets the multipart boundary.
    expect(headers.get('content-type')).toBeNull();
  });

  it('triageDocument POSTs to the triage path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"kind":"unknown","document_id":5,"reason":"x"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { triageDocument } = await import('./api');
    await triageDocument(5);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/documents/5/triage');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
  });

  it('approveApproval POSTs approved_by as JSON', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"approval":{"id":9},"voucher":null}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const { approveApproval } = await import('./api');
    await approveApproval(9, 'operator');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/approvals/9/approve');
    expect(JSON.parse(init?.body as string)).toEqual({ approved_by: 'operator' });
  });
```

- [ ] **Step 3: Run — expect FAIL**
Run: `cd frontend && npx vitest run src/api.test.ts`
Expected: FAIL (helpers not exported).

- [ ] **Step 4: Append to `frontend/src/api.ts`** (after the deletes block from P1.x):
```ts

// ── Intake / triage (POST /api/documents, /triage, /complete) ─────────────
export type TriageOutcome =
  | { kind: 'expense'; document_id: number; expense_id: number }
  | { kind: 'invoice'; document_id: number; invoice_id: number }
  | { kind: 'unknown'; document_id: number; reason: string };

export const uploadDocument = (file: File) => {
  // Multipart: set NO content-type so the browser adds the boundary.
  const body = new FormData();
  body.append('file', file);
  return apiFetch<{ document: DocumentRow; deduplicated: boolean }>(
    '/api/documents',
    { method: 'POST', body },
  );
};

export const getTriagePending = () =>
  apiFetch<{ pending: DocumentRow[] }>('/api/triage/pending').then(
    (r) => r.pending,
  );

export const triageDocument = (id: number) =>
  apiFetch<TriageOutcome>(`/api/documents/${id}/triage`, { method: 'POST' });

export const completeDocument = (id: number) =>
  apiFetch<{ id: number; status: string }>(`/api/documents/${id}/complete`, {
    method: 'POST',
  });

// ── Approvals (HITL) ──────────────────────────────────────────────────────
export interface Approval {
  id: number;
  object_type: string;
  object_id: number;
  status: string;
  requested_by: string;
  approved_by: string | null;
  rejected_reason: string | null;
  superseded_by: number | null;
  created_at: number;
  resolved_at: number | null;
}

export const getPendingApprovals = () =>
  apiFetch<{ approvals: Approval[] }>('/api/approvals/pending').then(
    (r) => r.approvals,
  );

export const approveApproval = (id: number, approvedBy: string) =>
  apiFetch(`/api/approvals/${id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved_by: approvedBy }),
  });

export const rejectApproval = (id: number, reason: string) =>
  apiFetch(`/api/approvals/${id}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rejected_reason: reason }),
  });
```

- [ ] **Step 5: Run — expect PASS**
Run: `cd frontend && npx vitest run src/api.test.ts` → expect 5 passing (2 from P1.x + 3 new). `cd frontend && npx tsc -b` → exit 0.

- [ ] **Step 6: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/api.ts frontend/src/api.test.ts frontend/.gitignore
git rm --cached frontend/tsconfig.tsbuildinfo 2>/dev/null || true
git commit -m "feat(spa): intake/triage + approvals api helpers; ignore tsbuildinfo"
```

---

### Task 2: IntakeView component (upload + triage queue)

**Files:** Create `frontend/src/components/IntakeView.tsx` + `frontend/src/components/IntakeView.test.tsx`.

- [ ] **Step 1: Write the failing test** — create `frontend/src/components/IntakeView.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IntakeView } from './IntakeView';
import * as api from '../api';

const doc = {
  id: 5,
  filename: 'invoice.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  status: 'pending',
  created_at: 0,
};

describe('IntakeView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getTriagePending').mockResolvedValue([doc]);
    vi.spyOn(api, 'triageDocument').mockResolvedValue({
      kind: 'expense',
      document_id: 5,
      expense_id: 42,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists pending documents and runs triage, showing the outcome', async () => {
    render(<IntakeView />);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /run triage/i }));

    await waitFor(() => expect(api.triageDocument).toHaveBeenCalledWith(5));
    expect(await screen.findByText(/expense #42/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`./IntakeView` missing)
Run: `cd frontend && npx vitest run src/components/IntakeView.test.tsx`

- [ ] **Step 3: Create `frontend/src/components/IntakeView.tsx`:**
```tsx
import { useEffect, useRef, useState } from 'react';
import {
  uploadDocument,
  getTriagePending,
  triageDocument,
  completeDocument,
  type DocumentRow,
  type TriageOutcome,
} from '../api';

function outcomeLabel(o: TriageOutcome): string {
  if (o.kind === 'expense') return `→ draft expense #${o.expense_id}`;
  if (o.kind === 'invoice') return `→ draft invoice #${o.invoice_id}`;
  return `→ needs triage: ${o.reason}`;
}

export function IntakeView() {
  const [pending, setPending] = useState<DocumentRow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Per-document triage outcome, keyed by document id.
  const [outcomes, setOutcomes] = useState<Record<number, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () =>
    getTriagePending()
      .then(setPending)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onUpload = () =>
    run(async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) return;
      const { document, deduplicated } = await uploadDocument(file);
      setNote(
        deduplicated
          ? `Document #${document.id} already existed (deduplicated).`
          : `Uploaded document #${document.id}.`,
      );
      if (fileRef.current) fileRef.current.value = '';
      await refresh();
    });

  const onTriage = (id: number) =>
    run(async () => {
      const outcome = await triageDocument(id);
      setOutcomes((m) => ({ ...m, [id]: outcomeLabel(outcome) }));
      await refresh();
    });

  const onComplete = (id: number) =>
    run(async () => {
      await completeDocument(id);
      await refresh();
    });

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <input ref={fileRef} type="file" className="text-sm" />
        <button
          type="button"
          disabled={busy}
          onClick={onUpload}
          className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-50"
        >
          Upload
        </button>
        {note && <span className="text-sm text-green-700">{note}</span>}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div>
        <h2 className="text-sm font-medium text-gray-700 mb-1">
          Pending documents
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing pending.</p>
        ) : (
          <table className="min-w-full text-sm border-collapse">
            <thead>
              <tr className="border-b bg-gray-50 text-left">
                <th className="px-3 py-2 font-medium text-gray-700">ID</th>
                <th className="px-3 py-2 font-medium text-gray-700">Filename</th>
                <th className="px-3 py-2 font-medium text-gray-700">Status</th>
                <th className="px-3 py-2 font-medium text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr key={d.id} className="border-b align-top">
                  <td className="px-3 py-2">{d.id}</td>
                  <td className="px-3 py-2">{d.filename}</td>
                  <td className="px-3 py-2">
                    {d.status}
                    {outcomes[d.id] && (
                      <span className="block text-gray-500">
                        {outcomes[d.id]}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 space-x-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onTriage(d.id)}
                      className="text-blue-600 hover:underline disabled:opacity-50"
                    >
                      Run triage
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onComplete(d.id)}
                      className="text-gray-600 hover:underline disabled:opacity-50"
                    >
                      Complete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**
Run: `cd frontend && npx vitest run src/components/IntakeView.test.tsx` → 1 pass. `cd frontend && npx tsc -b` → exit 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/components/IntakeView.tsx frontend/src/components/IntakeView.test.tsx
git commit -m "feat(spa): IntakeView — upload + pending triage queue"
```

---

### Task 3: ApprovalsView component (approve / reject)

**Files:** Create `frontend/src/components/ApprovalsView.tsx` + `frontend/src/components/ApprovalsView.test.tsx`.

- [ ] **Step 1: Write the failing test** — create `frontend/src/components/ApprovalsView.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApprovalsView } from './ApprovalsView';
import * as api from '../api';

const approval = {
  id: 9,
  object_type: 'expense',
  object_id: 42,
  status: 'pending',
  requested_by: 'system',
  approved_by: null,
  rejected_reason: null,
  superseded_by: null,
  created_at: 0,
  resolved_at: null,
};

describe('ApprovalsView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getPendingApprovals').mockResolvedValue([approval]);
    vi.spyOn(api, 'approveApproval').mockResolvedValue({});
    vi.spyOn(window, 'prompt').mockReturnValue('operator');
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists pending approvals and approves with the entered approver', async () => {
    render(<ApprovalsView />);
    expect(await screen.findByText(/expense #42/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    await waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(9, 'operator'),
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
Run: `cd frontend && npx vitest run src/components/ApprovalsView.test.tsx`

- [ ] **Step 3: Create `frontend/src/components/ApprovalsView.tsx`:**
```tsx
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
                <td className="px-3 py-2">
                  {a.object_type} #{a.object_id}
                </td>
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
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**
Run: `cd frontend && npx vitest run src/components/ApprovalsView.test.tsx` → 1 pass. `cd frontend && npx tsc -b` → exit 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/alekseirevin/test/headless-bookkeeping/.claude/worktrees/api-fixes
git add frontend/src/components/ApprovalsView.tsx frontend/src/components/ApprovalsView.test.tsx
git commit -m "feat(spa): ApprovalsView — pending approvals approve/reject"
```

---

### Task 4: add Intake + Approvals tabs

**Files:** Modify `frontend/src/tabs.tsx`.

- [ ] **Step 1: Import the two views.** After the existing `import { KmdView } from './components/KmdView';` line, add:
```tsx
import { IntakeView } from './components/IntakeView';
import { ApprovalsView } from './components/ApprovalsView';
```

- [ ] **Step 2: Define the tabs.** After the existing `kmdTab` constant, add:
```tsx
const intakeTab: TabDef = {
  key: 'intake',
  label: 'Intake',
  load: async () => [],
  columns: [],
  Custom: IntakeView,
};

const approvalsTab: TabDef = {
  key: 'approvals',
  label: 'Approvals',
  load: async () => [],
  columns: [],
  Custom: ApprovalsView,
};
```

- [ ] **Step 3: Add them to `TABS`.** Insert `intakeTab` and `approvalsTab` into the `TABS` array — put them right after `documentsTab` (intake/approvals belong with documents, before the reporting tabs):
```tsx
export const TABS: TabDef[] = [
  orgTab,
  entitiesTab,
  expensesTab,
  invoicesTab,
  documentsTab,
  intakeTab,
  approvalsTab,
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
git commit -m "feat(spa): add Intake + Approvals tabs"
```

---

### Task 5: final gate + push

- [ ] **Step 1: Backend gate** (the SPA build ships in Docker; confirm no regression)
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
Expected: tsc 0; vitest green (auth, api, Table, KmdView, IntakeView, ApprovalsView); build produces `dist/`.

- [ ] **Step 3: Manual smoke (optional, local)**
`npm run start:dev` + `cd frontend && npm run dev`; mint a token; on **Intake**: pick a file → Upload (shows uploaded/deduplicated), the pending list shows it; Run triage → outcome appears (draft expense/invoice or needs-triage reason); Complete removes it. On **Approvals**: a pending approval shows Approve/Reject; Approve prompts for a name and resolves it.

- [ ] **Step 4: Push and hand off**
```bash
git push -u origin operator-spa-p2
```
Then STOP — `main` is protected; open the PR for `operator-spa-p2` manually.

---

## Self-Review

**Spec coverage:**
- Upload document → Task 1 `uploadDocument` (multipart) + Task 2 IntakeView upload control. ✓
- Run triage on pending docs + see outcome (expense/invoice/needs-triage) → Task 1 `getTriagePending`/`triageDocument` + Task 2 queue with outcome labels. ✓
- Complete a document → Task 1 `completeDocument` + Task 2 Complete button. ✓
- Approvals queue with approve/reject → Task 1 `getPendingApprovals`/`approveApproval`/`rejectApproval` + Task 3 ApprovalsView. ✓
- Tabs wired → Task 4. ✓
- 401 during any action → `apiFetch` clears the token + throws; the views surface the error string. (Like KMD, custom-tab views don't auto-redirect to the gate — a known limitation tracked for a later `onUnauthorized`/context fix; acceptable for v1.)

**Placeholder scan:** none — full code in every step.

**Type consistency:** `TriageOutcome`/`Approval`/`DocumentRow` (api.ts) ← IntakeView/ApprovalsView; `uploadDocument` returns `{document, deduplicated}` matching the upload usage; `outcomeLabel` exhaustively handles the three `kind`s; multipart vs JSON content-type handled per the apiFetch contract.

**Soft spots:**
- Custom-tab views (Intake, Approvals, KMD) each manage their own load/error and do NOT redirect to the token gate on a 401 — they show the cleared-token error text. Consistent across all three; a shared `onUnauthorized` is the right future fix when the custom-tab count grows.
- Triage depends on the server AI pipeline; with no AI credentials the outcome is `needs_triage`/an error — surfaced as-is, not a UI bug.
- `approveApproval`/`rejectApproval` return values are ignored by the UI (it just reloads); typed loosely as `apiFetch(...)` (unknown) — fine since the UI doesn't read the result.
