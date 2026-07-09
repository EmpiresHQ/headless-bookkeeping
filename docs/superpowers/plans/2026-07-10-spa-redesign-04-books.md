# SPA Redesign — Plan 04: Books section rebuild (Expenses / Invoices / Documents / Credit notes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four legacy Books tabs (`ExpensesView`/`InvoicesView` — ID-first tables with inline create forms and `window.confirm` deletes; `DocumentsView` — a table with a dead `#expense-N` anchor and an inline triage panel; `CreditNotesView` — the raw-cents "Object ID: ___" form that turns a typed "100.00" into a 1-cent note) with the redesigned Books section: one `/books` screen with four segments (Expenses | Invoices | Documents | Credit notes) in `?seg=`, month sections with per-group totals recomputed under the active filter, supplier/customer-titled rows (IDs are not data), status chips + corrected marker + 🏦 reconciled icon + 📎 no-document marker, real detail routes for all four object kinds (facts KV with navigable document link, bank-reconciliation status, rejection reason for drafts, honest history), a Correct sheet with the three ADR-0009 branches explained in human terms, credit notes **in euros** created via an object PICKER (number · counterparty · amount · outstanding — never raw ID entry) reachable from the invoice/expense detail AND the segment, a documents archive with thumbnails/channels/signed links/copy-share-link/delete-guard, and header "+" create flows (new expense / new invoice / upload with claimant dropdown, ADR-0036) — all on the EXISTING server API. Plan 03's routed debts land here: the legacy triage cluster dies with `DocumentsView`, the three parallel `reason_type` mappings collapse to one, expense/document facts become navigable, drafts (with rejection reasons) become findable, and the Books lists adopt `sharedKeys.expenses`/`sharedKeys.invoices`.

**Architecture:** New screens live in `packages/web/src/books/`; typed TanStack Query hooks + the pure list model (month grouping, filters, search, joins) in `packages/web/src/queries/books.ts`; transport additions in `src/api.ts` (correction outcome/credit-note payload typing, `getCreditNote`, `listApprovals`, `postInvoice`, claimant upload option, widened display subsets). Lists read through the FROZEN `sharedKeys.expenses`/`sharedKeys.invoices` cache keys (`src/queries/keys.ts`) — the same entries Plan 03's `invalidateInbox` already invalidates, so an Inbox decision refreshes Books for free. Reused kit: `ListGroup`/`ListRow`/`KeyValue`, `Chip`, `AmountText`, `SegmentedControl`, `SearchInput`, `Sheet`, `ConfirmDialog`, `LoadError`, `EmptyState`/`SkeletonRows`, `Button`/`LinkButton`, `LargeTitleHeader`/`ScreenHeader`, toasts; `DocPreviewRow` (inbox) is reused as-is on detail screens, and a small `DocThumb` (same blob-URL choreography) serves archive rows. Routes `/books` (+`?seg=`), `/books/expenses/:id`, `/books/invoices/:id`, `/books/documents/:id`, `/books/credit-notes/:id`, `/books/credit-notes/new` replace the LegacyTabs Books mount at the end; deleted with their tests: `ExpensesView`, `InvoicesView`, `DocumentsView`, `CreditNotesView`, `corrections-form.tsx`, and the surviving triage cluster (`TriagePanel`, `ResolveSupplierForm`, `TriageManualForm`, `TriageManualInvoiceForm`, `TriageOcrFailedForm`, `DocumentThumb`, `reasonBadge.ts`). **`components/Table.tsx` SURVIVES this plan** — `EntitiesView` (legacy, dies in Plan 06) still consumes it. The server is NOT modified. Spec: `docs/superpowers/specs/2026-07-08-spa-ux-redesign-design.md` (Books subsection + Data display rules); canonical screen asset: `docs/superpowers/specs/assets/2026-07-09-screens-data-redesign.html` §4 (expenses list), §5 (expense detail), §9+ (Documents archive + Credit notes text rules).

**Tech Stack:** React 18, TypeScript, Vite, Tailwind 3 (foundation tokens), react-router-dom v7 (data mode), @tanstack/react-query v5, vaul (Sheet), sonner (toasts), @radix-ui/react-alert-dialog (ConfirmDialog), vitest + @testing-library/react (jsdom). All installed since Plan 01 — no new dependencies.

## Reality of the server contract (read this before touching any task)

These facts were verified against `packages/server/src` and BIND every task below:

1. **A correction rewrites the SAME row — there is no "corrected copy" object.** `POST /api/expenses/:id/correct` / `POST /api/sales-invoices/:id/correct` (`corrections/corrections.controller.ts:11-35`) branch on kind (`corrections/corrections.service.ts:125-165`): `financial` on a POSTED object posts a reversal voucher + a corrected voucher atomically, patches the object's amounts in place (`patchAmountsTx` inside `beforePost`, `corrections.service.ts:300-317`), and flips the object `posted → reversed` re-pointed at the corrected voucher (`markReversed`, `corrections.service.ts:343-356`). So after a financial correction the row shows the CORRECTED amounts with `status: 'reversed'` — that status means "corrected, and the corrected figures are what is live in the books", not "gone". The UI renders `reversed` as a **corrected** chip, never as a dead state.
2. **Correction provenance is voucher-level and therefore INVISIBLE to this client.** `reverses_id`/`corrects_object_*` live on vouchers only (`corrections.service.ts:216-219,241-243`); the expense row (`expenses/types.ts:7-31`) and invoice row (`sales-invoices/types.ts:7-23`) carry NO provenance fields, and ADR-0001/0030 keep vouchers off the operator surface. The spec's "correction provenance chain" degrades to an honest history built from exposed facts: created (`created_at` + intake channel via the document link), rejected (reason from the approvals log, Reality #9), corrected (the `reversed` status — the correction's own date/reason are NOT retrievable). Appendix A gap 1.
3. **Correction outcomes are typed and carry the locked-period redirect.** `CorrectionResult` (`corrections/types.ts:24-38`): `cosmetic_attachment_replaced` | `draft_edited` | `posted_reversal_and_correction` (+`redirected`, `redirectedToPeriodId` when the original date sat in a locked period and both vouchers were re-dated into the open period, `corrections.service.ts:252-277` — 409 if no open period) | `credit_note_created` | `unsupported_status` (a `reversed` object is not re-correctable — corrections are one-shot, ADR-0006/0009, `corrections.service.ts:159-164`). `financial` on a `draft`/`pending` object edits the draft in place and returns `draft_edited` (`corrections.service.ts:146-152`).
4. **`cosmetic` is a server no-op today.** The branch returns `{ outcome: 'cosmetic_attachment_replaced' }` without touching anything (`corrections.service.ts:130-133`). The Correct sheet keeps the branch (ADR-0009 vocabulary) but its explanation says so honestly, and nothing pretends an attachment was replaced. Appendix A gap 7.
5. **`kind: 'credit_note'` via `/correct` requires a `creditNote` payload the legacy client never sent.** Server-side the branch delegates `{ credits_object_*, ...request.creditNote! }` to `CreditNotesService.create` (`corrections.service.ts:136-143`; payload shape `corrections/types.ts:5-10,21`), but the client's `CorrectionRequest` (`src/api.ts:343-347`) has no `creditNote` field — the legacy corrections form submitted `kind:'credit_note'` with only a patch, producing a malformed insert. The rebuilt Correct sheet does NOT call `/correct` for credit notes; its credit-note branch navigates to the prefilled credit-note create flow (`POST /api/credit-notes` directly, same result minus the trap).
6. **Credit notes speak integer CENTS and inherit currency; only POSTED objects can be credited; over-crediting is capped.** `createCreditNoteSchema` requires `gross_amount`/`vat_amount` as `z.number().int()` (`credit-notes/types.ts:23-30`); currency comes from the credited object (`credit-notes.service.ts:147`); a non-posted object 400s ("only a posted document can be credited", `credit-notes.service.ts:83-91`); cumulative posted notes may not exceed the object's gross — the 400 carries the remaining amount (`credit-notes.service.ts:93-103`); a locked-period date is redirected to the open period (`credit-notes.service.ts:213-225`). The original object STAYS `posted` (a credit note is not a correction artifact, `credit-notes.service.ts:59-61`). **The legacy cent bug is in the FORM, not the API**: `CreditNotesView.tsx:41-42` sends `Number(grossAmount)` — euros typed by a human, delivered as cents. The new form goes through `eurosToCents`. `GET /api/credit-notes/:id` exists (`credit-notes/credit-notes.controller.ts:29-37`); list returns `{ credit_notes }` ordered by id; rows carry `currency`, `tax_point_date`, `created_at` (`credit-notes/types.ts:7-21`) which the client subset must gain to group/display.
7. **There is NO `discarded` document status on the server.** `DocumentStatus = 'pending' | 'triaged' | 'needs_triage' | 'processed' | 'error'` (`documents/types.ts:18-23`); `validateDocumentStatus` throws on anything else (`documents.service.ts:680-690`). ADR-0038 line 23 lists the `discarded` terminal + SPA view as NEW work not yet built. The spec's "Documents segment includes a discarded filter" degrades to: filter chips over the five REAL statuses, no fake Discarded chip. Appendix A gap 3.
8. **The document delete guard is server-enforced with a human message.** `documents.service.ts:516-537`: hard delete (files + artifacts + internal OCR conversation; real Telegram/email threads unlinked, not deleted) EXCEPT when a linked expense is `posted`/`reversed` → 409 `"Document N is evidence for expense #M (posted) — reverse the expense before deleting"`. The client mirrors the guard (disabled button + explanation from `expense_status` already on the archive row) and surfaces the server text if a race slips through.
9. **Rejection reasons for drafts ARE retrievable.** `GET /api/approvals?status=…&object_type=…` (`approvals/approvals.controller.ts:105-126`, `ListApprovalsQuery` `approvals/types.ts:93-103`) returns the full approvals log including `rejected_reason`, `resolved_at`, `object_id`. A rejected approval returns the expense/invoice to `draft` (Plan 03 Reality #3) — the Books detail joins the newest rejected approval for the object and shows "Rejected: <reason>" on drafts. Statuses: `pending|approved|rejected|superseded` (`approvals/types.ts:10`).
10. **Claimant upload is SUPPORTED.** `POST /api/documents` multipart accepts `claimant_id` (string field → `Number`, `documents/documents.controller.ts:71-110`). Claimants are entities with role `employee` or `director` (`entities/types.ts:38-44`; supplier/customer need a registration key, employee/director don't). The upload sheet's claimant dropdown is real, not degraded. (ADR-0036: a claimant-paid expense is always held for approval — server-side policy, nothing for this client to do.)
11. **`reconciled` is a list-only boolean; no endpoint maps an object to its bank transaction.** `GET /api/expenses` enriches rows with `reconciled` (voucher has an ACTIVE match, `expenses.service.ts:63-75`); the invoices list does the same. All reconciliation reads are statement-scoped (`/api/bank-statements/:id/…`, `src/api.ts:830-931`) — there is no "matches for expense X". The detail's Bank row is a STATUS ("Reconciled ✓" / "Not matched"), not a navigation. Appendix A gap 4.
12. **"Waiting for a document" is derivable, but the operator's document policy is not persisted.** `DocumentArchiveRow.expense_id` (`documents/types.ts:83`) links every document to its expense, so *expenses with no linked document* = a real client-side join (📎 marker + filter). The Bank flow's "чек будет позже / чека не будет" choice, the waiting queue, and late-document auto-attach do NOT exist server-side (Plan 02 Appendix; unchanged) — the marker is neutral ("No document"), never a fake queue. Appendix A gap 5.
13. **There is still NO `GET /api/sales-invoices/:id`** (`sales-invoices/sales-invoices.controller.ts` — list/delete/create/generate-draft/send/post only). The invoice detail renders from the LIST row (cache-shared); an id absent from the list gets an honest not-found state. But list rows DO carry `document_id` and `due_date` (`sales-invoices/types.ts:15,20`) — the client subset gains both so the invoice detail can link its document. Appendix A gap 6.
14. **Draft resubmission is the `/post` pipeline** — `POST /api/expenses/:id/post` (`expenses/expenses.controller.ts:96-137`) and `POST /api/sales-invoices/:id/post` (`sales-invoices/sales-invoices.controller.ts:98-129`) run draft → Rules → Policy → post-or-hold, both 409 on non-draft (idempotent), both return `{ expense|invoice, voucher, policy }` — voucher stays off the typed surface (ADR-0001/0030), `policy` is the existing `PolicyDecisionView`. This is the sanctioned draft path (Plan 03 Reality #2: `/post` on drafts MINTS holds; the Inbox then approves). The drafts surface uses it as "Submit for posting" with an honest held/posted receipt.

## Global Constraints

- Working directory for all commands: `packages/web` (repo root: `/Users/alekseirevin/test/headless-bookkeeping.spa-redesign-foundation`).
- Test command: `npx vitest run <file>`; full suite: `npm test`; lint: `npm run lint`; build (typecheck + bundle): `npm run build`. Every task leaves the FULL suite green. **Never run `git stash` in any form** (shared cross-worktree stash stack).
- **Routes (binding):** `/books` (segments `?seg=expenses|invoices|documents|credit-notes`, default `expenses`; legacy `?tab=` accepted as an alias), `/books/expenses/:id`, `/books/invoices/:id`, `/books/documents/:id`, `/books/credit-notes/:id`, `/books/credit-notes/new` (`?type=sales_invoice|expense&id=N` prefills the picker). Search lives in `?q=`, status filter in `?status=`, the no-document toggle in `?nodoc=1` — all shareable, all survive F5. Legacy `/expenses|/invoices|/documents|/credit-notes` redirect to the matching `?seg=`.
- **Cache keys:** Books lists read expenses/invoices through the FROZEN `sharedKeys.expenses`/`sharedKeys.invoices` (`src/queries/keys.ts` — Plan 03's `invalidateInbox` already invalidates them; cache continuity is the point). New Books-domain keys live under the `['books', …]` prefix in `src/queries/books.ts`. Every Books mutation invalidates via `invalidateBooks(qc)` (Task 2), which covers `['books']`, both shared lists, AND `['inbox']` (posting a draft can mint an approval; deleting/correcting changes what Inbox rows join against).
- **NO new polling.** Zero `refetchInterval` anywhere in `src/books/` or `src/queries/books.ts`. The bank import job (1.5s) and the Inbox lists (30s, route-scoped) remain the only intervals (Plan 03 Global Constraints).
- **Colors through tokens** (`bg-surface`, `text-ink-2`, `text-ok`, `bg-warn-bg`, `border-line`, `bg-accent`, `bg-accent-deep`, `bg-alert`, …). Sanctioned one-offs (approved mockups, no token): icon tint `bg-[#E3EFE8]`, secondary-button grey `bg-[#E9EBE7]` (kit), chevron/handle greys `#C2C7C1`/`#D4D7D1` (kit). No other raw hex.
- **Anti-overlap rules (binding):** amounts never wrap (`AmountText` + `flex-none` containers); titles/subtitles single-line `truncate`; left column `min-w-0 flex-1`, right column `flex-none`.
- **Screen invariants:** exactly ONE primary button per state and its label states the outcome with the amount where one exists ("Issue credit note · −120.00 €", "Create expense · −48.20 €", "Post correction · −650.00 €" — never "Submit"); IDs are not data (no "#214" in titles; ids live in URLs); reasons are human sentences; VAT belongs to detail, not lists.
- **Dates:** lists show the tax-point day SHORT ("3 Jul") — `tax_point_date` is a calendar fact, not an event timestamp, so data rule 5's "relative in lists" applies to activity times (documents keep `relativeTime(created_at)`); details show absolute dates (`absoluteDate`/`absoluteDateFromIso` from `src/inbox/format.ts`).
- Money **inputs are euros** via `eurosToCents`/`centsToEuroInput` (`src/lib/money.ts`); the API speaks integer cents; display via `AmountText`/`fmtCents`/`signedEuros`. VAT prefill via `vatFromGross` + `STANDARD_VAT_RATE_PCT` (22, `src/bank/format.ts:61`) — editable, same degradation as Plans 02/03.
- **Never** `window.prompt/confirm/alert`. Never render voucher/account/debit/credit words (ADR-0001/0030). Irreversible actions (delete expense/invoice/document) go through `ConfirmDialog` — plan→confirm→receipt, never optimistic. Corrections/credit-notes/posting are non-optimistic mutations with receipt toasts.
- **Sheets remount per object** — every action sheet mounted from a detail screen carries `key={<objectId>}` (or is unmounted when closed) so state never leaks across objects (Plan 03 Task 13 lesson). Compute-before-mutate for anything that navigates after a mutation.
- UI copy is **English** (Russian in mockups is design annotation): "Books", "Expenses"/"Invoices"/"Documents"/"Credit notes", "Corrected", "Reconciled with bank", "No document", "Submit for posting", "Correct…", "Issue credit note…", "Delete draft…", "Copy link", "Resolve in Inbox".
- Test mocking rule (Plan 03): modules import the REAL `fmtCents` from `../api`, so tests mock the api module with the spread-importOriginal pattern (`vi.mock('../api', async (io) => ({ ...(await io<typeof import('../api')>()), <fn>: vi.fn() }))`), never a bare object literal.
- Commit style: `feat(web): …`, one commit per task. React StrictMode double-mount safe (effects with cleanup; one-shot fetches via React Query).
- Legacy views stay untouched and mounted until Task 14 swaps the router and deletes them; every intermediate task leaves the suite green.

---

### Task 1: API transport additions + `reason_type` union consolidation (client side)

**Files:**
- Modify: `packages/web/src/api.ts`
- Test: `packages/web/src/api.books.test.ts` (new)

**Interfaces:**
- Consumes: existing `apiFetch`.
- Produces (all from `src/api.ts`):
  - `NeedsTriageItem.reason_type` retyped to the EXISTING exported `TriageReasonType` (kills the inline duplicate union — consolidation part 1; `reasonBadge.ts`'s copy dies in Task 14 with its last consumer).
  - `SalesInvoice` gains `document_id: number | null` and `due_date: string | null` (verified on every list row, `sales-invoices/types.ts:15,20` — needed by the invoice detail).
  - `ExpenseDetail` gains `created_at: number` and `claimant_id: number | null` (verified `expenses/types.ts:23,29` — history + claimant fact).
  - `CreditNote` gains `currency: string`, `tax_point_date: string`, `created_at: number` (verified `credit-notes/types.ts:13-14,19`); `getCreditNote(id): Promise<CreditNote>` — `GET /api/credit-notes/:id` (Reality #6).
  - `CorrectionOutcome { outcome: string; redirected?: boolean; redirectedToPeriodId?: number }` — `correctExpense`/`correctInvoice` retyped to return it (Reality #3; `creditNoteId` deliberately untyped — the client never uses the `/correct` credit-note branch, Reality #5, and `CorrectionRequest` deliberately does NOT gain a `creditNote` field for the same reason).
  - `listApprovals(query: { status?: 'pending' | 'approved' | 'rejected' | 'superseded'; object_type?: 'expense' | 'sales_invoice' | 'allowance' | 'reconciliation_match' }): Promise<Approval[]>` — `GET /api/approvals?…` (Reality #9).
  - `postInvoice(id): Promise<{ invoice: SalesInvoice; policy: PolicyDecisionView }>` — `POST /api/sales-invoices/:id/post` (Reality #14; voucher stays off the typed surface like `postExpense`).
  - `uploadDocument(file, opts?: { claimantId?: number | null })` — appends multipart `claimant_id` when provided (Reality #10). Existing single-argument call sites (InboxScreen, OcrFailedSheet) stay source-compatible.

- [ ] **Step 1: Write failing tests**

`src/api.books.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import {
  correctExpense,
  getCreditNote,
  listApprovals,
  postInvoice,
  uploadDocument,
} from './api';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe('books api additions', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('getCreditNote GETs the single credit note', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        id: 7,
        credit_note_number: 'CN-1',
        status: 'posted',
        gross_amount: 12000,
        vat_amount: 2164,
        currency: 'EUR',
        tax_point_date: '2026-07-02',
        created_at: 1751400000,
        credits_object_type: 'sales_invoice',
        credits_object_id: 3,
        kind: 'sales',
        voucher_id: 99,
      }),
    );
    const cn = await getCreditNote(7);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/credit-notes/7');
    expect(cn.tax_point_date).toBe('2026-07-02');
    expect(cn.currency).toBe('EUR');
  });

  it('correctExpense returns the typed correction outcome incl. redirect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        outcome: 'posted_reversal_and_correction',
        reversalVoucherId: 1,
        correctedVoucherId: 2,
        redirected: true,
        redirectedToPeriodId: 5,
      }),
    );
    const res = await correctExpense(9, {
      kind: 'financial',
      reason: 'OCR misread the total',
      patch: { gross_amount: 65000, vat_amount: 11721 },
    });
    expect(res.outcome).toBe('posted_reversal_and_correction');
    expect(res.redirected).toBe(true);
  });

  it('listApprovals builds the query string and unwraps approvals', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        approvals: [
          {
            id: 4,
            object_type: 'expense',
            object_id: 12,
            status: 'rejected',
            requested_by: 'system',
            approved_by: null,
            rejected_reason: 'Wrong supplier',
            policy_reason: null,
            superseded_by: null,
            created_at: 1751000000,
            resolved_at: 1751100000,
          },
        ],
      }),
    );
    const rows = await listApprovals({
      status: 'rejected',
      object_type: 'expense',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/approvals?status=rejected&object_type=expense',
    );
    expect(rows[0].rejected_reason).toBe('Wrong supplier');
  });

  it('postInvoice POSTs the pipeline endpoint and types invoice + policy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        invoice: { id: 3, status: 'pending' },
        voucher: null,
        policy: { action: 'hold-for-approval', reason: 'ceiling' },
      }),
    );
    const res = await postInvoice(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sales-invoices/3/post');
    expect(init?.method).toBe('POST');
    expect(res.policy.action).toBe('hold-for-approval');
  });

  it('uploadDocument appends claimant_id when provided and omits it otherwise', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({ document: { id: 1 }, deduplicated: false }),
    );
    const file = new File(['x'], 'r.pdf', { type: 'application/pdf' });
    await uploadDocument(file, { claimantId: 42 });
    const body1 = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body1.get('claimant_id')).toBe('42');
    await uploadDocument(file);
    const body2 = fetchMock.mock.calls[1][1]?.body as FormData;
    expect(body2.get('claimant_id')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/api.books.test.ts
```

Expected: FAIL — `getCreditNote`, `listApprovals`, `postInvoice` not exported; `correctExpense` result untyped for `redirected`; `uploadDocument` rejects a second argument.

- [ ] **Step 3: Implement in `src/api.ts`**

3a. Retype the inline union on `NeedsTriageItem` (consolidation part 1) — replace its `reason_type:` member with:

```ts
  reason_type: TriageReasonType;
```

(`TriageReasonType` is already exported above it; the literal union body is deleted.)

3b. Widen `SalesInvoice` — add after `tax_point_date: string;`:

```ts
  due_date: string | null;
  // Present on every list row (sales-invoices/types.ts:20) — the invoice
  // detail links its source document with it.
  document_id: number | null;
```

3c. Widen `ExpenseDetail` — add after `ai_confidence: number | null;`:

```ts
  claimant_id: number | null;
  created_at: number;
```

3d. Widen `CreditNote` and add the single GET (replace the existing `CreditNote` interface):

```ts
export interface CreditNote {
  id: number;
  credit_note_number: string;
  status: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  created_at: number;
  credits_object_type: string;
  credits_object_id: number;
}

export const getCreditNote = (id: number) =>
  apiFetch<CreditNote>(`/api/credit-notes/${id}`);
```

3e. Type the correction outcome — replace the `{ outcome: string }` result type on BOTH `correctExpense` and `correctInvoice`:

```ts
/**
 * Correction result (corrections/types.ts:24-38). `redirected` is true when
 * the original date sat in a LOCKED period and the reversal + correction were
 * re-dated into the current open period (ADR-0009). Voucher ids stay off the
 * typed surface (ADR-0001/0030). NOTE: the server's `kind:'credit_note'`
 * branch needs a creditNote payload this client deliberately never sends —
 * credit notes go through POST /api/credit-notes (see CorrectSheet).
 */
export interface CorrectionOutcome {
  outcome: string;
  redirected?: boolean;
  redirectedToPeriodId?: number;
}

export const correctExpense = (id: number, req: CorrectionRequest) =>
  apiFetch<CorrectionOutcome>(`/api/expenses/${id}/correct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });

export const correctInvoice = (id: number, req: CorrectionRequest) =>
  apiFetch<CorrectionOutcome>(`/api/sales-invoices/${id}/correct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
```

3f. Approvals log read — add below `rejectApproval`:

```ts
/** Approvals LOG (GET /api/approvals?status=&object_type=) — the Books
 *  detail joins the newest rejected approval to show WHY a draft came back
 *  (rejecting returns the object to draft, ADR-0015). */
export interface ListApprovalsQuery {
  status?: 'pending' | 'approved' | 'rejected' | 'superseded';
  object_type?: 'expense' | 'sales_invoice' | 'allowance' | 'reconciliation_match';
}

export const listApprovals = (query: ListApprovalsQuery = {}) => {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.object_type) params.set('object_type', query.object_type);
  const qs = params.toString();
  return apiFetch<{ approvals: Approval[] }>(
    qs ? `/api/approvals?${qs}` : '/api/approvals',
  ).then((r) => r.approvals);
};
```

3g. Invoice posting pipeline — add below `postExpense`:

```ts
/** Draft → Rules → Policy → post or hold, for sales invoices (mirror of
 *  postExpense; 409 on non-draft). Voucher stays untyped (ADR-0001/0030). */
export const postInvoice = (id: number) =>
  apiFetch<{ invoice: SalesInvoice; policy: PolicyDecisionView }>(
    `/api/sales-invoices/${id}/post`,
    { method: 'POST' },
  );
```

3h. Claimant on upload — replace `uploadDocument`:

```ts
export const uploadDocument = (
  file: File,
  opts: { claimantId?: number | null } = {},
) => {
  // Multipart: set NO content-type so the browser adds the boundary.
  const body = new FormData();
  body.append('file', file);
  // ADR-0036: the employee/director who paid out-of-pocket. The server takes
  // it as a multipart string field (documents.controller.ts:79,109).
  if (opts.claimantId != null) body.append('claimant_id', String(opts.claimantId));
  return apiFetch<{ document: DocumentRow; deduplicated: boolean }>(
    '/api/documents',
    { method: 'POST', body },
  );
};
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/api.books.test.ts && npm test
```

Expected: PASS (5 tests); full suite PASS (all changes are widenings/additions; `uploadDocument`'s second parameter is optional).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/api.books.test.ts
git commit -m "feat(web): books API transport — credit-note GET, approvals log, invoice posting, correction outcome typing, claimant upload"
```

---

### Task 2: Books query layer + pure list model (month groups, filters, search, joins)

**Files:**
- Create: `packages/web/src/queries/books.ts`
- Test: `packages/web/src/queries/books.test.tsx` (new)

**Interfaces:**
- Consumes: `src/api.ts` (`getDocuments`, `getDocumentDetails`, `getExpense`, `getCreditNote`, `listCreditNotes`, `listApprovals`, types), `src/queries/keys.ts` (`sharedKeys`), `src/queries/shared.ts` (`useExpenses`, `useInvoices` are consumed by SCREENS directly — this module only adds Books-domain keys).
- Produces:
  - `booksKeys` — key factory: `all: ['books']`, `documents`, `docDetails(id)`, `creditNotes`, `creditNote(id)`, `expense(id)`, `rejection(objectType, objectId)`.
  - Hooks: `useDocumentsArchive()`, `useDocDetails(id)`, `useCreditNotes()`, `useCreditNoteDetail(id)`, `useExpenseFacts(id)`, `useRejectedReason(objectType, objectId, enabled)` (newest rejected approval for the object, or null).
  - `invalidateBooks(qc)` — invalidates `['books']` + `sharedKeys.expenses` + `sharedKeys.invoices` + `['inbox']` (Global Constraints).
  - Pure model: `monthKey`, `monthLabel`, `shortDate`, `groupByMonth`, `STATUS_FILTERS`/`matchesStatus` (with `corrected` ≙ `reversed`), `documentedExpenseIds`, `rowSearchText`-style helpers `expenseMatchesQuery`/`invoiceMatchesQuery`, `entityName`, `remainingCreditable`.

- [ ] **Step 1: Write failing tests**

`src/queries/books.test.tsx`:

```tsx
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentArchiveRow, Expense } from '../api';
import {
  booksKeys,
  documentedExpenseIds,
  expenseMatchesQuery,
  groupByMonth,
  invalidateBooks,
  matchesStatus,
  monthLabel,
  newestRejection,
  remainingCreditable,
  shortDate,
} from './books';

const exp = (o: Partial<Expense>): Expense => ({
  id: 1,
  supplier_id: null,
  category: 'fuel',
  gross_amount: 4820,
  vat_amount: 869,
  currency: 'EUR',
  tax_point_date: '2026-07-01',
  status: 'posted',
  reconciled: false,
  ...o,
});

describe('books pure model', () => {
  it('groups by tax_point_date month, newest month first, newest row first, with totals under the ACTIVE filter', () => {
    const rows = [
      exp({ id: 1, tax_point_date: '2026-06-25', gross_amount: 65000 }),
      exp({ id: 2, tax_point_date: '2026-07-03', gross_amount: 8900 }),
      exp({ id: 3, tax_point_date: '2026-07-01', gross_amount: 4820 }),
    ];
    const groups = groupByMonth(rows);
    expect(groups.map((g) => g.month)).toEqual(['2026-07', '2026-06']);
    expect(groups[0].rows.map((r) => r.id)).toEqual([2, 3]);
    expect(groups[0].totalCents).toBe(13720);
    expect(groups[0].count).toBe(2);
    expect(groups[1].totalCents).toBe(65000);
  });

  it('monthLabel and shortDate are pure string math (timezone-proof)', () => {
    expect(monthLabel('2026-07')).toBe('July 2026');
    expect(shortDate('2026-07-03')).toBe('3 Jul');
  });

  it('matchesStatus maps the corrected chip onto the reversed status', () => {
    expect(matchesStatus(exp({ status: 'reversed' }), 'corrected')).toBe(true);
    expect(matchesStatus(exp({ status: 'posted' }), 'corrected')).toBe(false);
    expect(matchesStatus(exp({ status: 'draft' }), 'all')).toBe(true);
    expect(matchesStatus(exp({ status: 'draft' }), 'draft')).toBe(true);
  });

  it('expenseMatchesQuery searches supplier name, category and amount', () => {
    const row = exp({ category: 'software', gross_amount: 8900 });
    expect(expenseMatchesQuery(row, 'telia', 'Telia Eesti AS')).toBe(true);
    expect(expenseMatchesQuery(row, 'soft', null)).toBe(true);
    expect(expenseMatchesQuery(row, '89.00', null)).toBe(true);
    expect(expenseMatchesQuery(row, 'bolt', 'Telia Eesti AS')).toBe(false);
    expect(expenseMatchesQuery(row, '', null)).toBe(true);
  });

  it('documentedExpenseIds joins the archive (waiting-for-document marker)', () => {
    const docs = [
      { id: 1, expense_id: 12 },
      { id: 2, expense_id: null },
      { id: 3, expense_id: 14 },
    ] as DocumentArchiveRow[];
    const set = documentedExpenseIds(docs);
    expect(set.has(12)).toBe(true);
    expect(set.has(13)).toBe(false);
  });

  it('newestRejection picks the latest resolved rejection for the object', () => {
    const mk = (id: number, object_id: number, resolved_at: number | null) => ({
      id,
      object_type: 'expense' as const,
      object_id,
      status: 'rejected',
      requested_by: 'system',
      approved_by: null,
      rejected_reason: `r${id}`,
      policy_reason: null,
      superseded_by: null,
      created_at: 0,
      resolved_at,
    });
    const rows = [mk(1, 5, 100), mk(2, 5, 200), mk(3, 6, 300)];
    expect(newestRejection(rows, 5)?.rejected_reason).toBe('r2');
    expect(newestRejection(rows, 7)).toBeNull();
  });

  it('remainingCreditable subtracts POSTED notes for the object only', () => {
    const notes = [
      { credits_object_type: 'sales_invoice', credits_object_id: 3, status: 'posted', gross_amount: 4000 },
      { credits_object_type: 'sales_invoice', credits_object_id: 3, status: 'draft', gross_amount: 9999 },
      { credits_object_type: 'expense', credits_object_id: 3, status: 'posted', gross_amount: 500 },
    ];
    expect(
      remainingCreditable(12000, notes as never, 'sales_invoice', 3),
    ).toBe(8000);
  });

  it('invalidateBooks invalidates books + shared lists + inbox', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await invalidateBooks(qc);
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(booksKeys.all);
    expect(keys).toContainEqual(['expenses']);
    expect(keys).toContainEqual(['invoices']);
    expect(keys).toContainEqual(['inbox']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/queries/books.test.tsx
```

Expected: FAIL — `./books` not found.

- [ ] **Step 3: Implement `src/queries/books.ts`**

```ts
import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  fmtCents,
  getCreditNote,
  getDocumentDetails,
  getDocuments,
  getExpense,
  listApprovals,
  listCreditNotes,
  type Approval,
  type CreditNote,
  type Entity,
  type Expense,
  type SalesInvoice,
} from '../api';
import { sharedKeys } from './keys';

/**
 * Books data layer. Lists themselves come from the SHARED hooks
 * (useExpenses/useInvoices — frozen sharedKeys, Plan 03); this module adds
 * the Books-only reads and the PURE list model (month groups, filters,
 * search, joins) so grouping/totals are unit-testable without React.
 * NO refetchInterval anywhere here (Global Constraints).
 */
export const booksKeys = {
  all: ['books'] as const,
  documents: ['books', 'documents'] as const,
  docDetails: (id: number) => ['books', 'doc', id, 'details'] as const,
  creditNotes: ['books', 'credit-notes'] as const,
  creditNote: (id: number) => ['books', 'credit-notes', id] as const,
  expense: (id: number) => ['books', 'expense', id] as const,
  rejection: (objectType: 'expense' | 'sales_invoice', objectId: number) =>
    ['books', 'rejection', objectType, objectId] as const,
};

export const useDocumentsArchive = () =>
  useQuery({ queryKey: booksKeys.documents, queryFn: getDocuments });

/** Persisted intake artifacts only — never a reclassify (ADR-0039). */
export const useDocDetails = (id: number) =>
  useQuery({
    queryKey: booksKeys.docDetails(id),
    queryFn: () => getDocumentDetails(id),
  });

export const useCreditNotes = () =>
  useQuery({ queryKey: booksKeys.creditNotes, queryFn: listCreditNotes });

export const useCreditNoteDetail = (id: number) =>
  useQuery({
    queryKey: booksKeys.creditNote(id),
    queryFn: () => getCreditNote(id),
  });

/** Single-expense facts for the expense detail (document_id, ai fields,
 *  claimant, created_at — the list subset has none of these). */
export const useExpenseFacts = (id: number) =>
  useQuery({ queryKey: booksKeys.expense(id), queryFn: () => getExpense(id) });

/** Newest rejected approval for the object, or null. Enabled only for
 *  drafts — that is the state a rejection returns an object to. */
export function newestRejection(
  approvals: Approval[],
  objectId: number,
): Approval | null {
  const mine = approvals
    .filter((a) => a.object_id === objectId)
    .sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0));
  return mine[0] ?? null;
}

export function useRejectedReason(
  objectType: 'expense' | 'sales_invoice',
  objectId: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: booksKeys.rejection(objectType, objectId),
    queryFn: () => listApprovals({ status: 'rejected', object_type: objectType }),
    select: (rows) => newestRejection(rows, objectId),
    enabled,
  });
}

/** After any Books mutation: Books reads, the shared lists the rows join
 *  against, AND the Inbox (posting a draft can mint an approval; deletes/
 *  corrections change what Inbox rows join against). */
export function invalidateBooks(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: booksKeys.all }),
    qc.invalidateQueries({ queryKey: sharedKeys.expenses }),
    qc.invalidateQueries({ queryKey: sharedKeys.invoices }),
    qc.invalidateQueries({ queryKey: ['inbox'] }),
  ]).then(() => undefined);
}

// ── Pure list model ────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

/** '2026-07-03' → '2026-07'. Pure string math — timezone-proof (Plan 03
 *  lexicographic-ISO discipline). */
export const monthKey = (isoDate: string): string => isoDate.slice(0, 7);

export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** '2026-07-03' → '3 Jul' — the short list form of a CALENDAR fact
 *  (tax point), distinct from relativeTime (activity timestamps). */
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]}`;
}

export interface MonthGroup<T> {
  month: string;       // '2026-07'
  label: string;       // 'July 2026'
  rows: T[];
  totalCents: number;  // sum of gross under the ACTIVE filter
  count: number;
}

/** Month sections, newest month first, newest tax-point first inside each.
 *  Call it with the ALREADY-FILTERED rows so totals honor the filter
 *  (spec data rule 6). */
export function groupByMonth<
  T extends { tax_point_date: string; gross_amount: number },
>(rows: T[]): MonthGroup<T>[] {
  const byMonth = new Map<string, T[]>();
  for (const r of rows) {
    const k = monthKey(r.tax_point_date);
    const bucket = byMonth.get(k);
    if (bucket) bucket.push(r);
    else byMonth.set(k, [r]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, rs]) => ({
      month,
      label: monthLabel(month),
      rows: [...rs].sort((a, b) =>
        b.tax_point_date.localeCompare(a.tax_point_date),
      ),
      totalCents: rs.reduce((s, r) => s + r.gross_amount, 0),
      count: rs.length,
    }));
}

/** Status filter chips. `corrected` is the human name for the server's
 *  `reversed` (Reality #1: the corrected figures ARE live). */
export type StatusFilter = 'all' | 'draft' | 'pending' | 'posted' | 'corrected';
export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all', 'draft', 'pending', 'posted', 'corrected',
];

export function matchesStatus(
  row: { status: string },
  f: StatusFilter,
): boolean {
  if (f === 'all') return true;
  if (f === 'corrected') return row.status === 'reversed';
  return row.status === f;
}

const norm = (s: string) => s.toLowerCase();

export function expenseMatchesQuery(
  row: Expense,
  q: string,
  supplierName: string | null,
): boolean {
  const needle = norm(q.trim());
  if (needle === '') return true;
  return [supplierName ?? '', row.category, fmtCents(row.gross_amount)]
    .some((hay) => norm(hay).includes(needle));
}

export function invoiceMatchesQuery(
  row: SalesInvoice,
  q: string,
  customerName: string | null,
): boolean {
  const needle = norm(q.trim());
  if (needle === '') return true;
  return [customerName ?? '', row.invoice_number, fmtCents(row.gross_amount)]
    .some((hay) => norm(hay).includes(needle));
}

export const entityName = (
  entities: Entity[],
  id: number | null,
): string | null =>
  id == null ? null : (entities.find((e) => e.id === id)?.name ?? null);

/** Expense ids that HAVE a linked source document (archive join) — the
 *  complement wears the 📎 "No document" marker (Reality #12). */
export function documentedExpenseIds(
  docs: { expense_id: number | null }[],
): Set<number> {
  const set = new Set<number>();
  for (const d of docs) if (d.expense_id != null) set.add(d.expense_id);
  return set;
}

/** Client mirror of the server's over-credit cap (credit-notes.service.ts:
 *  93-103) — POSTED notes against the object reduce what remains. The
 *  server stays the authority; this only makes the form honest up front. */
export function remainingCreditable(
  objectGrossCents: number,
  notes: Pick<
    CreditNote,
    'credits_object_type' | 'credits_object_id' | 'status' | 'gross_amount'
  >[],
  objectType: 'sales_invoice' | 'expense',
  objectId: number,
): number {
  const credited = notes
    .filter(
      (n) =>
        n.credits_object_type === objectType &&
        n.credits_object_id === objectId &&
        n.status === 'posted',
    )
    .reduce((s, n) => s + n.gross_amount, 0);
  return objectGrossCents - credited;
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/queries/books.test.tsx && npm test
```

Expected: PASS (8 tests); full suite PASS (pure addition).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/queries/books.ts packages/web/src/queries/books.test.tsx
git commit -m "feat(web): books query layer + pure month/filter/search model"
```

---
### Task 3: Shared Books row furniture (status chips, filter chips) + ExpensesSegment

**Files:**
- Create: `packages/web/src/books/chips.tsx`, `packages/web/src/books/ExpensesSegment.tsx`
- Test: `packages/web/src/books/ExpensesSegment.test.tsx` (new)

**Interfaces:**
- Consumes: `useExpenses` (`queries/shared.ts` — frozen `sharedKeys.expenses`), `useEntities`, `useDocumentsArchive` + pure model (`queries/books.ts`), kit (`ListGroup`/`ListRow`, `Chip`, `AmountText`, `LoadError`, `EmptyState`/`SkeletonRows`), `fmtCents`.
- Produces:
  - `StatusChipRow({ counts, active, onChange, extra? })` — the filter-chip row (`All · Draft n · Pending n · Posted n · Corrected n` + an optional extra chip slot); active state visible; counts computed by the caller under the active search.
  - `statusChip(status: string): JSX.Element` — `draft`→muted, `pending`→warn, `posted`→ok, `reversed`→ok **"corrected"** (Reality #1), anything else muted verbatim.
  - `ExpensesSegment({ q }: { q: string })` — month sections with per-group totals (recomputed under filter+search), supplier-titled rows (`category · 3 Jul · 🏦 · 📎`), status filter in `?status=`, no-document toggle in `?nodoc=1`, rows navigate to `/books/expenses/:id`.
- Sign convention: expenses render NEGATIVE (`AmountText cents={-gross}`); month totals render `−X € · n`.

- [ ] **Step 1: Write failing tests**

`src/books/ExpensesSegment.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ExpensesSegment } from './ExpensesSegment';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpenses: vi.fn(),
  getEntities: vi.fn(),
  getDocuments: vi.fn(),
}));
import { getDocuments, getEntities, getExpenses } from '../api';

const EXPENSES = [
  { id: 1, supplier_id: 3, category: 'software', gross_amount: 8900, vat_amount: 1632, currency: 'EUR', tax_point_date: '2026-07-03', status: 'pending', reconciled: false },
  { id: 2, supplier_id: 4, category: 'transport', gross_amount: 2490, vat_amount: 449, currency: 'EUR', tax_point_date: '2026-07-02', status: 'posted', reconciled: true },
  { id: 3, supplier_id: null, category: 'fuel', gross_amount: 4820, vat_amount: 869, currency: 'EUR', tax_point_date: '2026-06-25', status: 'draft', reconciled: false },
];
const ENTITIES = [
  { id: 3, role: 'supplier', country: 'EE', name: 'Telia Eesti AS', goods_vs_services: null },
  { id: 4, role: 'supplier', country: 'EE', name: 'Bolt Operations OÜ', goods_vs_services: null },
];
const DOCS = [{ id: 9, expense_id: 1 }];

function mount(q = '', url = '/books') {
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <ExpensesSegment q={q} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ExpensesSegment', () => {
  it('renders supplier-titled rows inside month sections with filtered totals', async () => {
    mount();
    expect(await screen.findByText('Telia Eesti AS')).toBeInTheDocument();
    expect(screen.getByText('Bolt Operations OÜ')).toBeInTheDocument();
    // Month headers with totals under the (empty) filter:
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    expect(screen.getByText('−113.90 € · 2')).toBeInTheDocument();
    expect(screen.getByText('June 2026')).toBeInTheDocument();
    expect(screen.getByText('−48.20 € · 1')).toBeInTheDocument();
    // Supplier-less draft falls back to its category as the title:
    expect(screen.getByText('fuel')).toBeInTheDocument();
    // Row navigates to the detail route:
    expect(
      screen.getByRole('link', { name: /Telia Eesti AS/ }),
    ).toHaveAttribute('href', '/books/expenses/1');
  });

  it('marks reconciled rows with 🏦 and document-less rows with the 📎 marker', async () => {
    mount();
    await screen.findByText('Telia Eesti AS');
    // Expense 2 is reconciled; expense 1 has a document; 2 and 3 do not.
    expect(screen.getByText(/transport · 2 Jul · 🏦/)).toBeInTheDocument();
    expect(screen.getByText(/software · 3 Jul$/)).toBeInTheDocument();
    expect(screen.getByText(/fuel · 25 Jun · 📎 no document/)).toBeInTheDocument();
  });

  it('status chips filter via ?status= and totals follow the filter', async () => {
    mount('', '/books?status=draft');
    await screen.findByText('fuel');
    expect(screen.queryByText('Telia Eesti AS')).not.toBeInTheDocument();
    expect(screen.getByText('−48.20 € · 1')).toBeInTheDocument();
    expect(screen.queryByText('July 2026')).not.toBeInTheDocument();
  });

  it('search narrows rows and recomputes totals', async () => {
    mount('telia');
    await screen.findByText('Telia Eesti AS');
    expect(screen.queryByText('Bolt Operations OÜ')).not.toBeInTheDocument();
    expect(screen.getByText('−89.00 € · 1')).toBeInTheDocument();
  });

  it('list error renders a retryable LoadError', async () => {
    vi.mocked(getExpenses).mockRejectedValue(new Error('boom'));
    vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
    vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/books']}>
          <ExpensesSegment q="" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('the no-document chip toggles ?nodoc=1', async () => {
    mount();
    await screen.findByText('Telia Eesti AS');
    await userEvent.click(screen.getByRole('button', { name: /No document/ }));
    // Only expenses WITHOUT a linked document remain (ids 2 and 3).
    expect(screen.queryByText('Telia Eesti AS')).not.toBeInTheDocument();
    expect(screen.getByText('Bolt Operations OÜ')).toBeInTheDocument();
    expect(screen.getByText('fuel')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/ExpensesSegment.test.tsx
```

Expected: FAIL — `./ExpensesSegment` not found.

- [ ] **Step 3: Implement**

`src/books/chips.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Chip } from '../ui/Chip';
import { STATUS_FILTERS, type StatusFilter } from '../queries/books';

/** Status → chip. `reversed` reads as CORRECTED (Reality #1: the corrected
 *  figures are what is live in the books — it is not a dead state). */
export function statusChip(status: string): ReactNode {
  switch (status) {
    case 'draft':
      return <Chip tone="muted">draft</Chip>;
    case 'pending':
      return <Chip tone="warn">pending</Chip>;
    case 'posted':
      return <Chip tone="ok">posted</Chip>;
    case 'reversed':
      return <Chip tone="ok">corrected</Chip>;
    default:
      return <Chip tone="muted">{status}</Chip>;
  }
}

const LABELS: Record<StatusFilter, string> = {
  all: 'All',
  draft: 'Draft',
  pending: 'Pending',
  posted: 'Posted',
  corrected: 'Corrected',
};

/** Horizontal filter-chip row. Counts are computed by the CALLER under the
 *  active search so chips stay honest (data rule 6). `extra` hosts
 *  segment-specific chips (📎 No document). */
export function StatusChipRow({
  counts,
  active,
  onChange,
  extra,
}: {
  counts: Record<StatusFilter, number>;
  active: StatusFilter;
  onChange: (f: StatusFilter) => void;
  extra?: ReactNode;
}) {
  return (
    <div className="flex gap-1.5 overflow-x-auto px-4 pb-2.5">
      {STATUS_FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onChange(f)}
          className={`flex-none whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${
            f === active ? 'bg-accent text-white' : 'bg-surface text-ink-2'
          }`}
        >
          {f === 'all' ? LABELS[f] : `${LABELS[f]} ${counts[f]}`}
        </button>
      ))}
      {extra}
    </div>
  );
}
```

`src/books/ExpensesSegment.tsx`:

```tsx
import { useSearchParams } from 'react-router-dom';
import { fmtCents, type Expense } from '../api';
import {
  documentedExpenseIds,
  entityName,
  expenseMatchesQuery,
  groupByMonth,
  matchesStatus,
  shortDate,
  useDocumentsArchive,
  STATUS_FILTERS,
  type StatusFilter,
} from '../queries/books';
import { useEntities, useExpenses } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { statusChip, StatusChipRow } from './chips';

/** Month-section header content: label left, filtered total right. */
function GroupHeader({ label, totalCents, count }: {
  label: string;
  totalCents: number;
  count: number;
}) {
  return (
    <span className="flex w-full items-baseline justify-between">
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">
        −{fmtCents(totalCents)} € · {count}
      </span>
    </span>
  );
}

function ExpenseRow({
  e,
  supplierName,
  hasDocument,
}: {
  e: Expense;
  supplierName: string | null;
  hasDocument: boolean;
}) {
  const parts = [e.category, shortDate(e.tax_point_date)];
  if (e.reconciled) parts.push('🏦');
  if (!hasDocument) parts.push('📎 no document');
  return (
    <ListRow
      to={`/books/expenses/${e.id}`}
      title={supplierName ?? e.category}
      subtitle={parts.join(' · ')}
      trailing={
        <div className="flex-none">
          <AmountText cents={-e.gross_amount} className="block text-[14px]" />
          <div className="mt-0.5">{statusChip(e.status)}</div>
        </div>
      }
    />
  );
}

/** Books › Expenses: supplier-titled rows in month sections with totals
 *  recomputed under the active filter+search (asset §4). Filters live in
 *  query params (?status=, ?nodoc=1) — shareable, F5-proof. */
export function ExpensesSegment({ q }: { q: string }) {
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status: StatusFilter = STATUS_FILTERS.includes(
    rawStatus as StatusFilter,
  )
    ? (rawStatus as StatusFilter)
    : 'all';
  const noDocOnly = params.get('nodoc') === '1';

  const expensesQ = useExpenses();
  const entitiesQ = useEntities();
  const docsQ = useDocumentsArchive();
  const entities = entitiesQ.data ?? [];
  const documented = documentedExpenseIds(docsQ.data ?? []);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  if (expensesQ.isPending) return <SkeletonRows count={5} />;
  if (expensesQ.isError) {
    return (
      <LoadError
        message={
          expensesQ.error instanceof Error
            ? expensesQ.error.message
            : 'Failed to load expenses'
        }
        onRetry={() => void expensesQ.refetch()}
      />
    );
  }

  const searched = (expensesQ.data ?? []).filter((e) =>
    expenseMatchesQuery(e, q, entityName(entities, e.supplier_id)),
  );
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [f, searched.filter((e) => matchesStatus(e, f)).length]),
  ) as Record<StatusFilter, number>;
  const noDocCount = searched.filter((e) => !documented.has(e.id)).length;
  const filtered = searched
    .filter((e) => matchesStatus(e, status))
    .filter((e) => !noDocOnly || !documented.has(e.id));
  const groups = groupByMonth(filtered);

  return (
    <div>
      <StatusChipRow
        counts={counts}
        active={status}
        onChange={(f) => setParam('status', f === 'all' ? null : f)}
        extra={
          <button
            type="button"
            onClick={() => setParam('nodoc', noDocOnly ? null : '1')}
            className={`flex-none whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${
              noDocOnly ? 'bg-accent text-white' : 'bg-surface text-ink-2'
            }`}
          >
            📎 No document {noDocCount}
          </button>
        }
      />
      {groups.length === 0 && (
        <EmptyState
          icon="🧾"
          title="No expenses match"
          hint="Adjust the filter or create one with +"
        />
      )}
      {groups.map((g) => (
        <ListGroup
          key={g.month}
          label={
            <GroupHeader label={g.label} totalCents={g.totalCents} count={g.count} />
          }
        >
          {g.rows.map((e) => (
            <ExpenseRow
              key={e.id}
              e={e}
              supplierName={entityName(entities, e.supplier_id)}
              hasDocument={documented.has(e.id)}
            />
          ))}
        </ListGroup>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/ExpensesSegment.test.tsx && npm test
```

Expected: PASS (6 tests); full suite PASS (nothing mounts the new component yet).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books packages/web/src/queries
git commit -m "feat(web): books expenses segment — month sections with totals, supplier rows, status/no-doc filters"
```

---

### Task 4: InvoicesSegment (mirror list: customer + number, sent chip, inflow amounts)

**Files:**
- Create: `packages/web/src/books/InvoicesSegment.tsx`
- Test: `packages/web/src/books/InvoicesSegment.test.tsx` (new)

**Interfaces:**
- Consumes: `useInvoices` (frozen `sharedKeys.invoices`), `useEntities`, pure model, `chips.tsx`.
- Produces: `InvoicesSegment({ q })` — asset §4 decision "Invoices — зеркально": title = customer name (fallback: invoice number), subtitle = `№ · 3 Jul · 🏦 · sent`, trailing = `+amount` (green, `showSign`) + status chip; totals positive (`+X € · n`); `?status=` filter shared with the expenses convention; rows navigate to `/books/invoices/:id`. No `nodoc` chip (the expense↔document join does not cover invoices — `DocumentArchiveRow` carries `expense_id` only, Reality #12).

- [ ] **Step 1: Write failing tests**

`src/books/InvoicesSegment.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { InvoicesSegment } from './InvoicesSegment';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
}));
import { getEntities, getInvoices } from '../api';

const INVOICES = [
  { id: 1, customer_id: 7, invoice_number: '2026-018', gross_amount: 120000, vat_amount: 21639, currency: 'EUR', tax_point_date: '2026-07-04', due_date: null, document_id: null, status: 'posted', sent_at: 1751600000, reconciled: true },
  { id: 2, customer_id: null, invoice_number: '2026-019', gross_amount: 45000, vat_amount: 8115, currency: 'EUR', tax_point_date: '2026-06-20', due_date: null, document_id: 5, status: 'draft', sent_at: null, reconciled: false },
];
const ENTITIES = [
  { id: 7, role: 'customer', country: 'EE', name: 'Nordic Consulting OÜ', goods_vs_services: null },
];

function mount(q = '', url = '/books?seg=invoices') {
  vi.mocked(getInvoices).mockResolvedValue(INVOICES as never);
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <InvoicesSegment q={q} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InvoicesSegment', () => {
  it('renders customer-titled rows with number/sent markers and inflow totals', async () => {
    mount();
    expect(await screen.findByText('Nordic Consulting OÜ')).toBeInTheDocument();
    expect(screen.getByText(/2026-018 · 4 Jul · 🏦 · sent/)).toBeInTheDocument();
    expect(screen.getByText('+1200.00 € · 1')).toBeInTheDocument();
    // Customer-less draft falls back to the invoice number as its title:
    expect(screen.getByText('2026-019')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Nordic Consulting/ }),
    ).toHaveAttribute('href', '/books/invoices/1');
  });

  it('?status= filters and totals follow', async () => {
    mount('', '/books?seg=invoices&status=draft');
    expect(await screen.findByText('2026-019')).toBeInTheDocument();
    expect(screen.queryByText('Nordic Consulting OÜ')).not.toBeInTheDocument();
    expect(screen.getByText('+450.00 € · 1')).toBeInTheDocument();
  });

  it('search matches the invoice number', async () => {
    mount('018');
    expect(await screen.findByText('Nordic Consulting OÜ')).toBeInTheDocument();
    expect(screen.queryByText('2026-019')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/InvoicesSegment.test.tsx
```

Expected: FAIL — `./InvoicesSegment` not found.

- [ ] **Step 3: Implement `src/books/InvoicesSegment.tsx`**

```tsx
import { useSearchParams } from 'react-router-dom';
import { fmtCents, type SalesInvoice } from '../api';
import {
  entityName,
  groupByMonth,
  invoiceMatchesQuery,
  matchesStatus,
  shortDate,
  STATUS_FILTERS,
  type StatusFilter,
} from '../queries/books';
import { useEntities, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { statusChip, StatusChipRow } from './chips';

function InvoiceRow({ inv, customerName }: {
  inv: SalesInvoice;
  customerName: string | null;
}) {
  const parts = [inv.invoice_number, shortDate(inv.tax_point_date)];
  if (inv.reconciled) parts.push('🏦');
  if (inv.sent_at != null) parts.push('sent');
  return (
    <ListRow
      to={`/books/invoices/${inv.id}`}
      title={customerName ?? inv.invoice_number}
      subtitle={parts.join(' · ')}
      trailing={
        <div className="flex-none">
          <AmountText
            cents={inv.gross_amount}
            showSign
            className="block text-[14px]"
          />
          <div className="mt-0.5">{statusChip(inv.status)}</div>
        </div>
      }
    />
  );
}

/** Books › Invoices — the §4 mirror: customer/number rows, inflow amounts,
 *  month totals under the active filter. */
export function InvoicesSegment({ q }: { q: string }) {
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status: StatusFilter = STATUS_FILTERS.includes(
    rawStatus as StatusFilter,
  )
    ? (rawStatus as StatusFilter)
    : 'all';

  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const entities = entitiesQ.data ?? [];

  if (invoicesQ.isPending) return <SkeletonRows count={5} />;
  if (invoicesQ.isError) {
    return (
      <LoadError
        message={
          invoicesQ.error instanceof Error
            ? invoicesQ.error.message
            : 'Failed to load invoices'
        }
        onRetry={() => void invoicesQ.refetch()}
      />
    );
  }

  const searched = (invoicesQ.data ?? []).filter((i) =>
    invoiceMatchesQuery(i, q, entityName(entities, i.customer_id)),
  );
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [f, searched.filter((i) => matchesStatus(i, f)).length]),
  ) as Record<StatusFilter, number>;
  const filtered = searched.filter((i) => matchesStatus(i, status));
  const groups = groupByMonth(filtered);

  return (
    <div>
      <StatusChipRow
        counts={counts}
        active={status}
        onChange={(f) => {
          const next = new URLSearchParams(params);
          if (f === 'all') next.delete('status');
          else next.set('status', f);
          setParams(next, { replace: true });
        }}
      />
      {groups.length === 0 && (
        <EmptyState
          icon="📨"
          title="No invoices match"
          hint="Adjust the filter or create one with +"
        />
      )}
      {groups.map((g) => (
        <ListGroup
          key={g.month}
          label={
            <span className="flex w-full items-baseline justify-between">
              <span>{g.label}</span>
              <span className="whitespace-nowrap tabular-nums">
                +{fmtCents(g.totalCents)} € · {g.count}
              </span>
            </span>
          }
        >
          {g.rows.map((inv) => (
            <InvoiceRow
              key={inv.id}
              inv={inv}
              customerName={entityName(entities, inv.customer_id)}
            />
          ))}
        </ListGroup>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/InvoicesSegment.test.tsx && npm test
```

Expected: PASS (3 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): books invoices segment — customer rows, sent marker, inflow month totals"
```

---
### Task 5: ExpenseScreen — detail route with navigable facts, drafts surface (rejection reason, submit, delete)

**Files:**
- Create: `packages/web/src/books/ExpenseScreen.tsx`
- Test: `packages/web/src/books/ExpenseScreen.test.tsx` (new)

**Interfaces:**
- Consumes: `useExpenseFacts`/`useRejectedReason`/`invalidateBooks` (`queries/books.ts`), `useExpenses` (reconciled flag — a LIST enrichment, Reality #11), `useEntities`, `useDocumentsArchive` (document filename), `postExpense`, `deleteExpense`, `humanizePolicyReason` (`inbox/reason.ts` — the held receipt reuses the Inbox vocabulary), `vatRatePct`/`absoluteDate`/`absoluteDateFromIso` (`inbox/format.ts`), kit (`ScreenHeader`, `ListGroup`/`ListRow`/`KeyValue`, `AmountText`, `Button`/`LinkButton`, `ConfirmDialog`, toasts, `LoadError`/`SkeletonRows`).
- Produces: `ExpenseScreen()` for `/books/expenses/:id` — asset §5: amount hero (supplier · category · status chip), facts KV (VAT with implied rate, tax point, supplier name, invoice number, AI confidence, claimant), **Document row that NAVIGATES to `/books/documents/:docId`** (this plan's route — the approval-screen gap 6 closes for documents; the supplier link stays Plan 06, name shown inline), **Bank row as status** ("🏦 Reconciled" / "Not matched" — no navigation, Reality #11), honest History (created / rejected-with-reason / corrected — Reality #2), and the drafts surface: rejection banner + "Submit for posting" (`/post` pipeline with humanized held receipt, Reality #14) + "Delete draft…" (ConfirmDialog → `deleteExpense`; a 409's server text surfaces in a toast). `posted` shows a "Correct…" button only after Task 6 wires the sheet (this task renders the posted state with a read-only ADR-0009 hint).
- Delete is drafts-only BY CONSTRUCTION (button rendered only for `status === 'draft'`; the server 409s anything else — ADR-0012, `expenses.controller.ts:56-66`).

- [ ] **Step 1: Write failing tests**

`src/books/ExpenseScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { ExpenseScreen } from './ExpenseScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpense: vi.fn(),
  getExpenses: vi.fn(),
  getEntities: vi.fn(),
  getDocuments: vi.fn(),
  listApprovals: vi.fn(),
  postExpense: vi.fn(),
  deleteExpense: vi.fn(),
  // CorrectSheet (mounted for posted expenses from Task 6 on) reads these:
  getCategories: vi.fn(),
}));
import {
  deleteExpense,
  getCategories,
  getDocuments,
  getEntities,
  getExpense,
  getExpenses,
  listApprovals,
  postExpense,
} from '../api';

const DETAIL = {
  id: 12,
  document_id: 9,
  supplier_id: 3,
  category: 'rent',
  gross_amount: 65000,
  vat_amount: 11721,
  currency: 'EUR',
  tax_point_date: '2026-06-25',
  status: 'posted',
  supplier_invoice_number: 'A-183',
  ai_confidence: 0.96,
  claimant_id: null,
  created_at: 1750830000,
};

function mountAt(
  detail: Partial<typeof DETAIL> = {},
  listStatus = 'posted',
  rejections: unknown[] = [],
) {
  vi.mocked(getExpense).mockResolvedValue({ ...DETAIL, ...detail } as never);
  vi.mocked(getExpenses).mockResolvedValue([
    { id: 12, supplier_id: 3, category: 'rent', gross_amount: 65000, vat_amount: 11721, currency: 'EUR', tax_point_date: '2026-06-25', status: listStatus, reconciled: true },
  ] as never);
  vi.mocked(getEntities).mockResolvedValue([
    { id: 3, role: 'supplier', country: 'EE', name: 'AS Merko Ehitus', goods_vs_services: null },
  ] as never);
  vi.mocked(getDocuments).mockResolvedValue([
    { id: 9, expense_id: 12, filename: 'arve-183.pdf' },
  ] as never);
  // MUST be mocked BEFORE render — the rejection query fires on mount.
  vi.mocked(listApprovals).mockResolvedValue(rejections as never);
  vi.mocked(getCategories).mockResolvedValue([] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/books/expenses/12']}>
        <AppToaster />
        <Routes>
          <Route path="/books/expenses/:id" element={<ExpenseScreen />} />
          <Route path="/books" element={<div>BOOKS LIST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ExpenseScreen', () => {
  it('renders hero, facts with implied VAT rate, navigable document row and bank STATUS (no link)', async () => {
    mountAt();
    expect(await screen.findByText('AS Merko Ehitus · rent')).toBeInTheDocument();
    expect(screen.getByText('-650.00 €')).toBeInTheDocument();
    expect(screen.getByText('117.21 € (22%)')).toBeInTheDocument();
    expect(screen.getByText('25.06.2026')).toBeInTheDocument();
    expect(screen.getByText('A-183')).toBeInTheDocument();
    // Document row is a REAL route (fixes the #expense-N dead-end class):
    expect(
      screen.getByRole('link', { name: /arve-183\.pdf/ }),
    ).toHaveAttribute('href', '/books/documents/9');
    // Bank is a status, not a navigation (no endpoint maps expense→tx):
    expect(screen.getByText('🏦 Reconciled')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Reconciled/ })).toBeNull();
    // Posted state: read-only ADR-0009 hint, no Delete.
    expect(screen.getByText(/only through a correction/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });

  it('drafts show the rejection reason and Submit for posting with a humanized HELD receipt', async () => {
    vi.mocked(postExpense).mockResolvedValue({
      expense: { id: 12, status: 'pending' },
      policy: {
        action: 'hold-for-approval',
        reason: 'Voucher amount 65000 exceeds ceiling 5000',
      },
    } as never);
    mountAt({ status: 'draft' }, 'draft', [
      { id: 4, object_type: 'expense', object_id: 12, status: 'rejected', requested_by: 'system', approved_by: null, rejected_reason: 'Wrong supplier picked', policy_reason: null, superseded_by: null, created_at: 1750000000, resolved_at: 1750900000 },
    ]);
    expect(await screen.findByText(/Wrong supplier picked/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for posting' }),
    );
    await waitFor(() => expect(postExpense).toHaveBeenCalledWith(12));
    expect(
      await screen.findByText(
        /Held for approval — 650\.00 € above the 50\.00 € auto-post limit/,
      ),
    ).toBeInTheDocument();
  });

  it('Delete draft goes plan→confirm→receipt and navigates back to the list', async () => {
    vi.mocked(deleteExpense).mockResolvedValue({ id: 12 } as never);
    mountAt({ status: 'draft' }, 'draft');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete draft…' }),
    );
    // Nothing deleted yet — ConfirmDialog first:
    expect(deleteExpense).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteExpense).toHaveBeenCalledWith(12));
    expect(await screen.findByText('BOOKS LIST')).toBeInTheDocument();
  });

  it('a corrected (reversed) expense explains one-shot corrections and shows the corrected marker', async () => {
    mountAt({ status: 'reversed' }, 'reversed');
    expect(await screen.findByText('corrected')).toBeInTheDocument();
    expect(
      screen.getByText(/Already corrected — corrections are one-shot/),
    ).toBeInTheDocument();
  });

  it('detail fetch failure renders a retryable LoadError, not skeletons forever', async () => {
    vi.mocked(getExpense).mockRejectedValue(new Error('nope'));
    vi.mocked(getExpenses).mockResolvedValue([] as never);
    vi.mocked(getEntities).mockResolvedValue([] as never);
    vi.mocked(getDocuments).mockResolvedValue([] as never);
    vi.mocked(listApprovals).mockResolvedValue([] as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/books/expenses/12']}>
          <Routes>
            <Route path="/books/expenses/:id" element={<ExpenseScreen />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/ExpenseScreen.test.tsx
```

Expected: FAIL — `./ExpenseScreen` not found.

- [ ] **Step 3: Implement `src/books/ExpenseScreen.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { deleteExpense, postExpense, type ExpenseDetail } from '../api';
import {
  absoluteDate,
  absoluteDateFromIso,
  vatRatePct,
} from '../inbox/format';
import { humanizePolicyReason } from '../inbox/reason';
import {
  entityName,
  invalidateBooks,
  useDocumentsArchive,
  useExpenseFacts,
  useRejectedReason,
} from '../queries/books';
import { useEntities, useExpenses } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { statusChip } from './chips';

/** Honest history (Reality #2): built ONLY from exposed facts — created_at,
 *  the rejection log, and the reversed status. The correction's own date and
 *  reason are voucher-level and not retrievable (Appendix A gap 1). */
function History({
  detail,
  rejectedReason,
  rejectedAt,
}: {
  detail: ExpenseDetail;
  rejectedReason: string | null;
  rejectedAt: number | null;
}) {
  return (
    <ListGroup label="History">
      {detail.status === 'reversed' && (
        <ListRow
          title="Corrected"
          subtitle="A reversal + corrected entry replaced the original (ADR-0009); the figures above are the corrected ones"
        />
      )}
      {rejectedReason != null && (
        <ListRow
          title="Rejected — returned to draft"
          subtitle={`${rejectedReason}${rejectedAt != null ? ` · ${absoluteDate(rejectedAt)}` : ''}`}
        />
      )}
      <ListRow
        title={detail.document_id != null ? 'Created from a document' : 'Created'}
        subtitle={absoluteDate(detail.created_at)}
      />
    </ListGroup>
  );
}

export function ExpenseScreen() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const detailQ = useExpenseFacts(id);
  const listQ = useExpenses();
  const entitiesQ = useEntities();
  const docsQ = useDocumentsArchive();
  const detail = detailQ.data;
  const rejectionQ = useRejectedReason('expense', id, detail?.status === 'draft');

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  if (detailQ.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Expense" backTo="/books" />
        <LoadError
          message={
            detailQ.error instanceof Error
              ? detailQ.error.message
              : 'Failed to load the expense'
          }
          onRetry={() => void detailQ.refetch()}
        />
      </div>
    );
  }
  if (detail === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Expense" backTo="/books" />
        <SkeletonRows count={4} />
      </div>
    );
  }

  const supplier = entityName(entitiesQ.data ?? [], detail.supplier_id);
  const claimant = entityName(entitiesQ.data ?? [], detail.claimant_id);
  const listRow = (listQ.data ?? []).find((e) => e.id === detail.id);
  const doc = (docsQ.data ?? []).find((d) => d.id === detail.document_id);
  const rate = vatRatePct(detail.gross_amount, detail.vat_amount);
  const rejection = rejectionQ.data ?? null;

  const onSubmitForPosting = async () => {
    setBusy(true);
    try {
      const res = await postExpense(detail.id);
      await invalidateBooks(qc);
      if (res.policy.action === 'hold-for-approval') {
        toastOk(
          `Held for approval — ${humanizePolicyReason(res.policy.reason)}`,
        );
      } else {
        toastOk(`Posted · -${(detail.gross_amount / 100).toFixed(2)} €`);
      }
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setBusy(true);
    try {
      await deleteExpense(detail.id);
      await invalidateBooks(qc);
      toastOk('Draft expense deleted');
      navigate('/books', { replace: true });
    } catch (e) {
      // 409 carries the server's own explanation (non-draft).
      toastErr(e instanceof Error ? e.message : String(e));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Expense" backTo="/books" />

      <div className="px-5 pb-4 pt-1 text-center">
        <AmountText
          cents={-detail.gross_amount}
          currency={detail.currency}
          className="text-[30px]"
        />
        <p className="mt-1 text-[14px] text-ink-2">
          {supplier != null ? `${supplier} · ${detail.category}` : detail.category}{' '}
          <span className="align-[2px]">{statusChip(detail.status)}</span>
        </p>
      </div>

      {detail.status === 'draft' && rejection != null && (
        <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg px-4 py-3">
          <p className="text-[13px] font-semibold text-warn">
            Rejected — {rejection.rejected_reason ?? 'no reason recorded'}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-2">
            Fix what is wrong, then submit for posting again.
          </p>
        </div>
      )}

      <ListGroup label="Facts">
        <KeyValue k="Category" v={detail.category} />
        <KeyValue
          k="VAT"
          v={`${(detail.vat_amount / 100).toFixed(2)} €${rate != null ? ` (${rate}%)` : ''}`}
        />
        <KeyValue k="Tax point" v={absoluteDateFromIso(detail.tax_point_date)} />
        {supplier != null && <KeyValue k="Supplier" v={supplier} />}
        {claimant != null && <KeyValue k="Paid by" v={claimant} />}
        {detail.supplier_invoice_number != null && (
          <KeyValue k="Invoice no." v={detail.supplier_invoice_number} />
        )}
        {detail.ai_confidence != null && (
          <KeyValue k="AI confidence" v={detail.ai_confidence.toFixed(2)} />
        )}
        <KeyValue
          k="Bank"
          v={listRow?.reconciled === true ? '🏦 Reconciled' : 'Not matched'}
        />
      </ListGroup>

      {detail.document_id != null && (
        <ListGroup label="Document">
          <ListRow
            to={`/books/documents/${detail.document_id}`}
            leading={<span aria-hidden>📄</span>}
            title={doc?.filename ?? 'Source document'}
            subtitle="Open the document detail"
          />
        </ListGroup>
      )}
      {detail.document_id == null && (
        <ListGroup label="Document">
          <ListRow
            title="No source document"
            subtitle="Entered without a receipt/invoice — uploads land in Documents (auto-attach is a server follow-up)"
          />
        </ListGroup>
      )}

      <History
        detail={detail}
        rejectedReason={detail.status === 'draft' ? (rejection?.rejected_reason ?? null) : null}
        rejectedAt={detail.status === 'draft' ? (rejection?.resolved_at ?? null) : null}
      />

      <div className="space-y-2 px-5 pt-2">
        {detail.status === 'draft' && (
          <>
            <Button className="w-full" busy={busy} onClick={() => void onSubmitForPosting()}>
              Submit for posting
            </Button>
            <Button
              variant="danger"
              className="w-full"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete draft…
            </Button>
          </>
        )}
        {detail.status === 'pending' && (
          <>
            <p className="text-center text-[12.5px] text-ink-2">
              Waiting for approval — decide it in the Inbox.
            </p>
            <LinkButton to="/inbox?seg=approvals" className="w-full">
              Open Inbox
            </LinkButton>
          </>
        )}
        {detail.status === 'posted' && (
          <p className="text-center text-[12.5px] text-ink-2">
            Posted entries change only through a correction (ADR-0009).
          </p>
        )}
        {detail.status === 'reversed' && (
          <p className="text-center text-[12.5px] text-ink-2">
            Already corrected — corrections are one-shot (ADR-0009). Issue a
            credit note or a new expense for further changes.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this draft expense?"
        body="The draft is removed permanently. Posted expenses can never be deleted — only corrected."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
```

Note on the hero amount: `AmountText` renders `fmtCents(cents)` + a currency suffix (`€` for EUR), so the hero shows `-650.00 €` — `fmtCents` already emits the leading minus. If the exact-string assertion ever mismatches, adjust the ASSERTION to the component's real output, never the component to the test.

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/ExpenseScreen.test.tsx && npm test
```

Expected: PASS (5 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): expense detail route — facts, navigable document, bank status, drafts surface with rejection reason"
```

---

### Task 6: CorrectSheet — the three ADR-0009 branches, wired into ExpenseScreen

**Files:**
- Create: `packages/web/src/books/CorrectSheet.tsx`
- Modify: `packages/web/src/books/ExpenseScreen.tsx` (posted state gains "Correct…")
- Test: `packages/web/src/books/CorrectSheet.test.tsx` (new)

**Interfaces:**
- Consumes: `correctExpense`/`correctInvoice` (typed `CorrectionOutcome`, Task 1), `eurosToCents`/`centsToEuroInput` (`lib/money.ts`), `useCategories`, kit (`Sheet`, `Field`/`TextInput`/`SelectInput`, `Button`), toasts.
- Produces: `CorrectSheet({ open, onOpenChange, objectType, objectId, grossCents, vatCents, category?, onDone })` — kind selection as three explained radio rows:
  - **Financial** (default): "Posts a reversal + a corrected entry; the original becomes 'corrected'. If the period is locked, both land in the current open period." Patch fields (gross €, VAT €, category select for expenses) prefilled from the current values; reason mandatory; primary label `Post correction · −X €` (`+X €` for invoices). Receipt states the redirect when `redirected` ("Correction landed in the current open period — the original period is locked").
  - **Cosmetic**: "Fixes presentation only — nothing changes in the books. (The server records no changes for this yet — Appendix A gap 7.)" Reason mandatory; no patch fields.
  - **Credit note**: "Issues a negative document against this one; the original stays posted. Opens the credit-note form." — NO `/correct` call (Reality #5): the button NAVIGATES to `/books/credit-notes/new?type=<objectType>&id=<objectId>`.
- The sheet is mounted with `key={objectId}` by callers (state never leaks across objects — Global Constraints).

- [ ] **Step 1: Write failing tests**

`src/books/CorrectSheet.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { CorrectSheet } from './CorrectSheet';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  correctExpense: vi.fn(),
  correctInvoice: vi.fn(),
  getCategories: vi.fn(),
}));
import { correctExpense, getCategories } from '../api';

function mount(props: Partial<Parameters<typeof CorrectSheet>[0]> = {}) {
  vi.mocked(getCategories).mockResolvedValue([
    { key: 'rent', label: 'Rent', accountCode: 'X' },
    { key: 'fuel', label: 'Fuel', accountCode: 'Y' },
  ] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/books/expenses/12']}>
        <AppToaster />
        <Routes>
          <Route
            path="/books/expenses/:id"
            element={
              <CorrectSheet
                open
                onOpenChange={() => undefined}
                objectType="expense"
                objectId={12}
                grossCents={65000}
                vatCents={11721}
                category="rent"
                onDone={onDone}
                {...props}
              />
            }
          />
          <Route path="/books/credit-notes/new" element={<div>CN FORM</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onDone };
}

describe('CorrectSheet', () => {
  it('financial: prefilled euros, mandatory reason, outcome-stating submit, cents on the wire', async () => {
    vi.mocked(correctExpense).mockResolvedValue({
      outcome: 'posted_reversal_and_correction',
      redirected: false,
    } as never);
    const { onDone } = mount();
    const gross = await screen.findByLabelText('New gross (€)');
    expect(gross).toHaveValue('650.00');
    // Reason empty → primary disabled:
    const submit = screen.getByRole('button', { name: /Post correction/ });
    expect(submit).toBeDisabled();
    await userEvent.clear(gross);
    await userEvent.type(gross, '605,00');
    await userEvent.clear(screen.getByLabelText('New VAT (€)'));
    await userEvent.type(screen.getByLabelText('New VAT (€)'), '109.10');
    await userEvent.type(
      screen.getByLabelText('Reason'),
      'OCR misread the total',
    );
    expect(
      screen.getByRole('button', { name: 'Post correction · −605.00 €' }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Post correction · −605.00 €' }),
    );
    await waitFor(() =>
      expect(correctExpense).toHaveBeenCalledWith(12, {
        kind: 'financial',
        reason: 'OCR misread the total',
        patch: { gross_amount: 60500, vat_amount: 10910, category: 'rent' },
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('states the locked-period redirect in the receipt', async () => {
    vi.mocked(correctExpense).mockResolvedValue({
      outcome: 'posted_reversal_and_correction',
      redirected: true,
      redirectedToPeriodId: 5,
    } as never);
    mount();
    await userEvent.type(
      await screen.findByLabelText('Reason'),
      'late fix',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Post correction/ }),
    );
    expect(
      await screen.findByText(/landed in the current open period/i),
    ).toBeInTheDocument();
  });

  it('cosmetic: no patch fields, honest no-op hint, reason still mandatory', async () => {
    vi.mocked(correctExpense).mockResolvedValue({
      outcome: 'cosmetic_attachment_replaced',
    } as never);
    mount();
    await userEvent.click(await screen.findByLabelText(/Cosmetic/));
    expect(screen.queryByLabelText('New gross (€)')).toBeNull();
    expect(screen.getByText(/nothing changes in the books/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Reason'), 'typo in note');
    await userEvent.click(
      screen.getByRole('button', { name: 'Record cosmetic correction' }),
    );
    await waitFor(() =>
      expect(correctExpense).toHaveBeenCalledWith(12, {
        kind: 'cosmetic',
        reason: 'typo in note',
      }),
    );
  });

  it('credit note branch NAVIGATES to the prefilled form — no /correct call', async () => {
    mount();
    await userEvent.click(await screen.findByLabelText(/Credit note/));
    expect(
      screen.getByRole('link', { name: 'Open the credit-note form' }),
    ).toHaveAttribute('href', '/books/credit-notes/new?type=expense&id=12');
    await userEvent.click(
      screen.getByRole('link', { name: 'Open the credit-note form' }),
    );
    expect(await screen.findByText('CN FORM')).toBeInTheDocument();
    expect(correctExpense).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/CorrectSheet.test.tsx
```

Expected: FAIL — `./CorrectSheet` not found.

- [ ] **Step 3: Implement `src/books/CorrectSheet.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  correctExpense,
  correctInvoice,
  type CorrectionRequest,
} from '../api';
import { centsToEuroInput, eurosToCents } from '../lib/money';
import { invalidateBooks } from '../queries/books';
import { useCategories } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, INPUT_CLS, SelectInput, TextInput } from '../ui/Form';
import { LinkButton } from '../ui/LinkButton';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

type Kind = 'financial' | 'cosmetic' | 'credit_note';

const EXPLAIN: Record<Kind, string> = {
  financial:
    'Posts a reversal + a corrected entry; this document becomes “corrected” and the new figures go live. If the original period is locked, both land in the current open period (ADR-0009).',
  cosmetic:
    'Fixes presentation only — nothing changes in the books. (The server records no changes for this yet; use it to leave a reasoned note.)',
  credit_note:
    'Issues a negative document against this one; the original stays posted. Opens the credit-note form with this document preselected.',
};

/**
 * The ADR-0009 correction sheet. Mount with key={objectId} — the sheet keeps
 * form state and must never leak it across objects. The credit-note branch
 * NAVIGATES to /books/credit-notes/new (the /correct credit_note branch
 * needs a payload this client deliberately never sends — Reality #5).
 */
export function CorrectSheet({
  open,
  onOpenChange,
  objectType,
  objectId,
  grossCents,
  vatCents,
  category,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  objectType: 'expense' | 'sales_invoice';
  objectId: number;
  grossCents: number;
  vatCents: number;
  /** Current category — expenses only; invoices pass undefined. */
  category?: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const categoriesQ = useCategories();
  const [kind, setKind] = useState<Kind>('financial');
  const [gross, setGross] = useState(centsToEuroInput(grossCents));
  const [vat, setVat] = useState(centsToEuroInput(vatCents));
  const [cat, setCat] = useState(category ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const grossParsed = eurosToCents(gross);
  const vatParsed = eurosToCents(vat);
  const financialValid =
    grossParsed !== null && grossParsed > 0 && vatParsed !== null && vatParsed >= 0;
  const canSubmit =
    reason.trim() !== '' && (kind === 'cosmetic' || financialValid);
  const sign = objectType === 'expense' ? '−' : '+';

  const submit = async () => {
    setBusy(true);
    try {
      const req: CorrectionRequest =
        kind === 'cosmetic'
          ? { kind: 'cosmetic', reason: reason.trim() }
          : {
              kind: 'financial',
              reason: reason.trim(),
              patch: {
                gross_amount: grossParsed as number,
                vat_amount: vatParsed as number,
                ...(objectType === 'expense' && cat !== ''
                  ? { category: cat }
                  : {}),
              },
            };
      const res =
        objectType === 'expense'
          ? await correctExpense(objectId, req)
          : await correctInvoice(objectId, req);
      await invalidateBooks(qc);
      if (res.redirected === true) {
        toastOk(
          'Correction landed in the current open period — the original period is locked',
        );
      } else if (res.outcome === 'draft_edited') {
        toastOk('Draft updated');
      } else if (kind === 'cosmetic') {
        toastOk('Cosmetic correction recorded');
      } else {
        toastOk(`Correction posted · ${sign}${gross} €`);
      }
      onOpenChange(false);
      onDone();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Correct">
      <div className="space-y-3 px-5 pb-2">
        <div className="space-y-2">
          {(
            [
              ['financial', 'Financial — amounts or category are wrong'],
              ['cosmetic', 'Cosmetic — presentation only'],
              ['credit_note', 'Credit note — credit part or all of it'],
            ] as const
          ).map(([k, label]) => (
            <label
              key={k}
              className={`block rounded-xl border px-3.5 py-2.5 ${
                kind === k ? 'border-accent bg-surface' : 'border-line bg-surface'
              }`}
            >
              <span className="flex items-center gap-2 text-[14px] font-semibold">
                <input
                  type="radio"
                  name="correction-kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {label}
              </span>
              <span className="mt-1 block text-[12px] text-ink-2">
                {EXPLAIN[k]}
              </span>
            </label>
          ))}
        </div>

        {kind === 'credit_note' ? (
          <LinkButton
            to={`/books/credit-notes/new?type=${objectType}&id=${objectId}`}
            className="w-full"
          >
            Open the credit-note form
          </LinkButton>
        ) : (
          <>
            {kind === 'financial' && (
              <>
                <Field label="New gross (€)">
                  <TextInput
                    inputMode="decimal"
                    value={gross}
                    onChange={(e) => setGross(e.target.value)}
                  />
                </Field>
                <Field label="New VAT (€)">
                  <TextInput
                    inputMode="decimal"
                    value={vat}
                    onChange={(e) => setVat(e.target.value)}
                  />
                </Field>
                {objectType === 'expense' && (
                  <Field label="Category">
                    <SelectInput value={cat} onChange={(e) => setCat(e.target.value)}>
                      {/* Keep a predating category selectable so it is never lost */}
                      {cat !== '' &&
                        !(categoriesQ.data ?? []).some((c) => c.key === cat) && (
                          <option value={cat}>{cat}</option>
                        )}
                      {(categoriesQ.data ?? []).map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                )}
              </>
            )}
            <Field label="Reason" hint="Required — it lands in the audit trail">
              <textarea
                className={INPUT_CLS}
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this correction…"
              />
            </Field>
            <Button
              className="w-full"
              busy={busy}
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {kind === 'cosmetic'
                ? 'Record cosmetic correction'
                : `Post correction · ${sign}${
                    grossParsed !== null ? centsToEuroInput(grossParsed) : gross
                  } €`}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Wire into `ExpenseScreen`**

In `src/books/ExpenseScreen.tsx`: add state `const [correctOpen, setCorrectOpen] = useState(false);`, replace the `posted` hint block with:

```tsx
        {detail.status === 'posted' && (
          <>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setCorrectOpen(true)}
            >
              Correct…
            </Button>
            <p className="text-center text-[12.5px] text-ink-2">
              Posted entries change only through a correction (ADR-0009).
            </p>
          </>
        )}
```

and mount the sheet before the closing `</div>` (remount-per-object via `key`):

```tsx
      {detail.status === 'posted' && (
        <CorrectSheet
          key={detail.id}
          open={correctOpen}
          onOpenChange={setCorrectOpen}
          objectType="expense"
          objectId={detail.id}
          grossCents={detail.gross_amount}
          vatCents={detail.vat_amount}
          category={detail.category}
          onDone={() => void detailQ.refetch()}
        />
      )}
```

(import `CorrectSheet`). Add one test to `ExpenseScreen.test.tsx`:

```tsx
  it('posted expenses offer Correct… which opens the sheet', async () => {
    mountAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Correct…' }),
    );
    expect(
      await screen.findByRole('button', { name: /Post correction/ }),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/CorrectSheet.test.tsx src/books/ExpenseScreen.test.tsx && npm test
```

Expected: PASS (4 + 6 tests); full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): correction sheet — explained ADR-0009 branches, euros in, locked-period redirect receipt"
```

---
### Task 7: InvoiceScreen — detail from the LIST row, Correct + Issue credit note entry points

**Files:**
- Create: `packages/web/src/books/InvoiceScreen.tsx`
- Test: `packages/web/src/books/InvoiceScreen.test.tsx` (new)

**Interfaces:**
- Consumes: `useInvoices` (there is NO single-invoice GET — Reality #13; the detail is the list row from the shared cache), `useEntities`, `useRejectedReason`, `postInvoice`, `deleteInvoice`, `CorrectSheet` (Task 6, `category` omitted — the backend ignores category on invoices), `absoluteDate`/`absoluteDateFromIso`/`vatRatePct`, `humanizePolicyReason`, kit.
- Produces: `InvoiceScreen()` for `/books/invoices/:id` — hero `+amount` (customer · № · status chip), facts KV (VAT with rate, tax point, due date, sent-at absolute, customer name, Bank status), Document row navigating to `/books/documents/:docId` when `document_id` is set (the list row carries it after Task 1), History (created is NOT renderable — the list subset has no `created_at`; the history shows rejection + corrected only — honest), drafts: rejection banner + Submit for posting (`postInvoice`) + Delete draft (ConfirmDialog); posted: **Correct…** (sheet) + **Issue credit note…** (`LinkButton` → `/books/credit-notes/new?type=sales_invoice&id=N` — the asset's "Issue credit note from the detail, object already known"); reversed: one-shot hint. An id absent from the loaded list renders an honest not-found state (deleted or never existed), never skeletons forever.

- [ ] **Step 1: Write failing tests**

`src/books/InvoiceScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { InvoiceScreen } from './InvoiceScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  listApprovals: vi.fn(),
  postInvoice: vi.fn(),
  deleteInvoice: vi.fn(),
  getCategories: vi.fn(),
}));
import {
  deleteInvoice,
  getCategories,
  getEntities,
  getInvoices,
  listApprovals,
} from '../api';

const INVOICE = {
  id: 3,
  customer_id: 7,
  invoice_number: '2026-018',
  gross_amount: 120000,
  vat_amount: 21639,
  currency: 'EUR',
  tax_point_date: '2026-07-04',
  due_date: '2026-07-18',
  document_id: 5,
  status: 'posted',
  sent_at: 1751600000,
  reconciled: true,
};

function mountAt(
  inv: Partial<typeof INVOICE> = {},
  id = '3',
  rejections: unknown[] = [],
) {
  vi.mocked(getInvoices).mockResolvedValue([{ ...INVOICE, ...inv }] as never);
  vi.mocked(getEntities).mockResolvedValue([
    { id: 7, role: 'customer', country: 'EE', name: 'Nordic Consulting OÜ', goods_vs_services: null },
  ] as never);
  // MUST be mocked BEFORE render — the rejection query fires on mount.
  vi.mocked(listApprovals).mockResolvedValue(rejections as never);
  vi.mocked(getCategories).mockResolvedValue([] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/books/invoices/${id}`]}>
        <AppToaster />
        <Routes>
          <Route path="/books/invoices/:id" element={<InvoiceScreen />} />
          <Route path="/books" element={<div>BOOKS LIST</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InvoiceScreen', () => {
  it('renders hero and facts from the LIST row, document link, and both posted actions', async () => {
    mountAt();
    expect(await screen.findByText(/Nordic Consulting OÜ · 2026-018/)).toBeInTheDocument();
    expect(screen.getByText('216.39 € (22%)')).toBeInTheDocument();
    expect(screen.getByText('04.07.2026')).toBeInTheDocument();
    expect(screen.getByText('18.07.2026')).toBeInTheDocument();
    expect(screen.getByText('🏦 Reconciled')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Source document/ }),
    ).toHaveAttribute('href', '/books/documents/5');
    expect(screen.getByRole('button', { name: 'Correct…' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Issue credit note…' }),
    ).toHaveAttribute('href', '/books/credit-notes/new?type=sales_invoice&id=3');
  });

  it('drafts: rejection banner + Delete via ConfirmDialog', async () => {
    vi.mocked(deleteInvoice).mockResolvedValue({ id: 3 } as never);
    mountAt({ status: 'draft', sent_at: null, reconciled: false }, '3', [
      { id: 9, object_type: 'sales_invoice', object_id: 3, status: 'rejected', requested_by: 'system', approved_by: null, rejected_reason: 'Amount looks wrong', policy_reason: null, superseded_by: null, created_at: 1, resolved_at: 2 },
    ]);
    expect(await screen.findByText(/Amount looks wrong/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete draft…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteInvoice).toHaveBeenCalledWith(3));
    expect(await screen.findByText('BOOKS LIST')).toBeInTheDocument();
  });

  it('an id absent from the list renders an honest not-found state', async () => {
    mountAt({}, '999');
    expect(
      await screen.findByText(/not in the books/i),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/InvoiceScreen.test.tsx
```

Expected: FAIL — `./InvoiceScreen` not found.

- [ ] **Step 3: Implement `src/books/InvoiceScreen.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { deleteInvoice, postInvoice } from '../api';
import {
  absoluteDate,
  absoluteDateFromIso,
  vatRatePct,
} from '../inbox/format';
import { humanizePolicyReason } from '../inbox/reason';
import {
  entityName,
  invalidateBooks,
  useRejectedReason,
} from '../queries/books';
import { useEntities, useInvoices } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { statusChip } from './chips';
import { CorrectSheet } from './CorrectSheet';

/** /books/invoices/:id — facts come from the LIST row (no single-invoice
 *  endpoint exists, Reality #13; the row is cache-shared with the segment). */
export function InvoiceScreen() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const inv = (invoicesQ.data ?? []).find((i) => i.id === id);
  const rejectionQ = useRejectedReason('sales_invoice', id, inv?.status === 'draft');

  const [correctOpen, setCorrectOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  if (invoicesQ.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Invoice" backTo="/books?seg=invoices" />
        <LoadError
          message={
            invoicesQ.error instanceof Error
              ? invoicesQ.error.message
              : 'Failed to load invoices'
          }
          onRetry={() => void invoicesQ.refetch()}
        />
      </div>
    );
  }
  if (invoicesQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Invoice" backTo="/books?seg=invoices" />
        <SkeletonRows count={4} />
      </div>
    );
  }
  if (inv === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Invoice" backTo="/books?seg=invoices" />
        <EmptyState
          icon="🤷"
          title="This invoice is not in the books"
          hint="It may have been deleted. (The API has no single-invoice lookup.)"
        />
      </div>
    );
  }

  const customer = entityName(entitiesQ.data ?? [], inv.customer_id);
  const rate = vatRatePct(inv.gross_amount, inv.vat_amount);
  const rejection = rejectionQ.data ?? null;

  const onSubmitForPosting = async () => {
    setBusy(true);
    try {
      const res = await postInvoice(inv.id);
      await invalidateBooks(qc);
      if (res.policy.action === 'hold-for-approval') {
        toastOk(`Held for approval — ${humanizePolicyReason(res.policy.reason)}`);
      } else {
        toastOk(`Posted · +${(inv.gross_amount / 100).toFixed(2)} €`);
      }
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setBusy(true);
    try {
      await deleteInvoice(inv.id);
      await invalidateBooks(qc);
      toastOk('Draft invoice deleted');
      navigate('/books?seg=invoices', { replace: true });
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Invoice" backTo="/books?seg=invoices" />

      <div className="px-5 pb-4 pt-1 text-center">
        <AmountText
          cents={inv.gross_amount}
          currency={inv.currency}
          showSign
          className="text-[30px]"
        />
        <p className="mt-1 text-[14px] text-ink-2">
          {customer != null ? `${customer} · ${inv.invoice_number}` : inv.invoice_number}{' '}
          <span className="align-[2px]">{statusChip(inv.status)}</span>
        </p>
      </div>

      {inv.status === 'draft' && rejection != null && (
        <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg px-4 py-3">
          <p className="text-[13px] font-semibold text-warn">
            Rejected — {rejection.rejected_reason ?? 'no reason recorded'}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-2">
            Fix what is wrong, then submit for posting again.
          </p>
        </div>
      )}

      <ListGroup label="Facts">
        <KeyValue k="Invoice no." v={inv.invoice_number} />
        <KeyValue
          k="VAT"
          v={`${(inv.vat_amount / 100).toFixed(2)} €${rate != null ? ` (${rate}%)` : ''}`}
        />
        <KeyValue k="Tax point" v={absoluteDateFromIso(inv.tax_point_date)} />
        {inv.due_date != null && (
          <KeyValue k="Due" v={absoluteDateFromIso(inv.due_date)} />
        )}
        {customer != null && <KeyValue k="Customer" v={customer} />}
        {inv.sent_at != null && (
          <KeyValue k="Sent" v={absoluteDate(inv.sent_at)} />
        )}
        <KeyValue
          k="Bank"
          v={inv.reconciled ? '🏦 Reconciled' : 'Not matched'}
        />
      </ListGroup>

      {inv.document_id != null && (
        <ListGroup label="Document">
          <ListRow
            to={`/books/documents/${inv.document_id}`}
            leading={<span aria-hidden>📄</span>}
            title="Source document"
            subtitle="Open the document detail"
          />
        </ListGroup>
      )}

      {(inv.status === 'reversed' || (inv.status === 'draft' && rejection != null)) && (
        <ListGroup label="History">
          {inv.status === 'reversed' && (
            <ListRow
              title="Corrected"
              subtitle="A reversal + corrected entry replaced the original (ADR-0009)"
            />
          )}
          {inv.status === 'draft' && rejection != null && (
            <ListRow
              title="Rejected — returned to draft"
              subtitle={`${rejection.rejected_reason ?? ''}${rejection.resolved_at != null ? ` · ${absoluteDate(rejection.resolved_at)}` : ''}`}
            />
          )}
        </ListGroup>
      )}

      <div className="space-y-2 px-5 pt-2">
        {inv.status === 'draft' && (
          <>
            <Button className="w-full" busy={busy} onClick={() => void onSubmitForPosting()}>
              Submit for posting
            </Button>
            <Button
              variant="danger"
              className="w-full"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete draft…
            </Button>
          </>
        )}
        {inv.status === 'pending' && (
          <>
            <p className="text-center text-[12.5px] text-ink-2">
              Waiting for approval — decide it in the Inbox.
            </p>
            <LinkButton to="/inbox?seg=approvals" className="w-full">
              Open Inbox
            </LinkButton>
          </>
        )}
        {inv.status === 'posted' && (
          <>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setCorrectOpen(true)}
            >
              Correct…
            </Button>
            <LinkButton
              to={`/books/credit-notes/new?type=sales_invoice&id=${inv.id}`}
              variant="secondary"
              className="w-full"
            >
              Issue credit note…
            </LinkButton>
            <p className="text-center text-[12.5px] text-ink-2">
              Posted entries change only through a correction (ADR-0009).
            </p>
          </>
        )}
        {inv.status === 'reversed' && (
          <p className="text-center text-[12.5px] text-ink-2">
            Already corrected — corrections are one-shot (ADR-0009).
          </p>
        )}
      </div>

      {inv.status === 'posted' && (
        <CorrectSheet
          key={inv.id}
          open={correctOpen}
          onOpenChange={setCorrectOpen}
          objectType="sales_invoice"
          objectId={inv.id}
          grossCents={inv.gross_amount}
          vatCents={inv.vat_amount}
          onDone={() => void invoicesQ.refetch()}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this draft invoice?"
        body="The draft is removed permanently. Posted invoices can never be deleted — only corrected or credited."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
```

Note: `Correct…` has exactly one primary sibling per state — in the `posted` state BOTH visible buttons are `secondary` (the primary action for a posted object is "leave it alone"; the state's screen invariant is satisfied with zero primaries and explanatory copy — same pattern Plan 02 used on disposed tx states).

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/InvoiceScreen.test.tsx && npm test
```

Expected: PASS (3 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): invoice detail route — list-row facts, correct sheet, credit-note entry, drafts surface"
```

---

### Task 8: Credit-notes segment + credit-note detail (object-linked rows, no raw IDs)

**Files:**
- Create: `packages/web/src/books/CreditNotesSegment.tsx`, `packages/web/src/books/CreditNoteScreen.tsx`
- Test: `packages/web/src/books/CreditNotesSegment.test.tsx` (new)

**Interfaces:**
- Consumes: `useCreditNotes`/`useCreditNoteDetail` (Task 2), `useExpenses`/`useInvoices`/`useEntities` (join the credited object's counterparty/number), `groupByMonth`/`shortDate`, kit.
- Produces:
  - `creditNoteDisplay(note, ctx)` (exported from `CreditNotesSegment.tsx`): title = credited object in business terms ("Nordic Consulting OÜ · Invoice 2026-018" / "AS Merko Ehitus · Expense rent"; fallback to the note number when the object is not in the lists), subtitle = `CN-number · credits <kind> · 3 Jul`.
  - `CreditNotesSegment({ q })` — month sections (the client `CreditNote` carries `tax_point_date` after Task 1); amounts signed by direction: a credit against a **sales invoice reduces income → `−X €`**; against an **expense reduces cost → `+X €`**; rows navigate to `/books/credit-notes/:id`; a "New credit note" `LinkButton` to `/books/credit-notes/new` heads the segment (creation reachable from the segment AND from detail screens).
  - `CreditNoteScreen()` for `/books/credit-notes/:id` (`getCreditNote`, Reality #6) — facts KV + a **navigable row to the credited object** (`/books/invoices/:id` or `/books/expenses/:id` — data rule 2).

- [ ] **Step 1: Write failing tests**

`src/books/CreditNotesSegment.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CreditNotesSegment } from './CreditNotesSegment';
import { CreditNoteScreen } from './CreditNoteScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  listCreditNotes: vi.fn(),
  getCreditNote: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  getCreditNote,
  getEntities,
  getExpenses,
  getInvoices,
  listCreditNotes,
} from '../api';

const NOTE = {
  id: 7,
  credit_note_number: 'CN-1',
  status: 'posted',
  gross_amount: 40000,
  vat_amount: 7213,
  currency: 'EUR',
  tax_point_date: '2026-07-02',
  created_at: 1751400000,
  credits_object_type: 'sales_invoice',
  credits_object_id: 3,
};

function seed() {
  vi.mocked(listCreditNotes).mockResolvedValue([NOTE] as never);
  vi.mocked(getCreditNote).mockResolvedValue(NOTE as never);
  vi.mocked(getInvoices).mockResolvedValue([
    { id: 3, customer_id: 7, invoice_number: '2026-018', gross_amount: 120000, vat_amount: 21639, currency: 'EUR', tax_point_date: '2026-07-04', due_date: null, document_id: null, status: 'posted', sent_at: null, reconciled: false },
  ] as never);
  vi.mocked(getExpenses).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue([
    { id: 7, role: 'customer', country: 'EE', name: 'Nordic Consulting OÜ', goods_vs_services: null },
  ] as never);
}

function mount(ui: ReactElement, url = '/books?seg=credit-notes') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Credit notes', () => {
  it('rows are titled by the credited object with context, amount signed against income', async () => {
    seed();
    mount(<CreditNotesSegment q="" />);
    expect(
      await screen.findByText('Nordic Consulting OÜ · Invoice 2026-018'),
    ).toBeInTheDocument();
    expect(screen.getByText(/CN-1 · credits invoice · 2 Jul/)).toBeInTheDocument();
    expect(screen.getByText(/-400\.00/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Nordic Consulting OÜ · Invoice 2026-018/ }),
    ).toHaveAttribute('href', '/books/credit-notes/7');
    // Creation reachable from the segment:
    expect(
      screen.getByRole('link', { name: 'New credit note' }),
    ).toHaveAttribute('href', '/books/credit-notes/new');
  });

  it('detail links back to the credited object route', async () => {
    seed();
    mount(
      <Routes>
        <Route path="/books/credit-notes/:id" element={<CreditNoteScreen />} />
      </Routes>,
      '/books/credit-notes/7',
    );
    expect(await screen.findByText('CN-1')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Invoice 2026-018/ }),
    ).toHaveAttribute('href', '/books/invoices/3');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/CreditNotesSegment.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/books/CreditNotesSegment.tsx`:

```tsx
import {
  type CreditNote,
  type Entity,
  type Expense,
  type SalesInvoice,
} from '../api';
import { entityName, groupByMonth, shortDate, useCreditNotes } from '../queries/books';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { statusChip } from './chips';

export interface CreditedContext {
  expenses: Expense[];
  invoices: SalesInvoice[];
  entities: Entity[];
}

/** Business-terms display for a credit note (data rule 1: the row answers
 *  "what does this credit", never "row #7"). */
export function creditNoteDisplay(
  n: CreditNote,
  ctx: CreditedContext,
): { title: string; subtitle: string; objectRoute: string | null } {
  if (n.credits_object_type === 'sales_invoice') {
    const inv = ctx.invoices.find((i) => i.id === n.credits_object_id);
    const customer = inv ? entityName(ctx.entities, inv.customer_id) : null;
    return {
      title: inv
        ? `${customer ?? 'Invoice'} · Invoice ${inv.invoice_number}`
        : n.credit_note_number,
      subtitle: `${n.credit_note_number} · credits invoice · ${shortDate(n.tax_point_date)}`,
      objectRoute: inv ? `/books/invoices/${inv.id}` : null,
    };
  }
  const e = ctx.expenses.find((x) => x.id === n.credits_object_id);
  const supplier = e ? entityName(ctx.entities, e.supplier_id) : null;
  return {
    title: e
      ? `${supplier ?? 'Expense'} · Expense ${e.category}`
      : n.credit_note_number,
    subtitle: `${n.credit_note_number} · credits expense · ${shortDate(n.tax_point_date)}`,
    objectRoute: e ? `/books/expenses/${e.id}` : null,
  };
}

/** Sign: a sales credit note reduces income (−); a purchase credit note
 *  reduces cost (+). */
export const creditNoteSign = (n: CreditNote): number =>
  n.credits_object_type === 'sales_invoice' ? -n.gross_amount : n.gross_amount;

export function CreditNotesSegment({ q }: { q: string }) {
  const notesQ = useCreditNotes();
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const ctx: CreditedContext = {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  };

  if (notesQ.isPending) return <SkeletonRows count={4} />;
  if (notesQ.isError) {
    return (
      <LoadError
        message={
          notesQ.error instanceof Error
            ? notesQ.error.message
            : 'Failed to load credit notes'
        }
        onRetry={() => void notesQ.refetch()}
      />
    );
  }

  const needle = q.trim().toLowerCase();
  const rows = (notesQ.data ?? []).filter((n) => {
    if (needle === '') return true;
    const d = creditNoteDisplay(n, ctx);
    return (
      d.title.toLowerCase().includes(needle) ||
      n.credit_note_number.toLowerCase().includes(needle)
    );
  });
  const groups = groupByMonth(rows);

  return (
    <div>
      <div className="px-4 pb-3">
        <LinkButton to="/books/credit-notes/new" variant="secondary" className="w-full">
          New credit note
        </LinkButton>
      </div>
      {groups.length === 0 && (
        <EmptyState
          icon="🧾"
          title="No credit notes"
          hint="Issue one from a posted invoice or expense detail"
        />
      )}
      {groups.map((g) => (
        <ListGroup key={g.month} label={g.label}>
          {g.rows.map((n) => {
            const d = creditNoteDisplay(n, ctx);
            return (
              <ListRow
                key={n.id}
                to={`/books/credit-notes/${n.id}`}
                title={d.title}
                subtitle={d.subtitle}
                trailing={
                  <div className="flex-none">
                    <AmountText
                      cents={creditNoteSign(n)}
                      showSign
                      className="block text-[14px]"
                    />
                    <div className="mt-0.5">{statusChip(n.status)}</div>
                  </div>
                }
              />
            );
          })}
        </ListGroup>
      ))}
    </div>
  );
}
```

`src/books/CreditNoteScreen.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { absoluteDateFromIso } from '../inbox/format';
import { useCreditNoteDetail } from '../queries/books';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { AmountText } from '../ui/AmountText';
import { SkeletonRows } from '../ui/Feedback';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { statusChip } from './chips';
import { creditNoteDisplay, creditNoteSign } from './CreditNotesSegment';

export function CreditNoteScreen() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const noteQ = useCreditNoteDetail(id);
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();

  if (noteQ.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Credit note" backTo="/books?seg=credit-notes" />
        <LoadError
          message={
            noteQ.error instanceof Error
              ? noteQ.error.message
              : 'Failed to load the credit note'
          }
          onRetry={() => void noteQ.refetch()}
        />
      </div>
    );
  }
  if (noteQ.data === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Credit note" backTo="/books?seg=credit-notes" />
        <SkeletonRows count={3} />
      </div>
    );
  }

  const n = noteQ.data;
  const d = creditNoteDisplay(n, {
    expenses: expensesQ.data ?? [],
    invoices: invoicesQ.data ?? [],
    entities: entitiesQ.data ?? [],
  });

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Credit note" backTo="/books?seg=credit-notes" />
      <div className="px-5 pb-4 pt-1 text-center">
        <AmountText
          cents={creditNoteSign(n)}
          currency={n.currency}
          showSign
          className="text-[30px]"
        />
        <p className="mt-1 text-[14px] text-ink-2">
          {n.credit_note_number}{' '}
          <span className="align-[2px]">{statusChip(n.status)}</span>
        </p>
      </div>
      <ListGroup label="Facts">
        <KeyValue k="Number" v={n.credit_note_number} />
        <KeyValue k="VAT" v={`${(n.vat_amount / 100).toFixed(2)} €`} />
        <KeyValue k="Tax point" v={absoluteDateFromIso(n.tax_point_date)} />
      </ListGroup>
      <ListGroup label="Credits">
        {d.objectRoute != null ? (
          <ListRow
            to={d.objectRoute}
            title={
              n.credits_object_type === 'sales_invoice'
                ? `Invoice ${
                    (invoicesQ.data ?? []).find((i) => i.id === n.credits_object_id)
                      ?.invoice_number ?? ''
                  }`.trim()
                : 'Expense'
            }
            subtitle={d.title}
          />
        ) : (
          <ListRow
            title="Credited object"
            subtitle="Not in the current lists — it may have been deleted"
          />
        )}
      </ListGroup>
      <p className="px-5 text-center text-[12.5px] text-ink-2">
        The credited document stays posted — a credit note offsets it, it does
        not rewrite it.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/CreditNotesSegment.test.tsx && npm test
```

Expected: PASS (2 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): credit-notes segment + detail — object-linked rows in business terms, direction-signed amounts"
```

---

### Task 9: CreditNoteCreateScreen — object PICKER with context, EUROS (the cent bug dies here)

**Files:**
- Create: `packages/web/src/books/CreditNoteCreateScreen.tsx`
- Test: `packages/web/src/books/CreditNoteCreateScreen.test.tsx` (new)

**Interfaces:**
- Consumes: `createCreditNote` (cents on the wire — Reality #6), `useCreditNotes` + `remainingCreditable` (client mirror of the server cap), `useExpenses`/`useInvoices`/`useEntities` (picker candidates: POSTED objects only — the server 400s anything else), `eurosToCents`, `vatFromGross` + `STANDARD_VAT_RATE_PCT` (VAT prefill, editable), `invalidateBooks`, kit (`ScreenHeader`, `SearchInput`, `Field`/`TextInput`, `Button`, toasts).
- Produces: `CreditNoteCreateScreen()` for `/books/credit-notes/new` — data rule 8 ("object selection is never ID entry"): a searchable picker of posted invoices + expenses, each row showing **number/category · counterparty · amount · outstanding** (outstanding = `remainingCreditable`); `?type=&id=` preselects (arriving from a detail or the Correct sheet skips the picker but keeps it changeable); form: credit-note number, gross €, VAT € (auto at 22% while untouched — same convention as Plans 02/03), tax point date (default: the credited object's `tax_point_date`); validation: number non-empty, gross parses > 0 and ≤ outstanding (server stays authority), VAT parses ≥ 0; primary label `Issue credit note · −X €` (`+X €` when crediting an expense); receipt → invalidate → navigate to the created note's detail.

- [ ] **Step 1: Write failing tests**

`src/books/CreditNoteCreateScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { CreditNoteCreateScreen } from './CreditNoteCreateScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  createCreditNote: vi.fn(),
  listCreditNotes: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  createCreditNote,
  getEntities,
  getExpenses,
  getInvoices,
  listCreditNotes,
} from '../api';

function seed() {
  vi.mocked(listCreditNotes).mockResolvedValue([
    { id: 1, credit_note_number: 'CN-0', status: 'posted', gross_amount: 20000, vat_amount: 0, currency: 'EUR', tax_point_date: '2026-06-01', created_at: 1, credits_object_type: 'sales_invoice', credits_object_id: 3 },
  ] as never);
  vi.mocked(getInvoices).mockResolvedValue([
    { id: 3, customer_id: 7, invoice_number: '2026-018', gross_amount: 120000, vat_amount: 21639, currency: 'EUR', tax_point_date: '2026-07-04', due_date: null, document_id: null, status: 'posted', sent_at: null, reconciled: false },
    { id: 4, customer_id: 7, invoice_number: '2026-019', gross_amount: 5000, vat_amount: 0, currency: 'EUR', tax_point_date: '2026-07-05', due_date: null, document_id: null, status: 'draft', sent_at: null, reconciled: false },
  ] as never);
  vi.mocked(getExpenses).mockResolvedValue([
    { id: 12, supplier_id: 9, category: 'rent', gross_amount: 65000, vat_amount: 11721, currency: 'EUR', tax_point_date: '2026-06-25', status: 'posted', reconciled: false },
  ] as never);
  vi.mocked(getEntities).mockResolvedValue([
    { id: 7, role: 'customer', country: 'EE', name: 'Nordic Consulting OÜ', goods_vs_services: null },
    { id: 9, role: 'supplier', country: 'EE', name: 'AS Merko Ehitus', goods_vs_services: null },
  ] as never);
}

function mount(url = '/books/credit-notes/new') {
  seed();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <AppToaster />
        <Routes>
          <Route path="/books/credit-notes/new" element={<CreditNoteCreateScreen />} />
          <Route path="/books/credit-notes/:id" element={<div>NOTE DETAIL</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CreditNoteCreateScreen', () => {
  it('the picker lists POSTED objects with number · counterparty · amount · outstanding (never an ID input)', async () => {
    mount();
    // Posted invoice with prior CN-0 (200 €) already credited:
    expect(
      await screen.findByText(/2026-018 · Nordic Consulting OÜ/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1200\.00 € · 1000\.00 € outstanding/)).toBeInTheDocument();
    // Posted expense present, draft invoice absent:
    expect(screen.getByText(/rent · AS Merko Ehitus/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-019/)).toBeNull();
    // No raw ID entry anywhere:
    expect(screen.queryByLabelText(/object id/i)).toBeNull();
  });

  it('?type=&id= preselects the object and the form submits CENTS from euro inputs', async () => {
    vi.mocked(createCreditNote).mockResolvedValue({ id: 8 } as never);
    mount('/books/credit-notes/new?type=sales_invoice&id=3');
    // Preselected summary visible:
    expect(await screen.findByText(/2026-018 · Nordic Consulting OÜ/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Credit note number'), 'CN-2');
    await userEvent.type(screen.getByLabelText('Gross (€)'), '120,00');
    // VAT auto-derived at 22% while untouched → 21.64; submit states outcome:
    await userEvent.click(
      await screen.findByRole('button', { name: 'Issue credit note · −120.00 €' }),
    );
    await waitFor(() =>
      expect(createCreditNote).toHaveBeenCalledWith({
        credits_object_type: 'sales_invoice',
        credits_object_id: 3,
        credit_note_number: 'CN-2',
        gross_amount: 12000,
        vat_amount: 2164,
        tax_point_date: '2026-07-04',
      }),
    );
    expect(await screen.findByText('NOTE DETAIL')).toBeInTheDocument();
  });

  it('over-crediting is blocked up front with the outstanding amount in the error', async () => {
    mount('/books/credit-notes/new?type=sales_invoice&id=3');
    await screen.findByText(/2026-018/);
    await userEvent.type(screen.getByLabelText('Credit note number'), 'CN-3');
    await userEvent.type(screen.getByLabelText('Gross (€)'), '1500');
    expect(
      await screen.findByText(/only 1000\.00 € remains creditable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Issue credit note/ }),
    ).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/CreditNoteCreateScreen.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/books/CreditNoteCreateScreen.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createCreditNote } from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import {
  entityName,
  invalidateBooks,
  remainingCreditable,
  shortDate,
  useCreditNotes,
} from '../queries/books';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Feedback';
import { Field, TextInput } from '../ui/Form';
import { ListGroup, ListRow } from '../ui/List';
import { SearchInput } from '../ui/SearchInput';
import { toastErr, toastOk } from '../ui/toast';

interface Candidate {
  type: 'sales_invoice' | 'expense';
  id: number;
  label: string;        // '2026-018 · Nordic Consulting OÜ'
  grossCents: number;
  outstandingCents: number;
  taxPointDate: string;
}

/** /books/credit-notes/new — data rule 8: a searchable PICKER over posted
 *  objects with full context; raw IDs are never typed. Euros in, cents on
 *  the wire (the legacy cent bug ends here). */
export function CreditNoteCreateScreen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const notesQ = useCreditNotes();
  const invoicesQ = useInvoices();
  const expensesQ = useExpenses();
  const entitiesQ = useEntities();

  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<{
    type: 'sales_invoice' | 'expense';
    id: number;
  } | null>(() => {
    const type = params.get('type');
    const id = Number(params.get('id'));
    return (type === 'sales_invoice' || type === 'expense') && Number.isInteger(id) && id > 0
      ? { type, id }
      : null;
  });
  const [number, setNumber] = useState('');
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);

  const loading =
    notesQ.isPending || invoicesQ.isPending || expensesQ.isPending;
  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="New credit note" backTo="/books?seg=credit-notes" />
        <SkeletonRows count={4} />
      </div>
    );
  }

  const notes = notesQ.data ?? [];
  const entities = entitiesQ.data ?? [];
  const candidates: Candidate[] = [
    ...(invoicesQ.data ?? [])
      .filter((i) => i.status === 'posted')
      .map((i) => ({
        type: 'sales_invoice' as const,
        id: i.id,
        label: `${i.invoice_number} · ${entityName(entities, i.customer_id) ?? 'no customer'}`,
        grossCents: i.gross_amount,
        outstandingCents: remainingCreditable(i.gross_amount, notes, 'sales_invoice', i.id),
        taxPointDate: i.tax_point_date,
      })),
    ...(expensesQ.data ?? [])
      .filter((e) => e.status === 'posted')
      .map((e) => ({
        type: 'expense' as const,
        id: e.id,
        label: `${e.category} · ${entityName(entities, e.supplier_id) ?? 'no supplier'}`,
        grossCents: e.gross_amount,
        outstandingCents: remainingCreditable(e.gross_amount, notes, 'expense', e.id),
        taxPointDate: e.tax_point_date,
      })),
  ];
  const selected =
    picked === null
      ? null
      : (candidates.find((c) => c.type === picked.type && c.id === picked.id) ?? null);

  const needle = search.trim().toLowerCase();
  const visible = candidates.filter(
    (c) => needle === '' || c.label.toLowerCase().includes(needle),
  );

  const grossParsed = eurosToCents(gross);
  const vatAuto =
    grossParsed !== null && grossParsed > 0
      ? vatFromGross(grossParsed, STANDARD_VAT_RATE_PCT)
      : null;
  const vatEffective = vatTouched ? eurosToCents(vat) : vatAuto;
  const overCap =
    selected !== null && grossParsed !== null && grossParsed > selected.outstandingCents;
  const valid =
    selected !== null &&
    number.trim() !== '' &&
    grossParsed !== null &&
    grossParsed > 0 &&
    !overCap &&
    vatEffective !== null &&
    vatEffective >= 0;
  const sign = selected?.type === 'expense' ? '+' : '−';

  const submit = async () => {
    if (!valid || selected === null) return;
    setBusy(true);
    try {
      const created = await createCreditNote({
        credits_object_type: selected.type,
        credits_object_id: selected.id,
        credit_note_number: number.trim(),
        gross_amount: grossParsed as number,
        vat_amount: vatEffective as number,
        tax_point_date: date !== '' ? date : selected.taxPointDate,
      });
      await invalidateBooks(qc);
      toastOk(`Credit note issued · ${sign}${centsToEuroInput(grossParsed as number)} €`);
      navigate(`/books/credit-notes/${created.id}`, { replace: true });
    } catch (e) {
      // Server cap/state errors carry the remaining amount — show verbatim.
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="New credit note" backTo="/books?seg=credit-notes" />

      <ListGroup label={selected === null ? 'Credit what?' : 'Crediting'}>
        {selected !== null ? (
          <ListRow
            onClick={() => setPicked(null)}
            title={selected.label}
            subtitle={`${centsToEuroInput(selected.grossCents)} € · ${centsToEuroInput(selected.outstandingCents)} € outstanding · tap to change`}
          />
        ) : (
          <div className="px-3.5 py-2.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Number, counterparty, category…"
            />
          </div>
        )}
        {selected === null &&
          visible.map((c) => (
            <ListRow
              key={`${c.type}-${c.id}`}
              onClick={() => setPicked({ type: c.type, id: c.id })}
              title={c.label}
              subtitle={`${shortDate(c.taxPointDate)} · ${centsToEuroInput(c.grossCents)} € · ${centsToEuroInput(c.outstandingCents)} € outstanding`}
            />
          ))}
        {selected === null && visible.length === 0 && (
          <ListRow
            title="Nothing creditable"
            subtitle="Only posted invoices and expenses can be credited"
          />
        )}
      </ListGroup>

      {selected !== null && (
        <div className="space-y-3 px-5">
          <Field label="Credit note number">
            <TextInput value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <Field
            label="Gross (€)"
            error={
              overCap && selected !== null
                ? `Only ${centsToEuroInput(selected.outstandingCents)} € remains creditable on this document`
                : null
            }
          >
            <TextInput
              inputMode="decimal"
              value={gross}
              onChange={(e) => setGross(e.target.value)}
            />
          </Field>
          <Field
            label="VAT (€)"
            hint={
              vatTouched
                ? undefined
                : `Auto at ${STANDARD_VAT_RATE_PCT}% — edit if the document says otherwise`
            }
          >
            <TextInput
              inputMode="decimal"
              value={vatTouched ? vat : vatAuto !== null ? centsToEuroInput(vatAuto) : ''}
              onChange={(e) => {
                setVatTouched(true);
                setVat(e.target.value);
              }}
            />
          </Field>
          <Field
            label="Tax point date"
            hint="Defaults to the credited document's date; a locked-period date is redirected server-side (ADR-0009)"
          >
            <TextInput
              type="date"
              value={date !== '' ? date : selected.taxPointDate}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Button
            className="w-full"
            busy={busy}
            disabled={!valid}
            onClick={() => void submit()}
          >
            {grossParsed !== null && grossParsed > 0
              ? `Issue credit note · ${sign}${centsToEuroInput(grossParsed)} €`
              : 'Issue credit note'}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/CreditNoteCreateScreen.test.tsx && npm test
```

Expected: PASS (3 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): credit-note create — searchable object picker with outstanding context, euros in (cent bug fixed)"
```

---
### Task 10: DocumentsSegment + DocThumb — archive rows with thumbnails, channels, real status filters

**Files:**
- Create: `packages/web/src/books/DocThumb.tsx`, `packages/web/src/books/DocumentsSegment.tsx`
- Test: `packages/web/src/books/DocumentsSegment.test.tsx` (new)

**Interfaces:**
- Consumes: `useDocumentsArchive` (Task 2), `fetchDocumentPreviewObjectUrl` (blob-URL choreography identical to `inbox/DocPreviewRow.tsx` — bearer-only endpoint, revoke on unmount), `relativeTime`, `triageChipLabel` (`inbox/reason.ts` — the ONE surviving reason_type→label mapping; `reasonBadge.ts` dies in Task 14), kit.
- Produces:
  - `DocThumb({ id })` — 36×48 thumbnail `<img>` from a blob URL with 📄 fallback; StrictMode-safe cleanup (copied choreography, smaller frame).
  - `channelLabel(channel)` — human channel names (capability parity with `DocumentsView.channelLabel`): `💬 telegram`, `✉ email` (all three email channels), `☁ drive`, `📷 iOS`, `⬆ upload`, fallback `—`.
  - `DocumentsSegment({ q })` — rows: title = `supplier_name` (filename only while unrecognized — asset §9+ rule), subtitle = `filename · channel · 2h ago` (+ `Claimant: X` when present), chip = document status (+ reason chip for `needs_triage`), trailing = relative time; filter chips over the REAL statuses `All / Needs triage / In intake / Processed / Errors` in `?dstatus=` (**no Discarded chip — the status does not exist server-side, Reality #7**); `?q=` searches filename + supplier; rows navigate to `/books/documents/:id`.
  - "In intake" covers `pending` + `triaged` (both are mid-pipeline).

- [ ] **Step 1: Write failing tests**

`src/books/DocumentsSegment.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DocumentsSegment } from './DocumentsSegment';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getDocuments: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn().mockResolvedValue('blob:x'),
}));
import { getDocuments } from '../api';

const DOCS = [
  { id: 9, filename: 'arve-183.pdf', mime_type: 'application/pdf', size_bytes: 1000, status: 'processed', processing_since: null, created_at: 1751500000, preview_path: 'p', channel: 'email', reason: null, reason_type: null, expense_id: 12, supplier_name: 'AS Merko Ehitus', claimant_name: null, expense_status: 'posted' },
  { id: 10, filename: 'weird.jpg', mime_type: 'image/jpeg', size_bytes: 500, status: 'needs_triage', processing_since: null, created_at: 1751510000, preview_path: null, channel: 'telegram', reason: 'Unknown supplier', reason_type: 'supplier_unresolved', expense_id: null, supplier_name: null, claimant_name: 'Mari Maasikas', expense_status: null },
];

function mount(q = '', url = '/books?seg=documents') {
  vi.mocked(getDocuments).mockResolvedValue(DOCS as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <DocumentsSegment q={q} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentsSegment', () => {
  it('titles rows by supplier (filename only while unrecognized), shows channel + claimant, links the detail', async () => {
    mount();
    expect(await screen.findByText('AS Merko Ehitus')).toBeInTheDocument();
    expect(screen.getByText(/arve-183\.pdf · ✉ email/)).toBeInTheDocument();
    // Unrecognized document falls back to its filename as the title:
    expect(screen.getByText('weird.jpg')).toBeInTheDocument();
    expect(screen.getByText(/Claimant: Mari Maasikas/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /AS Merko Ehitus/ }),
    ).toHaveAttribute('href', '/books/documents/9');
  });

  it('offers the REAL status filters only — no fake Discarded chip', async () => {
    mount();
    await screen.findByText('AS Merko Ehitus');
    expect(screen.getByRole('button', { name: /Needs triage 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Processed 1/ })).toBeInTheDocument();
    expect(screen.queryByText(/Discarded/)).toBeNull();
  });

  it('?dstatus=needs_triage filters the list', async () => {
    mount('', '/books?seg=documents&dstatus=needs_triage');
    expect(await screen.findByText('weird.jpg')).toBeInTheDocument();
    expect(screen.queryByText('AS Merko Ehitus')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/DocumentsSegment.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/books/DocThumb.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { fetchDocumentPreviewObjectUrl } from '../api';

/** Archive-row thumbnail: bearer-only /preview bytes → blob URL, revoked on
 *  unmount (same choreography as inbox/DocPreviewRow — StrictMode-safe). */
export function DocThumb({ id }: { id: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetchDocumentPreviewObjectUrl(id)
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
  }, [id]);

  return src !== null ? (
    <img
      src={src}
      alt=""
      className="h-12 w-9 rounded-md border border-line object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex h-12 w-9 items-center justify-center rounded-md bg-line text-base"
    >
      📄
    </span>
  );
}
```

`src/books/DocumentsSegment.tsx`:

```tsx
import { useSearchParams } from 'react-router-dom';
import type { DocumentArchiveRow } from '../api';
import { triageChipLabel } from '../inbox/reason';
import { useDocumentsArchive } from '../queries/books';
import { relativeTime } from '../relativeTime';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { DocThumb } from './DocThumb';

export function channelLabel(channel: string | null): string {
  switch (channel) {
    case 'telegram':
      return '💬 telegram';
    case 'email':
    case 'email_sync':
    case 'email_push':
      return '✉ email';
    case 'drive':
      return '☁ drive';
    case 'ios_photo_library':
      return '📷 iOS';
    case 'upload':
      return '⬆ upload';
    default:
      return channel ?? '—';
  }
}

/** REAL document statuses only (documents/types.ts:18-23). ADR-0038's
 *  `discarded` is not implemented server-side — no fake chip (Reality #7). */
type DocFilter = 'all' | 'needs_triage' | 'intake' | 'processed' | 'error';
const DOC_FILTERS: readonly { key: DocFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs_triage', label: 'Needs triage' },
  { key: 'intake', label: 'In intake' },
  { key: 'processed', label: 'Processed' },
  { key: 'error', label: 'Errors' },
];

const matchesDocFilter = (d: DocumentArchiveRow, f: DocFilter): boolean => {
  if (f === 'all') return true;
  if (f === 'intake') return d.status === 'pending' || d.status === 'triaged';
  return d.status === f;
};

function docStatusChip(d: DocumentArchiveRow) {
  switch (d.status) {
    case 'processed':
      return <Chip tone="ok">processed</Chip>;
    case 'needs_triage':
      return <Chip tone="warn">{triageChipLabel(d.reason_type)}</Chip>;
    case 'error':
      return <Chip tone="err">error</Chip>;
    default:
      return <Chip tone="muted">{d.status === 'pending' || d.status === 'triaged' ? 'in intake' : d.status}</Chip>;
  }
}

export function DocumentsSegment({ q }: { q: string }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('dstatus');
  const filter: DocFilter = DOC_FILTERS.some((f) => f.key === raw)
    ? (raw as DocFilter)
    : 'all';
  const docsQ = useDocumentsArchive();

  if (docsQ.isPending) return <SkeletonRows count={5} />;
  if (docsQ.isError) {
    return (
      <LoadError
        message={
          docsQ.error instanceof Error
            ? docsQ.error.message
            : 'Failed to load documents'
        }
        onRetry={() => void docsQ.refetch()}
      />
    );
  }

  const needle = q.trim().toLowerCase();
  const searched = (docsQ.data ?? []).filter(
    (d) =>
      needle === '' ||
      d.filename.toLowerCase().includes(needle) ||
      (d.supplier_name ?? '').toLowerCase().includes(needle),
  );
  const rows = searched
    .filter((d) => matchesDocFilter(d, filter))
    .sort((a, b) => b.created_at - a.created_at);

  return (
    <div>
      <div className="flex gap-1.5 overflow-x-auto px-4 pb-2.5">
        {DOC_FILTERS.map((f) => {
          const count = searched.filter((d) => matchesDocFilter(d, f.key)).length;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                const next = new URLSearchParams(params);
                if (f.key === 'all') next.delete('dstatus');
                else next.set('dstatus', f.key);
                setParams(next, { replace: true });
              }}
              className={`flex-none whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${
                f.key === filter ? 'bg-accent text-white' : 'bg-surface text-ink-2'
              }`}
            >
              {f.key === 'all' ? f.label : `${f.label} ${count}`}
            </button>
          );
        })}
      </div>
      {rows.length === 0 && (
        <EmptyState
          icon="🗂"
          title="No documents match"
          hint="Upload one with + or adjust the filter"
        />
      )}
      {rows.length > 0 && (
        <ListGroup>
          {rows.map((d) => {
            const subtitleParts = [
              // Filename moves to the subtitle once the supplier is known.
              ...(d.supplier_name != null ? [d.filename] : []),
              channelLabel(d.channel),
              relativeTime(d.created_at),
              ...(d.claimant_name != null ? [`Claimant: ${d.claimant_name}`] : []),
            ];
            return (
              <ListRow
                key={d.id}
                to={`/books/documents/${d.id}`}
                leading={<DocThumb id={d.id} />}
                title={d.supplier_name ?? d.filename}
                subtitle={subtitleParts.join(' · ')}
                chip={docStatusChip(d)}
              />
            );
          })}
        </ListGroup>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/DocumentsSegment.test.tsx && npm test
```

Expected: PASS (3 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): documents segment — thumb rows, channels, honest status filters (no fake discarded)"
```

---

### Task 11: DocumentScreen — detail from persisted artifacts, linked-expense navigation, guarded delete

**Files:**
- Create: `packages/web/src/books/DocumentScreen.tsx`
- Test: `packages/web/src/books/DocumentScreen.test.tsx` (new)

**Interfaces:**
- Consumes: `useDocumentsArchive` (the row: filename/channel/claimant/linkage/status), `useDocDetails` (persisted OCR + classification ONLY — ADR-0039, Reality; the reclassify endpoint is never called here), `openSignedDocument` (the FIXED opener — Plan 03 Task 16), `copyDocumentShareLink` (+ success toast — the legacy silent copy becomes a receipt), `retryDocument`, `deleteDocument`, `DocPreviewRow`, `channelLabel` (Task 10), `absoluteDate`, kit.
- Produces: `DocumentScreen()` for `/books/documents/:id` —
  - Preview row (tap → signed open in a new tab), actions: **Copy link** (receipt toast "Link copied — valid ~1 hour"), **Retry AI** (needs_triage only), **Resolve in Inbox** (`LinkButton` → `/inbox/doc/:id`, needs_triage only).
  - Facts KV: filename, channel, added (absolute), size, claimant.
  - **Linked expense row → `/books/expenses/:id`** with the expense status chip — the legacy `#expense-N` dead anchor becomes a real navigation (data rule 2).
  - Details: classification facts KV + OCR markdown in a collapsible, straight from `getDocumentDetails`; loading/error states explicit.
  - **Delete**: hidden entirely when the linked expense is `posted`/`reversed` — replaced by an explanation row mirroring the server guard ("evidence for a posted expense — correct/reverse the expense first", Reality #8/ADR-0012); otherwise ConfirmDialog → `deleteDocument` → receipt → navigate to the archive; a racing 409's server text surfaces verbatim.

- [ ] **Step 1: Write failing tests**

`src/books/DocumentScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { DocumentScreen } from './DocumentScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getDocuments: vi.fn(),
  getDocumentDetails: vi.fn(),
  fetchDocumentPreviewObjectUrl: vi.fn().mockResolvedValue('blob:x'),
  copyDocumentShareLink: vi.fn(),
  retryDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));
import {
  copyDocumentShareLink,
  deleteDocument,
  getDocumentDetails,
  getDocuments,
} from '../api';

const ROW = {
  id: 9, filename: 'arve-183.pdf', mime_type: 'application/pdf', size_bytes: 34816,
  status: 'processed', processing_since: null, created_at: 1751500000, preview_path: 'p',
  channel: 'email', reason: null, reason_type: null, expense_id: 12,
  supplier_name: 'AS Merko Ehitus', claimant_name: null, expense_status: 'posted',
};
const DETAILS = {
  document_id: 9,
  ocr: { ok: true, markdown: '# Arve 183' },
  classification: {
    ok: true,
    result: {
      kind: 'purchase_invoice', document_type: 'invoice', gross_amount: 65000,
      vat_amount: 11721, currency: 'EUR', tax_point_date: '2026-06-25',
      category: 'rent', document_vat_marking: null, supplier_invoice_number: 'A-183',
      confidence: 0.96,
    },
  },
};

function mountAt(row: Partial<typeof ROW> = {}) {
  vi.mocked(getDocuments).mockResolvedValue([{ ...ROW, ...row }] as never);
  vi.mocked(getDocumentDetails).mockResolvedValue(DETAILS as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/books/documents/9']}>
        <AppToaster />
        <Routes>
          <Route path="/books/documents/:id" element={<DocumentScreen />} />
          <Route path="/books" element={<div>ARCHIVE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DocumentScreen', () => {
  it('renders facts, persisted classification + OCR, and the REAL expense navigation', async () => {
    mountAt();
    expect(await screen.findByText('arve-183.pdf')).toBeInTheDocument();
    expect(screen.getByText('✉ email')).toBeInTheDocument();
    // Linked expense is a route link, not a dead anchor:
    expect(
      screen.getByRole('link', { name: /AS Merko Ehitus/ }),
    ).toHaveAttribute('href', '/books/expenses/12');
    // Persisted classification facts (ADR-0039 — no reclassify call):
    expect(await screen.findByText('rent')).toBeInTheDocument();
    expect(screen.getByText('650.00 € (VAT 117.21 €)')).toBeInTheDocument();
    // OCR collapsible:
    await userEvent.click(screen.getByText(/OCR text/));
    expect(screen.getByText('# Arve 183')).toBeInTheDocument();
  });

  it('Copy link gives a success receipt', async () => {
    vi.mocked(copyDocumentShareLink).mockResolvedValue(undefined);
    mountAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Copy link' }),
    );
    await waitFor(() => expect(copyDocumentShareLink).toHaveBeenCalledWith(9));
    expect(
      await screen.findByText(/Link copied — valid ~1 hour/),
    ).toBeInTheDocument();
  });

  it('delete is REPLACED by the guard explanation when the linked expense is posted', async () => {
    mountAt();
    await screen.findByText('arve-183.pdf');
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(
      screen.getByText(/evidence for a posted expense/i),
    ).toBeInTheDocument();
  });

  it('deletable documents go plan→confirm→receipt→archive', async () => {
    vi.mocked(deleteDocument).mockResolvedValue({ deleted: 9 } as never);
    mountAt({ expense_id: null, supplier_name: null, expense_status: null });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete document…' }),
    );
    expect(deleteDocument).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith(9));
    expect(await screen.findByText('ARCHIVE')).toBeInTheDocument();
  });

  it('needs_triage documents offer Retry AI and Resolve in Inbox', async () => {
    mountAt({ status: 'needs_triage', reason: 'Unknown supplier', reason_type: 'supplier_unresolved', expense_id: null, expense_status: null });
    expect(
      await screen.findByRole('button', { name: 'Retry AI' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Resolve in Inbox' }),
    ).toHaveAttribute('href', '/inbox/doc/9');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/DocumentScreen.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/books/DocumentScreen.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  copyDocumentShareLink,
  deleteDocument,
  retryDocument,
  type DocumentDetails,
} from '../api';
import { DocPreviewRow } from '../inbox/DocPreviewRow';
import { absoluteDate, absoluteDateFromIso } from '../inbox/format';
import { triageSubtitle } from '../inbox/reason';
import {
  invalidateBooks,
  useDocDetails,
  useDocumentsArchive,
} from '../queries/books';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { LinkButton } from '../ui/LinkButton';
import { KeyValue, ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr, toastOk } from '../ui/toast';
import { channelLabel } from './DocumentsSegment';
import { statusChip } from './chips';

function ClassificationFacts({ details }: { details: DocumentDetails }) {
  if (details.classification === null) {
    return (
      <p className="px-3.5 py-2.5 text-[13px] text-ink-2">
        No classification — OCR produced no text.
      </p>
    );
  }
  if (!details.classification.ok) {
    return (
      <p className="px-3.5 py-2.5 text-[13px] text-err">
        Classification failed ({details.classification.category}):{' '}
        {details.classification.detail}
      </p>
    );
  }
  const r = details.classification.result;
  return (
    <>
      <KeyValue k="Recognized as" v={r.document_type} />
      <KeyValue k="Category" v={r.category} />
      <KeyValue
        k="Amount"
        v={`${(r.gross_amount / 100).toFixed(2)} € (VAT ${(r.vat_amount / 100).toFixed(2)} €)`}
      />
      <KeyValue k="Tax point" v={absoluteDateFromIso(r.tax_point_date)} />
      {r.supplier_invoice_number != null && (
        <KeyValue k="Invoice no." v={r.supplier_invoice_number} />
      )}
      <KeyValue k="AI confidence" v={r.confidence.toFixed(2)} />
    </>
  );
}

/** /books/documents/:id — everything rendered from PERSISTED intake
 *  artifacts (ADR-0039); AI re-runs only via the explicit Retry. */
export function DocumentScreen() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const docsQ = useDocumentsArchive();
  const detailsQ = useDocDetails(id);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  if (docsQ.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Document" backTo="/books?seg=documents" />
        <LoadError
          message={
            docsQ.error instanceof Error
              ? docsQ.error.message
              : 'Failed to load documents'
          }
          onRetry={() => void docsQ.refetch()}
        />
      </div>
    );
  }
  if (docsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Document" backTo="/books?seg=documents" />
        <SkeletonRows count={4} />
      </div>
    );
  }
  const doc = (docsQ.data ?? []).find((d) => d.id === id);
  if (doc === undefined) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Document" backTo="/books?seg=documents" />
        <EmptyState icon="🤷" title="Document not found" hint="It may have been deleted." />
      </div>
    );
  }

  // Server guard mirror (Reality #8, ADR-0012): the document is evidence.
  const deleteLocked =
    doc.expense_status === 'posted' || doc.expense_status === 'reversed';

  const onCopyLink = async () => {
    try {
      await copyDocumentShareLink(doc.id);
      toastOk('Link copied — valid ~1 hour');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onRetry = async () => {
    setBusy(true);
    try {
      await retryDocument(doc.id);
      await invalidateBooks(qc);
      toastOk('Queued for a fresh AI run — the outcome lands in the Inbox');
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setBusy(true);
    try {
      await deleteDocument(doc.id);
      await invalidateBooks(qc);
      toastOk('Document deleted');
      navigate('/books?seg=documents', { replace: true });
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e)); // 409 text verbatim
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader title="Document" backTo="/books?seg=documents" />

      <DocPreviewRow documentId={doc.id} subtitle={doc.filename} />

      <div className="flex gap-2 px-5 pb-3">
        <Button variant="secondary" className="flex-1" onClick={() => void onCopyLink()}>
          Copy link
        </Button>
        {doc.status === 'needs_triage' && (
          <Button variant="secondary" className="flex-1" busy={busy} onClick={() => void onRetry()}>
            Retry AI
          </Button>
        )}
      </div>

      {doc.status === 'needs_triage' && (
        <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg px-4 py-3">
          <p className="text-[13px] font-semibold text-warn">
            {triageSubtitle({ reason: doc.reason ?? '', reason_type: doc.reason_type ?? 'unknown' })}
          </p>
          <LinkButton to={`/inbox/doc/${doc.id}`} className="mt-2 w-full">
            Resolve in Inbox
          </LinkButton>
        </div>
      )}

      <ListGroup label="Facts">
        <KeyValue k="Filename" v={doc.filename} />
        <KeyValue k="Channel" v={channelLabel(doc.channel)} />
        <KeyValue k="Added" v={absoluteDate(doc.created_at)} />
        <KeyValue k="Size" v={`${Math.max(1, Math.round(doc.size_bytes / 1024))} KB`} />
        {doc.claimant_name != null && <KeyValue k="Paid by" v={doc.claimant_name} />}
      </ListGroup>

      {doc.expense_id != null && (
        <ListGroup label="Created from this document">
          <ListRow
            to={`/books/expenses/${doc.expense_id}`}
            leading={<span aria-hidden>🧾</span>}
            title={doc.supplier_name ?? 'Expense'}
            subtitle="Open the expense"
            trailing={doc.expense_status != null ? statusChip(doc.expense_status) : undefined}
          />
        </ListGroup>
      )}

      <ListGroup label="AI reading (persisted — never re-run here)">
        {detailsQ.isPending && (
          <p className="px-3.5 py-2.5 text-[13px] text-ink-2">Loading…</p>
        )}
        {detailsQ.isError && (
          <p className="px-3.5 py-2.5 text-[13px] text-err">
            {detailsQ.error instanceof Error
              ? detailsQ.error.message
              : 'Failed to load details'}
          </p>
        )}
        {detailsQ.data !== undefined && (
          <>
            <ClassificationFacts details={detailsQ.data} />
            <details className="border-t border-line px-3.5 py-2.5">
              <summary className="cursor-pointer text-[13px] font-semibold">
                OCR text
              </summary>
              {detailsQ.data.ocr.ok ? (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                  {detailsQ.data.ocr.markdown}
                </pre>
              ) : (
                <p className="mt-2 text-[13px] text-err">
                  OCR failed ({detailsQ.data.ocr.category}): {detailsQ.data.ocr.detail}
                </p>
              )}
            </details>
          </>
        )}
      </ListGroup>

      <div className="space-y-2 px-5 pt-2">
        {deleteLocked ? (
          <p className="text-center text-[12.5px] text-ink-2">
            This document is evidence for a posted expense — correct or reverse
            the expense first (ADR-0012).
          </p>
        ) : (
          <Button
            variant="danger"
            className="w-full"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete document…
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this document?"
        body="The file and its AI reading are removed permanently. Chat threads that delivered it keep their history."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/DocumentScreen.test.tsx && npm test
```

Expected: PASS (5 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): document detail — persisted artifacts, real expense link, copy receipt, guarded delete"
```

---
### Task 12: Create flows — "+" menu, NewExpenseSheet, NewInvoiceSheet, UploadSheet with claimant dropdown

**Files:**
- Create: `packages/web/src/books/create.tsx`
- Test: `packages/web/src/books/create.test.tsx` (new)

**Interfaces:**
- Consumes: `createExpense`/`createInvoice` (cents), `uploadDocument` (with `claimantId`, Task 1) + `triageDocument` + `outcomeText` (`inbox/reason.ts` — same upload choreography as InboxScreen's UploadAction, extended per ADR-0036), `useCategories`/`useSuppliers`/`useCustomers`/`useEntities`, `eurosToCents`/`vatFromGross`/`STANDARD_VAT_RATE_PCT`, `invalidateBooks`, kit (`Sheet`, `Field`/`TextInput`/`SelectInput`, `Button`, toasts).
- Produces (all from `src/books/create.tsx`):
  - `CreateMenu({ open, onOpenChange, onPick })` — three `ListRow`s: New expense / New invoice / Upload document (the spec's FAB/header-plus flows).
  - `NewExpenseSheet({ open, onOpenChange })` — category (plugin set), optional supplier, gross € (VAT auto at 22% while untouched), tax point date; currency is the constant `'EUR'` (data rule: euro inputs; multi-currency entry stays a non-goal, matching the legacy default). Primary: `Create expense · −X €`. Creates a DRAFT (`POST /api/expenses` does not post) → receipt "Draft created — submit it for posting from the detail" → navigate to `/books/expenses/:id`.
  - `NewInvoiceSheet({ open, onOpenChange })` — invoice number, optional customer, gross €, VAT auto, tax point, optional due date. Primary: `Create invoice · +X €` → navigate to `/books/invoices/:id`.
  - `UploadSheet({ open, onOpenChange })` — file picker + **optional claimant dropdown** (entities with role `employee`/`director` — Reality #10; hidden when none exist) → `uploadDocument(file, { claimantId })` → dedupe notice → `triageDocument` → `outcomeText` receipt → navigate to `/books/documents/:docId`.
- All three sheets reset by REMOUNT: the parent renders them only while open (`{sheet === 'expense' && <NewExpenseSheet …/>}`), so no stale-state discipline is needed beyond that (Plan 03 Task 13 lesson).

- [ ] **Step 1: Write failing tests**

`src/books/create.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { NewExpenseSheet, NewInvoiceSheet, UploadSheet } from './create';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  createExpense: vi.fn(),
  createInvoice: vi.fn(),
  uploadDocument: vi.fn(),
  triageDocument: vi.fn(),
  getCategories: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  createExpense,
  createInvoice,
  getCategories,
  getEntities,
  triageDocument,
  uploadDocument,
} from '../api';

function seed(entities: unknown[] = []) {
  vi.mocked(getCategories).mockResolvedValue([
    { key: 'fuel', label: 'Fuel', accountCode: 'X' },
  ] as never);
  vi.mocked(getEntities).mockResolvedValue(entities as never);
}

function mount(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/books']}>
        <AppToaster />
        <Routes>
          <Route path="/books" element={ui} />
          <Route path="/books/expenses/:id" element={<div>EXP DETAIL</div>} />
          <Route path="/books/invoices/:id" element={<div>INV DETAIL</div>} />
          <Route path="/books/documents/:id" element={<div>DOC DETAIL</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('create flows', () => {
  it('NewExpenseSheet: euros in, VAT auto at 22%, outcome-stating submit, navigates to the draft', async () => {
    seed();
    vi.mocked(createExpense).mockResolvedValue({ id: 31 } as never);
    mount(<NewExpenseSheet open onOpenChange={() => undefined} />);
    await userEvent.selectOptions(await screen.findByLabelText('Category'), 'fuel');
    await userEvent.type(screen.getByLabelText('Gross (€)'), '48,20');
    await userEvent.type(screen.getByLabelText('Tax point date'), '2026-07-01');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create expense · −48.20 €' }),
    );
    await waitFor(() =>
      expect(createExpense).toHaveBeenCalledWith({
        category: 'fuel',
        gross_amount: 4820,
        vat_amount: 869, // 22% inside 48.20
        currency: 'EUR',
        tax_point_date: '2026-07-01',
        supplier_id: null,
      }),
    );
    expect(await screen.findByText('EXP DETAIL')).toBeInTheDocument();
  });

  it('NewInvoiceSheet requires the number and navigates to the draft', async () => {
    seed();
    vi.mocked(createInvoice).mockResolvedValue({ id: 8 } as never);
    mount(<NewInvoiceSheet open onOpenChange={() => undefined} />);
    const submit = await screen.findByRole('button', { name: /Create invoice/ });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Invoice number'), '2026-020');
    await userEvent.type(screen.getByLabelText('Gross (€)'), '500');
    await userEvent.type(screen.getByLabelText('Tax point date'), '2026-07-05');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create invoice · +500.00 €' }),
    );
    await waitFor(() =>
      expect(createInvoice).toHaveBeenCalledWith({
        invoice_number: '2026-020',
        gross_amount: 50000,
        vat_amount: 9016,
        currency: 'EUR',
        tax_point_date: '2026-07-05',
        customer_id: null,
        due_date: null,
      }),
    );
    expect(await screen.findByText('INV DETAIL')).toBeInTheDocument();
  });

  it('UploadSheet sends the claimant and lands on the document detail', async () => {
    seed([
      { id: 5, role: 'employee', country: 'EE', name: 'Mari Maasikas', goods_vs_services: null },
    ]);
    vi.mocked(uploadDocument).mockResolvedValue({
      document: { id: 77 },
      deduplicated: false,
    } as never);
    vi.mocked(triageDocument).mockResolvedValue({
      kind: 'expense',
      document_id: 77,
      expense_id: 31,
    } as never);
    mount(<UploadSheet open onOpenChange={() => undefined} />);
    await userEvent.selectOptions(
      await screen.findByLabelText('Paid by (claimant)'),
      '5',
    );
    const file = new File(['x'], 'r.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('File'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Upload & process' }));
    await waitFor(() =>
      expect(uploadDocument).toHaveBeenCalledWith(file, { claimantId: 5 }),
    );
    await waitFor(() => expect(triageDocument).toHaveBeenCalledWith(77));
    expect(await screen.findByText('DOC DETAIL')).toBeInTheDocument();
  });

  it('UploadSheet hides the claimant dropdown when no employee/director exists', async () => {
    seed([{ id: 6, role: 'supplier', country: 'EE', name: 'X', goods_vs_services: null }]);
    mount(<UploadSheet open onOpenChange={() => undefined} />);
    expect(await screen.findByLabelText('File')).toBeInTheDocument();
    expect(screen.queryByLabelText('Paid by (claimant)')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/create.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/books/create.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createExpense,
  createInvoice,
  triageDocument,
  uploadDocument,
} from '../api';
import { STANDARD_VAT_RATE_PCT } from '../bank/format';
import { outcomeText } from '../inbox/reason';
import { centsToEuroInput, eurosToCents, vatFromGross } from '../lib/money';
import { invalidateBooks } from '../queries/books';
import { useCategories, useCustomers, useEntities, useSuppliers } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { ListGroup, ListRow } from '../ui/List';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

export type CreateKind = 'expense' | 'invoice' | 'upload';

/** Header "+" menu (spec: create flows via FAB/plus). */
export function CreateMenu({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (kind: CreateKind) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add to the books">
      <ListGroup>
        <ListRow
          onClick={() => onPick('upload')}
          leading={<span aria-hidden>📄</span>}
          title="Upload a document"
          subtitle="Receipt, invoice, statement — AI reads it"
        />
        <ListRow
          onClick={() => onPick('expense')}
          leading={<span aria-hidden>🧾</span>}
          title="New expense"
          subtitle="Manual entry, becomes a draft"
        />
        <ListRow
          onClick={() => onPick('invoice')}
          leading={<span aria-hidden>📨</span>}
          title="New sales invoice"
          subtitle="Manual entry, becomes a draft"
        />
      </ListGroup>
    </Sheet>
  );
}

/** Shared euro-amount pair: gross typed, VAT auto at the standard rate until
 *  touched (same convention as Plans 02/03; field stays editable). */
function useMoneyPair() {
  const [gross, setGross] = useState('');
  const [vat, setVat] = useState('');
  const [vatTouched, setVatTouched] = useState(false);
  const grossParsed = eurosToCents(gross);
  const vatAuto =
    grossParsed !== null && grossParsed > 0
      ? vatFromGross(grossParsed, STANDARD_VAT_RATE_PCT)
      : null;
  const vatEffective = vatTouched ? eurosToCents(vat) : vatAuto;
  return {
    gross, setGross, vat, setVat, vatTouched, setVatTouched,
    grossParsed, vatAuto, vatEffective,
  };
}

export function NewExpenseSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const categoriesQ = useCategories();
  const suppliersQ = useSuppliers();
  const [category, setCategory] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [date, setDate] = useState('');
  const m = useMoneyPair();
  const [busy, setBusy] = useState(false);

  const valid =
    category !== '' &&
    date !== '' &&
    m.grossParsed !== null &&
    m.grossParsed > 0 &&
    m.vatEffective !== null &&
    m.vatEffective >= 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const created = await createExpense({
        category,
        gross_amount: m.grossParsed as number,
        vat_amount: m.vatEffective as number,
        currency: 'EUR',
        tax_point_date: date,
        supplier_id: supplierId === '' ? null : Number(supplierId),
      });
      await invalidateBooks(qc);
      toastOk('Draft created — submit it for posting from the detail');
      onOpenChange(false);
      navigate(`/books/expenses/${created.id}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New expense">
      <div className="space-y-3 px-5 pb-2">
        <Field label="Category">
          <SelectInput value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">— select —</option>
            {(categoriesQ.data ?? []).map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Supplier" hint="Optional — unknown suppliers can be resolved later">
          <SelectInput value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">— none —</option>
            {(suppliersQ.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Gross (€)">
          <TextInput inputMode="decimal" value={m.gross} onChange={(e) => m.setGross(e.target.value)} />
        </Field>
        <Field
          label="VAT (€)"
          hint={m.vatTouched ? undefined : `Auto at ${STANDARD_VAT_RATE_PCT}% — edit if the receipt says otherwise`}
        >
          <TextInput
            inputMode="decimal"
            value={m.vatTouched ? m.vat : m.vatAuto !== null ? centsToEuroInput(m.vatAuto) : ''}
            onChange={(e) => {
              m.setVatTouched(true);
              m.setVat(e.target.value);
            }}
          />
        </Field>
        <Field label="Tax point date">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Button className="w-full" busy={busy} disabled={!valid} onClick={() => void submit()}>
          {m.grossParsed !== null && m.grossParsed > 0
            ? `Create expense · −${centsToEuroInput(m.grossParsed)} €`
            : 'Create expense'}
        </Button>
      </div>
    </Sheet>
  );
}

export function NewInvoiceSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const customersQ = useCustomers();
  const [number, setNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const m = useMoneyPair();
  const [busy, setBusy] = useState(false);

  const valid =
    number.trim() !== '' &&
    date !== '' &&
    m.grossParsed !== null &&
    m.grossParsed > 0 &&
    m.vatEffective !== null &&
    m.vatEffective >= 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const created = await createInvoice({
        invoice_number: number.trim(),
        gross_amount: m.grossParsed as number,
        vat_amount: m.vatEffective as number,
        currency: 'EUR',
        tax_point_date: date,
        customer_id: customerId === '' ? null : Number(customerId),
        due_date: dueDate === '' ? null : dueDate,
      });
      await invalidateBooks(qc);
      toastOk('Draft created — submit it for posting from the detail');
      onOpenChange(false);
      navigate(`/books/invoices/${created.id}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New sales invoice">
      <div className="space-y-3 px-5 pb-2">
        <Field label="Invoice number">
          <TextInput value={number} onChange={(e) => setNumber(e.target.value)} />
        </Field>
        <Field label="Customer" hint="Optional">
          <SelectInput value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">— none —</option>
            {(customersQ.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Gross (€)">
          <TextInput inputMode="decimal" value={m.gross} onChange={(e) => m.setGross(e.target.value)} />
        </Field>
        <Field
          label="VAT (€)"
          hint={m.vatTouched ? undefined : `Auto at ${STANDARD_VAT_RATE_PCT}% — edit if needed`}
        >
          <TextInput
            inputMode="decimal"
            value={m.vatTouched ? m.vat : m.vatAuto !== null ? centsToEuroInput(m.vatAuto) : ''}
            onChange={(e) => {
              m.setVatTouched(true);
              m.setVat(e.target.value);
            }}
          />
        </Field>
        <Field label="Tax point date">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Due date" hint="Optional">
          <TextInput type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Button className="w-full" busy={busy} disabled={!valid} onClick={() => void submit()}>
          {m.grossParsed !== null && m.grossParsed > 0
            ? `Create invoice · +${centsToEuroInput(m.grossParsed)} €`
            : 'Create invoice'}
        </Button>
      </div>
    </Sheet>
  );
}

export function UploadSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const entitiesQ = useEntities();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [claimantId, setClaimantId] = useState('');
  const [busy, setBusy] = useState(false);

  // ADR-0036: employee/director who paid out-of-pocket.
  const claimants = (entitiesQ.data ?? []).filter(
    (e) => e.role === 'employee' || e.role === 'director',
  );

  const submit = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { document, deduplicated } = await uploadDocument(file, {
        claimantId: claimantId === '' ? null : Number(claimantId),
      });
      if (deduplicated) toastOk('Already uploaded — using the existing document');
      const outcome = await triageDocument(document.id);
      if (outcome.kind === 'unknown') toastErr(outcomeText(outcome));
      else toastOk(outcomeText(outcome));
      await invalidateBooks(qc);
      onOpenChange(false);
      navigate(`/books/documents/${document.id}`);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Upload a document">
      <div className="space-y-3 px-5 pb-2">
        <Field label="File">
          <input
            ref={fileRef}
            type="file"
            className="w-full text-[14px]"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          />
        </Field>
        {claimants.length > 0 && (
          <Field
            label="Paid by (claimant)"
            hint="Only when an employee/director paid out-of-pocket — the expense is then held for approval (ADR-0036)"
          >
            <SelectInput value={claimantId} onChange={(e) => setClaimantId(e.target.value)}>
              <option value="">— company paid —</option>
              {claimants.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </SelectInput>
          </Field>
        )}
        <Button
          className="w-full"
          busy={busy}
          disabled={fileName === null}
          onClick={() => void submit()}
        >
          Upload &amp; process
        </Button>
        {busy && (
          <p className="text-center text-[12.5px] text-ink-2">
            AI is reading the document — this can take a minute…
          </p>
        )}
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/create.test.tsx && npm test
```

Expected: PASS (4 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): books create flows — plus menu, euro drafts, upload with claimant (ADR-0036)"
```

---

### Task 13: BooksScreen shell — segments in `?seg=`, shared search, "+" wiring

**Files:**
- Create: `packages/web/src/books/BooksScreen.tsx`
- Test: `packages/web/src/books/BooksScreen.test.tsx` (new)

**Interfaces:**
- Consumes: the four segments (Tasks 3/4/8/10), `create.tsx` (Task 12), `LargeTitleHeader`, `SegmentedControl`, `SearchInput`.
- Produces: `BooksScreen()` for `/books` — large title "Books" with a trailing "+" button (opens `CreateMenu`; picking mounts the matching sheet), `SegmentedControl` bound to `?seg=` (legacy `?tab=` accepted as an alias — the LegacyTabs mount used it), `SearchInput` bound to `?q=` (passed to every segment). Changing segment PRESERVES `q` but drops segment-specific filter params (`status`, `nodoc`, `dstatus`) — a Draft filter has no meaning on Documents.

- [ ] **Step 1: Write failing tests**

`src/books/BooksScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BooksScreen } from './BooksScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpenses: vi.fn().mockResolvedValue([]),
  getInvoices: vi.fn().mockResolvedValue([]),
  getEntities: vi.fn().mockResolvedValue([]),
  getDocuments: vi.fn().mockResolvedValue([]),
  listCreditNotes: vi.fn().mockResolvedValue([]),
  getCategories: vi.fn().mockResolvedValue([]),
}));

function mount(url = '/books') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <BooksScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BooksScreen', () => {
  it('defaults to Expenses and switches segments via ?seg=', async () => {
    mount();
    expect(
      await screen.findByRole('heading', { name: 'Books' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Expenses' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('No documents match')).toBeInTheDocument();
  });

  it('accepts the legacy ?tab= alias', async () => {
    mount('/books?tab=credit-notes');
    expect(
      await screen.findByRole('link', { name: 'New credit note' }),
    ).toBeInTheDocument();
  });

  it('switching segments preserves ?q= but drops segment-specific filters', async () => {
    mount('/books?seg=expenses&q=telia&status=draft');
    await screen.findByRole('heading', { name: 'Books' });
    await userEvent.click(screen.getByRole('tab', { name: 'Invoices' }));
    // q survives in the search box; status chip resets to All:
    expect(screen.getByDisplayValue('telia')).toBeInTheDocument();
    expect(await screen.findByText('No invoices match')).toBeInTheDocument();
  });

  it('the + button opens the create menu', async () => {
    mount();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add to the books' }),
    );
    expect(await screen.findByText('New expense')).toBeInTheDocument();
    expect(screen.getByText('Upload a document')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/books/BooksScreen.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/books/BooksScreen.tsx`**

```tsx
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LargeTitleHeader } from '../shell/Headers';
import { SearchInput } from '../ui/SearchInput';
import { SegmentedControl } from '../ui/SegmentedControl';
import { CreateMenu, NewExpenseSheet, NewInvoiceSheet, UploadSheet, type CreateKind } from './create';
import { CreditNotesSegment } from './CreditNotesSegment';
import { DocumentsSegment } from './DocumentsSegment';
import { ExpensesSegment } from './ExpensesSegment';
import { InvoicesSegment } from './InvoicesSegment';

const SEGMENTS = ['expenses', 'invoices', 'documents', 'credit-notes'] as const;
type Segment = (typeof SEGMENTS)[number];

/** Params owned by individual segments — dropped on segment switch (a Draft
 *  filter has no meaning on Documents); ?q= survives. */
const SEGMENT_PARAMS = ['status', 'nodoc', 'dstatus'] as const;

export function BooksScreen() {
  const [params, setParams] = useSearchParams();
  // Legacy bookmarks used ?tab= (LegacyTabs); accept it as an alias.
  const rawSeg = params.get('seg') ?? params.get('tab');
  const seg: Segment = SEGMENTS.includes(rawSeg as Segment)
    ? (rawSeg as Segment)
    : 'expenses';
  const q = params.get('q') ?? '';
  const [createOpen, setCreateOpen] = useState(false);
  const [sheet, setSheet] = useState<CreateKind | null>(null);

  const setSeg = (next: Segment) => {
    const p = new URLSearchParams(params);
    p.set('seg', next);
    p.delete('tab');
    for (const key of SEGMENT_PARAMS) p.delete(key);
    setParams(p, { replace: true });
  };

  const setQ = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === '') p.delete('q');
    else p.set('q', next);
    setParams(p, { replace: true });
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Books"
        trailing={
          <button
            type="button"
            aria-label="Add to the books"
            onClick={() => setCreateOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-lg font-bold text-white"
          >
            +
          </button>
        }
      />
      <div className="space-y-2.5 px-4 pb-3">
        <SegmentedControl
          options={[
            { value: 'expenses' as const, label: 'Expenses' },
            { value: 'invoices' as const, label: 'Invoices' },
            { value: 'documents' as const, label: 'Documents' },
            { value: 'credit-notes' as const, label: 'Credit notes' },
          ]}
          value={seg}
          onChange={setSeg}
        />
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="Counterparty, amount, category…"
        />
      </div>
      {seg === 'expenses' && <ExpensesSegment q={q} />}
      {seg === 'invoices' && <InvoicesSegment q={q} />}
      {seg === 'documents' && <DocumentsSegment q={q} />}
      {seg === 'credit-notes' && <CreditNotesSegment q={q} />}

      <CreateMenu
        open={createOpen}
        onOpenChange={setCreateOpen}
        onPick={(kind) => {
          setCreateOpen(false);
          setSheet(kind);
        }}
      />
      {/* Sheets reset by REMOUNT — rendered only while open. */}
      {sheet === 'expense' && (
        <NewExpenseSheet open onOpenChange={(o) => !o && setSheet(null)} />
      )}
      {sheet === 'invoice' && (
        <NewInvoiceSheet open onOpenChange={(o) => !o && setSheet(null)} />
      )}
      {sheet === 'upload' && (
        <UploadSheet open onOpenChange={(o) => !o && setSheet(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/books/BooksScreen.test.tsx && npm test
```

Expected: PASS (4 tests); full suite PASS (still unmounted in the router).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/books
git commit -m "feat(web): books shell — segments in ?seg with legacy alias, shared search, plus-menu wiring"
```

---
### Task 14: Router swap + legacy deletions (the triage cluster dies with DocumentsView)

**Files:**
- Modify: `packages/web/src/shell/router.tsx`, `packages/web/src/shell/router.test.tsx`
- Delete (WITH their tests): `packages/web/src/components/ExpensesView.tsx`, `ExpensesView.test.tsx`, `InvoicesView.tsx`, `InvoicesView.test.tsx`, `DocumentsView.tsx`, `DocumentsView.test.tsx`, `CreditNotesView.tsx`, `CreditNotesView.test.tsx`, `corrections-form.tsx`, `TriagePanel.tsx`, `ResolveSupplierForm.tsx`, `TriageManualForm.tsx`, `TriageManualInvoiceForm.tsx`, `TriageOcrFailedForm.tsx`, `DocumentThumb.tsx`, and `packages/web/src/reasonBadge.ts` — 16 files (12 source + 4 test files; the triage cluster and `corrections-form`/`DocumentThumb`/`reasonBadge` have no standalone test files — verify with `ls` before assuming).

**Why the cluster dies now:** Plan 03 explicitly kept `TriagePanel` + the four legacy forms + `DocumentThumb` + `reasonBadge.ts` alive because legacy `DocumentsView` still mounted them (`components/DocumentsView.tsx:16-17`). This task deletes `DocumentsView`, so the whole cluster loses its last consumer. This also COMPLETES the reason_type consolidation: after this task the single union lives in `src/api.ts` (`TriageReasonType`, referenced by `NeedsTriageItem`/`DocumentArchiveRow` — Task 1) and the single label/subtitle mapping lives in `src/inbox/reason.ts` (`triageChipLabel`/`triageSubtitle`, consumed by Inbox AND Books); `reasonBadge.ts`'s duplicate union + emoji labels are gone.

**What SURVIVES (explicitly):** `components/Table.tsx` + `Table.test.tsx` — `EntitiesView.tsx` still consumes it (`grep -rn "from './Table'" src/components` → EntitiesView). It dies in Plan 06 with the settings-legacy views. `CategoriesView`, `EnrollView`, `EntitiesView`, `KmdView`, `MailboxSettings`, `OrgView`, `SettingsView`, `LegacyTabs` (Reports/Settings mounts) also survive to Plan 05/06.

- [ ] **Step 1: Update `src/shell/router.tsx`**

Remove the imports of `CreditNotesView`, `DocumentsView`, `ExpensesView`, `InvoicesView`; add:

```tsx
import { BooksScreen } from '../books/BooksScreen';
import { CreditNoteCreateScreen } from '../books/CreditNoteCreateScreen';
import { CreditNoteScreen } from '../books/CreditNoteScreen';
import { DocumentScreen } from '../books/DocumentScreen';
import { ExpenseScreen } from '../books/ExpenseScreen';
import { InvoiceScreen } from '../books/InvoiceScreen';
```

Replace the whole `path: '/books'` LegacyTabs route object with:

```tsx
        { path: '/books', element: <BooksScreen /> },
        { path: '/books/expenses/:id', element: <ExpenseScreen /> },
        { path: '/books/invoices/:id', element: <InvoiceScreen /> },
        { path: '/books/documents/:id', element: <DocumentScreen /> },
        // Static 'new' outranks ':id' in v7 route ranking — order is not load-bearing.
        { path: '/books/credit-notes/new', element: <CreditNoteCreateScreen /> },
        { path: '/books/credit-notes/:id', element: <CreditNoteScreen /> },
```

Update `LEGACY_REDIRECTS` (BooksScreen accepts `?tab=` as an alias, but the canonical param is `?seg=`):

```tsx
  '/expenses': '/books?seg=expenses',
  '/invoices': '/books?seg=invoices',
  '/documents': '/books?seg=documents',
  '/credit-notes': '/books?seg=credit-notes',
```

- [ ] **Step 2: Delete the legacy files**

```bash
cd packages/web
git rm src/components/ExpensesView.tsx src/components/ExpensesView.test.tsx \
  src/components/InvoicesView.tsx src/components/InvoicesView.test.tsx \
  src/components/DocumentsView.tsx src/components/DocumentsView.test.tsx \
  src/components/CreditNotesView.tsx src/components/CreditNotesView.test.tsx \
  src/components/corrections-form.tsx src/components/TriagePanel.tsx \
  src/components/ResolveSupplierForm.tsx src/components/TriageManualForm.tsx \
  src/components/TriageManualInvoiceForm.tsx src/components/TriageOcrFailedForm.tsx \
  src/components/DocumentThumb.tsx src/reasonBadge.ts
```

- [ ] **Step 3: Verify zero residual references**

```bash
grep -rn "ExpensesView\|InvoicesView\|DocumentsView\|CreditNotesView\|corrections-form\|TriagePanel\|ResolveSupplierForm\|TriageManualForm\|TriageManualInvoiceForm\|TriageOcrFailedForm\|DocumentThumb\|reasonBadge" src/ && echo "FAIL: dangling references" || echo "ok: cluster fully gone"
grep -rln "from './Table'" src/components
```

Expected: `ok: cluster fully gone`; the Table grep lists `EntitiesView.tsx` (+ `Table.test.tsx`) ONLY — that is the documented Plan 06 survivor. **One expected COMMENT-ONLY hit:** `src/inbox/DocPreviewRow.tsx` mentions "legacy DocumentThumb" in its doc comment — reword it to "the deleted legacy thumb component" in this commit (comment scrub, zero behavior). If any CODE reference surfaces, STOP and investigate before proceeding.

- [ ] **Step 4: Update `src/shell/router.test.tsx`**

The screens all carry their own behavior tests — the router test pins MOUNTING and REDIRECTS only. Concretely (read the file first; it already mounts `buildRoutes()` in a `createMemoryRouter` for the `/inbox` and `/bank` routes — Plan 03 Task 15 established the pattern and the api mocks):

1. Any existing assertion that `/books` renders LegacyTabs content (the four `?tab=` labels or a legacy table) is DELETED with the views.
2. Using the file's existing mount helper, add mounting pins for: `/books` → the "Books" heading renders; `/books/expenses/5` → the "Expense" ScreenHeader renders; `/books/credit-notes/new` → the "New credit note" ScreenHeader renders.
3. Extend the existing LEGACY_REDIRECTS coverage (the file already walks redirect entries): `/expenses` must land on pathname `/books` with `seg=expenses` in the search string; same pattern for `/invoices`, `/documents`, `/credit-notes`.
4. Whatever api functions the newly mounted screens call on mount must be added to the file's existing `vi.mock('../api', …)` block (`getExpense`, `getExpenses`, `getEntities`, `getDocuments`, `getInvoices`, `listCreditNotes`, `listApprovals`, `getCategories` — all `mockResolvedValue([])`/minimal objects, matching how the file already stubs bank/inbox reads).

If the file's existing structure diverges from this description, follow the FILE (it is the tested reality), keep the four pins above as the acceptance bar, and disclose any deviation in the commit message.

- [ ] **Step 5: Full suite, lint, build; record the test arithmetic**

```bash
npm test && npm run lint && npm run build
```

Expected: PASS. Record in the commit message: tests before − (deleted legacy view tests) + (this plan's new tests) = tests after; the four deleted `*.test.tsx` files' test counts must be accounted for (read the run summary before/after — Plan 02 Task 12 discipline).

- [ ] **Step 6: Commit**

```bash
git add -A packages/web
git commit -m "feat(web): mount Books routes, delete legacy Books views + triage cluster (reason_type consolidation complete)"
```

---

### Task 15: Final verification + browser smoke

**Files:** none new; fixes only if verification fails.

- [ ] **Step 1: Full suite, lint, build**

```bash
npm test && npm run lint && npm run build
```

Expected: all tests PASS, no lint errors, `tsc -b` + vite build succeed.

- [ ] **Step 2: Grep-level invariants**

```bash
grep -rn "window.prompt\|window.confirm\|window.alert" src/books src/queries && echo "FAIL: banned dialogs" || echo "ok: no banned dialogs"
grep -rn "refetchInterval" src/books src/queries/books.ts && echo "FAIL: stray polling" || echo "ok: no new polling"
grep -rn "getDocumentReclassify" src/books && echo "FAIL: AI re-run outside Inbox (ADR-0039)" || echo "ok: persisted artifacts only"
grep -rn "voucher\|debit\|credit_line\|account_code" src/books --include='*.tsx' | grep -v "credit-note\|credit_note\|creditNote\|Credit note" && echo "CHECK: possible ledger vocabulary leak" || echo "ok: no ledger vocabulary"
grep -rn "Number(grossAmount)\|Number(vatAmount)" src/ && echo "FAIL: the cent bug pattern" || echo "ok: euros in, cents on the wire"
```

Expected: the five `ok:` lines.

- [ ] **Step 3: Manual browser smoke** (`npm run dev` against a dev server with seeded data; resize between ~390px and ≥1024px — every check on BOTH widths)

Lists:
- `/books` defaults to Expenses: month sections with `−X € · n` headers, supplier-titled rows, no IDs anywhere; `?seg=`/`?q=`/`?status=` survive F5 and are shareable; legacy `/expenses` bookmark lands on the segment.
- Status chips filter and the month totals recompute; the `📎 No document` toggle shows only document-less expenses; a reconciled expense wears 🏦.
- Invoices segment mirrors (customer titles, `+` amounts, sent marker).
- Documents segment: thumbnails render (and the 📄 fallback for a CSV), channel labels correct, filter chips are the five real statuses — NO Discarded chip.
- Credit notes segment: rows named by credited object, sales notes negative.

Details & flows:
- Expense detail: facts KV; the document row NAVIGATES to the document detail and back; Bank row shows Reconciled/Not matched without a link; a draft rejected from the Inbox (reject one first) shows the rejection reason banner; "Submit for posting" on an above-ceiling draft lands "Held for approval — X € above the Y € auto-post limit" and the item appears in the Inbox.
- Delete draft: ConfirmDialog → receipt → back on the list; verify a posted expense shows NO delete anywhere.
- Correct (posted expense): financial branch prefilled in euros; submit → "corrected" chip on the row, corrected amounts live; correcting the SAME expense again → the sheet's unsupported outcome surfaces honestly (server refuses, Reality #3). If a locked period exists, correct an old expense and confirm the redirect notice.
- Correct → credit-note branch → lands on the prefilled create form; the picker shows outstanding; over-crediting is blocked with the remaining amount; a "100.00" credit note books as 100 €, NOT 1 cent (verify in the list — THE regression check).
- Document detail: signed open in a NEW tab (queue position preserved); Copy link → toast + the pasted link opens tokenless; delete guard explanation on a posted-linked document; delete an unlinked junk file end-to-end; "Resolve in Inbox" from a needs_triage document lands on `/inbox/doc/:id`.
- Create flows: + → New expense (euros, VAT auto) → lands on the draft detail; + → Upload with a claimant selected → document detail shows "Paid by"; ADR-0036: the resulting expense should be HELD (check the Inbox).
- Cross-links closed: document → expense → document round-trip; credit note → credited invoice; invoice → its document.

- [ ] **Step 4: Commit any smoke fixes**

```bash
git add -A packages/web && git commit -m "fix(web): books smoke fixes"
```

(Skip if nothing needed fixing.)

---

## Appendix A — Server gaps & degradation (binding for this plan)

Every gap below is a SERVER gap this client-only plan degrades around. The client behavior is the contract; server work is queued for a later dedicated step.

| # | Spec/mockup expectation | Server reality (verified) | Client degradation in this plan | Exact server ask |
|---|---|---|---|---|
| 1 | Correction provenance chain (`reverses`/`corrects_object`) as a timeline with reasons and links | Provenance lives on VOUCHERS only (`corrections.service.ts:216-219,241-243`); expense/invoice rows expose none of it; vouchers are ADR-0001-hidden | History renders only exposed facts: Created (`created_at`), Rejected (approvals log, reason + date), Corrected (from `status='reversed'` — undated, no reason). No fake chain | A corrections-history endpoint in business terms: `[{ correctedAt, reason, kind, redirectedToPeriod? }]` per object (or reversal/correction refs + dates on the object row) |
| 2 | "Исправлен — сумма 605,00 → 650,00 €" (before→after amounts) | The correction PATCHES the object row in place; the pre-correction amounts survive only in the hidden reversal voucher | The corrected (live) amounts are shown; the timeline entry says a correction happened without before/after figures | Same endpoint as gap 1 — include prior amounts |
| 3 | Documents segment has a `Discarded` filter (ADR-0038) | `DocumentStatus` has NO `discarded` (`documents/types.ts:18-23`); ADR-0038 line 23 marks it as new work | Filter chips over the five REAL statuses; no fake chip; junk currently lands in `needs_triage` (`not_a_document`) and is findable there | Implement the `discarded` terminal + ingest-profile disposition per ADR-0038; the chip then slots into `DOC_FILTERS` |
| 4 | Expense/invoice detail links to the bank match ("🏦 сверен · SEB 25.06 ›") | `reconciled` is a list-only boolean (`expenses.service.ts:63-75`); all match reads are statement-scoped; nothing maps object→transaction | Bank row is a STATUS ("🏦 Reconciled" / "Not matched") without navigation | Expose match refs on the object (statementId+txId) or a `GET /api/reconciliation/matches?objectType=&objectId=` |
| 5 | "Ждут документ" queue: "чек догонит" policy, late-document auto-attach suggestions | The operator's document policy is NOT persisted; no waiting queue; no auto-attach (Plan 02 gap, unchanged). Only the document↔expense link exists (`DocumentArchiveRow.expense_id`) | A NEUTRAL derived `📎 No document` marker + filter on the expenses list (real client-side join). No fake queue semantics, no "waiting" language | Persist the no-doc/doc-later choice on the expense; suggestion endpoint matching late documents by supplier+amount±date (spec Bank section) |
| 6 | Invoice detail from a single fetch | NO `GET /api/sales-invoices/:id` (controller verified) | Detail renders from the cached LIST row; absent id → honest not-found; invoice `created_at` not shown (list subset lacks it) | Add `GET /api/sales-invoices/:id` (mirror of expenses) |
| 7 | Cosmetic correction "replaces the attachment" | The branch is a no-op returning `cosmetic_attachment_replaced` (`corrections.service.ts:130-133`) | The branch exists with an HONEST explanation ("nothing changes in the books; the server records no changes for this yet") | Implement attachment replacement (or drop the outcome) |
| 8 | VAT "by country rate" | No endpoint exposes the plugin VAT rate (Plans 02/03 gap, unchanged) | `STANDARD_VAT_RATE_PCT = 22` prefill, always editable, hint says so | Expose the country plugin's VAT rate(s) |
| 9 | Supplier fact row navigates to the supplier card | Client-side: `/settings/entities/:id` does not exist until Plan 06 (not a server gap) | Supplier/claimant shown as plain text facts | — (Plan 06 wires the link) |

## Appendix B — Follow-ups for later plans

- **Plan 05 (Reports):** INF-gap fix-links point at `/books/expenses/:id` (the route now exists) — use `PATCH /api/expenses/:id/document-metadata` from there or from Reports directly; period-lock straggler lists can link to `/books?seg=expenses&status=draft`.
- **Plan 06 (Settings):** delete `components/Table.tsx` with `EntitiesView` (last consumer after this plan); wire the expense/invoice detail supplier/customer/claimant facts to `/settings/entities/:id` (gap 9); token sweep (`#C2C7C1` etc.), a11y pass, `vite.config.js` artifacts — the accumulated Plan 01-03 triage list.
- **Draft editing:** the corrections endpoint edits drafts (`draft_edited`, Reality #3) but this plan exposes no "Edit draft" affordance (rejected drafts are re-submitted as-is or deleted). If operators need to FIX amounts before resubmitting, surface the financial branch on drafts — one conditional on `CorrectSheet` mounting.
- **Desktop power:** two-pane list+detail via nested routes/`<Outlet/>` for Books (the spec's `lg:` vision); swipe actions; ⌘K.
- **Server list (new items from this plan):** corrections-history endpoint (gaps 1-2); `discarded` document status (gap 3); object→bank-match refs (gap 4); waiting-document persistence + auto-attach suggestions (gap 5); `GET /api/sales-invoices/:id` (gap 6); cosmetic attachment replacement (gap 7); VAT-rate exposure (gap 8). Carried from Plan 03: needs-triage enrichment, entity search, reconciliation `policy_reason`.

## Appendix C — Spec coverage map (self-review)

Spec Books bullet → this plan: month section headers with totals → Tasks 2-4 ✅ (`groupByMonth`, totals recomputed under filter+search — data rule 6); status chips draft/pending/posted + corrected marker → `chips.tsx` ✅ (`reversed` rendered as "corrected", Reality #1); detail shows linked document thumbnail (persisted preview) → Tasks 5/11 ✅ (`DocPreviewRow` reuse, `DocThumb` rows); correction provenance chain → DEGRADED honestly (gaps 1-2, History from exposed facts) ✅; bank-reconciliation status → Tasks 3-5/7 ✅ (🏦 icon + status row; link degraded, gap 4); Correct = sheet with kind selection cosmetic/financial/credit-note per ADR-0009 → Task 6 ✅ (human explanations; credit-note branch routes to the create form — the `/correct` payload trap documented, Reality #5; locked-period redirect surfaced, Reality #3); Delete only for drafts → Tasks 5/7 ✅ (render-gated + server 409 surfaced); blocked for posted-linked documents (ADR-0012) → Task 11 ✅ (guard mirrored + server text verbatim, Reality #8); Documents discarded filter (ADR-0038) → DEGRADED (gap 3, no fake chip) ✅; IA routes `/books` + 4 detail routes + create flows via header "+" incl. claimant upload (ADR-0036) → Tasks 12-14 ✅ (claimant REAL, Reality #10); "Ждут документ" concept → NEUTRAL 📎 marker/filter via archive join (gap 5 — honest about server limits) ✅. Asset §4 → Task 3 ✅ (supplier titles, month totals, filter chips in query params, 🏦 icon); §5 → Tasks 5-6 ✅ (hero, facts KV all-links-clickable where routes exist, history, Correct sheet, delete-draft-only); credit-notes text rule → Tasks 8-9 ✅ (create from invoice/expense detail AND segment; object PICKER with number·counterparty·amount·outstanding; EUROS — the `Number(grossAmount)` cent bug dies with `CreditNotesView`, `eurosToCents` everywhere). Plan 03 routed debts: triage-cluster deletion → Task 14 ✅; reason_type consolidation → Tasks 1+14 ✅ (single union in api.ts + single mapping in inbox/reason.ts; reasonBadge.ts deleted); ApprovalScreen fact rows navigable → expense→document→(bank status) rows are real routes (supplier stays Plan 06, stated) ✅; drafts findable with rejection reason → Draft filter chips + detail banners via the approvals log (Reality #9) ✅; `sharedKeys.expenses`/`invoices` adoption → Tasks 2-4 ✅ (frozen keys; `invalidateInbox`↔`invalidateBooks` cross-invalidation). Global constraints carried: tokens + sanctioned one-offs only; English copy; euros in; one primary per state with outcome-stating labels; amounts never wrap; no `window.*`; ConfirmDialog for destructive; NO new polling; sheet remount discipline (`key={id}` / render-while-open); commit style; suite green per task. Placeholder scan: none — every code block is complete and runnable as written. Type consistency: every widened client field verified against server source (`sales-invoices/types.ts:15,20`, `expenses/types.ts:23,29`, `credit-notes/types.ts:7-30`, `approvals/types.ts:10,29-40,93-103`, `documents/documents.controller.ts:71-110`); every referenced api export verified present in `src/api.ts` (getExpenses, getExpense, createExpense, deleteExpense, correctExpense, postExpense, getInvoices, createInvoice, deleteInvoice, correctInvoice, listCreditNotes, createCreditNote, getDocuments, getDocumentDetails, deleteDocument, retryDocument, uploadDocument, triageDocument, openSignedDocument, copyDocumentShareLink, fetchDocumentPreviewObjectUrl, getCategories, getEntities, fmtCents) plus the six Task 1 adds (getCreditNote, listApprovals, postInvoice, CorrectionOutcome retyping, claimant upload option, widened subsets); helper imports verified (`eurosToCents`/`centsToEuroInput`/`vatFromGross` in `lib/money.ts`, `STANDARD_VAT_RATE_PCT` at `bank/format.ts:61`, `humanizePolicyReason`/`triageChipLabel`/`triageSubtitle`/`outcomeText` in `inbox/reason.ts`, `absoluteDate`/`absoluteDateFromIso`/`vatRatePct`/`signedEuros` in `inbox/format.ts`, `DocPreviewRow` in `inbox/DocPreviewRow.tsx`, kit components in `ui/`, `sharedKeys` frozen in `queries/keys.ts`).






