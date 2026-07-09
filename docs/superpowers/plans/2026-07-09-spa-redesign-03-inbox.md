# SPA Redesign — Plan 03: Inbox section rebuild (unified decision queue: triage + approvals)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two legacy Inbox screens (`IntakeView` — an accordion of "ID + filename + status", `ApprovalsView` — a table whose approve/reject go through `window.prompt`) with the redesigned unified Inbox: one FIFO decision queue merging needs-triage documents and pending approvals (Today/Earlier sections, one-line human reasons with real numbers, amounts, chips), an approval detail screen (amount hero → "why held" → document preview → facts → Approve/Reject-with-reason), a triage detail screen whose four resolution flows (resolve supplier, manual classify expense, manual classify invoice, OCR-failed) open as restyled fullscreen sheets, live queue polling, "N of M" progress with auto-advance, an inbox-zero state, and the live tab-bar/sidebar badge — all on the EXISTING server API.

**Architecture:** New screens live in `packages/web/src/inbox/`; typed TanStack Query hooks + the pure queue model in `packages/web/src/queries/inbox.ts`; one small addition to the transport layer `src/api.ts` (`getExpense` — the single-expense endpoint the approval detail needs for `document_id`/`ai_confidence`). This plan also pays Plan 02's two deferred debts before building on them: a `LinkButton` ui-kit component (replacing the two existing raw-`Link`-as-button duplications) and a shared cross-domain query-key factory (`src/queries/keys.ts` + `src/queries/shared.ts`) that centralizes the `['entities']`/`['categories']`/`['organization']` literals currently inline in `src/queries/bank.ts` (literals preserved byte-identically for cache compatibility). Routes `/inbox` (segments in `?seg=`), `/inbox/doc/:id`, `/inbox/approval/:id` replace the LegacyTabs Inbox mount at the end; `IntakeView.tsx` + `ApprovalsView.tsx` + their tests are deleted. **`TriagePanel` and the four legacy form components (`ResolveSupplierForm`, `TriageManualForm`, `TriageManualInvoiceForm`, `TriageOcrFailedForm`) plus `DocumentThumb`/`reasonBadge` SURVIVE this plan** — `DocumentsView` (legacy, dies in the Books plan) still mounts `TriagePanel` inline (`components/DocumentsView.tsx:17,382`); the Inbox builds NEW restyled sheets that reuse the same API choreography, and the Books plan deletes the legacy set together with `DocumentsView`. The server is NOT modified. Spec: `docs/superpowers/specs/2026-07-08-spa-ux-redesign-design.md` (Inbox subsection + Data display rules); canonical screen asset: `docs/superpowers/specs/assets/2026-07-09-screens-data-redesign.html` §1 (queue), §2 (approval detail), §3 (manual classify).

**Tech Stack:** React 18, TypeScript, Vite, Tailwind 3 (foundation tokens), react-router-dom v7 (data mode), @tanstack/react-query v5, vaul (Sheet), sonner (toasts), @radix-ui/react-alert-dialog (ConfirmDialog), vitest + @testing-library/react (jsdom). All already installed by Plan 01 — no new dependencies.

## Reality of the server contract (read this before touching any task)

These facts were verified against `packages/server/src` and BIND every task below:

1. **Approve is NOT undoable.** `POST /api/approvals/:id/approve` posts the underlying voucher inside the same transaction (`approvals/approvals.service.ts:143-277` — `statusTransition` pending→posted + `postingService.postVoucherTx` + approval→approved, atomically). Posted objects are immutable (ADR-0009). The spec's "Approve is one tap + Undo" therefore degrades exactly like Plan 02's create&match did: **approve stays one tap, the receipt toast has NO Undo button** ("Approved & posted · −89.00 €"); recovery is the correction flow (Books plan). Approve is idempotent server-side (re-approving an approved approval returns the existing voucher, no double-post).
2. **The approval path is `approveApproval` — never `postExpense`.** A held object is `pending`, and `POST /api/expenses/:id/post` claims draft→posted only; on a pending expense it 409s (`ledger/status/status-transition.service.ts` guarded transition). This is the documented API trap the spec calls out: the Inbox NEVER calls `postExpense`; the only posting seam it touches is `POST /api/approvals/:id/approve`.
3. **Reject requires a reason and returns the object to draft.** `RejectDto` is `{ rejected_reason: z.string() }` — the KEY is mandatory but zod accepts an empty string (`approvals/types.ts:77-81`), so the client enforces non-empty. For `expense`/`sales_invoice`/`allowance` the object transitions back to `draft` with the reason persisted (`approvals.service.ts:314-383`, ADR-0015 — nothing is deleted); for `reconciliation_match` rejecting DISCARDS the draft match link (ledger-neutral, `approvals.service.ts:325-338`). Reject is not undoable either (re-submitting means re-running the posting pipeline) — it is a deliberate sheet with a mandatory reason field, not an optimistic toast.
4. **`object_type` domain is `expense | sales_invoice | allowance | reconciliation_match`** (`approvals/types.ts:19-23`). All four appear in `GET /api/approvals/pending`. The queue and the detail screen must render every one safely: expense/invoice get full facts; `reconciliation_match` (staged by Bank flows; carries NO `policy_reason` — the reconciliation engine inserts the approval row without one, `reconciliation/reconciliation.service.ts:936-948`) and `allowance` get a generic fact card (requested-by, waiting-since, honest hint) — no crash, approve/reject fully functional.
5. **`policy_reason` strings DO carry the real numbers** — the "89.00 € above the 50.00 € limit" rendering is achievable from persisted data. Verified generators (`policy/policy.service.ts`): `Voucher amount ${cents} exceeds ceiling ${cents}` (line 97; both sides base-currency integer cents — `auto_post_amount_ceiling` is cents per `policy/types.ts:25-26`), `AI confidence ${x} below threshold ${y}` (line 107), `Unknown supplier requires approval` (line 119), `Structural/hard rule failure: …` (line 70), `Semantic rule failure: …` (line 84). The humanizer parses the PERSISTED string (the fact at hold time) rather than joining against `getPolicyConfig` (the config may have changed since the hold); unparseable strings render verbatim (still human-readable English).
6. **The needs-triage list is newest-first and amount-less.** `GET /api/triage/needs-triage` orders `created_at DESC` (`triage/triage.service.ts:38-64`) — the client re-sorts oldest-first (FIFO). `NeedsTriageItem` is `{ id, filename, created_at, reason, reason_type }` — NO amount, NO counterparty (the mockup's "−48.20 €" on triage rows is not renderable from the list; amounts appear once the detail fetches persisted classification). `reason` is a human-readable English sentence (e.g. `AI confidence 0.41 below threshold 0.8`, `Not a business accounting document — …`); `reason_type` is derived server-side by `classifyReasonType` (`triage/types.ts:239-267`).
7. **`completeDocument` ("Dismiss") archives without creating anything** — sets document status `processed` and clears the pending triage result (`triage/triage.controller.ts:126-137`). There is no un-complete endpoint → Dismiss gets a ConfirmDialog, not an Undo toast. **`retryDocument`** resets a `needs_triage` document to `pending` so the intake queue re-runs OCR+LLM (idempotent, `documents/documents.controller.ts:283-295`); the result lands minutes later — which is exactly why the queue polls.
8. **`getDocumentReclassify` ALWAYS re-runs OCR+LLM** (`triage/triage.controller.ts:51-63`) — it is the sanctioned prefill source for the manual-classify form (the legacy `TriageManualForm` already uses it), but it must be fetched ONCE per sheet-open (`staleTime: Infinity` on its query; React Query dedupes the StrictMode double-mount). Read-only facts on the triage detail screen come from `getDocumentDetails` (persisted artifacts only, ADR-0039).
9. **`GET /api/expenses/:id` exists and returns the full expense row** — including `document_id`, `ai_confidence`, `supplier_invoice_number` (`expenses/expenses.controller.ts:46-54`, `expenses/types.ts:7-31`) but NOT `reconciled` (that flag is a list-endpoint enrichment only, `expenses/expenses.service.ts:63-75`). **There is NO `GET /api/sales-invoices/:id`** (`sales-invoices/sales-invoices.controller.ts` — list/create/generate-draft/send/post only) — invoice approval facts come from finding the row in `getInvoices()`.
10. **Classification memory is not exposed** — no endpoint returns per-supplier category history directly. However `getExpenses()` returns every expense with `supplier_id` + `category`, so the "usually X · N of M" hint IS computable client-side from real data; that is the honest implementation used here (and the category chips order by recency from the same list).
11. **Polling rule (conflict with Plan 02 resolved):** Plan 02's constraint said the import job is the ONLY `refetchInterval`. The spec mandates a live Inbox queue (OCR/retry outcomes land minutes later; approvals appear from Bank flows). Resolution: **the import job's 1.5s remains the only FAST poll; the two Inbox list queries get a modest 30s `refetchInterval` that is active only while an Inbox route is mounted.** Mechanism: `refetchInterval` is a per-observer option in TanStack Query v5 — the Inbox screens subscribe with `poll: true` (30 000 ms); the always-mounted badge hook subscribes to the SAME query keys without an interval, so no polling happens outside the Inbox section, yet the badge updates instantly from the shared cache whenever the Inbox refetches (plus the global `refetchOnWindowFocus` + 15s `staleTime` keep it honest elsewhere). The Plan-02 constraint is superseded by the wording in Global Constraints below.
12. **Upload + auto-triage choreography** (kept from `IntakeView`): `uploadDocument(file)` (multipart, may dedupe) → `triageDocument(id)` → `TriageOutcome` (`expense | invoice | bank_statement | unknown`). `POST /api/documents/:id/triage` runs the full pipeline synchronously (can take a minute+); the Inbox keeps a minimal upload affordance with a busy state and outcome toast — the full upload flow (claimant dropdown etc., ADR-0036) belongs to the Books plan.

## Global Constraints

- Working directory for all commands: `packages/web` (repo root: `/Users/alekseirevin/test/headless-bookkeeping.spa-redesign-foundation`).
- Test command: `npx vitest run <file>`; full suite: `npm test`; lint: `npm run lint`; build (typecheck + bundle): `npm run build`.
- **Routes (binding):** `/inbox` (unified queue; segment in `?seg=all|triage|approvals`, default `all`; legacy `?tab=` accepted as an alias), `/inbox/doc/:id` (triage detail), `/inbox/approval/:id` (approval detail). Legacy `/intake?expand=N` must land on `/inbox/doc/N` (redirect chain: `/intake` → `/inbox?seg=triage&expand=N` → in-screen `Navigate` to `/inbox/doc/N`). Legacy `/approvals` → `/inbox?seg=approvals`.
- **Polling (supersedes Plan 02's wording):** fast polling (≤10s) remains exclusive to the bank import job (1.5s, `queries/bank.ts`). The Inbox queue lists (`needs-triage`, `approvals/pending`) poll at `INBOX_REFETCH_MS = 30_000` ONLY via observers mounted by Inbox-route screens (`poll: true`); every other observer of those keys (the badge) subscribes without an interval. No other `refetchInterval` anywhere.
- **Colors through tokens** (`bg-surface`, `text-ink-2`, `text-ok`, `bg-warn-bg`, `border-line`, `bg-accent`, `bg-accent-deep`, `bg-alert`, `text-signal`, …). Sanctioned one-offs (approved mockups, no token): icon tints `bg-[#E3EFE8]` (approval ✓), secondary-button grey `bg-[#E9EBE7]` (kit), hero CTA `bg-signal text-accent-deep`.
- **Anti-overlap rules (binding):** amounts never wrap (`flex-none whitespace-nowrap tabular-nums` — `AmountText` + `flex-none` containers); titles/subtitles single-line `truncate`; left column `min-w-0 flex-1`, right column `flex-none`.
- **Screen invariants:** exactly ONE primary button per state and its label states the outcome **with the amount** where one exists ("Approve · −89.00 €", "Create expense · −48.20 €" — never "Submit"); reasons are human sentences with numbers, never reason codes; IDs are not data (no "#214" in titles; ids live in URLs); dates relative in lists, absolute in details; low confidence shown, high confidence hidden in the queue (confidence appears in detail facts regardless).
- UI copy is **English** (Russian in the mockups is design annotation): "Inbox", "All"/"Triage"/"Approvals", "Today"/"Earlier", "approve?"/"resolve"/"classify"/"retry", "Why held", "Approve", "Reject…", "Reject & return to draft", "Resolve supplier…", "Create expense · −X €", "Record invoice · +X €", "Dismiss", "Retry AI", "Upload", "Inbox zero".
- Money **inputs are euros** via `eurosToCents`/`centsToEuroInput` (`src/lib/money.ts`); the API speaks integer cents; display via `AmountText`/`fmtCents`. VAT prefill uses `vatFromGross` + `STANDARD_VAT_RATE_PCT` (22, `src/bank/format.ts` — same degradation as Plan 02 gap 5; the field stays editable).
- **Never** `window.prompt/confirm/alert`. Never render voucher/account/debit/credit words (ADR-0001/0030). Destructive/non-reversible actions (Dismiss, Delete file) go through `ConfirmDialog`; approve/reject are non-optimistic mutations with receipt toasts (see Reality #1/#3).
- `approved_by` for approve calls is the literal `'operator'` (matches legacy + Plan 02 usage).
- Cross-domain query keys come from `src/queries/keys.ts` after Task 3 — the literals `['entities']`, `['categories']`, `['organization']` are frozen (cache compatibility with `queries/bank.ts` consumers).
- Test mocking rule for inbox modules: `src/inbox/reason.ts` imports the REAL `fmtCents` from `../api`, so tests mock the api module with the spread-importOriginal pattern (`vi.mock('../api', async (io) => ({ ...(await io<typeof import('../api')>()), <fn>: vi.fn(), … }))`) instead of a bare object literal.
- Commit style: `feat(web): …`, one commit per task. React StrictMode double-mount safe (all effects with cleanup; one-shot fetches via React Query).
- Legacy `IntakeView.tsx`/`ApprovalsView.tsx` (+tests) are untouched until Task 15 deletes them; every intermediate task leaves the full suite green.

---

### Task 1: API transport addition — `getExpense` / `ExpenseDetail`

**Files:**
- Modify: `packages/web/src/api.ts`
- Test: `packages/web/src/api.inbox.test.ts` (new)

**Interfaces:**
- Consumes: existing `apiFetch`.
- Produces (from `src/api.ts`):
  - `interface ExpenseDetail { id: number; document_id: number | null; supplier_id: number | null; category: string; gross_amount: number; vat_amount: number; currency: string; tax_point_date: string; status: string; supplier_invoice_number: string | null; ai_confidence: number | null }` — display subset of the single-expense response (Reality #9: `document_id` + `ai_confidence` are what the approval detail renders; deliberately NOT extending `Expense` because the single fetch has no `reconciled` flag).
  - `getExpense(id: number): Promise<ExpenseDetail>` — `GET /api/expenses/:id` (unwrapped object).

- [ ] **Step 1: Write failing tests**

`src/api.inbox.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import { getExpense } from './api';

describe('inbox api additions', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('getExpense GETs the single-expense endpoint and returns the detail subset', async () => {
    const body = JSON.stringify({
      id: 214,
      document_id: 88,
      supplier_id: 3,
      category: 'software',
      gross_amount: 8900,
      vat_amount: 1632,
      currency: 'EUR',
      tax_point_date: '2026-07-03',
      status: 'pending',
      supplier_invoice_number: 'A-183',
      ai_confidence: 0.94,
      voucher_id: null,
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status: 200 }));
    const res = await getExpense(214);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/expenses/214');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(res.document_id).toBe(88);
    expect(res.ai_confidence).toBe(0.94);
    expect(res.gross_amount).toBe(8900);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/api.inbox.test.ts
```

Expected: FAIL — `getExpense` is not exported from `./api`.

- [ ] **Step 3: Implement in `src/api.ts`**

Insert after the `getExpenses` export block (below the `getCategories` helper is fine too — keep it adjacent to the expenses reads):

```ts
/**
 * Single-expense detail (GET /api/expenses/:id). Display subset for the
 * approval detail screen: adds document_id + ai_confidence, which the list
 * subset (Expense) deliberately omits. NOT extending Expense: the single
 * fetch carries no `reconciled` flag (that is a list-endpoint enrichment).
 * voucher_id stays off the typed surface (ADR-0001/ADR-0030).
 */
export interface ExpenseDetail {
  id: number;
  document_id: number | null;
  supplier_id: number | null;
  category: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: string;
  supplier_invoice_number: string | null;
  ai_confidence: number | null;
}

export const getExpense = (id: number) =>
  apiFetch<ExpenseDetail>(`/api/expenses/${id}`);
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/api.inbox.test.ts && npm test
```

Expected: PASS (1 test); full suite PASS (pure addition).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/api.inbox.test.ts
git commit -m "feat(web): inbox API transport — single-expense detail wrapper"
```

---

### Task 2: `LinkButton` ui-kit component (Plan 02 deferral) + adopt at the two duplicated call sites

**Files:**
- Create: `packages/web/src/ui/LinkButton.tsx`
- Modify: `packages/web/src/bank/StatementsScreen.tsx` (empty-state CTA), `packages/web/src/bank/ImportScreen.tsx` ("Open statement")
- Test: `packages/web/src/ui/LinkButton.test.tsx` (new)

**Interfaces:**
- Consumes: `react-router-dom` `Link`.
- Produces: `LinkButton({ to, variant?, className?, children }: { to: string; variant?: 'primary' | 'secondary'; className?: string; children: ReactNode }): JSX.Element` — a `Link` (always `viewTransition`) styled exactly like the kit `Button` (`rounded-xl px-4 py-2.5 text-[15px] font-bold` + variant colors), replacing the two raw-`Link`-as-button duplications from Plan 02 (`bank/StatementsScreen.tsx:53-59`, `bank/ImportScreen.tsx:180-187`).

- [ ] **Step 1: Write failing tests**

`src/ui/LinkButton.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { LinkButton } from './LinkButton';

describe('LinkButton', () => {
  it('renders a link styled as a primary button', () => {
    render(
      <MemoryRouter>
        <LinkButton to="/bank/import">Import statement</LinkButton>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Import statement' });
    expect(link).toHaveAttribute('href', '/bank/import');
    expect(link.className).toContain('bg-accent');
    expect(link.className).toContain('rounded-xl');
  });

  it('supports the secondary variant and extra classes', () => {
    render(
      <MemoryRouter>
        <LinkButton to="/x" variant="secondary" className="mt-3">
          Back
        </LinkButton>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Back' });
    expect(link.className).toContain('bg-[#E9EBE7]');
    expect(link.className).toContain('mt-3');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ui/LinkButton.test.tsx
```

Expected: FAIL — `./LinkButton` not found.

- [ ] **Step 3: Implement**

`src/ui/LinkButton.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'primary' | 'secondary';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white',
  secondary: 'bg-[#E9EBE7] text-ink',
};

/** A route navigation styled as a kit Button (mirror of ui/Button styles).
 *  Use when a "button" is really a Link — never window.location, never a
 *  button+navigate pair. Always animates with viewTransition. */
export function LinkButton({
  to,
  variant = 'primary',
  className = '',
  children,
}: {
  to: string;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      viewTransition
      className={`inline-block rounded-xl px-4 py-2.5 text-center text-[15px] font-bold ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}
```

In `src/bank/StatementsScreen.tsx`, replace the empty-state action Link:

```tsx
          action={
            <Link
              to="/bank/import"
              viewTransition
              className="inline-block rounded-xl bg-accent px-4 py-2.5 text-[15px] font-bold text-white"
            >
              Import statement
            </Link>
          }
```

with:

```tsx
          action={<LinkButton to="/bank/import">Import statement</LinkButton>}
```

adding `import { LinkButton } from '../ui/LinkButton';` (the header "Import" text link at the top of the file is a header ACTION, not a button — it stays a raw Link).

In `src/bank/ImportScreen.tsx`, replace the "Open statement" Link:

```tsx
              <Link
                to={`/bank/statements/${job.statement_id}`}
                viewTransition
                className="block h-[46px] rounded-xl bg-accent text-center text-[14px] font-bold leading-[46px] text-white"
              >
                Open statement
              </Link>
```

with:

```tsx
              <LinkButton
                to={`/bank/statements/${job.statement_id}`}
                className="block"
              >
                Open statement
              </LinkButton>
```

adding the import (remove the now-unused `Link` import from ImportScreen if nothing else uses it — check with the linter).

- [ ] **Step 4: Run the new test, the two bank screen tests, then the full suite**

```bash
npx vitest run src/ui/LinkButton.test.tsx src/bank/StatementsScreen.test.tsx src/bank/ImportScreen.test.tsx && npm test
```

Expected: PASS — the bank tests assert by role/name (`link`, `/import/i`, "Open statement"), which the LinkButton preserves.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/ui/LinkButton.tsx packages/web/src/ui/LinkButton.test.tsx packages/web/src/bank/StatementsScreen.tsx packages/web/src/bank/ImportScreen.tsx
git commit -m "feat(web): LinkButton ui-kit component, adopt at bank call sites (Plan 02 deferral)"
```

---

### Task 3: Shared cross-domain query keys + read hooks (Plan 02 deferral)

**Files:**
- Create: `packages/web/src/queries/keys.ts`
- Create: `packages/web/src/queries/shared.ts`
- Modify: `packages/web/src/queries/bank.ts` (drop inline literals, re-export moved hooks)
- Test: `packages/web/src/queries/shared.test.tsx` (new)

**Interfaces:**
- Produces (`src/queries/keys.ts`):
  - `sharedKeys = { entities: ['entities'], categories: ['categories'], organization: ['organization'], expenses: ['expenses'], invoices: ['invoices'], reportingPeriods: ['reporting-periods'] } as const` — the first three literals are FROZEN (they must equal the strings previously inline in `queries/bank.ts` so existing caches/invalidations stay compatible); the last three are new, chosen to be the natural keys the Books/Reports plans will adopt.
- Produces (`src/queries/shared.ts`):
  - `useCategories()`, `useSuppliers()` (entities filtered `role === 'supplier'`), `useCustomers()` (`role === 'customer'`), `useEntities()`, `useOrganizationCountry()`, `useExpenses()`, `useInvoices()`, `useReportingPeriods()` — all `useQuery` wrappers over the existing api fns, keyed by `sharedKeys`.
- Modifies (`src/queries/bank.ts`): the local `useCategories`/`useSuppliers`/`useOrganizationCountry` definitions are REPLACED by re-exports from `./shared` (`export { useCategories, useSuppliers, useOrganizationCountry } from './shared';`) so every bank-screen import keeps working unchanged.

- [ ] **Step 1: Write failing tests**

`src/queries/shared.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getOrganization: vi.fn(),
  getReportingPeriods: vi.fn(),
}));

import * as api from '../api';
import { sharedKeys } from './keys';
import { useCustomers, useSuppliers } from './shared';

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
  return { client, wrapper };
}

describe('shared query keys', () => {
  it('preserves the exact legacy literals for cache compatibility', () => {
    expect(sharedKeys.entities).toEqual(['entities']);
    expect(sharedKeys.categories).toEqual(['categories']);
    expect(sharedKeys.organization).toEqual(['organization']);
  });
});

describe('shared hooks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('useSuppliers and useCustomers share ONE entities cache entry and filter by role', async () => {
    vi.mocked(api.getEntities).mockResolvedValue([
      { id: 1, role: 'supplier', country: 'EE', name: 'Wolt', goods_vs_services: null },
      { id: 2, role: 'customer', country: 'EE', name: 'Nordic', goods_vs_services: null },
    ]);
    const { client, wrapper } = makeWrapper();
    const suppliers = renderHook(() => useSuppliers(), { wrapper });
    const customers = renderHook(() => useCustomers(), { wrapper });
    await waitFor(() => expect(suppliers.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(customers.result.current.isSuccess).toBe(true));
    expect(api.getEntities).toHaveBeenCalledTimes(1); // one cache entry
    expect(suppliers.result.current.data).toEqual([
      expect.objectContaining({ name: 'Wolt' }),
    ]);
    expect(customers.result.current.data).toEqual([
      expect.objectContaining({ name: 'Nordic' }),
    ]);
    expect(client.getQueryData(sharedKeys.entities)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/queries/shared.test.tsx
```

Expected: FAIL — `./keys` / `./shared` not found.

- [ ] **Step 3: Implement**

`src/queries/keys.ts`:

```ts
/**
 * Cross-domain query keys — the single source of truth once more than one
 * domain reads the same resource (bank + inbox both need entities/categories/
 * organization; inbox adds expenses/invoices/reporting-periods that Books and
 * Reports will adopt).
 *
 * COMPATIBILITY: entities/categories/organization literals predate this
 * factory (inline in queries/bank.ts since Plan 02) and MUST stay
 * byte-identical — existing invalidations and cached data key off them.
 */
export const sharedKeys = {
  entities: ['entities'] as const,
  categories: ['categories'] as const,
  organization: ['organization'] as const,
  expenses: ['expenses'] as const,
  invoices: ['invoices'] as const,
  reportingPeriods: ['reporting-periods'] as const,
};
```

`src/queries/shared.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import {
  getCategories,
  getEntities,
  getExpenses,
  getInvoices,
  getOrganization,
  getReportingPeriods,
} from '../api';
import { sharedKeys } from './keys';

/** Cross-domain read hooks. Role-filtered entity views share ONE cache entry
 *  (same queryKey, different select). */
export const useCategories = () =>
  useQuery({ queryKey: sharedKeys.categories, queryFn: getCategories });

export const useEntities = () =>
  useQuery({ queryKey: sharedKeys.entities, queryFn: getEntities });

export const useSuppliers = () =>
  useQuery({
    queryKey: sharedKeys.entities,
    queryFn: getEntities,
    select: (entities) => entities.filter((e) => e.role === 'supplier'),
  });

export const useCustomers = () =>
  useQuery({
    queryKey: sharedKeys.entities,
    queryFn: getEntities,
    select: (entities) => entities.filter((e) => e.role === 'customer'),
  });

export const useOrganizationCountry = () =>
  useQuery({
    queryKey: sharedKeys.organization,
    queryFn: getOrganization,
    select: (org) => org.country,
  });

export const useExpenses = () =>
  useQuery({ queryKey: sharedKeys.expenses, queryFn: getExpenses });

export const useInvoices = () =>
  useQuery({ queryKey: sharedKeys.invoices, queryFn: getInvoices });

export const useReportingPeriods = () =>
  useQuery({
    queryKey: sharedKeys.reportingPeriods,
    queryFn: getReportingPeriods,
  });
```

In `src/queries/bank.ts`: delete the three local hook definitions —

```ts
export const useCategories = () =>
  useQuery({ queryKey: ['categories'], queryFn: getCategories });

export const useSuppliers = () =>
  useQuery({
    queryKey: ['entities'],
    queryFn: getEntities,
    select: (entities) => entities.filter((e) => e.role === 'supplier'),
  });

export const useOrganizationCountry = () =>
  useQuery({
    queryKey: ['organization'],
    queryFn: getOrganization,
    select: (org) => org.country,
  });
```

— and add in their place:

```ts
// Cross-domain reads moved to the shared layer (Plan 03); re-exported so bank
// screens' imports keep working. Keys unchanged (see queries/keys.ts).
export { useCategories, useOrganizationCountry, useSuppliers } from './shared';
```

Then remove `getCategories`, `getEntities`, `getOrganization` from bank.ts's `../api` import list (they are no longer referenced there).

- [ ] **Step 4: Run the new test, the bank query tests, then the full suite**

```bash
npx vitest run src/queries/shared.test.tsx src/queries/bank.test.tsx && npm test
```

Expected: PASS. Note: `queries/bank.test.tsx` mocks `../api` with an object literal that includes `getCategories`/`getEntities`/`getOrganization` — the re-export chain (`bank.ts` → `shared.ts` → `../api`) resolves through the same mock, so it keeps passing unmodified.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/queries
git commit -m "feat(web): shared cross-domain query-key factory and read hooks (Plan 02 deferral)"
```

---

### Task 4: Humanized reasons + inbox formatting helpers

**Files:**
- Create: `packages/web/src/inbox/reason.ts`
- Create: `packages/web/src/inbox/format.ts`
- Test: `packages/web/src/inbox/reason.test.ts`, `packages/web/src/inbox/format.test.ts`

**Interfaces:**
- Produces (`src/inbox/reason.ts`):
  - `humanizePolicyReason(policyReason: string | null): string` — parses the verified server strings (Reality #5) into human English with euro amounts: `"Voucher amount 8900 exceeds ceiling 5000"` → `"89.00 € above the 50.00 € auto-post limit"`; `"AI confidence 0.41 below threshold 0.8"` → `"AI confidence 0.41 — below the 0.8 auto-post threshold"`; unknown-supplier and rule-failure variants; `null` (reconciliation_match) → `"Held for your approval"`; anything else verbatim.
  - `triageSubtitle(item: Pick<NeedsTriageItem, 'reason' | 'reason_type'>): string` — one-line human reason per `reason_type`, extracting confidence numbers from the server sentence where present.
  - `triageChipLabel(rt: TriageReasonType | null): string` — queue chip verbs (`resolve`/`classify`/`invoice`/`retry`/`junk`/`review`).
  - `outcomeText(o: TriageOutcome): string` — receipt copy for upload/triage outcomes (no IDs — IDs are not data).
- Produces (`src/inbox/format.ts`):
  - `absoluteDate(unixSecs: number): string` — `03.07.2026` (details use absolute dates).
  - `absoluteDateFromIso(iso: string): string` — `"2026-07-03"` → `"03.07.2026"`.
  - `vatRatePct(grossCents: number, vatCents: number): number | null` — implied percent from VAT-inclusive facts (`Math.round(vat / (gross − vat) × 100)`); `null` when not computable.

- [ ] **Step 1: Write failing tests**

`src/inbox/reason.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  humanizePolicyReason,
  outcomeText,
  triageChipLabel,
  triageSubtitle,
} from './reason';

describe('humanizePolicyReason', () => {
  it('renders the amount-ceiling hold with euro amounts from the persisted cents', () => {
    expect(humanizePolicyReason('Voucher amount 8900 exceeds ceiling 5000')).toBe(
      '89.00 € above the 50.00 € auto-post limit',
    );
  });
  it('renders the confidence hold with the real numbers', () => {
    expect(humanizePolicyReason('AI confidence 0.41 below threshold 0.8')).toBe(
      'AI confidence 0.41 — below the 0.8 auto-post threshold',
    );
  });
  it('renders the unknown-supplier hold', () => {
    expect(humanizePolicyReason('Unknown supplier requires approval')).toBe(
      'Unknown supplier — policy requires your approval',
    );
  });
  it('unwraps rule failures', () => {
    expect(
      humanizePolicyReason('Semantic rule failure: VAT exceeds gross'),
    ).toBe('Rule check failed: VAT exceeds gross');
  });
  it('falls back to a generic line for null (reconciliation_match carries no reason)', () => {
    expect(humanizePolicyReason(null)).toBe('Held for your approval');
  });
  it('passes unknown strings through verbatim', () => {
    expect(humanizePolicyReason('Some future policy text')).toBe(
      'Some future policy text',
    );
  });
});

describe('triageSubtitle', () => {
  it('extracts the confidence numbers for low_confidence', () => {
    expect(
      triageSubtitle({
        reason: 'AI confidence 0.41 below threshold 0.8',
        reason_type: 'low_confidence',
      }),
    ).toBe('AI confidence 0.41 — below the 0.8 threshold, check the result');
  });
  it('falls back to a fixed line when low_confidence has no numbers', () => {
    expect(
      triageSubtitle({
        reason: 'AI could not classify the document',
        reason_type: 'low_confidence',
      }),
    ).toBe('AI was not confident — check the result');
  });
  it('maps the other reason types to human questions', () => {
    expect(
      triageSubtitle({ reason: 'x', reason_type: 'supplier_unresolved' }),
    ).toBe('Unknown supplier — who is this?');
    expect(
      triageSubtitle({ reason: 'x', reason_type: 'outgoing_invoice' }),
    ).toBe('Looks like your outgoing invoice — confirm it');
    expect(triageSubtitle({ reason: 'x', reason_type: 'ocr_failed' })).toBe(
      'OCR could not read the file — retry or replace',
    );
    expect(
      triageSubtitle({ reason: 'x', reason_type: 'not_a_document' }),
    ).toBe('Does not look like a business document');
  });
  it('shows the server sentence for unknown types', () => {
    expect(
      triageSubtitle({ reason: 'Held for human review', reason_type: 'unknown' }),
    ).toBe('Held for human review');
  });
});

describe('triageChipLabel / outcomeText', () => {
  it('maps reason types to chip verbs', () => {
    expect(triageChipLabel('supplier_unresolved')).toBe('resolve');
    expect(triageChipLabel('low_confidence')).toBe('classify');
    expect(triageChipLabel('outgoing_invoice')).toBe('invoice');
    expect(triageChipLabel('ocr_failed')).toBe('retry');
    expect(triageChipLabel(null)).toBe('review');
  });
  it('describes triage outcomes without IDs', () => {
    expect(
      outcomeText({ kind: 'expense', document_id: 1, expense_id: 2 }),
    ).toBe('Expense created from the document');
    expect(
      outcomeText({ kind: 'bank_statement', document_id: 1, job_id: 9 }),
    ).toBe('Bank statement — import started');
    expect(
      outcomeText({ kind: 'unknown', document_id: 1, reason: 'blurred scan' }),
    ).toBe('Still needs review: blurred scan');
  });
});
```

`src/inbox/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { absoluteDate, absoluteDateFromIso, vatRatePct } from './format';

describe('absolute dates', () => {
  it('formats unix seconds as dd.mm.yyyy', () => {
    // 2026-07-03T10:00:00Z
    expect(absoluteDate(Date.UTC(2026, 6, 3, 12) / 1000)).toMatch(
      /^0?3\.07\.2026$/,
    );
  });
  it('formats ISO dates as dd.mm.yyyy', () => {
    expect(absoluteDateFromIso('2026-07-03')).toBe('03.07.2026');
  });
});

describe('vatRatePct', () => {
  it('derives the implied rate from VAT-inclusive facts', () => {
    expect(vatRatePct(8900, 1605)).toBe(22); // 1605 / 7295 ≈ 0.22
  });
  it('returns null when not computable', () => {
    expect(vatRatePct(0, 0)).toBeNull();
    expect(vatRatePct(100, 100)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/inbox/reason.test.ts src/inbox/format.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/inbox/reason.ts`:

```ts
import { fmtCents, type TriageOutcome, type TriageReasonType } from '../api';
import type { NeedsTriageItem } from '../api';

/**
 * Reasons in human language with numbers (spec data rule 3): parse the
 * PERSISTED policy_reason strings (the fact at hold time — the live policy
 * config may have changed since) and render threshold + fact, never a code.
 * Verified generators: packages/server/src/policy/policy.service.ts:70,84,97,107,119.
 */
const CEILING_RE = /^Voucher amount (\d+) exceeds ceiling (\d+)$/;
const CONFIDENCE_RE = /^AI confidence ([\d.]+) below threshold ([\d.]+)$/;
const RULE_RE = /^(?:Structural\/hard|Semantic) rule failure: (.*)$/;

export function humanizePolicyReason(policyReason: string | null): string {
  if (policyReason === null) return 'Held for your approval';
  const ceiling = CEILING_RE.exec(policyReason);
  if (ceiling) {
    return `${fmtCents(Number(ceiling[1]))} € above the ${fmtCents(
      Number(ceiling[2]),
    )} € auto-post limit`;
  }
  const confidence = CONFIDENCE_RE.exec(policyReason);
  if (confidence) {
    return `AI confidence ${confidence[1]} — below the ${confidence[2]} auto-post threshold`;
  }
  if (policyReason === 'Unknown supplier requires approval') {
    return 'Unknown supplier — policy requires your approval';
  }
  const rule = RULE_RE.exec(policyReason);
  if (rule) return `Rule check failed: ${rule[1]}`;
  return policyReason;
}

/** Needs-triage one-liner: the reason as a human question/instruction,
 *  keeping the numbers where the server sentence carries them. */
const TRIAGE_CONFIDENCE_RE = /confidence ([\d.]+) below threshold ([\d.]+)/i;

export function triageSubtitle(
  item: Pick<NeedsTriageItem, 'reason' | 'reason_type'>,
): string {
  switch (item.reason_type) {
    case 'supplier_unresolved':
      return 'Unknown supplier — who is this?';
    case 'outgoing_invoice':
      return 'Looks like your outgoing invoice — confirm it';
    case 'low_confidence': {
      const m = TRIAGE_CONFIDENCE_RE.exec(item.reason);
      return m
        ? `AI confidence ${m[1]} — below the ${m[2]} threshold, check the result`
        : 'AI was not confident — check the result';
    }
    case 'category_unresolved':
      return 'Category not recognized — pick one';
    case 'ocr_failed':
      return 'OCR could not read the file — retry or replace';
    case 'not_a_document':
      return 'Does not look like a business document';
    case 'unimplemented':
      return 'Recognized, but not supported yet — handle manually';
    default:
      return item.reason;
  }
}

export function triageChipLabel(rt: TriageReasonType | null): string {
  switch (rt) {
    case 'supplier_unresolved':
      return 'resolve';
    case 'low_confidence':
    case 'category_unresolved':
      return 'classify';
    case 'outgoing_invoice':
      return 'invoice';
    case 'ocr_failed':
      return 'retry';
    case 'not_a_document':
      return 'junk';
    default:
      return 'review';
  }
}

/** Receipt copy for triage/upload outcomes. No raw IDs (data rule 1). */
export function outcomeText(o: TriageOutcome): string {
  switch (o.kind) {
    case 'expense':
      return 'Expense created from the document';
    case 'invoice':
      return 'Sales invoice recorded';
    case 'bank_statement':
      return 'Bank statement — import started';
    default:
      return `Still needs review: ${o.reason}`;
  }
}
```

`src/inbox/format.ts`:

```ts
/** Detail screens show ABSOLUTE dates (lists show relative — data rule 5). */
const pad2 = (n: number) => String(n).padStart(2, '0');

export function absoluteDate(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function absoluteDateFromIso(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Implied VAT percent from VAT-inclusive facts: vat / (gross − vat).
 *  Display-only ("16.32 € (22%)"); null when the division is meaningless. */
export function vatRatePct(
  grossCents: number,
  vatCents: number,
): number | null {
  const net = grossCents - vatCents;
  if (net <= 0 || vatCents < 0) return null;
  return Math.round((vatCents / net) * 100);
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/inbox/reason.test.ts src/inbox/format.test.ts && npm test
```

Expected: PASS (16 tests across the two files); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/inbox
git commit -m "feat(web): inbox humanized reasons (numbers from persisted policy strings) and detail formatting"
```

---

### Task 5: Inbox query layer + pure queue model

**Files:**
- Create: `packages/web/src/queries/inbox.ts`
- Test: `packages/web/src/queries/inbox.test.tsx`

**Interfaces:**
- Consumes: `getNeedsTriageItems`, `getPendingApprovals`, `getExpense` (api), `sharedKeys` (queries/keys).
- Produces (all from `src/queries/inbox.ts`):
  - `INBOX_REFETCH_MS = 30_000`; `inboxRefetchInterval(poll: boolean): number | false` — the polling-rule seam (Reality #11).
  - `inboxKeys` — `needsTriage`, `approvals`, `docDetails(id)`, `reclassify(id)`, `pendingDraft(id)`, `approvalExpense(id)`, all under the `['inbox', …]` prefix (`inboxKeys.all`).
  - `useNeedsTriage({ poll? })` — FIFO-sorted (oldest first; the server sends newest-first, Reality #6).
  - `usePendingApprovals({ poll? })` — FIFO-sorted.
  - `useExpenseDetail(id: number | null)` — single-expense facts for the approval detail (enabled only with an id).
  - `type InboxSegment = 'all' | 'triage' | 'approvals'`; `type InboxEntry = { kind: 'triage'; createdAt: number; route: string; item: NeedsTriageItem } | { kind: 'approval'; createdAt: number; route: string; approval: Approval }`.
  - Pure functions: `buildQueue(triage, approvals, seg): InboxEntry[]` (merge + segment filter + FIFO sort), `startOfTodayUnix(now?)`, `splitTodayEarlier(entries, now?)`, `queuePosition(entries, route): { pos, total } | null` ("N of M"), `nextRouteAfter(entries, route): string` (auto-advance: the entry that followed; else the previous; else `/inbox`).
  - `useInboxQueue(seg, { poll? })` — composes the two list queries into `{ entries, counts: { triage, approvals }, triageQ, approvalsQ, isPending }`.
  - `useInboxCount(): number` — nav badge; SAME query keys, NO polling.
  - `approvalDisplay(a: Approval, ctx: { expenses; invoices; entities }): { title: string; amountCents: number | null }` — queue-row enrichment (expense → supplier name + negative gross; invoice → customer/invoice number + positive gross; `reconciliation_match`/`allowance` → safe generic titles).
  - `invalidateInbox(qc: QueryClient): Promise<void>` — invalidates `['inbox']` + `sharedKeys.expenses` + `sharedKeys.invoices`.

- [ ] **Step 1: Write failing tests**

`src/queries/inbox.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpense: vi.fn(),
}));

import * as api from '../api';
import type { Approval, NeedsTriageItem } from '../api';
import {
  INBOX_REFETCH_MS,
  approvalDisplay,
  buildQueue,
  inboxRefetchInterval,
  nextRouteAfter,
  queuePosition,
  splitTodayEarlier,
  useInboxCount,
  useNeedsTriage,
} from './inbox';

const T = (id: number, createdAt: number): NeedsTriageItem => ({
  id,
  filename: `doc-${id}.pdf`,
  created_at: createdAt,
  reason: 'AI confidence 0.41 below threshold 0.8',
  reason_type: 'low_confidence',
});

const A = (id: number, createdAt: number, over: Partial<Approval> = {}): Approval => ({
  id,
  object_type: 'expense',
  object_id: 100 + id,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: 'Voucher amount 8900 exceeds ceiling 5000',
  superseded_by: null,
  created_at: createdAt,
  resolved_at: null,
  ...over,
});

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('polling seam', () => {
  it('polls 30s only for Inbox-route observers', () => {
    expect(inboxRefetchInterval(true)).toBe(INBOX_REFETCH_MS);
    expect(INBOX_REFETCH_MS).toBe(30_000);
    expect(inboxRefetchInterval(false)).toBe(false);
  });
});

describe('buildQueue', () => {
  const triage = [T(1, 300), T(2, 100)];
  const approvals = [A(7, 200)];

  it('merges both sources FIFO oldest-first', () => {
    const q = buildQueue(triage, approvals, 'all');
    expect(q.map((e) => e.route)).toEqual([
      '/inbox/doc/2',
      '/inbox/approval/7',
      '/inbox/doc/1',
    ]);
  });

  it('filters by segment', () => {
    expect(buildQueue(triage, approvals, 'triage').every((e) => e.kind === 'triage')).toBe(true);
    expect(buildQueue(triage, approvals, 'approvals')).toHaveLength(1);
  });
});

describe('sections and progress', () => {
  const now = new Date('2026-07-09T10:00:00');
  const todayTs = Math.floor(new Date('2026-07-09T08:00:00').getTime() / 1000);
  const oldTs = Math.floor(new Date('2026-07-07T08:00:00').getTime() / 1000);
  const entries = buildQueue([T(1, oldTs), T(2, todayTs)], [], 'all');

  it('splits Today from Earlier at local midnight', () => {
    const { today, earlier } = splitTodayEarlier(entries, now);
    expect(today.map((e) => e.route)).toEqual(['/inbox/doc/2']);
    expect(earlier.map((e) => e.route)).toEqual(['/inbox/doc/1']);
  });

  it('computes N of M for a detail route', () => {
    expect(queuePosition(entries, '/inbox/doc/1')).toEqual({ pos: 1, total: 2 });
    expect(queuePosition(entries, '/inbox/doc/999')).toBeNull();
  });

  it('advances to the next pending, else previous, else the queue', () => {
    expect(nextRouteAfter(entries, '/inbox/doc/1')).toBe('/inbox/doc/2');
    expect(nextRouteAfter(entries, '/inbox/doc/2')).toBe('/inbox/doc/1');
    expect(nextRouteAfter([entries[0]], '/inbox/doc/1')).toBe('/inbox');
    expect(nextRouteAfter(entries, '/inbox/doc/404')).toBe('/inbox');
  });
});

describe('approvalDisplay', () => {
  const entities = [
    { id: 3, role: 'supplier', country: 'EE', name: 'Telia Eesti AS', goods_vs_services: null },
    { id: 4, role: 'customer', country: 'EE', name: 'Nordic Consulting', goods_vs_services: null },
  ];
  const expenses = [
    { id: 107, supplier_id: 3, category: 'software', gross_amount: 8900, vat_amount: 1632, currency: 'EUR', tax_point_date: '2026-07-03', status: 'pending', reconciled: false },
  ];
  const invoices = [
    { id: 55, customer_id: 4, invoice_number: '2026-018', gross_amount: 120000, vat_amount: 0, currency: 'EUR', tax_point_date: '2026-07-01', status: 'pending', sent_at: null, reconciled: false },
  ];

  it('titles an expense approval with the supplier and a negative amount', () => {
    expect(approvalDisplay(A(7, 1), { expenses, invoices, entities })).toEqual({
      title: 'Telia Eesti AS',
      amountCents: -8900,
    });
  });

  it('titles an invoice approval with the customer and a positive amount', () => {
    const a = A(8, 1, { object_type: 'sales_invoice', object_id: 55 });
    expect(approvalDisplay(a, { expenses, invoices, entities })).toEqual({
      title: 'Nordic Consulting',
      amountCents: 120000,
    });
  });

  it('renders reconciliation_match and allowance safely', () => {
    const m = A(9, 1, { object_type: 'reconciliation_match', object_id: 41, policy_reason: null });
    expect(approvalDisplay(m, { expenses, invoices, entities })).toEqual({
      title: 'Bank match',
      amountCents: null,
    });
    const al = A(10, 1, { object_type: 'allowance', object_id: 5 });
    expect(approvalDisplay(al, { expenses, invoices, entities }).title).toBe('Allowance');
  });

  it('falls back to the category when the expense row is not in the list yet', () => {
    expect(
      approvalDisplay(A(7, 1), { expenses: [], invoices, entities }).title,
    ).toBe('Expense');
  });
});

describe('hooks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('useNeedsTriage re-sorts the newest-first server list to FIFO', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([T(1, 300), T(2, 100)]);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useNeedsTriage(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((i) => i.id)).toEqual([2, 1]);
  });

  it('useInboxCount sums both queues without polling', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([T(1, 1), T(2, 2)]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([A(7, 3)]);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useInboxCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(3));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/queries/inbox.test.tsx
```

Expected: FAIL — `./inbox` not found.

- [ ] **Step 3: Implement `src/queries/inbox.ts`**

```ts
import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  getExpense,
  getNeedsTriageItems,
  getPendingApprovals,
  type Approval,
  type Entity,
  type Expense,
  type NeedsTriageItem,
  type SalesInvoice,
} from '../api';
import { sharedKeys } from './keys';

/**
 * Inbox data layer. The queue itself is a PURE merge of two server lists
 * (needs-triage documents + pending approvals) — kept as plain functions so
 * ordering, sections, and auto-advance are unit-testable without React.
 *
 * POLLING RULE (supersedes Plan 02's "import job is the only refetchInterval"):
 * the import job keeps the only FAST poll (1.5s); the two Inbox lists poll at
 * a modest 30s and ONLY while an Inbox route observes them — refetchInterval
 * is per-observer in TanStack Query v5, and the always-mounted badge observer
 * passes `false`, so no polling happens outside the Inbox section.
 */
export const INBOX_REFETCH_MS = 30_000;

export const inboxRefetchInterval = (poll: boolean): number | false =>
  poll ? INBOX_REFETCH_MS : false;

export const inboxKeys = {
  all: ['inbox'] as const,
  needsTriage: ['inbox', 'needs-triage'] as const,
  approvals: ['inbox', 'approvals', 'pending'] as const,
  docDetails: (id: number) => ['inbox', 'doc', id, 'details'] as const,
  reclassify: (id: number) => ['inbox', 'doc', id, 'reclassify'] as const,
  pendingDraft: (id: number) => ['inbox', 'doc', id, 'pending-draft'] as const,
  approvalExpense: (id: number) => ['inbox', 'approval-expense', id] as const,
};

const oldestFirst = <T extends { created_at: number }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.created_at - b.created_at);

/** Needs-triage list, FIFO (the server sends newest-first). */
export function useNeedsTriage(opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: inboxKeys.needsTriage,
    queryFn: getNeedsTriageItems,
    select: oldestFirst,
    refetchInterval: inboxRefetchInterval(opts.poll === true),
  });
}

/** Pending approvals, FIFO. */
export function usePendingApprovals(opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: inboxKeys.approvals,
    queryFn: getPendingApprovals,
    select: oldestFirst,
    refetchInterval: inboxRefetchInterval(opts.poll === true),
  });
}

/** Single-expense facts for the approval detail. */
export function useExpenseDetail(id: number | null) {
  return useQuery({
    queryKey: inboxKeys.approvalExpense(id ?? -1),
    queryFn: () => getExpense(id as number),
    enabled: id !== null,
  });
}

// ── Pure queue model ───────────────────────────────────────────────────────

export type InboxSegment = 'all' | 'triage' | 'approvals';

export type InboxEntry =
  | { kind: 'triage'; createdAt: number; route: string; item: NeedsTriageItem }
  | { kind: 'approval'; createdAt: number; route: string; approval: Approval };

/** Merge the two sources into ONE FIFO queue (oldest first — the queue must
 *  end; stuck items stay on top). Segment filters, never re-orders. */
export function buildQueue(
  triage: NeedsTriageItem[],
  approvals: Approval[],
  seg: InboxSegment,
): InboxEntry[] {
  const t: InboxEntry[] =
    seg === 'approvals'
      ? []
      : triage.map((item) => ({
          kind: 'triage' as const,
          createdAt: item.created_at,
          route: `/inbox/doc/${item.id}`,
          item,
        }));
  const a: InboxEntry[] =
    seg === 'triage'
      ? []
      : approvals.map((approval) => ({
          kind: 'approval' as const,
          createdAt: approval.created_at,
          route: `/inbox/approval/${approval.id}`,
          approval,
        }));
  return [...t, ...a].sort((x, y) => x.createdAt - y.createdAt);
}

export function startOfTodayUnix(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function splitTodayEarlier(
  entries: InboxEntry[],
  now: Date = new Date(),
): { today: InboxEntry[]; earlier: InboxEntry[] } {
  const cutoff = startOfTodayUnix(now);
  return {
    today: entries.filter((e) => e.createdAt >= cutoff),
    earlier: entries.filter((e) => e.createdAt < cutoff),
  };
}

/** "N of M" for the detail nav title. */
export function queuePosition(
  entries: InboxEntry[],
  route: string,
): { pos: number; total: number } | null {
  const i = entries.findIndex((e) => e.route === route);
  return i === -1 ? null : { pos: i + 1, total: entries.length };
}

/** Auto-advance: after deciding the item at `route`, go to the entry that
 *  followed it (same index once removed), else the previous one, else back
 *  to the queue. Callers compute this BEFORE mutating (the queue refetch
 *  will drop the decided entry). */
export function nextRouteAfter(entries: InboxEntry[], route: string): string {
  const i = entries.findIndex((e) => e.route === route);
  if (i === -1) return '/inbox';
  const rest = entries.filter((_, j) => j !== i);
  if (rest.length === 0) return '/inbox';
  return (rest[i] ?? rest[rest.length - 1]).route;
}

/** The two list queries + the merged queue, for the Inbox screens
 *  (poll: true there) and the detail screens (position/advance). */
export function useInboxQueue(seg: InboxSegment, opts: { poll?: boolean } = {}) {
  const triageQ = useNeedsTriage(opts);
  const approvalsQ = usePendingApprovals(opts);
  const triage = triageQ.data ?? [];
  const approvals = approvalsQ.data ?? [];
  return {
    triageQ,
    approvalsQ,
    entries: buildQueue(triage, approvals, seg),
    counts: { triage: triage.length, approvals: approvals.length },
    isPending: triageQ.isPending || approvalsQ.isPending,
  };
}

/** Nav badge (TabBar + Sidebar): SAME cache keys as the queue, NO polling —
 *  it updates from the shared cache whenever the Inbox refetches, plus the
 *  global staleTime/refetchOnWindowFocus defaults. */
export function useInboxCount(): number {
  const t = useNeedsTriage();
  const a = usePendingApprovals();
  return (t.data?.length ?? 0) + (a.data?.length ?? 0);
}

// ── Row enrichment ─────────────────────────────────────────────────────────

/** Queue-row facts for an approval: WHO (counterparty, not "Expense #214")
 *  and HOW MUCH (signed cents; negative = outflow). Joined client-side from
 *  the list endpoints — pending expenses/invoices ARE in those lists. */
export function approvalDisplay(
  a: Approval,
  ctx: { expenses: Expense[]; invoices: SalesInvoice[]; entities: Entity[] },
): { title: string; amountCents: number | null } {
  switch (a.object_type) {
    case 'expense': {
      const e = ctx.expenses.find((x) => x.id === a.object_id);
      const supplier =
        e?.supplier_id != null
          ? ctx.entities.find((en) => en.id === e.supplier_id)
          : undefined;
      return {
        title: supplier?.name ?? e?.category ?? 'Expense',
        amountCents: e ? -e.gross_amount : null,
      };
    }
    case 'sales_invoice': {
      const inv = ctx.invoices.find((x) => x.id === a.object_id);
      const customer =
        inv?.customer_id != null
          ? ctx.entities.find((en) => en.id === inv.customer_id)
          : undefined;
      return {
        title: customer?.name ?? inv?.invoice_number ?? 'Sales invoice',
        amountCents: inv ? inv.gross_amount : null,
      };
    }
    case 'reconciliation_match':
      return { title: 'Bank match', amountCents: null };
    case 'allowance':
      return { title: 'Allowance', amountCents: null };
    default:
      return { title: a.object_type, amountCents: null };
  }
}

/** After approve/reject/triage: the queue AND the business-object lists the
 *  rows join against are stale. */
export function invalidateInbox(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: inboxKeys.all }),
    qc.invalidateQueries({ queryKey: sharedKeys.expenses }),
    qc.invalidateQueries({ queryKey: sharedKeys.invoices }),
  ]).then(() => undefined);
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/queries/inbox.test.tsx && npm test
```

Expected: PASS (12 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/queries/inbox.ts packages/web/src/queries/inbox.test.tsx
git commit -m "feat(web): inbox query layer — FIFO queue model, 30s route-scoped polling, badge count"
```

---

### Task 6: InboxScreen — segments, FIFO sections, queue rows, polling, inbox-zero, legacy deep-link

**Files:**
- Create: `packages/web/src/inbox/InboxScreen.tsx`
- Create: `packages/web/src/ui/LoadError.tsx` (promote the bank query-error panel to the kit)
- Modify: `packages/web/src/bank/LoadError.tsx` (becomes a re-export)
- Test: `packages/web/src/inbox/InboxScreen.test.tsx`

**Interfaces:**
- Consumes: `useInboxQueue`, `splitTodayEarlier`, `approvalDisplay`, `type InboxEntry`, `type InboxSegment` (queries/inbox), `useExpenses`/`useInvoices`/`useEntities` (queries/shared), `humanizePolicyReason`/`triageSubtitle`/`triageChipLabel` (inbox/reason), `relativeTime`, kit (`SegmentedControl`, `ListGroup`, `ListRow`, `Chip`, `AmountText`, `EmptyState`, `SkeletonRows`), `LargeTitleHeader`.
- Produces:
  - `InboxScreen(): JSX.Element` — the unified queue at `/inbox`: segment in `?seg=` (legacy `?tab=` accepted as alias; invalid → `all`), Today/Earlier sections with counts, rows linking to their detail route, `poll: true` (30s, Reality #11), inbox-zero empty state, and the legacy `?expand=N` param redirecting to `/inbox/doc/N`.
  - `ui/LoadError` — unchanged component, now kit-owned; `bank/LoadError.tsx` re-exports it so all bank imports keep working.
- Row anatomy (asset §1): type icon (✓ tinted `bg-[#E3EFE8]` for approvals; ? `bg-warn-bg` for triage; ! `bg-err-bg` for ocr_failed/not_a_document) · title = counterparty for approvals / filename for triage (filename only until a counterparty exists — data rule 1) · subtitle = ONE-LINE HUMAN REASON with numbers · chip verb · right column amount (approvals only — Reality #6) + relative time. Low confidence is surfaced in the subtitle; high confidence never appears in the list.

- [ ] **Step 1: Write failing tests**

`src/inbox/InboxScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getReportingPeriods: vi.fn(),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
}));

import * as api from '../api';
import { InboxScreen } from './InboxScreen';

const NOW = Math.floor(Date.now() / 1000);
const YESTERDAY = NOW - 86400 * 2;

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <InboxScreen /> },
      { path: '/inbox/doc/:id', element: <p>doc detail</p> },
      { path: '/inbox/approval/:id', element: <p>approval detail</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('InboxScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      {
        id: 12,
        filename: 'cheque_scan_038.jpg',
        created_at: NOW - 3600,
        reason: 'AI confidence 0.41 below threshold 0.8',
        reason_type: 'low_confidence',
      },
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      {
        id: 7,
        object_type: 'expense',
        object_id: 214,
        status: 'pending',
        requested_by: 'system:policy',
        approved_by: null,
        rejected_reason: null,
        policy_reason: 'Voucher amount 8900 exceeds ceiling 5000',
        superseded_by: null,
        created_at: YESTERDAY,
        resolved_at: null,
      },
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([
      {
        id: 214,
        supplier_id: 3,
        category: 'software',
        gross_amount: 8900,
        vat_amount: 1632,
        currency: 'EUR',
        tax_point_date: '2026-07-03',
        status: 'pending',
        reconciled: false,
      },
    ]);
    vi.mocked(api.getInvoices).mockResolvedValue([]);
    vi.mocked(api.getEntities).mockResolvedValue([
      { id: 3, role: 'supplier', country: 'EE', name: 'Telia Eesti AS', goods_vs_services: null },
    ]);
    vi.mocked(api.getReportingPeriods).mockResolvedValue([]);
  });

  it('merges both sources FIFO with Today/Earlier sections', async () => {
    renderAt('/inbox');
    expect(await screen.findByText(/Earlier/)).toBeInTheDocument();
    expect(screen.getByText(/Today/)).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    // Oldest (the approval, 2 days ago) renders before the fresh triage doc.
    const approvalIdx = links.findIndex(
      (l) => l.getAttribute('href') === '/inbox/approval/7',
    );
    const triageIdx = links.findIndex(
      (l) => l.getAttribute('href') === '/inbox/doc/12',
    );
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(triageIdx).toBeGreaterThan(approvalIdx);
  });

  it('renders the approval row as counterparty · human reason with numbers · amount', async () => {
    renderAt('/inbox');
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(
      screen.getByText('89.00 € above the 50.00 € auto-post limit'),
    ).toBeInTheDocument();
    expect(screen.getByText('-89.00 €')).toBeInTheDocument();
    expect(screen.getByText('approve?')).toBeInTheDocument();
  });

  it('renders the triage row as filename · human reason with the confidence number', async () => {
    renderAt('/inbox');
    expect(await screen.findByText('cheque_scan_038.jpg')).toBeInTheDocument();
    expect(
      screen.getByText('AI confidence 0.41 — below the 0.8 threshold, check the result'),
    ).toBeInTheDocument();
    expect(screen.getByText('classify')).toBeInTheDocument();
  });

  it('filters by segment from ?seg=', async () => {
    renderAt('/inbox?seg=triage');
    expect(await screen.findByText('cheque_scan_038.jpg')).toBeInTheDocument();
    expect(screen.queryByText('Telia Eesti AS')).not.toBeInTheDocument();
  });

  it('accepts the legacy ?tab= param as a segment alias', async () => {
    renderAt('/inbox?tab=approvals');
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(screen.queryByText('cheque_scan_038.jpg')).not.toBeInTheDocument();
  });

  it('shows segment counts in the control', async () => {
    renderAt('/inbox');
    expect(await screen.findByRole('tab', { name: 'Triage 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Approvals 1' })).toBeInTheDocument();
  });

  it('shows the inbox-zero state when both queues are empty', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    renderAt('/inbox');
    expect(await screen.findByText('Inbox zero')).toBeInTheDocument();
  });

  it('redirects the legacy ?expand=N deep link to the triage detail route', async () => {
    const router = renderAt('/inbox?seg=triage&expand=12');
    expect(await screen.findByText('doc detail')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/inbox/doc/12');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/inbox/InboxScreen.test.tsx
```

Expected: FAIL — `./InboxScreen` not found.

- [ ] **Step 3: Implement**

`src/ui/LoadError.tsx` (verbatim move of the bank component — kit-owned now):

```tsx
import { Button } from './Button';

/** Explicit query-error state: server text + retry. */
export function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-err-bg px-4 py-3.5">
      <p className="text-[13px] font-semibold text-err">{message}</p>
      <Button variant="secondary" className="mt-2" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
```

`src/bank/LoadError.tsx` — replace the whole file with:

```tsx
// Promoted to the kit in Plan 03 (the Inbox needs it too); re-exported so
// every bank import keeps working.
export { LoadError } from '../ui/LoadError';
```

`src/inbox/InboxScreen.tsx`:

```tsx
import { Navigate, useSearchParams } from 'react-router-dom';
import { relativeTime } from '../relativeTime';
import { LargeTitleHeader } from '../shell/Headers';
import {
  splitTodayEarlier,
  useInboxQueue,
  approvalDisplay,
  type InboxEntry,
  type InboxSegment,
} from '../queries/inbox';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { SegmentedControl } from '../ui/SegmentedControl';
import { humanizePolicyReason, triageChipLabel, triageSubtitle } from './reason';

const SEGMENTS: readonly InboxSegment[] = ['all', 'triage', 'approvals'];

function EntryIcon({ entry }: { entry: InboxEntry }) {
  const [bg, glyph] =
    entry.kind === 'approval'
      ? ['bg-[#E3EFE8] text-accent', '✓']
      : entry.item.reason_type === 'ocr_failed' ||
          entry.item.reason_type === 'not_a_document'
        ? ['bg-err-bg text-err', '!']
        : ['bg-warn-bg text-warn', '?'];
  return (
    <span
      aria-hidden
      className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] text-[15px] font-bold ${bg}`}
    >
      {glyph}
    </span>
  );
}

function QueueRow({
  entry,
  facts,
}: {
  entry: InboxEntry;
  facts: Parameters<typeof approvalDisplay>[1];
}) {
  if (entry.kind === 'triage') {
    return (
      <ListRow
        to={entry.route}
        leading={<EntryIcon entry={entry} />}
        title={entry.item.filename}
        subtitle={triageSubtitle(entry.item)}
        chip={<Chip tone="warn">{triageChipLabel(entry.item.reason_type)}</Chip>}
        trailing={
          <div className="text-[12px] text-ink-2">
            {relativeTime(entry.item.created_at)}
          </div>
        }
      />
    );
  }
  const d = approvalDisplay(entry.approval, facts);
  return (
    <ListRow
      to={entry.route}
      leading={<EntryIcon entry={entry} />}
      title={d.title}
      subtitle={humanizePolicyReason(entry.approval.policy_reason)}
      chip={<Chip tone="accent">approve?</Chip>}
      trailing={
        <div className="flex-none">
          {d.amountCents != null && (
            <AmountText
              cents={d.amountCents}
              showSign
              className="block whitespace-nowrap text-[14px]"
            />
          )}
          <div className="text-[12px] text-ink-2">
            {relativeTime(entry.approval.created_at)}
          </div>
        </div>
      }
    />
  );
}

/** /inbox — the unified decision queue: needs-triage documents + pending
 *  approvals, ONE FIFO list (oldest on top — the queue must end). Polls at
 *  30s while mounted; see queries/inbox.ts for the polling rule. */
export function InboxScreen() {
  const [params, setParams] = useSearchParams();
  // Legacy bookmarks used ?tab= (LegacyTabs); accept it as an alias.
  const rawSeg = params.get('seg') ?? params.get('tab');
  const seg: InboxSegment = SEGMENTS.includes(rawSeg as InboxSegment)
    ? (rawSeg as InboxSegment)
    : 'all';
  const { entries, counts, triageQ, approvalsQ, isPending } = useInboxQueue(
    seg,
    { poll: true },
  );
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const facts = {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  };
  const { today, earlier } = splitTodayEarlier(entries);
  const total = counts.triage + counts.approvals;
  const listError = triageQ.error ?? approvalsQ.error;

  // Legacy /intake?expand=N deep link (redirect chain preserves the param).
  const expand = params.get('expand');
  if (expand !== null && /^\d+$/.test(expand)) {
    return <Navigate to={`/inbox/doc/${expand}`} replace />;
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Inbox"
        trailing={
          <span className="text-[12.5px] font-semibold text-ink-2">
            {total === 1 ? '1 task' : `${total} tasks`}
          </span>
        }
      />
      <div className="px-4 pb-3">
        <SegmentedControl
          options={[
            { value: 'all' as const, label: 'All' },
            { value: 'triage' as const, label: `Triage ${counts.triage}` },
            {
              value: 'approvals' as const,
              label: `Approvals ${counts.approvals}`,
            },
          ]}
          value={seg}
          onChange={(v) => setParams({ seg: v }, { replace: true })}
        />
      </div>
      {isPending && <SkeletonRows count={4} />}
      {listError != null && (
        <LoadError
          message={
            listError instanceof Error
              ? listError.message
              : 'Failed to load the queue'
          }
          onRetry={() => {
            void triageQ.refetch();
            void approvalsQ.refetch();
          }}
        />
      )}
      {!isPending && listError == null && entries.length === 0 && (
        <EmptyState
          icon="🎉"
          title="Inbox zero"
          hint="Nothing needs a decision right now."
        />
      )}
      {today.length > 0 && (
        <ListGroup label={`Today · ${today.length}`}>
          {today.map((e) => (
            <QueueRow key={e.route} entry={e} facts={facts} />
          ))}
        </ListGroup>
      )}
      {earlier.length > 0 && (
        <ListGroup label={`Earlier · ${earlier.length}`}>
          {earlier.map((e) => (
            <QueueRow key={e.route} entry={e} facts={facts} />
          ))}
        </ListGroup>
      )}
      {entries.length > 0 && (
        <p className="pb-2 text-center text-[10.5px] text-ink-2">
          Oldest first — the queue clears FIFO
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/inbox/InboxScreen.test.tsx && npm test
```

Expected: PASS (7 tests); full suite PASS (bank LoadError re-export keeps bank tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/inbox packages/web/src/ui/LoadError.tsx packages/web/src/bank/LoadError.tsx
git commit -m "feat(web): unified Inbox queue screen — FIFO sections, human reasons, segments, polling"
```

---

### Task 7: InboxScreen — hero card (open period + month total + CTA) and the upload affordance

**Files:**
- Modify: `packages/web/src/queries/inbox.ts` (add `openPeriod`, `periodExpensesTotal`, `useInboxHero`)
- Modify: `packages/web/src/inbox/InboxScreen.tsx` (hero + upload header action)
- Test: extend `packages/web/src/queries/inbox.test.tsx` and `packages/web/src/inbox/InboxScreen.test.tsx`

**Interfaces:**
- Produces (queries/inbox):
  - `openPeriod(periods: ReportingPeriod[]): ReportingPeriod | null` — latest `status === 'open'` period by `start_date`.
  - `periodExpensesTotal(expenses: Expense[], period: ReportingPeriod): number` — Σ `gross_amount` of `posted`/`pending` expenses with `tax_point_date` inside the period (drafts are not money spent yet).
  - `useInboxHero(): { periodName: string; monthTotalCents: number } | null` — `null` until both queries resolve or when no open period exists (hero hidden — no fake surface).
- Produces (InboxScreen):
  - `InboxHero` — `bg-accent-deep` card: period name + "open" eyebrow, month total (`−X €`, tabular, never wraps), mint CTA ("Start clearing · N") linking to the FIRST queue entry — rendered only when the queue is non-empty. The mint `bg-signal text-accent-deep` Link is the one sanctioned bespoke button (spec: signal = hero CTA only).
  - `UploadAction` — header text-action "Upload" + hidden file input: `uploadDocument` → `triageDocument` → outcome toast (`outcomeText`, dedupe notice) → `invalidateInbox`. Minimal by design — the full upload flow (claimant dropdown, ADR-0036) is the Books plan's.

- [ ] **Step 1: Write failing tests**

Append to `src/queries/inbox.test.tsx` (imports: add `openPeriod`, `periodExpensesTotal` to the `./inbox` import):

```tsx
describe('hero data', () => {
  const period = {
    id: 1,
    name: 'July 2026',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    status: 'open',
    filed_at: null,
  };
  // Typed Partial so the spread keeps the Expense shape (a Record spread
  // would widen the fields). Add `Expense` to the api type imports.
  const expense = (over: Partial<Expense> = {}): Expense => ({
    id: 1,
    supplier_id: null,
    category: 'software',
    gross_amount: 1000,
    vat_amount: 0,
    currency: 'EUR',
    tax_point_date: '2026-07-03',
    status: 'posted',
    reconciled: false,
    ...over,
  });

  it('openPeriod picks the latest open period and ignores locked ones', () => {
    expect(
      openPeriod([
        { ...period, id: 2, name: 'June', start_date: '2026-06-01', end_date: '2026-06-30', status: 'locked' },
        period,
      ])?.name,
    ).toBe('July 2026');
    expect(openPeriod([{ ...period, status: 'locked' }])).toBeNull();
    expect(openPeriod([])).toBeNull();
  });

  it('periodExpensesTotal sums posted+pending inside the period only', () => {
    const total = periodExpensesTotal(
      [
        expense({ id: 1, gross_amount: 8900 }),
        expense({ id: 2, gross_amount: 4820, status: 'pending' }),
        expense({ id: 3, gross_amount: 999, status: 'draft' }), // not money yet
        expense({ id: 4, gross_amount: 5000, tax_point_date: '2026-06-30' }), // out of period
      ],
      period,
    );
    expect(total).toBe(13720);
  });
});
```

Append to `src/inbox/InboxScreen.test.tsx` (inside the existing `describe`; `fireEvent` + `waitFor` added to the testing-library import):

```tsx
  it('renders the hero card with the open period, month total and CTA to the first item', async () => {
    vi.mocked(api.getReportingPeriods).mockResolvedValue([
      { id: 1, name: 'July 2026', start_date: '2026-07-01', end_date: '2026-07-31', status: 'open', filed_at: null },
    ]);
    renderAt('/inbox');
    expect(await screen.findByText(/July 2026/)).toBeInTheDocument();
    // 89.00 pending expense inside the period (from the shared fixture).
    expect(screen.getByText('−89.00 €')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Start clearing · 2/ });
    // FIFO first = the 2-day-old approval.
    expect(cta).toHaveAttribute('href', '/inbox/approval/7');
  });

  it('hides the hero when no period is open', async () => {
    renderAt('/inbox'); // getReportingPeriods resolves [] in the shared fixture
    await screen.findByText('Telia Eesti AS');
    expect(screen.queryByText(/expenses this period/)).not.toBeInTheDocument();
  });

  it('uploads a file, auto-triages it and refreshes the queue', async () => {
    vi.mocked(api.uploadDocument).mockResolvedValue({
      document: { id: 99, filename: 'r.pdf', mime_type: 'application/pdf', size_bytes: 1, status: 'pending', processing_since: null, created_at: 1 },
      deduplicated: false,
    });
    vi.mocked(api.triageDocument).mockResolvedValue({
      kind: 'expense',
      document_id: 99,
      expense_id: 500,
    });
    renderAt('/inbox');
    await screen.findByText('Telia Eesti AS');
    const callsBefore = vi.mocked(api.getNeedsTriageItems).mock.calls.length;
    const input = screen.getByLabelText('Upload document');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'r.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(api.triageDocument).toHaveBeenCalledWith(99));
    await waitFor(() =>
      expect(
        vi.mocked(api.getNeedsTriageItems).mock.calls.length,
      ).toBeGreaterThan(callsBefore),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/queries/inbox.test.tsx src/inbox/InboxScreen.test.tsx
```

Expected: FAIL — `openPeriod`/`periodExpensesTotal` not exported; no hero/upload in the screen.

- [ ] **Step 3: Implement**

Append to `src/queries/inbox.ts` (add `ReportingPeriod` to the api type imports; add `useExpenses`, `useReportingPeriods` imports from `./shared`):

```ts
// ── Hero card data (open period + month total) ─────────────────────────────

/** Latest open reporting period, or null (hero hidden — no fake surface). */
export function openPeriod(periods: ReportingPeriod[]): ReportingPeriod | null {
  const open = periods.filter((p) => p.status === 'open');
  if (open.length === 0) return null;
  return [...open].sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
}

/** Money spent in the period: posted + pending expenses (drafts are not
 *  money yet), tax_point_date within [start, end]. ISO strings compare
 *  lexicographically. */
export function periodExpensesTotal(
  expenses: Expense[],
  period: ReportingPeriod,
): number {
  return expenses
    .filter(
      (e) =>
        (e.status === 'posted' || e.status === 'pending') &&
        e.tax_point_date >= period.start_date &&
        e.tax_point_date <= period.end_date,
    )
    .reduce((sum, e) => sum + e.gross_amount, 0);
}

export function useInboxHero(): {
  periodName: string;
  monthTotalCents: number;
} | null {
  const periodsQ = useReportingPeriods();
  const expensesQ = useExpenses();
  const period = openPeriod(periodsQ.data ?? []);
  if (period === null || expensesQ.data === undefined) return null;
  return {
    periodName: period.name,
    monthTotalCents: periodExpensesTotal(expensesQ.data, period),
  };
}
```

In `src/inbox/InboxScreen.tsx`:

1. Add imports: `Link` (react-router-dom, merged with the Navigate import), `useRef`, `useState` (react), `useQueryClient` (@tanstack/react-query), `fmtCents`, `triageDocument`, `uploadDocument` (../api), `invalidateInbox`, `useInboxHero` (../queries/inbox), `toastErr`, `toastOk` (../ui/toast), `outcomeText` (./reason).

2. Add the two components above `InboxScreen`:

```tsx
function InboxHero({
  periodName,
  monthTotalCents,
  taskCount,
  firstRoute,
}: {
  periodName: string;
  monthTotalCents: number;
  taskCount: number;
  firstRoute: string | null;
}) {
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-accent-deep px-5 py-4 text-white">
      <p className="text-[11px] font-bold uppercase tracking-wide opacity-70">
        {periodName} · open
      </p>
      <p className="mt-1 whitespace-nowrap text-[28px] font-extrabold tabular-nums">
        −{fmtCents(monthTotalCents)} €
      </p>
      <p className="text-[12.5px] opacity-70">expenses this period</p>
      {taskCount > 0 && firstRoute !== null && (
        // The mint hero CTA is the ONE sanctioned bespoke button (spec:
        // `signal` token is hero-CTA-only).
        <Link
          to={firstRoute}
          viewTransition
          className="mt-3 block rounded-xl bg-signal px-4 py-2.5 text-center text-[15px] font-bold text-accent-deep"
        >
          Start clearing · {taskCount}
        </Link>
      )}
    </div>
  );
}

/** Minimal upload entry point (legacy IntakeView capability kept): upload →
 *  auto-triage → outcome toast. The full upload flow (claimant dropdown,
 *  ADR-0036) belongs to the Books plan. */
function UploadAction() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (file: File) => {
    setBusy(true);
    try {
      const { document, deduplicated } = await uploadDocument(file);
      if (deduplicated) toastOk('Already uploaded — using the existing document');
      const outcome = await triageDocument(document.id);
      if (outcome.kind === 'unknown') toastErr(outcomeText(outcome));
      else toastOk(outcomeText(outcome));
      await invalidateInbox(qc);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        aria-label="Upload document"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onPick(f);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="text-[15px] font-semibold text-accent disabled:opacity-50"
      >
        {busy ? 'Processing…' : 'Upload'}
      </button>
    </>
  );
}
```

3. Inside `InboxScreen`: add `const hero = useInboxHero();` next to the other hooks; change the header `trailing` to

```tsx
        trailing={
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] font-semibold text-ink-2">
              {total === 1 ? '1 task' : `${total} tasks`}
            </span>
            <UploadAction />
          </div>
        }
```

and render the hero right after the segmented-control `<div>` closes:

```tsx
      {hero !== null && (
        <InboxHero
          periodName={hero.periodName}
          monthTotalCents={hero.monthTotalCents}
          taskCount={entries.length}
          firstRoute={entries[0]?.route ?? null}
        />
      )}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/queries/inbox.test.tsx src/inbox/InboxScreen.test.tsx && npm test
```

Expected: PASS (hero + upload tests green; the earlier Task 6 tests unaffected — `getReportingPeriods` resolves `[]` there, hiding the hero).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/queries/inbox.ts packages/web/src/queries/inbox.test.tsx packages/web/src/inbox/InboxScreen.tsx packages/web/src/inbox/InboxScreen.test.tsx
git commit -m "feat(web): inbox hero card (open period, month total, CTA) and upload affordance"
```

---

### Task 8: `DocPreviewRow` + ApprovalScreen rendering (hero → why-held → document → facts, "N of M", safe fallbacks)

**Files:**
- Create: `packages/web/src/inbox/DocPreviewRow.tsx`
- Create: `packages/web/src/inbox/ApprovalScreen.tsx`
- Modify: `packages/web/src/inbox/format.ts` (add `signedEuros`)
- Test: `packages/web/src/inbox/ApprovalScreen.test.tsx`; extend `packages/web/src/inbox/format.test.ts`

**Interfaces:**
- Consumes: `usePendingApprovals`, `useInboxQueue`, `queuePosition`, `useExpenseDetail` (queries/inbox), `useEntities`/`useInvoices` (queries/shared), `humanizePolicyReason` (inbox/reason), `absoluteDate`/`absoluteDateFromIso`/`vatRatePct` (inbox/format), `fetchDocumentPreviewObjectUrl`/`openSignedDocument` (api), `ScreenHeader`, kit (`ListGroup`, `ListRow`, `KeyValue`, `Chip`, `SkeletonRows`, `EmptyState`), `LinkButton`.
- Produces:
  - `signedEuros(cents: number): string` (inbox/format) — `-89.00 €` / `+1200.00 €` / `0.00 €`; used by the hero and the Approve button label.
  - `DocPreviewRow({ documentId, subtitle? })` — preview thumb via the blob-URL pattern (Bearer-only `/preview`, revoke on unmount — same choreography as legacy `DocumentThumb`, restyled); tapping opens the signed file URL (`openSignedDocument`). Fallback glyph when no preview exists.
  - `ApprovalScreen(): JSX.Element` at `/inbox/approval/:id` (asset §2): nav title "N of M" over the FIFO queue; **expense** → amount hero (−gross) + "supplier · category" subtitle, "Why held" warn box with the humanized reason, document row (when `document_id` — Reality #9), facts KV (VAT with implied rate, tax point absolute, AI confidence with ok/warn color, supplier, invoice number); **sales_invoice** → +gross hero, customer · invoice number, same box/KV from the invoices list (Reality #9: no single-invoice endpoint); **reconciliation_match / allowance** → generic safe card (object label chip, requested-by, waiting-since absolute date, honest hint) — never crashes (Reality #4). Already-decided/missing id → "Already decided" state with a back LinkButton. Action BUTTONS land in Task 9 — this task renders everything above them.

- [ ] **Step 1: Write failing tests**

Append to `src/inbox/format.test.ts`:

```ts
import { signedEuros } from './format'; // merge into the existing import

describe('signedEuros', () => {
  it('formats signed euro amounts', () => {
    expect(signedEuros(-8900)).toBe('-89.00 €');
    expect(signedEuros(120000)).toBe('+1200.00 €');
    expect(signedEuros(0)).toBe('0.00 €');
  });
});
```

`src/inbox/ApprovalScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getExpense: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

import * as api from '../api';
import type { Approval } from '../api';
import { ApprovalScreen } from './ApprovalScreen';

const APPROVAL = (over: Partial<Approval> = {}): Approval => ({
  id: 7,
  object_type: 'expense',
  object_id: 214,
  status: 'pending',
  requested_by: 'system:policy',
  approved_by: null,
  rejected_reason: null,
  policy_reason: 'Voucher amount 8900 exceeds ceiling 5000',
  superseded_by: null,
  created_at: 100,
  resolved_at: null,
  ...over,
});

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <p>queue</p> },
      { path: '/inbox/approval/:id', element: <ApprovalScreen /> },
      { path: '/inbox/doc/:id', element: <p>doc detail</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('ApprovalScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL(),
      APPROVAL({ id: 8, object_id: 215, created_at: 200 }),
    ]);
    vi.mocked(api.getExpense).mockResolvedValue({
      id: 214,
      document_id: 88,
      supplier_id: 3,
      category: 'software',
      gross_amount: 8900,
      vat_amount: 1605,
      currency: 'EUR',
      tax_point_date: '2026-07-03',
      status: 'pending',
      supplier_invoice_number: 'A-183',
      ai_confidence: 0.94,
    });
    vi.mocked(api.getExpenses).mockResolvedValue([]);
    vi.mocked(api.getInvoices).mockResolvedValue([]);
    vi.mocked(api.getEntities).mockResolvedValue([
      { id: 3, role: 'supplier', country: 'EE', name: 'Telia Eesti AS', goods_vs_services: null },
    ]);
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
      new Error('no preview'),
    );
  });

  it('renders hero amount, subtitle and the N-of-M nav title', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('-89.00 €')).toBeInTheDocument();
    expect(screen.getByText(/Telia Eesti AS · software/)).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('renders the why-held box with the humanized numbers', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('Why held')).toBeInTheDocument();
    expect(
      screen.getByText(/89\.00 € above the 50\.00 € auto-post limit/),
    ).toBeInTheDocument();
  });

  it('renders the facts KV — VAT with implied rate, absolute date, confidence, invoice number', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('16.05 € (22%)')).toBeInTheDocument();
    expect(screen.getByText('03.07.2026')).toBeInTheDocument();
    expect(screen.getByText('0.94')).toBeInTheDocument();
    expect(screen.getByText('A-183')).toBeInTheDocument();
  });

  it('shows the document row when the expense has a linked document', async () => {
    renderAt('/inbox/approval/7');
    expect(await screen.findByText('Source document')).toBeInTheDocument();
  });

  it('renders a reconciliation_match approval safely (generic facts, no crash)', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      APPROVAL({
        id: 9,
        object_type: 'reconciliation_match',
        object_id: 41,
        policy_reason: null,
      }),
    ]);
    renderAt('/inbox/approval/9');
    expect(await screen.findByText('Bank match')).toBeInTheDocument();
    expect(screen.getByText('Held for your approval')).toBeInTheDocument();
    expect(screen.getByText(/normally confirmed from the Bank section/)).toBeInTheDocument();
  });

  it('shows the already-decided state for an id not in the pending list', async () => {
    renderAt('/inbox/approval/404');
    expect(await screen.findByText('Already decided')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to inbox/i })).toHaveAttribute(
      'href',
      '/inbox',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/inbox/format.test.ts src/inbox/ApprovalScreen.test.tsx
```

Expected: FAIL — `signedEuros`/`./ApprovalScreen` not found.

- [ ] **Step 3: Implement**

Append to `src/inbox/format.ts`:

```ts
/** Signed euro string for hero amounts and outcome-stating button labels.
 *  (fmtCents already emits the leading "-" for negatives.) */
export function signedEuros(cents: number): string {
  const base = `${(Math.abs(cents) / 100).toFixed(2)} €`;
  if (cents < 0) return `-${base}`;
  if (cents > 0) return `+${base}`;
  return base;
}
```

`src/inbox/DocPreviewRow.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { fetchDocumentPreviewObjectUrl, openSignedDocument } from '../api';
import { ListGroup, ListRow } from '../ui/List';

/**
 * Document preview row (asset §2): thumb + "tap to open". The /preview
 * endpoint is Bearer-only, so the bytes are fetched into a blob: URL and
 * revoked on unmount (same choreography as legacy DocumentThumb, restyled);
 * the file opens via a signed token-free URL inside the click gesture.
 */
export function DocPreviewRow({
  documentId,
  subtitle = 'Tap to open the file',
}: {
  documentId: number;
  subtitle?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetchDocumentPreviewObjectUrl(documentId)
      .then((url) => {
        if (revoked) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => undefined); // no preview → fallback glyph
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId]);

  return (
    <ListGroup label="Document">
      <ListRow
        onClick={() => void openSignedDocument(documentId)}
        leading={
          src !== null ? (
            <img
              src={src}
              alt="Document preview"
              className="h-12 w-9 rounded-md border border-line object-cover"
            />
          ) : (
            <span
              aria-label="no preview"
              className="flex h-12 w-9 items-center justify-center rounded-md bg-line text-base"
            >
              📄
            </span>
          )
        }
        title="Source document"
        subtitle={subtitle}
      />
    </ListGroup>
  );
}
```

`src/inbox/ApprovalScreen.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { ScreenHeader } from '../shell/Headers';
import {
  queuePosition,
  useExpenseDetail,
  useInboxQueue,
  usePendingApprovals,
} from '../queries/inbox';
import { useEntities, useInvoices } from '../queries/shared';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup } from '../ui/List';
import { LinkButton } from '../ui/LinkButton';
import { LoadError } from '../ui/LoadError';
import { DocPreviewRow } from './DocPreviewRow';
import { absoluteDate, absoluteDateFromIso, signedEuros, vatRatePct } from './format';
import { humanizePolicyReason } from './reason';

function WhyHeldBox({ reason }: { reason: string | null }) {
  return (
    <div className="mx-3.5 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5">
      <p className="text-[11px] font-bold uppercase tracking-wide text-warn">
        Why held
      </p>
      <p className="text-[12.5px] leading-snug text-warn">
        {humanizePolicyReason(reason)}
      </p>
    </div>
  );
}

function Hero({ amount, subtitle }: { amount: string; subtitle: string }) {
  return (
    <div className="px-5 pb-3 pt-1 text-center">
      <p className="whitespace-nowrap text-[28px] font-extrabold tabular-nums">
        {amount}
      </p>
      <p className="truncate text-[12.5px] text-ink-2">{subtitle}</p>
    </div>
  );
}

/** /inbox/approval/:id — the decision detail (asset §2): amount hero →
 *  "why held" with concrete numbers → document preview → facts KV.
 *  Renders EVERY object_type safely; actions are wired in Task 9. */
export function ApprovalScreen() {
  const { id } = useParams();
  const approvalId = Number(id);
  const route = `/inbox/approval/${approvalId}`;

  const approvalsQ = usePendingApprovals();
  const approval = approvalsQ.data?.find((a) => a.id === approvalId);
  const { entries } = useInboxQueue('all');
  const position = queuePosition(entries, route);

  const expenseQ = useExpenseDetail(
    approval?.object_type === 'expense' ? approval.object_id : null,
  );
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const entities = entitiesQ.data ?? [];

  const title = position !== null ? `${position.pos} of ${position.total}` : 'Approval';

  if (approvalsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo="/inbox" />
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (approvalsQ.isError) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo="/inbox" />
        <LoadError
          message={
            approvalsQ.error instanceof Error
              ? approvalsQ.error.message
              : 'Failed to load the approval'
          }
          onRetry={() => void approvalsQ.refetch()}
        />
      </div>
    );
  }
  if (approval === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Approval" backTo="/inbox" />
        <EmptyState
          icon="✓"
          title="Already decided"
          hint="This approval is no longer pending."
          action={<LinkButton to="/inbox">Back to Inbox</LinkButton>}
        />
      </div>
    );
  }

  let body: JSX.Element;
  if (approval.object_type === 'expense') {
    const e = expenseQ.data;
    const supplier =
      e?.supplier_id != null
        ? entities.find((en) => en.id === e.supplier_id)
        : undefined;
    body =
      e === undefined ? (
        <SkeletonRows count={2} />
      ) : (
        <>
          <Hero
            amount={signedEuros(-e.gross_amount)}
            subtitle={`${supplier?.name ?? 'Unknown supplier'} · ${e.category}`}
          />
          <WhyHeldBox reason={approval.policy_reason} />
          {e.document_id !== null && <DocPreviewRow documentId={e.document_id} />}
          <ListGroup label="Facts">
            <KeyValue
              k="VAT"
              v={
                vatRatePct(e.gross_amount, e.vat_amount) !== null
                  ? `${(e.vat_amount / 100).toFixed(2)} € (${vatRatePct(e.gross_amount, e.vat_amount)}%)`
                  : `${(e.vat_amount / 100).toFixed(2)} €`
              }
            />
            <KeyValue k="Tax point" v={absoluteDateFromIso(e.tax_point_date)} />
            {e.ai_confidence !== null && (
              <KeyValue
                k="AI confidence"
                v={
                  <span className={e.ai_confidence >= 0.9 ? 'text-ok' : 'text-warn'}>
                    {e.ai_confidence.toFixed(2)}
                  </span>
                }
              />
            )}
            <KeyValue k="Supplier" v={supplier?.name ?? '—'} />
            {e.supplier_invoice_number !== null && (
              <KeyValue k="Invoice number" v={e.supplier_invoice_number} />
            )}
          </ListGroup>
        </>
      );
  } else if (approval.object_type === 'sales_invoice') {
    const inv = invoicesQ.data?.find((x) => x.id === approval.object_id);
    const customer =
      inv?.customer_id != null
        ? entities.find((en) => en.id === inv.customer_id)
        : undefined;
    body =
      inv === undefined ? (
        <SkeletonRows count={2} />
      ) : (
        <>
          <Hero
            amount={signedEuros(inv.gross_amount)}
            subtitle={`${customer?.name ?? 'No customer'} · ${inv.invoice_number}`}
          />
          <WhyHeldBox reason={approval.policy_reason} />
          <ListGroup label="Facts">
            <KeyValue k="VAT" v={`${(inv.vat_amount / 100).toFixed(2)} €`} />
            <KeyValue k="Tax point" v={absoluteDateFromIso(inv.tax_point_date)} />
            <KeyValue k="Invoice number" v={inv.invoice_number} />
          </ListGroup>
        </>
      );
  } else {
    // reconciliation_match / allowance / future types: generic, safe.
    const label =
      approval.object_type === 'reconciliation_match'
        ? 'Bank match'
        : approval.object_type === 'allowance'
          ? 'Allowance'
          : approval.object_type;
    body = (
      <>
        <div className="px-5 pb-3 pt-1 text-center">
          <p className="text-[22px] font-extrabold">{label}</p>
          <Chip tone="muted">{approval.object_type}</Chip>
        </div>
        <WhyHeldBox reason={approval.policy_reason} />
        <ListGroup label="Facts">
          <KeyValue k="Requested by" v={approval.requested_by} />
          <KeyValue k="Waiting since" v={absoluteDate(approval.created_at)} />
        </ListGroup>
        {approval.object_type === 'reconciliation_match' && (
          <p className="mx-6 mb-3 text-[12px] text-ink-2">
            This hold is normally confirmed from the Bank section, where the
            matched line and its object are visible. Approving here activates
            the match; rejecting discards it.
          </p>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo="/inbox" />
      {body}
      {/* Action bar lands in Task 9 */}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/inbox/format.test.ts src/inbox/ApprovalScreen.test.tsx && npm test
```

Expected: PASS (6 screen tests + format additions); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/inbox
git commit -m "feat(web): approval detail screen — amount hero, why-held with numbers, document preview, facts"
```

---

### Task 9: ApprovalScreen actions — one-tap Approve (receipt, no undo), Reject sheet with mandatory reason, auto-advance

**Files:**
- Create: `packages/web/src/inbox/RejectSheet.tsx`
- Modify: `packages/web/src/inbox/ApprovalScreen.tsx`
- Test: extend `packages/web/src/inbox/ApprovalScreen.test.tsx`

**Interfaces:**
- Consumes: `approveApproval`, `rejectApproval` (api — the ONLY posting seam, Reality #2), `nextRouteAfter`, `invalidateInbox` (queries/inbox), `Sheet`, `Button`, `Field`/`INPUT_CLS`, toasts.
- Produces:
  - `RejectSheet({ open, onOpenChange, busy, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; busy: boolean; onSubmit: (reason: string) => void })` — bottom sheet with a REQUIRED reason textarea (client-enforced non-empty, Reality #3); primary "Reject & return to draft" disabled until filled; explains the consequence in words.
  - ApprovalScreen action bar: secondary "Reject…" + primary "Approve · −89.00 €" (outcome-stating label with the amount when known). Approve → `approveApproval(id, 'operator')` → receipt toast **without Undo** ("Approved & posted · −89.00 €" — Reality #1) → `invalidateInbox` → `navigate(nextRouteAfter(...))` (auto-advance to the next pending item, else `/inbox`). Reject → sheet → same invalidate + advance with "Rejected — returned to draft". Both mutations are non-optimistic (the server decision is the receipt). A hint line under the bar states the reality: "Approve posts to the books immediately — recover via a correction".

- [ ] **Step 1: Write failing tests**

Append to `src/inbox/ApprovalScreen.test.tsx` (add `fireEvent`, `waitFor` to the testing-library import):

```tsx
  it('approves with one tap and auto-advances to the next pending item', async () => {
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'approved' }),
    });
    const router = renderAt('/inbox/approval/7');
    const btn = await screen.findByRole('button', { name: 'Approve · -89.00 €' });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.approveApproval).toHaveBeenCalledWith(7, 'operator'),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/approval/8'),
    );
  });

  it('rejects only with a non-empty reason and advances', async () => {
    vi.mocked(api.rejectApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'rejected' }),
    });
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(await screen.findByRole('button', { name: 'Reject…' }));
    const submit = await screen.findByRole('button', {
      name: 'Reject & return to draft',
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/why this should not be posted/i), {
      target: { value: 'Wrong supplier' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.rejectApproval).toHaveBeenCalledWith(7, 'Wrong supplier'),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/approval/8'),
    );
  });

  it('stays on the screen when approve fails (server text surfaced)', async () => {
    vi.mocked(api.approveApproval).mockRejectedValue(
      new Error('Approval 7 is rejected, cannot approve'),
    );
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve · -89.00 €' }),
    );
    await waitFor(() => expect(api.approveApproval).toHaveBeenCalled());
    expect(router.state.location.pathname).toBe('/inbox/approval/7');
  });

  it('approves the last remaining item and returns to the queue', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([APPROVAL()]);
    vi.mocked(api.approveApproval).mockResolvedValue({
      approval: APPROVAL({ status: 'approved' }),
    });
    const router = renderAt('/inbox/approval/7');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve · -89.00 €' }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox'),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/inbox/ApprovalScreen.test.tsx
```

Expected: FAIL — no Approve/Reject buttons rendered yet.

- [ ] **Step 3: Implement**

`src/inbox/RejectSheet.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS } from '../ui/Form';
import { Sheet } from '../ui/Sheet';

/** Reject = a deliberate decision with a MANDATORY reason (ADR-0015; the
 *  server persists it on the draft). Never window.prompt. */
export function RejectSheet({
  open,
  onOpenChange,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  busy: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Reject">
      <div className="space-y-3 px-5 pb-2">
        <p className="text-[13px] text-ink-2">
          The item returns to draft with your reason attached — nothing is
          deleted. (A rejected bank match is discarded instead.)
        </p>
        <Field label="Reason" hint="Required — it lands in the audit trail">
          <textarea
            className={INPUT_CLS}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this should not be posted…"
          />
        </Field>
        <Button
          className="w-full"
          busy={busy}
          disabled={reason.trim() === ''}
          onClick={() => onSubmit(reason.trim())}
        >
          Reject &amp; return to draft
        </Button>
      </div>
    </Sheet>
  );
}
```

In `src/inbox/ApprovalScreen.tsx`:

1. Add imports: `useState` (react), `useNavigate` (react-router-dom, merged), `useMutation, useQueryClient` (@tanstack/react-query), `approveApproval, rejectApproval` (../api), `invalidateInbox, nextRouteAfter` (merged into the ../queries/inbox import), `Button` (../ui/Button), `toastErr, toastOk` (../ui/toast), `RejectSheet` (./RejectSheet).

2. Inside `ApprovalScreen`, after the `entities` line add the action plumbing (hooks BEFORE the early returns — keep them with the other hooks at the top):

```tsx
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [rejectOpen, setRejectOpen] = useState(false);
  // Computed from the CURRENT queue before the mutation lands (the refetch
  // will drop this entry).
  const next = nextRouteAfter(entries, route);

  const approveMut = useMutation({
    mutationFn: () => approveApproval(approvalId, 'operator'),
    onSuccess: async (_res, _vars, _ctx) => {
      // NO Undo: approve posts the voucher in the same transaction
      // (Reality #1); recovery is the correction flow.
      toastOk(
        heroAmount !== null
          ? `Approved & posted · ${heroAmount}`
          : 'Approved & posted',
      );
      await invalidateInbox(qc);
      navigate(next);
    },
    onError: (e) => toastErr(e instanceof Error ? e.message : String(e)),
  });

  const rejectMut = useMutation({
    mutationFn: (reason: string) => rejectApproval(approvalId, reason),
    onSuccess: async () => {
      setRejectOpen(false);
      toastOk('Rejected — returned to draft');
      await invalidateInbox(qc);
      navigate(next);
    },
    onError: (e) => toastErr(e instanceof Error ? e.message : String(e)),
  });
```

3. Compute `heroAmount: string | null` BEFORE the two `useMutation` calls (their `onSuccess` closures read it — declaring it after would be a use-before-declaration hazard). Place it right after the `entities` line, derived straight from the queries:

```tsx
  const heroAmount: string | null =
    approval?.object_type === 'expense' && expenseQ.data !== undefined
      ? signedEuros(-expenseQ.data.gross_amount)
      : approval?.object_type === 'sales_invoice'
        ? (() => {
            const inv = invoicesQ.data?.find(
              (x) => x.id === approval.object_id,
            );
            return inv !== undefined ? signedEuros(inv.gross_amount) : null;
          })()
        : null;
```

Then reuse `heroAmount` inside the expense/invoice `body` branches (`<Hero amount={heroAmount ?? ''} …>` — the branches already guard on the data being loaded, so it is non-empty there).

4. Replace the `{/* Action bar lands in Task 9 */}` placeholder with:

```tsx
      <div className="mx-3.5 mt-2 flex gap-2.5">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={approveMut.isPending || rejectMut.isPending}
          onClick={() => setRejectOpen(true)}
        >
          Reject…
        </Button>
        <Button
          className="flex-1"
          busy={approveMut.isPending}
          disabled={rejectMut.isPending}
          onClick={() => approveMut.mutate()}
        >
          {heroAmount !== null ? `Approve · ${heroAmount}` : 'Approve'}
        </Button>
      </div>
      <p className="px-6 pt-2 text-center text-[10.5px] text-ink-2">
        Approve posts to the books immediately — recover via a correction
      </p>
      <RejectSheet
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        busy={rejectMut.isPending}
        onSubmit={(reason) => rejectMut.mutate(reason)}
      />
```

Note: the action bar renders only in the `approval !== undefined` return path (below `{body}`) — the loading/error/decided returns stay button-free, so there is never a second primary on screen.

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/inbox/ApprovalScreen.test.tsx && npm test
```

Expected: PASS (10 tests in the file); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/inbox
git commit -m "feat(web): approval actions — one-tap approve with receipt, reject sheet with mandatory reason, auto-advance"
```

---

### Task 10: ResolveSupplierSheet + OcrFailedSheet (restyled triage flows 1 & 4)

**Files:**
- Create: `packages/web/src/inbox/ResolveSupplierSheet.tsx`
- Create: `packages/web/src/inbox/OcrFailedSheet.tsx`
- Test: `packages/web/src/inbox/ResolveSupplierSheet.test.tsx`, `packages/web/src/inbox/OcrFailedSheet.test.tsx`

**Interfaces:**
- Consumes: `getPendingDraft`, `resolveSupplier`, `onboardEntity`, `uploadDocument`, `triageDocument`, `completeDocument`, `retryDocument` (api — the exact choreography of the legacy `ResolveSupplierForm`/`TriageOcrFailedForm`, which SURVIVE untouched for `DocumentsView`), `inboxKeys.pendingDraft` (queries/inbox), `useSuppliers` (queries/shared), kit (`Sheet`, `Button`, `Field`, `TextInput`, `SearchInput`, `ListGroup`, `ListRow`), `signedEuros`, `absoluteDateFromIso` (inbox/format), toasts.
- Produces:
  - `ResolveSupplierSheet({ documentId, open, onOpenChange, onDone }: { documentId: number; open: boolean; onOpenChange: (o: boolean) => void; onDone: (o: TriageOutcome) => void })` — prefill → confirm (data rule 7): loads the pending draft (`enabled: open`), shows the AI's read (category · amount · date), prefills the create-new-supplier fields from the proposal; primary "Create supplier & book · −48.20 €" (outcome + amount); below, "or pick an existing supplier" — SearchInput + up to 6 matching rows, tap = `resolveSupplier` with that entity (data rule 8: search with context, never ID entry). Reg. key REQUIRED for create (`onboardEntity` contract — Plan 02 Reality #10 carries over).
  - `OcrFailedSheet({ documentId, open, onOpenChange, onReplaced, onRetried }: { documentId: number; open: boolean; onOpenChange: (o: boolean) => void; onReplaced: (o: TriageOutcome) => void; onRetried: () => void })` — "Upload replacement" (upload → auto-triage the NEW file → `completeDocument` the broken original) and "Retry OCR on this file" (`retryDocument`; the result lands via polling). Dismiss stays on the SCREEN behind a ConfirmDialog (Task 13) — not in this sheet.

- [ ] **Step 1: Write failing tests**

`src/inbox/ResolveSupplierSheet.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getPendingDraft: vi.fn(),
  getEntities: vi.fn(),
  onboardEntity: vi.fn(),
  resolveSupplier: vi.fn(),
}));

import * as api from '../api';
import { ResolveSupplierSheet } from './ResolveSupplierSheet';

const OUTCOME = { kind: 'expense', document_id: 12, expense_id: 500 } as const;

function renderSheet(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ResolveSupplierSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('ResolveSupplierSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getPendingDraft).mockResolvedValue({
      document_id: 12,
      reason: 'supplier unresolved',
      supplier_proposal: {
        create_name: 'Circle K Eesti AS',
        create_country: 'EE',
        create_registration_key: 'EE100511246',
      },
      draft: {
        category: 'fuel',
        gross_amount: 4820,
        vat_amount: 867,
        currency: 'EUR',
        tax_point_date: '2026-07-01',
        supplier_invoice_number: null,
      },
    });
    vi.mocked(api.getEntities).mockResolvedValue([
      { id: 3, role: 'supplier', country: 'EE', name: 'Wolt Eesti OÜ', goods_vs_services: null },
    ]);
    vi.mocked(api.resolveSupplier).mockResolvedValue(OUTCOME);
  });

  it('prefills the proposal and states the outcome with the amount on the primary', async () => {
    renderSheet();
    expect(
      await screen.findByDisplayValue('Circle K Eesti AS'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('EE100511246')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create supplier & book · -48.20 €' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/fuel/)).toBeInTheDocument();
  });

  it('creates the supplier then resolves the document', async () => {
    vi.mocked(api.onboardEntity).mockResolvedValue({
      id: 9,
      role: 'supplier',
      country: 'EE',
      name: 'Circle K Eesti AS',
      goods_vs_services: null,
    });
    const onDone = renderSheet();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Create supplier & book · -48.20 €',
      }),
    );
    await waitFor(() =>
      expect(api.onboardEntity).toHaveBeenCalledWith({
        role: 'supplier',
        name: 'Circle K Eesti AS',
        country: 'EE',
        registrationKey: 'EE100511246',
      }),
    );
    await waitFor(() => expect(api.resolveSupplier).toHaveBeenCalledWith(12, 9));
    expect(onDone).toHaveBeenCalledWith(OUTCOME);
  });

  it('requires the registration key for create', async () => {
    renderSheet();
    const regKey = await screen.findByDisplayValue('EE100511246');
    fireEvent.change(regKey, { target: { value: '  ' } });
    expect(
      screen.getByRole('button', { name: 'Create supplier & book · -48.20 €' }),
    ).toBeDisabled();
  });

  it('picks an existing supplier via search', async () => {
    const onDone = renderSheet();
    fireEvent.change(await screen.findByPlaceholderText(/search suppliers/i), {
      target: { value: 'wolt' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Wolt Eesti OÜ/ }));
    await waitFor(() => expect(api.resolveSupplier).toHaveBeenCalledWith(12, 3));
    expect(onDone).toHaveBeenCalledWith(OUTCOME);
  });
});
```

`src/inbox/OcrFailedSheet.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
  completeDocument: vi.fn(),
  retryDocument: vi.fn(),
}));

import * as api from '../api';
import { OcrFailedSheet } from './OcrFailedSheet';

describe('OcrFailedSheet', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderSheet(onReplaced = vi.fn(), onRetried = vi.fn()) {
    render(
      <OcrFailedSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onReplaced={onReplaced}
        onRetried={onRetried}
      />,
    );
    return { onReplaced, onRetried };
  }

  it('retries OCR on the same file', async () => {
    vi.mocked(api.retryDocument).mockResolvedValue({ ok: true });
    const { onRetried } = renderSheet();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry OCR on this file' }),
    );
    await waitFor(() => expect(api.retryDocument).toHaveBeenCalledWith(12));
    expect(onRetried).toHaveBeenCalled();
  });

  it('uploads a replacement, triages it, and dismisses the broken original', async () => {
    vi.mocked(api.uploadDocument).mockResolvedValue({
      document: { id: 99, filename: 'better.jpg', mime_type: 'image/jpeg', size_bytes: 1, status: 'pending', processing_since: null, created_at: 1 },
      deduplicated: false,
    });
    const outcome = { kind: 'expense', document_id: 99, expense_id: 7 } as const;
    vi.mocked(api.triageDocument).mockResolvedValue(outcome);
    vi.mocked(api.completeDocument).mockResolvedValue({ id: 12, status: 'processed' });
    const { onReplaced } = renderSheet();
    fireEvent.change(screen.getByLabelText('Replacement file'), {
      target: { files: [new File(['x'], 'better.jpg', { type: 'image/jpeg' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload replacement' }));
    await waitFor(() => expect(api.triageDocument).toHaveBeenCalledWith(99));
    await waitFor(() => expect(api.completeDocument).toHaveBeenCalledWith(12));
    expect(onReplaced).toHaveBeenCalledWith(outcome);
  });

  it('disables Upload replacement until a file is chosen', () => {
    renderSheet();
    expect(
      screen.getByRole('button', { name: 'Upload replacement' }),
    ).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/inbox/ResolveSupplierSheet.test.tsx src/inbox/OcrFailedSheet.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/inbox/ResolveSupplierSheet.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getPendingDraft,
  onboardEntity,
  resolveSupplier,
  type TriageOutcome,
} from '../api';
import { inboxKeys } from '../queries/inbox';
import { useSuppliers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';
import { absoluteDateFromIso, signedEuros } from './format';

/**
 * Triage flow 1 — "who is this supplier?" Prefill → confirm: the AI proposal
 * (name/country/reg-key + the parsed draft) is already filled in; the
 * operator verifies or picks an existing supplier instead. Booking happens
 * server-side via resolve-supplier (the parked draft is completed).
 */
export function ResolveSupplierSheet({
  documentId,
  open,
  onOpenChange,
  onDone,
}: {
  documentId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (o: TriageOutcome) => void;
}) {
  const draftQ = useQuery({
    queryKey: inboxKeys.pendingDraft(documentId),
    queryFn: () => getPendingDraft(documentId),
    enabled: open,
  });
  const suppliersQ = useSuppliers();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [regKey, setRegKey] = useState('');
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (!prefilled && draftQ.data !== undefined) {
      setName(draftQ.data.supplier_proposal.create_name);
      setCountry(draftQ.data.supplier_proposal.create_country);
      setRegKey(draftQ.data.supplier_proposal.create_registration_key);
      setPrefilled(true);
    }
  }, [draftQ.data, prefilled]);

  const draft = draftQ.data?.draft;
  const amount = draft !== undefined ? signedEuros(-draft.gross_amount) : null;

  const finish = async (supplierEntityId: number) => {
    setBusy(true);
    try {
      onDone(await resolveSupplier(documentId, supplierEntityId));
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    setBusy(true);
    try {
      const entity = await onboardEntity({
        role: 'supplier',
        name: name.trim(),
        country: country.trim(),
        registrationKey: regKey.trim(),
      });
      onDone(await resolveSupplier(documentId, entity.id));
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const createValid =
    name.trim() !== '' && country.trim() !== '' && regKey.trim() !== '';
  const matches = (suppliersQ.data ?? [])
    .filter((s) => s.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 6);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Resolve supplier">
      <div className="space-y-3 px-5 pb-2">
        {draftQ.isPending && (
          <p className="text-[13px] text-ink-2">Loading the AI proposal…</p>
        )}
        {draftQ.isError && (
          <p className="text-[13px] font-semibold text-err">
            {draftQ.error instanceof Error
              ? draftQ.error.message
              : 'Failed to load the proposal'}
          </p>
        )}
        {draft !== undefined && (
          <p className="text-[13px] text-ink-2">
            AI read: {draft.category} · {signedEuros(-draft.gross_amount)} ·{' '}
            {absoluteDateFromIso(draft.tax_point_date)}
          </p>
        )}
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Country">
              <TextInput
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Reg. key" hint="Required — identity of the supplier">
              <TextInput
                value={regKey}
                onChange={(e) => setRegKey(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <Button
          className="w-full"
          busy={busy}
          disabled={!createValid || draft === undefined}
          onClick={() => void onCreate()}
        >
          {amount !== null
            ? `Create supplier & book · ${amount}`
            : 'Create supplier & book'}
        </Button>
        <p className="pt-1 text-center text-[11px] font-bold uppercase tracking-wide text-ink-2">
          or pick an existing supplier
        </p>
        <SearchInput value={q} onChange={setQ} placeholder="Search suppliers…" />
        <div className="overflow-hidden rounded-2xl bg-surface">
          {matches.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => void finish(s.id)}
              className="flex w-full items-center justify-between border-b border-line px-3.5 py-3 text-left text-[14px] font-semibold last:border-b-0 disabled:opacity-50"
            >
              {s.name}
              <span className="text-[12px] font-normal text-ink-2">
                {s.country}
              </span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-3.5 py-3 text-[12.5px] text-ink-2">No matches</p>
          )}
        </div>
      </div>
    </Sheet>
  );
}
```

`src/inbox/OcrFailedSheet.tsx`:

```tsx
import { useRef, useState } from 'react';
import {
  completeDocument,
  retryDocument,
  triageDocument,
  uploadDocument,
  type TriageOutcome,
} from '../api';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';

/**
 * Triage flow 4 — OCR failed. Replacement = upload a clearer scan (the NEW
 * file auto-triages; the broken original is archived), or re-run OCR on the
 * same file (result lands via queue polling). Dismiss lives on the screen
 * behind a ConfirmDialog, not here.
 */
export function OcrFailedSheet({
  documentId,
  open,
  onOpenChange,
  onReplaced,
  onRetried,
}: {
  documentId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onReplaced: (o: TriageOutcome) => void;
  onRetried: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [hasFile, setHasFile] = useState(false);
  const [busy, setBusy] = useState(false);

  const onReplace = async () => {
    const file = fileRef.current?.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    try {
      const { document } = await uploadDocument(file);
      const outcome = await triageDocument(document.id);
      await completeDocument(documentId); // archive the unreadable original
      onReplaced(outcome);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const onRetry = async () => {
    setBusy(true);
    try {
      await retryDocument(documentId);
      onRetried();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Fix file">
      <div className="space-y-3 px-5 pb-2">
        <p className="text-[13px] text-ink-2">
          OCR could not read this file. Upload a clearer scan of the SAME
          document (the broken one is archived), or retry on this file.
        </p>
        <input
          ref={fileRef}
          type="file"
          aria-label="Replacement file"
          className="w-full text-[13px]"
          onChange={(e) => setHasFile((e.target.files?.length ?? 0) > 0)}
        />
        <Button
          className="w-full"
          busy={busy}
          disabled={!hasFile}
          onClick={() => void onReplace()}
        >
          Upload replacement
        </Button>
        <Button
          variant="secondary"
          className="w-full"
          disabled={busy}
          onClick={() => void onRetry()}
        >
          Retry OCR on this file
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/inbox/ResolveSupplierSheet.test.tsx src/inbox/OcrFailedSheet.test.tsx && npm test
```

Expected: PASS (7 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/inbox
git commit -m "feat(web): resolve-supplier and OCR-failed sheets — prefill-first, outcome-stating buttons"
```

---

### Task 11: ClassifyExpenseSheet — manual classification with full prefill, category chips, auto-VAT, "usually X" hint

**Files:**
- Create: `packages/web/src/inbox/ClassifyExpenseSheet.tsx`
- Test: `packages/web/src/inbox/ClassifyExpenseSheet.test.tsx`

**Interfaces:**
- Consumes: `getDocumentReclassify` (ONE fetch per open — Reality #8), `manualClassify` (api), `inboxKeys.reclassify` (queries/inbox), `useCategories`/`useSuppliers`/`useExpenses` (queries/shared), `eurosToCents`/`centsToEuroInput`/`vatFromGross` (lib/money), `STANDARD_VAT_RATE_PCT` (bank/format — the sanctioned client constant, Plan 02 gap 5), kit (`Sheet`, `Button`, `Field`, `TextInput`, `SelectInput`, `SearchInput`), `signedEuros` (inbox/format), toasts.
- Produces: `ClassifyExpenseSheet({ documentId, open, onOpenChange, onDone }: { documentId: number; open: boolean; onOpenChange: (o: boolean) => void; onDone: (o: TriageOutcome) => void })` implementing asset §3:
  - **Prefill everything the system knows**: amounts/date/category/VAT-marking from the fresh AI run (`getDocumentReclassify`, `staleTime: Infinity` per open); supplier stays a manual pick (no alias-lookup endpoint — Appendix gap 2).
  - **Supplier = searchable picker** (data rule 8): SearchInput + up to 5 rows; the chosen supplier shows as a row with "Change".
  - **VAT auto-computed, editable**: typing gross recomputes VAT at 22% UNTIL the operator touches the VAT field; hint states the rule ("auto at 22% — edit if the receipt differs").
  - **Category chips, recent-first**: chips ordered by most-recent use across expenses (client-side recency — honest replacement for classification memory, Reality #10), predicted/selected always visible, "All…" expands the full list.
  - **"Usually X · N of M" hint** computed from the picked supplier's real expense history (≥2 expenses).
  - **Submit states the outcome with the amount**: "Create expense · −48.20 €", disabled until supplier + category + valid euros + date.

- [ ] **Step 1: Write failing tests**

`src/inbox/ClassifyExpenseSheet.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getDocumentReclassify: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getExpenses: vi.fn(),
  manualClassify: vi.fn(),
}));

import * as api from '../api';
import { ClassifyExpenseSheet } from './ClassifyExpenseSheet';

function renderSheet(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ClassifyExpenseSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('ClassifyExpenseSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDocumentReclassify).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'CIRCLE K …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 4820,
          vat_amount: 867,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: 'fuel',
          document_vat_marking: null,
          supplier_invoice_number: null,
          confidence: 0.41,
        },
      },
    });
    vi.mocked(api.getCategories).mockResolvedValue([
      { key: 'fuel', label: 'Fuel', accountCode: '5000' },
      { key: 'meals', label: 'Meals', accountCode: '5100' },
      { key: 'office', label: 'Office', accountCode: '5200' },
      { key: 'transport', label: 'Transport', accountCode: '5300' },
      { key: 'software', label: 'Software & IT', accountCode: '5400' },
    ]);
    vi.mocked(api.getEntities).mockResolvedValue([
      { id: 3, role: 'supplier', country: 'EE', name: 'Circle K Eesti AS', goods_vs_services: null },
    ]);
    vi.mocked(api.getExpenses).mockResolvedValue([
      { id: 1, supplier_id: 3, category: 'fuel', gross_amount: 1, vat_amount: 0, currency: 'EUR', tax_point_date: '2026-06-01', status: 'posted', reconciled: false },
      { id: 2, supplier_id: 3, category: 'fuel', gross_amount: 1, vat_amount: 0, currency: 'EUR', tax_point_date: '2026-06-15', status: 'posted', reconciled: false },
      { id: 3, supplier_id: 3, category: 'office', gross_amount: 1, vat_amount: 0, currency: 'EUR', tax_point_date: '2026-05-01', status: 'posted', reconciled: false },
    ]);
    vi.mocked(api.manualClassify).mockResolvedValue({
      kind: 'expense',
      document_id: 12,
      expense_id: 700,
    });
  });

  it('prefills amounts, date and category from the AI run and states the outcome on the button', async () => {
    renderSheet();
    expect(await screen.findByDisplayValue('48.20')).toBeInTheDocument();
    expect(screen.getByDisplayValue('8.67')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-07-01')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create expense · -48.20 €' }),
    ).toBeInTheDocument();
    // Predicted category chip is selected.
    expect(screen.getByRole('button', { name: 'Fuel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('auto-computes VAT at 22% while the VAT field is untouched, then stops', async () => {
    renderSheet();
    const gross = await screen.findByLabelText(/amount \(eur\)/i);
    fireEvent.change(gross, { target: { value: '100.00' } });
    // 10000 * 22 / 122 = 1803
    expect(screen.getByDisplayValue('18.03')).toBeInTheDocument();
    // Exact-string match: a /vat/i regex would also hit "VAT marking".
    const vat = screen.getByLabelText('VAT');
    fireEvent.change(vat, { target: { value: '0.00' } });
    fireEvent.change(gross, { target: { value: '50.00' } });
    expect(screen.getByDisplayValue('0.00')).toBeInTheDocument(); // manual VAT kept
  });

  it('shows the "usually" hint from the supplier history once a supplier is picked', async () => {
    renderSheet();
    fireEvent.change(await screen.findByPlaceholderText(/search suppliers/i), {
      target: { value: 'circle' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Circle K Eesti AS/ }));
    expect(await screen.findByText('Usually Fuel · 2 of 3')).toBeInTheDocument();
  });

  it('disables submit without a supplier, submits cents payload once valid', async () => {
    const onDone = renderSheet();
    const submit = await screen.findByRole('button', {
      name: 'Create expense · -48.20 €',
    });
    expect(submit).toBeDisabled(); // no supplier yet
    fireEvent.change(screen.getByPlaceholderText(/search suppliers/i), {
      target: { value: 'circle' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Circle K Eesti AS/ }));
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.manualClassify).toHaveBeenCalledWith(12, {
        supplier_id: 3,
        category: 'fuel',
        document_vat_marking: null,
        gross_amount: 4820,
        vat_amount: 867,
        currency: 'EUR',
        tax_point_date: '2026-07-01',
        supplier_invoice_number: null,
      }),
    );
    expect(onDone).toHaveBeenCalledWith({
      kind: 'expense',
      document_id: 12,
      expense_id: 700,
    });
  });

  it('expands the full category list behind "All…"', async () => {
    renderSheet();
    await screen.findByDisplayValue('48.20');
    fireEvent.click(screen.getByRole('button', { name: 'All…' }));
    expect(screen.getByRole('button', { name: 'Software & IT' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/inbox/ClassifyExpenseSheet.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/inbox/ClassifyExpenseSheet.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getDocumentReclassify,
  manualClassify,
  type Entity,
  type TriageOutcome,
} from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import { inboxKeys } from '../queries/inbox';
import { useCategories, useExpenses, useSuppliers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';
import { signedEuros } from './format';

const CURRENCIES = ['EUR', 'DKK', 'USD', 'GBP', 'SEK', 'NOK'] as const;
const VAT_MARKINGS = [
  { value: '', label: 'None' },
  { value: 'S', label: 'S — Standard' },
  { value: 'Z', label: 'Z — Zero-rated' },
  { value: 'E', label: 'E — Exempt' },
] as const;

/**
 * Triage flows 2/3 (low confidence / unknown category) — asset §3:
 * everything the system knows is PREFILLED (fresh AI run — the sanctioned
 * reclassify endpoint, fetched once per open); the operator verifies, not
 * types. VAT auto-computes from gross at the standard rate until touched.
 * Category chips are recent-first; the "usually X · N of M" hint is computed
 * from the picked supplier's real expense history (client-side — no
 * classification-memory endpoint exists).
 */
export function ClassifyExpenseSheet({
  documentId,
  open,
  onOpenChange,
  onDone,
}: {
  documentId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (o: TriageOutcome) => void;
}) {
  const reclassifyQ = useQuery({
    queryKey: inboxKeys.reclassify(documentId),
    queryFn: () => getDocumentReclassify(documentId),
    enabled: open,
    staleTime: Infinity, // ALWAYS re-runs the LLM server-side — fetch once
  });
  const categoriesQ = useCategories();
  const suppliersQ = useSuppliers();
  const expensesQ = useExpenses();

  const [supplier, setSupplier] = useState<Entity | null>(null);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [category, setCategory] = useState('');
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const [currency, setCurrency] = useState('EUR');
  const [date, setDate] = useState('');
  const [vatMarking, setVatMarking] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [showAllCats, setShowAllCats] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const c = reclassifyQ.data?.classification;
    if (!prefilled && c != null && c.ok) {
      setGross(centsToEuroInput(c.result.gross_amount));
      setVat(centsToEuroInput(c.result.vat_amount));
      setCurrency(c.result.currency !== '' ? c.result.currency : 'EUR');
      setDate(c.result.tax_point_date);
      setCategory(c.result.category);
      setVatMarking(c.result.document_vat_marking ?? '');
      setInvoiceNumber(c.result.supplier_invoice_number ?? '');
      setPrefilled(true);
    }
  }, [reclassifyQ.data, prefilled]);

  const onGrossChange = (v: string) => {
    setGross(v);
    if (!vatTouched) {
      const cents = eurosToCents(v);
      if (cents !== null && cents > 0) {
        setVat(centsToEuroInput(vatFromGross(cents, STANDARD_VAT_RATE_PCT)));
      }
    }
  };

  const categories = categoriesQ.data ?? [];
  const expenses = expensesQ.data ?? [];

  // Recent-first chip ordering: latest tax_point_date per category key.
  const orderedCategories = useMemo(() => {
    const lastUsed = new Map<string, string>();
    for (const e of expenses) {
      const prev = lastUsed.get(e.category);
      if (prev === undefined || e.tax_point_date > prev) {
        lastUsed.set(e.category, e.tax_point_date);
      }
    }
    return [...categories].sort((a, b) =>
      (lastUsed.get(b.key) ?? '').localeCompare(lastUsed.get(a.key) ?? ''),
    );
  }, [categories, expenses]);

  const visibleCats = useMemo(() => {
    if (showAllCats) return orderedCategories;
    const top = orderedCategories.slice(0, 4);
    const selected = orderedCategories.find((c) => c.key === category);
    return selected !== undefined && !top.includes(selected)
      ? [selected, ...top.slice(0, 3)]
      : top;
  }, [orderedCategories, showAllCats, category]);

  // "Usually X · N of M" — real history of the picked supplier.
  const usuallyHint = useMemo(() => {
    if (supplier === null) return null;
    const es = expenses.filter((e) => e.supplier_id === supplier.id);
    if (es.length < 2) return null;
    const counts = new Map<string, number>();
    for (const e of es) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    const [topKey, topCount] = [...counts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    const label = categories.find((c) => c.key === topKey)?.label ?? topKey;
    return `Usually ${label} · ${topCount} of ${es.length}`;
  }, [supplier, expenses, categories]);

  const grossCents = eurosToCents(gross);
  const vatCents = eurosToCents(vat);
  const valid =
    supplier !== null &&
    category !== '' &&
    date !== '' &&
    grossCents !== null &&
    grossCents > 0 &&
    vatCents !== null &&
    vatCents >= 0;

  const submit = async () => {
    if (!valid || supplier === null || grossCents === null || vatCents === null)
      return;
    setBusy(true);
    try {
      onDone(
        await manualClassify(documentId, {
          supplier_id: supplier.id,
          category,
          document_vat_marking: vatMarking !== '' ? vatMarking : null,
          gross_amount: grossCents,
          vat_amount: vatCents,
          currency,
          tax_point_date: date,
          supplier_invoice_number:
            invoiceNumber !== '' ? invoiceNumber : null,
        }),
      );
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const supplierMatches = (suppliersQ.data ?? [])
    .filter((s) =>
      s.name.toLowerCase().includes(supplierSearch.toLowerCase()),
    )
    .slice(0, 5);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Classify">
      <div className="space-y-3 px-5 pb-2">
        {reclassifyQ.isPending && (
          <p className="text-[13px] text-ink-2">
            Re-reading the document (OCR + AI)… this can take a minute
          </p>
        )}
        {reclassifyQ.isError && (
          <p className="text-[13px] font-semibold text-err">
            {reclassifyQ.error instanceof Error
              ? reclassifyQ.error.message
              : 'AI prefill failed — fill in manually'}
          </p>
        )}

        <Field label="Supplier">
          {supplier === null ? (
            <>
              <SearchInput
                value={supplierSearch}
                onChange={setSupplierSearch}
                placeholder="Search suppliers…"
              />
              <div className="mt-1 overflow-hidden rounded-xl bg-surface">
                {supplierMatches.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSupplier(s)}
                    className="flex w-full items-center justify-between border-b border-line px-3.5 py-2.5 text-left text-[14px] font-semibold last:border-b-0"
                  >
                    {s.name}
                    <span className="text-[12px] font-normal text-ink-2">
                      {s.country}
                    </span>
                  </button>
                ))}
                {supplierMatches.length === 0 && (
                  <p className="px-3.5 py-2.5 text-[12.5px] text-ink-2">
                    No matches — unknown suppliers go through “Resolve supplier”
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2.5">
              <span className="text-[15px] font-semibold">{supplier.name}</span>
              <button
                type="button"
                onClick={() => setSupplier(null)}
                className="text-[13px] font-semibold text-accent"
              >
                Change
              </button>
            </div>
          )}
        </Field>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Amount (EUR)" hint={`from OCR · VAT auto at ${STANDARD_VAT_RATE_PCT}%`}>
              <TextInput
                aria-label="Amount (EUR)"
                inputMode="decimal"
                value={gross}
                onChange={(e) => onGrossChange(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="VAT" hint="edit if the receipt differs">
              <TextInput
                aria-label="VAT"
                inputMode="decimal"
                value={vat}
                onChange={(e) => {
                  setVatTouched(true);
                  setVat(e.target.value);
                }}
              />
            </Field>
          </div>
        </div>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Date">
              <TextInput
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Currency">
              <SelectInput
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
        </div>

        <Field label="Category" hint={usuallyHint ?? undefined}>
          <div className="flex flex-wrap gap-1.5">
            {visibleCats.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={category === c.key}
                onClick={() => setCategory(c.key)}
                className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                  category === c.key
                    ? 'bg-accent-deep text-white'
                    : 'border border-line bg-surface text-ink-2'
                }`}
              >
                {c.label}
              </button>
            ))}
            {!showAllCats && orderedCategories.length > visibleCats.length && (
              <button
                type="button"
                onClick={() => setShowAllCats(true)}
                className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-2"
              >
                All…
              </button>
            )}
          </div>
        </Field>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="VAT marking">
              <SelectInput
                value={vatMarking}
                onChange={(e) => setVatMarking(e.target.value)}
              >
                {VAT_MARKINGS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Invoice number">
              <TextInput
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <Button
          className="w-full"
          busy={busy}
          disabled={!valid}
          onClick={() => void submit()}
        >
          {grossCents !== null && grossCents > 0
            ? `Create expense · ${signedEuros(-grossCents)}`
            : 'Create expense'}
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/inbox/ClassifyExpenseSheet.test.tsx && npm test
```

Expected: PASS (5 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/inbox
git commit -m "feat(web): manual classify sheet — full prefill, auto-VAT, recent-first chips, usually-X hint"
```

---

### Task 12: ClassifyInvoiceSheet — outgoing-invoice classification

**Files:**
- Create: `packages/web/src/inbox/ClassifyInvoiceSheet.tsx`
- Test: `packages/web/src/inbox/ClassifyInvoiceSheet.test.tsx`

**Interfaces:**
- Consumes: `getDocumentReclassify` (same one-shot prefill), `manualClassifyInvoice` (api), `useCustomers` (queries/shared), same kit + money helpers.
- Produces: `ClassifyInvoiceSheet({ documentId, open, onOpenChange, onDone })` — mirror of Task 11 for `outgoing_invoice`: customer OPTIONAL (searchable picker), invoice number REQUIRED, gross/VAT with the same auto-VAT behavior, date/currency/marking; submit "Record invoice · +48.20 €" (`manualClassifyInvoice` with `target: 'sales_invoice'`). Prefill from the AI run includes `supplier_invoice_number` → the invoice-number field (the AI reads the number off the document regardless of direction).

- [ ] **Step 1: Write failing tests**

`src/inbox/ClassifyInvoiceSheet.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getDocumentReclassify: vi.fn(),
  getEntities: vi.fn(),
  manualClassifyInvoice: vi.fn(),
}));

import * as api from '../api';
import { ClassifyInvoiceSheet } from './ClassifyInvoiceSheet';

function renderSheet(onDone = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ClassifyInvoiceSheet
        documentId={12}
        open
        onOpenChange={() => undefined}
        onDone={onDone}
      />
    </QueryClientProvider>,
  );
  return onDone;
}

describe('ClassifyInvoiceSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDocumentReclassify).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'INVOICE 2026-018 …' },
      classification: {
        ok: true,
        result: {
          kind: 'outgoing_invoice',
          document_type: 'invoice',
          gross_amount: 120000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: '',
          document_vat_marking: null,
          supplier_invoice_number: '2026-018',
          confidence: 0.6,
        },
      },
    });
    vi.mocked(api.getEntities).mockResolvedValue([
      { id: 4, role: 'customer', country: 'EE', name: 'Nordic Consulting OÜ', goods_vs_services: null },
    ]);
    vi.mocked(api.manualClassifyInvoice).mockResolvedValue({
      kind: 'invoice',
      document_id: 12,
      invoice_id: 60,
    });
  });

  it('prefills amounts and the invoice number, states the outcome with +amount', async () => {
    renderSheet();
    expect(await screen.findByDisplayValue('1200.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-018')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Record invoice · +1200.00 €' }),
    ).toBeInTheDocument();
  });

  it('requires the invoice number', async () => {
    renderSheet();
    const nr = await screen.findByDisplayValue('2026-018');
    fireEvent.change(nr, { target: { value: '' } });
    expect(
      screen.getByRole('button', { name: 'Record invoice · +1200.00 €' }),
    ).toBeDisabled();
  });

  it('submits the sales_invoice payload with optional customer', async () => {
    const onDone = renderSheet();
    fireEvent.change(await screen.findByPlaceholderText(/search customers/i), {
      target: { value: 'nordic' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Nordic Consulting/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Record invoice · +1200.00 €' }),
    );
    await waitFor(() =>
      expect(api.manualClassifyInvoice).toHaveBeenCalledWith(12, {
        target: 'sales_invoice',
        customer_id: 4,
        invoice_number: '2026-018',
        document_vat_marking: null,
        gross_amount: 120000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-07-01',
      }),
    );
    expect(onDone).toHaveBeenCalledWith({
      kind: 'invoice',
      document_id: 12,
      invoice_id: 60,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/inbox/ClassifyInvoiceSheet.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/inbox/ClassifyInvoiceSheet.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getDocumentReclassify,
  manualClassifyInvoice,
  type Entity,
  type TriageOutcome,
} from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import { inboxKeys } from '../queries/inbox';
import { useCustomers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { SearchInput } from '../ui/SearchInput';
import { Sheet } from '../ui/Sheet';
import { toastErr } from '../ui/toast';

const CURRENCIES = ['EUR', 'DKK', 'USD', 'GBP', 'SEK', 'NOK'] as const;
const VAT_MARKINGS = [
  { value: '', label: 'None' },
  { value: 'S', label: 'S — Standard' },
  { value: 'Z', label: 'Z — Zero-rated' },
  { value: 'E', label: 'E — Exempt' },
] as const;

/** Triage flow — a document the AI recognized as YOUR outgoing invoice.
 *  Records it as a sales invoice (customer optional). Same prefill-first
 *  shape as ClassifyExpenseSheet. */
export function ClassifyInvoiceSheet({
  documentId,
  open,
  onOpenChange,
  onDone,
}: {
  documentId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (o: TriageOutcome) => void;
}) {
  const reclassifyQ = useQuery({
    queryKey: inboxKeys.reclassify(documentId),
    queryFn: () => getDocumentReclassify(documentId),
    enabled: open,
    staleTime: Infinity,
  });
  const customersQ = useCustomers();

  const [customer, setCustomer] = useState<Entity | null>(null);
  const [search, setSearch] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const [currency, setCurrency] = useState('EUR');
  const [date, setDate] = useState('');
  const [vatMarking, setVatMarking] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const c = reclassifyQ.data?.classification;
    if (!prefilled && c != null && c.ok) {
      setGross(centsToEuroInput(c.result.gross_amount));
      setVat(centsToEuroInput(c.result.vat_amount));
      setCurrency(c.result.currency !== '' ? c.result.currency : 'EUR');
      setDate(c.result.tax_point_date);
      setVatMarking(c.result.document_vat_marking ?? '');
      setInvoiceNumber(c.result.supplier_invoice_number ?? '');
      setPrefilled(true);
    }
  }, [reclassifyQ.data, prefilled]);

  const onGrossChange = (v: string) => {
    setGross(v);
    if (!vatTouched) {
      const cents = eurosToCents(v);
      if (cents !== null && cents > 0) {
        setVat(centsToEuroInput(vatFromGross(cents, STANDARD_VAT_RATE_PCT)));
      }
    }
  };

  const grossCents = eurosToCents(gross);
  const vatCents = eurosToCents(vat);
  const valid =
    invoiceNumber.trim() !== '' &&
    date !== '' &&
    grossCents !== null &&
    grossCents > 0 &&
    vatCents !== null &&
    vatCents >= 0;

  const submit = async () => {
    if (!valid || grossCents === null || vatCents === null) return;
    setBusy(true);
    try {
      onDone(
        await manualClassifyInvoice(documentId, {
          target: 'sales_invoice',
          customer_id: customer?.id ?? null,
          invoice_number: invoiceNumber.trim(),
          document_vat_marking: vatMarking !== '' ? vatMarking : null,
          gross_amount: grossCents,
          vat_amount: vatCents,
          currency,
          tax_point_date: date,
        }),
      );
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const matches = (customersQ.data ?? [])
    .filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 5);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Record sales invoice">
      <div className="space-y-3 px-5 pb-2">
        {reclassifyQ.isPending && (
          <p className="text-[13px] text-ink-2">
            Re-reading the document (OCR + AI)… this can take a minute
          </p>
        )}

        <Field label="Customer (optional)">
          {customer === null ? (
            <>
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search customers…"
              />
              <div className="mt-1 overflow-hidden rounded-xl bg-surface">
                {matches.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCustomer(c)}
                    className="flex w-full items-center justify-between border-b border-line px-3.5 py-2.5 text-left text-[14px] font-semibold last:border-b-0"
                  >
                    {c.name}
                    <span className="text-[12px] font-normal text-ink-2">
                      {c.country}
                    </span>
                  </button>
                ))}
                {matches.length === 0 && (
                  <p className="px-3.5 py-2.5 text-[12.5px] text-ink-2">
                    No matches — leave empty if unknown
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2.5">
              <span className="text-[15px] font-semibold">{customer.name}</span>
              <button
                type="button"
                onClick={() => setCustomer(null)}
                className="text-[13px] font-semibold text-accent"
              >
                Change
              </button>
            </div>
          )}
        </Field>

        <Field label="Invoice number">
          <TextInput
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
          />
        </Field>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Amount (EUR)">
              <TextInput
                aria-label="Amount (EUR)"
                inputMode="decimal"
                value={gross}
                onChange={(e) => onGrossChange(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="VAT">
              <TextInput
                aria-label="VAT"
                inputMode="decimal"
                value={vat}
                onChange={(e) => {
                  setVatTouched(true);
                  setVat(e.target.value);
                }}
              />
            </Field>
          </div>
        </div>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <Field label="Date">
              <TextInput
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Currency">
              <SelectInput
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
        </div>

        <Field label="VAT marking">
          <SelectInput
            value={vatMarking}
            onChange={(e) => setVatMarking(e.target.value)}
          >
            {VAT_MARKINGS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Button
          className="w-full"
          busy={busy}
          disabled={!valid}
          onClick={() => void submit()}
        >
          {grossCents !== null && grossCents > 0
            ? `Record invoice · +${(grossCents / 100).toFixed(2)} €`
            : 'Record invoice'}
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/inbox/ClassifyInvoiceSheet.test.tsx && npm test
```

Expected: PASS (3 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/inbox
git commit -m "feat(web): classify-as-invoice sheet with prefill and outcome-stating submit"
```

---

### Task 13: TriageDocScreen — composition, action routing, dismiss/retry/delete, auto-advance

**Files:**
- Create: `packages/web/src/inbox/TriageDocScreen.tsx`
- Test: `packages/web/src/inbox/TriageDocScreen.test.tsx`

**Interfaces:**
- Consumes: `useNeedsTriage`, `useInboxQueue`, `queuePosition`, `nextRouteAfter`, `inboxKeys.docDetails`, `invalidateInbox` (queries/inbox), `getDocumentDetails`, `completeDocument`, `retryDocument`, `deleteDocument` (api), the four sheets (Tasks 10–12), `DocPreviewRow`, `triageSubtitle`/`triageChipLabel`/`outcomeText` (inbox/reason), `signedEuros`/`absoluteDateFromIso` (inbox/format), `ScreenHeader`, kit (`Button`, `ConfirmDialog`, `KeyValue`, `ListGroup`, `Chip`, `SkeletonRows`, `EmptyState`), `LinkButton`, `LoadError`, toasts.
- Produces: `TriageDocScreen(): JSX.Element` at `/inbox/doc/:id`:
  - Nav "N of M" over the FIFO queue; document preview row; warn "Needs a decision" box (human one-liner + the raw server sentence as the where-from detail — progressive disclosure, data rule 4); facts KV from PERSISTED artifacts (`getDocumentDetails`, ADR-0039) when classification exists (amount, VAT, date, category, confidence); OCR markdown behind a native `<details>` collapsible.
  - Action routing mirrors the legacy `TriagePanel` mapping: `supplier_unresolved` → ResolveSupplierSheet; `low_confidence`/`category_unresolved` → ClassifyExpenseSheet; `outgoing_invoice` → ClassifyInvoiceSheet; `ocr_failed` → OcrFailedSheet. Other types have NO form — Dismiss becomes the primary (one primary per state).
  - Secondary actions everywhere: "Retry AI" (`retryDocument` → toast → advance; result lands via polling) and "Dismiss" (ConfirmDialog — archives with no undo, Reality #7). `not_a_document` additionally offers "Delete file…" (destructive ConfirmDialog, `deleteDocument`).
  - Every successful resolution: outcome toast (`outcomeText`) → `invalidateInbox` → `navigate(nextRouteAfter(...))`; an `unknown` outcome keeps the operator on the screen (still unresolved) with an error toast.
  - Unknown/handled id → "Already handled" state with back LinkButton.

- [ ] **Step 1: Write failing tests**

`src/inbox/TriageDocScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
  getDocumentDetails: vi.fn(),
  getDocumentReclassify: vi.fn(),
  getPendingDraft: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
  getExpenses: vi.fn(),
  completeDocument: vi.fn(),
  retryDocument: vi.fn(),
  deleteDocument: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn(),
  openSignedDocument: vi.fn(),
}));

import * as api from '../api';
import type { NeedsTriageItem } from '../api';
import { TriageDocScreen } from './TriageDocScreen';

const ITEM = (over: Partial<NeedsTriageItem> = {}): NeedsTriageItem => ({
  id: 12,
  filename: 'cheque_scan_038.jpg',
  created_at: 100,
  reason: 'AI confidence 0.41 below threshold 0.8',
  reason_type: 'low_confidence',
  ...over,
});

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/inbox', element: <p>queue</p> },
      { path: '/inbox/doc/:id', element: <TriageDocScreen /> },
      { path: '/inbox/approval/:id', element: <p>approval detail</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('TriageDocScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      ITEM(),
      ITEM({ id: 13, filename: 'later.pdf', created_at: 200 }),
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    vi.mocked(api.getDocumentDetails).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'CIRCLE K 48.20 …' },
      classification: {
        ok: true,
        result: {
          kind: 'new_expense',
          document_type: 'receipt',
          gross_amount: 4820,
          vat_amount: 867,
          currency: 'EUR',
          tax_point_date: '2026-07-01',
          category: 'fuel',
          document_vat_marking: null,
          supplier_invoice_number: null,
          confidence: 0.41,
        },
      },
    });
    vi.mocked(api.getCategories).mockResolvedValue([]);
    vi.mocked(api.getEntities).mockResolvedValue([]);
    vi.mocked(api.getExpenses).mockResolvedValue([]);
    vi.mocked(api.fetchDocumentPreviewObjectUrl).mockRejectedValue(
      new Error('no preview'),
    );
  });

  it('renders N of M, the human reason with the raw sentence, and persisted facts', async () => {
    renderAt('/inbox/doc/12');
    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
    expect(
      screen.getByText('AI confidence 0.41 — below the 0.8 threshold, check the result'),
    ).toBeInTheDocument();
    expect(await screen.findByText('-48.20 €')).toBeInTheDocument();
    expect(screen.getByText('01.07.2026')).toBeInTheDocument();
    expect(screen.getByText('OCR text')).toBeInTheDocument();
  });

  it('routes low_confidence to the classify sheet as the single primary', async () => {
    vi.mocked(api.getDocumentReclassify).mockResolvedValue({
      document_id: 12,
      ocr: { ok: true, markdown: 'x' },
      classification: null,
    });
    renderAt('/inbox/doc/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Classify…' }));
    expect(await screen.findByText('Classify', { selector: 'h2' })).toBeInTheDocument();
  });

  it('routes supplier_unresolved to the resolve sheet', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      ITEM({ reason_type: 'supplier_unresolved', reason: 'supplier not found' }),
    ]);
    vi.mocked(api.getPendingDraft).mockResolvedValue({
      document_id: 12,
      reason: 'supplier not found',
      supplier_proposal: { create_name: 'X', create_country: 'EE', create_registration_key: 'Y' },
      draft: { category: 'fuel', gross_amount: 1, vat_amount: 0, currency: 'EUR', tax_point_date: '2026-07-01', supplier_invoice_number: null },
    });
    renderAt('/inbox/doc/12');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Resolve supplier…' }),
    );
    expect(
      await screen.findByText('Resolve supplier', { selector: 'h2' }),
    ).toBeInTheDocument();
  });

  it('dismisses behind a ConfirmDialog and advances to the next item', async () => {
    vi.mocked(api.completeDocument).mockResolvedValue({ id: 12, status: 'processed' });
    const router = renderAt('/inbox/doc/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Dismiss document' }),
    );
    await waitFor(() => expect(api.completeDocument).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/13'),
    );
  });

  it('Retry AI re-queues the document and advances', async () => {
    vi.mocked(api.retryDocument).mockResolvedValue({ ok: true });
    const router = renderAt('/inbox/doc/12');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry AI' }));
    await waitFor(() => expect(api.retryDocument).toHaveBeenCalledWith(12));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/13'),
    );
  });

  it('not_a_document gets Dismiss as primary plus a destructive Delete', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      ITEM({
        reason_type: 'not_a_document',
        reason: 'Not a business accounting document — …',
      }),
    ]);
    vi.mocked(api.deleteDocument).mockResolvedValue({ deleted: 12 });
    const router = renderAt('/inbox/doc/12');
    expect(
      await screen.findByRole('button', { name: 'Delete file…' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete file…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith(12));
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox'));
  });

  it('shows the already-handled state for an id not in the queue', async () => {
    renderAt('/inbox/doc/404');
    expect(await screen.findByText('Already handled')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/inbox/TriageDocScreen.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/inbox/TriageDocScreen.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  completeDocument,
  deleteDocument,
  getDocumentDetails,
  retryDocument,
  type TriageOutcome,
} from '../api';
import { ScreenHeader } from '../shell/Headers';
import {
  inboxKeys,
  invalidateInbox,
  nextRouteAfter,
  queuePosition,
  useInboxQueue,
  useNeedsTriage,
} from '../queries/inbox';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup } from '../ui/List';
import { LinkButton } from '../ui/LinkButton';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { ClassifyExpenseSheet } from './ClassifyExpenseSheet';
import { ClassifyInvoiceSheet } from './ClassifyInvoiceSheet';
import { DocPreviewRow } from './DocPreviewRow';
import { absoluteDateFromIso, signedEuros, vatRatePct } from './format';
import { OcrFailedSheet } from './OcrFailedSheet';
import { outcomeText, triageSubtitle } from './reason';
import { ResolveSupplierSheet } from './ResolveSupplierSheet';

type SheetKind = 'resolve' | 'classify' | 'invoice' | 'ocr';

/** /inbox/doc/:id — triage detail: persisted facts + the right resolution
 *  flow for the reason (fullscreen sheets), plus Retry AI / Dismiss / Delete.
 *  Facts come from getDocumentDetails ONLY (ADR-0039); the AI re-run happens
 *  inside the classify sheets via the sanctioned reclassify endpoint. */
export function TriageDocScreen() {
  const { id } = useParams();
  const docId = Number(id);
  const route = `/inbox/doc/${docId}`;
  const navigate = useNavigate();
  const qc = useQueryClient();

  const triageQ = useNeedsTriage();
  const item = triageQ.data?.find((i) => i.id === docId);
  const { entries } = useInboxQueue('all');
  const position = queuePosition(entries, route);
  const next = nextRouteAfter(entries, route);
  const detailsQ = useQuery({
    queryKey: inboxKeys.docDetails(docId),
    queryFn: () => getDocumentDetails(docId),
  });

  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [confirm, setConfirm] = useState<'dismiss' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  const finishTriage = async (o: TriageOutcome) => {
    setSheet(null);
    if (o.kind === 'unknown') {
      // Still unresolved — stay here, refresh the reason.
      toastErr(outcomeText(o));
      await invalidateInbox(qc);
      return;
    }
    toastOk(outcomeText(o));
    await invalidateInbox(qc);
    navigate(next);
  };

  const runAction = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      toastOk(message);
      await invalidateInbox(qc);
      navigate(next);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setConfirm(null);
    }
  };

  const title =
    position !== null ? `${position.pos} of ${position.total}` : 'Document';

  if (triageQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Document" backTo="/inbox" />
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (triageQ.isError) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Document" backTo="/inbox" />
        <LoadError
          message={
            triageQ.error instanceof Error
              ? triageQ.error.message
              : 'Failed to load the queue'
          }
          onRetry={() => void triageQ.refetch()}
        />
      </div>
    );
  }
  if (item === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Document" backTo="/inbox" />
        <EmptyState
          icon="✓"
          title="Already handled"
          hint="This document is no longer waiting for triage."
          action={<LinkButton to="/inbox">Back to Inbox</LinkButton>}
        />
      </div>
    );
  }

  const primary = (() => {
    switch (item.reason_type) {
      case 'supplier_unresolved':
        return { label: 'Resolve supplier…', open: 'resolve' as const };
      case 'low_confidence':
      case 'category_unresolved':
        return { label: 'Classify…', open: 'classify' as const };
      case 'outgoing_invoice':
        return { label: 'Record sales invoice…', open: 'invoice' as const };
      case 'ocr_failed':
        return { label: 'Fix file…', open: 'ocr' as const };
      default:
        return null; // Dismiss becomes the primary below
    }
  })();

  const classification = detailsQ.data?.classification;
  const ocr = detailsQ.data?.ocr;

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title={title} backTo="/inbox" />
      <div className="px-5 pb-2 pt-1 text-center">
        <p className="truncate text-[17px] font-extrabold">{item.filename}</p>
      </div>
      <div className="mx-3.5 mb-3 rounded-[13px] bg-warn-bg px-3.5 py-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-warn">
          Needs a decision
        </p>
        <p className="text-[12.5px] leading-snug text-warn">
          {triageSubtitle(item)}
        </p>
        {triageSubtitle(item) !== item.reason && (
          <p className="mt-1 text-[11px] leading-snug text-warn opacity-80">
            {item.reason}
          </p>
        )}
      </div>
      <DocPreviewRow documentId={docId} />
      {classification != null && classification.ok && (
        <ListGroup label="AI read (saved at intake)">
          <KeyValue
            k="Amount"
            v={signedEuros(-classification.result.gross_amount)}
          />
          <KeyValue
            k="VAT"
            v={
              vatRatePct(
                classification.result.gross_amount,
                classification.result.vat_amount,
              ) !== null
                ? `${(classification.result.vat_amount / 100).toFixed(2)} € (${vatRatePct(classification.result.gross_amount, classification.result.vat_amount)}%)`
                : `${(classification.result.vat_amount / 100).toFixed(2)} €`
            }
          />
          <KeyValue
            k="Date"
            v={absoluteDateFromIso(classification.result.tax_point_date)}
          />
          <KeyValue k="Category" v={classification.result.category || '—'} />
          <KeyValue
            k="AI confidence"
            v={
              <span
                className={
                  classification.result.confidence >= 0.9
                    ? 'text-ok'
                    : 'text-warn'
                }
              >
                {classification.result.confidence.toFixed(2)}
              </span>
            }
          />
        </ListGroup>
      )}
      {ocr != null && ocr.ok && (
        <details className="mx-3.5 mb-3 rounded-2xl bg-surface px-3.5 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold">
            OCR text
          </summary>
          <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-[12px] text-ink-2">
            {ocr.markdown}
          </pre>
        </details>
      )}

      <div className="mx-3.5 mt-2 space-y-2.5">
        {primary !== null && (
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => setSheet(primary.open)}
          >
            {primary.label}
          </Button>
        )}
        <div className="flex gap-2.5">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={busy}
            onClick={() =>
              void runAction(
                () => retryDocument(docId),
                'Queued for a fresh AI run — the queue updates as it lands',
              )
            }
          >
            Retry AI
          </Button>
          <Button
            variant={primary === null ? 'primary' : 'secondary'}
            className="flex-1"
            disabled={busy}
            onClick={() => setConfirm('dismiss')}
          >
            Dismiss
          </Button>
        </div>
        {item.reason_type === 'not_a_document' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirm('delete')}
            className="w-full py-1 text-center text-[13px] font-semibold text-err disabled:opacity-50"
          >
            Delete file…
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirm === 'dismiss'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Dismiss this document?"
        body="It is archived as processed without creating anything. There is no undo."
        confirmLabel="Dismiss document"
        busy={busy}
        onConfirm={() =>
          void runAction(
            () => completeDocument(docId),
            'Dismissed — archived without booking',
          )
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Delete this file?"
        body="The file is removed entirely. Use Dismiss instead to keep it in the archive."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() =>
          void runAction(() => deleteDocument(docId), 'File deleted')
        }
      />

      <ResolveSupplierSheet
        documentId={docId}
        open={sheet === 'resolve'}
        onOpenChange={(o) => setSheet(o ? 'resolve' : null)}
        onDone={(o) => void finishTriage(o)}
      />
      <ClassifyExpenseSheet
        documentId={docId}
        open={sheet === 'classify'}
        onOpenChange={(o) => setSheet(o ? 'classify' : null)}
        onDone={(o) => void finishTriage(o)}
      />
      <ClassifyInvoiceSheet
        documentId={docId}
        open={sheet === 'invoice'}
        onOpenChange={(o) => setSheet(o ? 'invoice' : null)}
        onDone={(o) => void finishTriage(o)}
      />
      <OcrFailedSheet
        documentId={docId}
        open={sheet === 'ocr'}
        onOpenChange={(o) => setSheet(o ? 'ocr' : null)}
        onReplaced={(o) => void finishTriage(o)}
        onRetried={() =>
          void runAction(
            () => Promise.resolve(),
            'Queued for a fresh AI run — the queue updates as it lands',
          )
        }
      />
    </div>
  );
}
```

Note: `OcrFailedSheet` already calls `retryDocument` itself before invoking `onRetried` — the `runAction(() => Promise.resolve(), …)` wrapper only toasts + invalidates + advances (no double retry).

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/inbox/TriageDocScreen.test.tsx && npm test
```

Expected: PASS (7 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/inbox
git commit -m "feat(web): triage detail screen — persisted facts, sheet routing, dismiss/retry/delete with auto-advance"
```

---

### Task 14: Live badge wiring — TabBar + Sidebar via AppLayout

**Files:**
- Modify: `packages/web/src/shell/AppLayout.tsx`
- Modify: `packages/web/src/shell/AppLayout.test.tsx` (replace — the shell now needs a QueryClientProvider)

**Interfaces:**
- Consumes: `useInboxCount` (queries/inbox — Reality #11: same cache keys as the queue, NO polling), the existing dead-code `inboxCount` props on `TabBar`/`Sidebar` (Plan 01 built them; nothing passes them today — `shell/AppLayout.tsx:8,12`).
- Produces: `AppLayout` passes the live count to both navs. `Root` already wraps `AppLayout` in the `QueryClientProvider` (`shell/Root.tsx:21-22`), so the hook is legal there.

- [ ] **Step 1: Replace `src/shell/AppLayout.test.tsx`** (the old two tests are preserved, re-hosted inside a provider; two badge tests added):

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getNeedsTriageItems: vi.fn(),
  getPendingApprovals: vi.fn(),
}));

import * as api from '../api';
import { AppLayout } from './AppLayout';

function renderShell(path = '/inbox') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        element: <AppLayout onSignOut={vi.fn()} />,
        children: [
          { path: '/inbox', element: <p>inbox body</p> },
          { path: '/books', element: <p>books body</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('AppLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
  });

  it('renders all five sections in both navs and the outlet content', () => {
    renderShell();
    expect(screen.getAllByRole('link', { name: /inbox/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /books/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /bank/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /reports/i })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /settings/i })).toHaveLength(2);
    expect(screen.getByText('inbox body')).toBeInTheDocument();
  });

  it('marks the active section', () => {
    renderShell('/books');
    const active = screen
      .getAllByRole('link', { name: /books/i })
      .map((a) => a.getAttribute('aria-current'));
    expect(active).toContain('page');
  });

  it('shows the live inbox badge in BOTH navs (triage + approvals summed)', async () => {
    vi.mocked(api.getNeedsTriageItems).mockResolvedValue([
      { id: 1, filename: 'a.pdf', created_at: 1, reason: 'x', reason_type: 'unknown' },
      { id: 2, filename: 'b.pdf', created_at: 2, reason: 'x', reason_type: 'unknown' },
    ]);
    vi.mocked(api.getPendingApprovals).mockResolvedValue([
      { id: 7, object_type: 'expense', object_id: 1, status: 'pending', requested_by: 'p', approved_by: null, rejected_reason: null, policy_reason: null, superseded_by: null, created_at: 3, resolved_at: null },
    ]);
    renderShell();
    await waitFor(() => expect(screen.getAllByText('3')).toHaveLength(2));
  });

  it('hides the badge at zero', async () => {
    renderShell();
    await waitFor(() => expect(api.getPendingApprovals).toHaveBeenCalled());
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
npx vitest run src/shell/AppLayout.test.tsx
```

Expected: FAIL — the badge test finds no '3' (AppLayout passes nothing).

- [ ] **Step 3: Implement — replace `src/shell/AppLayout.tsx`**

```tsx
import { Outlet } from 'react-router-dom';
import { useInboxCount } from '../queries/inbox';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';

export function AppLayout({ onSignOut }: { onSignOut: () => void }) {
  // Live decision-queue badge. NO polling here — the hook shares the Inbox
  // queue's cache keys and refreshes via staleTime/focus + Inbox refetches.
  const inboxCount = useInboxCount();
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Sidebar onSignOut={onSignOut} inboxCount={inboxCount} />
      <div className="pb-24 lg:pb-6 lg:pl-56">
        <Outlet />
      </div>
      <TabBar inboxCount={inboxCount} />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/shell/AppLayout.test.tsx && npm test
```

Expected: PASS (4 tests). Note: `router.test.tsx` mounts routes through `Root` (which provides the QueryClient), so AppLayout's new hook does not break it; if any router test hits unmocked fetch noise from the badge queries, Task 15 adds the URL-routing fetch mock that settles it.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/shell/AppLayout.tsx packages/web/src/shell/AppLayout.test.tsx
git commit -m "feat(web): live inbox badge in TabBar and Sidebar (Plan 01 dead prop wired)"
```

---

### Task 15: Mount the Inbox routes, delete legacy IntakeView/ApprovalsView

**Files:**
- Modify: `packages/web/src/shell/router.tsx`
- Modify: `packages/web/src/shell/router.test.tsx`
- Delete: `packages/web/src/components/IntakeView.tsx`, `packages/web/src/components/IntakeView.test.tsx`, `packages/web/src/components/ApprovalsView.tsx`, `packages/web/src/components/ApprovalsView.test.tsx`

**Interfaces:**
- Consumes: `InboxScreen`, `TriageDocScreen`, `ApprovalScreen` (inbox/).
- Produces: `/inbox`, `/inbox/doc/:id`, `/inbox/approval/:id` replacing the LegacyTabs Inbox mount. Legacy redirects updated: `/intake` → `/inbox?seg=triage` and `/approvals` → `/inbox?seg=approvals` (the merge helper preserves `?expand=N`, which InboxScreen forwards to `/inbox/doc/N`). Old `/inbox?tab=…` bookmarks keep working via the screen's `tab` alias.
- **Survivors (explicit):** `TriagePanel`, `ResolveSupplierForm`, `TriageManualForm`, `TriageManualInvoiceForm`, `TriageOcrFailedForm`, `DocumentThumb`, `reasonBadge.ts` stay — `DocumentsView` consumes them until the Books plan deletes that whole cluster.

- [ ] **Step 1: Update `src/shell/router.test.tsx`**

Replace the `/intake` redirect test and add Inbox assertions. The full updated file:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth';
import { buildRoutes } from './router';

function renderAt(path: string) {
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

/** The new Inbox screens fetch on mount; route JSON per endpoint so any
 *  screen the router lands on renders without network noise. */
function mockApiFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (url.includes('/api/triage/needs-triage')) return json({ items: [] });
    if (url.includes('/api/approvals/pending')) return json({ approvals: [] });
    if (url.includes('/api/expenses')) return json({ expenses: [] });
    if (url.includes('/api/sales-invoices')) return json({ invoices: [] });
    if (url.includes('/api/entities')) return json({ entities: [] });
    if (url.includes('/api/reporting-periods'))
      return json({ reportingPeriods: [] });
    if (url.includes('/api/documents/')) return json({});
    return json([]);
  });
}

describe('router', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('test-token');
    mockApiFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the token gate when no token is stored', () => {
    localStorage.clear();
    renderAt('/inbox');
    expect(
      screen.getByRole('heading', { name: /api token/i }),
    ).toBeInTheDocument();
  });

  it('redirects / to /inbox and renders the new queue screen', async () => {
    const router = renderAt('/');
    expect(router.state.location.pathname).toBe('/inbox');
    expect(
      await screen.findByRole('heading', { name: 'Inbox' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^All$/ })).toBeInTheDocument();
  });

  it('redirects legacy /intake?expand=5 all the way to the triage detail route', async () => {
    const router = renderAt('/intake?expand=5');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/inbox/doc/5'),
    );
  });

  it('redirects legacy /approvals to the approvals segment', () => {
    const router = renderAt('/approvals');
    expect(router.state.location.pathname).toBe('/inbox');
    expect(router.state.location.search).toContain('seg=approvals');
  });

  it('redirects legacy /expenses to /books?tab=expenses', () => {
    const router = renderAt('/expenses');
    expect(router.state.location.pathname).toBe('/books');
    expect(router.state.location.search).toContain('tab=expenses');
  });

  it('renders legacy section tabs at /settings', () => {
    renderAt('/settings');
    expect(
      screen.getByRole('tab', { name: 'Organization' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Entities' })).toBeInTheDocument();
  });

  it('renders the new Bank statements screen at /bank', async () => {
    renderAt('/bank');
    expect(
      await screen.findByRole('heading', { name: 'Bank' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      '/bank/import',
    );
  });
});
```

- [ ] **Step 2: Run to verify the new expectations fail**

```bash
npx vitest run src/shell/router.test.tsx
```

Expected: FAIL — `/inbox` still renders LegacyTabs (no "All" tab of the new screen; `/intake?expand=5` parks at `/inbox` with `tab=triage`).

- [ ] **Step 3: Swap the routes in `src/shell/router.tsx`**

Remove the imports of `IntakeView` and `ApprovalsView`; add:

```tsx
import { ApprovalScreen } from '../inbox/ApprovalScreen';
import { InboxScreen } from '../inbox/InboxScreen';
import { TriageDocScreen } from '../inbox/TriageDocScreen';
```

Replace the `/inbox` LegacyTabs route object:

```tsx
        {
          path: '/inbox',
          element: (
            <LegacyTabs
              title="Inbox"
              tabs={[
                { key: 'triage', label: 'Triage', El: IntakeView },
                { key: 'approvals', label: 'Approvals', El: ApprovalsView },
              ]}
            />
          ),
        },
```

with:

```tsx
        { path: '/inbox', element: <InboxScreen /> },
        { path: '/inbox/doc/:id', element: <TriageDocScreen /> },
        { path: '/inbox/approval/:id', element: <ApprovalScreen /> },
```

In `LEGACY_REDIRECTS`, change the two Inbox entries to the new segment param:

```tsx
  '/intake': '/inbox?seg=triage',
  '/approvals': '/inbox?seg=approvals',
```

- [ ] **Step 4: Delete the legacy views**

```bash
git rm packages/web/src/components/IntakeView.tsx packages/web/src/components/IntakeView.test.tsx packages/web/src/components/ApprovalsView.tsx packages/web/src/components/ApprovalsView.test.tsx
grep -rn "IntakeView\|ApprovalsView" src/ || echo "no legacy inbox references left"
```

Expected: grep prints `no legacy inbox references left`. (`TriagePanel` and the four forms remain referenced by `DocumentsView` — they are NOT deleted here.)

- [ ] **Step 5: Run the router test, then the full suite, lint, build**

```bash
npx vitest run src/shell/router.test.tsx && npm test && npm run lint && npm run build
```

Expected: all PASS with the legacy inbox tests gone.

- [ ] **Step 6: Commit**

```bash
git add -A packages/web/src
git commit -m "feat(web): mount redesigned Inbox routes, delete legacy IntakeView/ApprovalsView"
```

---

### Task 16: Final verification + browser smoke

**Files:** none new; fixes only if verification fails.

- [ ] **Step 1: Full suite, lint, build**

```bash
npm test && npm run lint && npm run build
```

Expected: all tests PASS, no lint errors, `tsc -b` + vite build succeed.

- [ ] **Step 2: Grep-level invariants**

```bash
grep -rn "window.prompt\|window.confirm\|window.alert" src/inbox src/queries && echo "FAIL: banned dialogs" || echo "ok: no banned dialogs"
grep -rn "refetchInterval" src/ | grep -v "bank.ts\|inbox.ts\|test" && echo "FAIL: stray polling" || echo "ok: polling confined"
grep -rn "postExpense" src/inbox && echo "FAIL: the /post trap in Inbox" || echo "ok: approvals path only"
```

Expected: the three `ok:` lines.

- [ ] **Step 3: Manual browser smoke** (`npm run dev` against a dev server with seeded data; resize between ~390px and ≥1024px — every check on BOTH widths)

Queue:
- `/inbox` shows the hero (open period name + `−X €` month total) and the queue with Today/Earlier sections, oldest first; segment counts match; `?seg=` survives F5.
- An expense held by policy (set a low ceiling in Settings → policy, create + post an above-ceiling expense) appears with the supplier as title and "X € above the Y € auto-post limit" as subtitle — numbers, not `amount_over_ceiling`.
- Tab bar + sidebar badge equals triage+approvals count; decide an item → badge drops without a manual refresh.
- Upload a receipt via the header "Upload": busy state → outcome toast; a junk file lands in the queue as needs-review.
- Leave the tab open: a `retryDocument`-requeued document's outcome appears within ~30s without touching anything (polling); confirm via devtools that the 30s refetch stops after navigating to `/bank`.
- Inbox-zero: clear everything → 🎉 state.

Approval detail:
- Open an expense approval: hero amount, "Why held" with concrete numbers, document preview row opens the signed file in a new tab, facts KV (VAT with rate, absolute date, confidence colored, supplier, invoice number), "N of M" title.
- Approve → toast "Approved & posted · −X €" (NO undo button — by design) → auto-advance to the next pending item; the expense appears posted in the legacy Books tab.
- Reject → sheet; the button stays disabled until a reason is typed; after reject the expense is back to draft with the reason stored.
- A `reconciliation_match` approval (stage one from Bank without confirming): renders the generic card with the Bank-section hint; approve activates the match (check the statement screen).
- Deep-link `/inbox/approval/:id` and F5 — renders from scratch; a decided id shows "Already decided".

Triage detail:
- Low-confidence doc: facts from persisted artifacts, OCR text collapsible; "Classify…" opens the sheet PRE-FILLED (amounts, date, category chip selected); typing a new gross recomputes VAT at 22% until VAT is edited; picking a supplier with history shows "Usually X · N of M"; submit label carries the amount; after submit → toast → next item.
- Supplier-unresolved doc: "Resolve supplier…" prefills the AI proposal; creating requires the Reg. key; picking an existing supplier books directly.
- Outgoing invoice: "Record sales invoice…" — invoice number required, `+amount` submit.
- OCR-failed: "Fix file…" — replacement upload triages the new file and archives the broken one; "Retry OCR" returns to the queue and the doc reappears after the pipeline re-runs.
- Dismiss asks for confirmation and advances; `not_a_document` offers the destructive "Delete file…".
- Legacy URL `/intake?expand=<id>` lands on that document's detail.

- [ ] **Step 4: Commit any smoke fixes**

```bash
git add -A packages/web && git commit -m "fix(web): inbox smoke fixes"
```

(Skip if nothing needed fixing.)

---

## Appendix A — Server gaps & degradation (binding for this plan)

Every gap below is a SERVER gap this client-only plan degrades around. The client behavior is the contract; server work is queued for a later dedicated step.

| # | Spec/mockup expectation | Server reality (verified) | Client degradation in this plan |
|---|---|---|---|
| 1 | Approve = one tap + 5s Undo | Approve posts the voucher atomically (`approvals.service.ts:143-277`); posted objects are immutable | One tap stays; receipt toast WITHOUT Undo ("Approved & posted · −X €") + a hint line stating the reality; recovery = correction flow (Books plan) |
| 2 | Triage queue rows show counterparty + amount ("Circle K — who is this?" · −48.20 €) | `NeedsTriageItem` = id/filename/created_at/reason/reason_type only (`triage/triage.service.ts:48-53`) | Triage row title = filename, subtitle = human reason; amounts appear on the DETAIL (persisted classification) and in the classify sheet |
| 3 | Manual classify: supplier "found by alias ✓" auto-prefilled | No alias-lookup endpoint; the reclassify result carries no supplier id | Supplier is a searchable picker; the ResolveSupplier flow covers the unknown-supplier case with the AI's create-proposal prefilled |
| 4 | Category "usually X" from classification memory (ADR-0014) | No classification-memory endpoint | Computed client-side from `getExpenses()` (real per-supplier history): "Usually X · N of M" when ≥2 expenses; chips ordered by recency from the same list |
| 5 | VAT auto "by country rate" | No endpoint exposes the plugin VAT rate | `STANDARD_VAT_RATE_PCT = 22` (Plan 02's constant reused); field stays editable with an explanatory hint |
| 6 | Approval detail links to the object route ("Supplier ›", "Expense ›") | Books/Settings detail routes don't exist yet (Plans 04/06) | Facts shown inline (name, amounts, document preview); links become navigations when those routes land |
| 7 | Approval detail for EVERY object_type with typed facts | No `GET /api/sales-invoices/:id`; no client allowance wrapper; `reconciliation_match` approvals carry `policy_reason: null` | Invoice facts from the list endpoint; `allowance`/`reconciliation_match` render a generic safe card (requested-by, waiting-since, honest hint); nothing crashes |
| 8 | Document row shows filename + channel + "2h ago" (asset §2) | `getExpense` yields only `document_id`; details endpoint has no filename/channel | Generic "Source document · tap to open" row with preview thumb |
| 9 | AI confidence shown in the approval facts | Present for expenses (`ai_confidence` on the row); absent for invoices | Shown for expenses (ok/warn colored); omitted for invoices |
| 10 | Swipe right = approve, swipe left = more; j/k/e/r hotkeys; ⌘K | Client-side work, not server — deferred with Plan 02's identical deferral (needs the `motion` gesture layer) | Buttons on detail are the fallback the spec mandates; gestures/hotkeys in the desktop-power follow-up |
| 11 | Reject with reason then "returns to draft" visible somewhere | True for expense/invoice (draft again) but the draft is only visible in legacy Books tabs until Plan 04 | Toast says "returned to draft"; Books plan surfaces drafts properly |

## Appendix B — Follow-ups for later plans

- **Books plan (04):** delete the legacy triage cluster (`TriagePanel`, `ResolveSupplierForm`, `TriageManualForm`, `TriageManualInvoiceForm`, `TriageOcrFailedForm`, `DocumentThumb`, `reasonBadge.ts`) together with `DocumentsView`; expense/document detail routes so approval facts KV rows become navigations (gap 6); drafts view (rejected approvals land there, gap 11); adopt `sharedKeys.expenses`/`invoices` for its lists (cache continuity with the Inbox joins); full upload flow with claimant dropdown (ADR-0036).
- **Server step:** alias-lookup for supplier prefill (gap 3); classification-memory endpoint (replaces the client-side history join, gap 4); country VAT-rate exposure (gap 5); `NeedsTriageItem` enrichment (counterparty + amount from the parked draft, gap 2); single-invoice GET (gap 7).
- **Desktop power features:** hover Approve/Reject directly on queue rows, j/k/e/r hotkeys, swipe actions on mobile — on top of the routes built here.
- **Reports plan (05):** "unresolved in period" row links to `/inbox` (the queue already supports `?seg=`); consider a `?period=` filter if operators ask for it.
- **Settings plan (06):** policy screen shows the SAME humanized wording ("expenses above X go to approval") — reuse `humanizePolicyReason`'s vocabulary for consistency.

## Appendix C — Spec coverage map (self-review)

Spec Inbox bullet → this plan: hero card (open period, month total, CTA) → Task 7 ✅ (total = posted+pending expenses in period — client-side sum); queue rows with type icon / one-line human reason with numbers / amount / chip → Task 6 ✅ (triage amounts degraded, gap 2; approval numbers real, Reality #5); FIFO oldest-first with Today/Earlier → Tasks 5-6 ✅ (client re-sort, Reality #6); low confidence shown, high hidden → Task 4 subtitle logic ✅ (detail always shows confidence per asset §2); polling keeps the queue live → Reality #11 + Tasks 5/6 ✅ (30s route-scoped; import job keeps 1.5s exclusivity); inbox-zero → Task 6 ✅; approve one-tap (+Undo degraded to receipt, gap 1) → Task 9 ✅; reject sheet with mandatory reason → Task 9 ✅ (client enforces non-empty, Reality #3); triage forms as fullscreen sheets reusing existing form logic restyled → Tasks 10-12 ✅ (same API choreography; legacy components survive for DocumentsView — Architecture note); "N of M" + auto-advance → `queuePosition`/`nextRouteAfter` used by Tasks 8/9/13 ✅; approvals show ALL object_types + link to object → Tasks 8-9 ✅ (generic card for match/allowance, links degraded to inline facts, gaps 6/7); approval path `POST /api/approvals` → approve, never `/post` → Reality #2 + Task 16 grep ✅; upload kept minimal → Task 7 ✅; badge → Task 14 ✅; `/intake?expand=` compatibility → Tasks 6/15 ✅. Asset §2 hierarchy (amount → why → document → facts → actions) → Task 8 layout ✅. Asset §3 (prefill everything, VAT auto editable, chips recent-first with "usually", submit states outcome with amount) → Task 11 ✅ (alias prefill degraded, gap 3). Global data rules: IDs never in titles ✅ (object labels, filenames); every mutation invalidates ✅; euros in, cents over the wire ✅; amounts `tabular-nums`/no-wrap ✅ (`AmountText` + flex-none); relative dates in lists / absolute in details ✅ (`relativeTime` / `absoluteDate*`); ConfirmDialog for non-reversible (dismiss/delete) ✅; one primary per state ✅ (detail action bars + sheet submits; Dismiss promotes to primary only when no form exists). Placeholder scan: none — every code block above is complete. Type consistency: `ExpenseDetail` (Task 1) matches `expenses/types.ts:7-31` minus display-irrelevant fields; every referenced api export verified present in `src/api.ts` (getNeedsTriageItems, getPendingApprovals, approveApproval, rejectApproval, getDocumentDetails, getDocumentReclassify, getPendingDraft, resolveSupplier, manualClassify, manualClassifyInvoice, completeDocument, retryDocument, deleteDocument, uploadDocument, triageDocument, getExpenses, getInvoices, getEntities, getCategories, getOrganization, getReportingPeriods, fetchDocumentPreviewObjectUrl, openSignedDocument, fmtCents) plus the one Task 1 adds (getExpense).
