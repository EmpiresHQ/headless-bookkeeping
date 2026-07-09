# SPA Redesign — Plan 05: Reports section rebuild (Periods / KMD / Lock guard / Submissions)

> **⚠️ EXECUTOR ATTENTION — deviations from the superpowers TDD default, binding for every task:** this plan follows the Plan 02–04 conventions: complete code in every step (No Placeholders), each task = red → green → full suite → commit, `fireEvent` (never `userEvent`) for anything inside a vaul Drawer, typed fixtures, **never `git stash` in any form** (shared cross-worktree stash stack).

**Goal:** Replace the last legacy Reports surface — `KmdView` (a `<select>` of periods with raw `Row 1…Row 7 → number` table rows, an "Override" toggle, a "Download KMD" button, and zero knowledge of period status, locking, or the submission lifecycle) — with the redesigned Reports section: a `/reports` periods list where the current open period is a hero card and every past period carries one honest status line (open / locked + **folded submission state** per ADR-0037, asset §7); a period detail at `/reports/periods/:id` that renders the KMD declaration with **human-first labels** (never `row5_input_vat`), an explicit **live preview vs frozen snapshot** marking, the VD-3S manual-filing notice, plugin review flags, a client-derived **INF missing-invoice-number list with an in-place fix** (`PATCH /api/expenses/:id/document-metadata`, open periods only), an unresolved-in-period stragglers row linking into Inbox/Books, and an honest **"dated in this period"** traceability section that links every in-period expense/invoice to its Books detail (the closest the existing API gets to asset §7's per-row drill-down — Reality #10); a **lock flow per ADR-0015** (warn-and-confirm sheet with the stragglers list, consequences in human terms, typed-name confirmation, no unlock — because the server has none, by design); and a **submissions timeline** at `/reports/periods/:id/submissions` (append-only event log: prepared → submitted → accepted/rejected/correction\_\*, operator-attested "Add event" with external ref, ADR-0037). Create-next-period survives as a sheet (`POST /api/reporting-periods/next` with the legacy override fields). The final tasks swap the router and **delete `KmdView.tsx`** with its test — zero residual references. All on the EXISTING server API; the server is NOT modified.

**Architecture:** New screens live in `packages/web/src/reports/`; typed TanStack Query hooks + the pure model (period titles, lexicographic in-period membership, INF-gap derivation, submission-status fold labels) in `packages/web/src/queries/reports.ts`; transport additions in `src/api.ts` (period warnings, lock, submission state/events, document-metadata patch, `Expense.supplier_invoice_number` widening). The periods list reads through the FROZEN `sharedKeys.reportingPeriods` cache key (`src/queries/keys.ts`) via the EXISTING `useReportingPeriods` (`src/queries/shared.ts:47-51`) — the same entry the Inbox hero already populates. Reused kit: `ListGroup`/`ListRow`/`KeyValue`/`GroupLabel`, `Chip`, `AmountText`, `Sheet`, `Button`/`LinkButton`, `Field`/`TextInput`/`SelectInput`, `EmptyState`/`SkeletonRows`, `LoadError`, `ScreenHeader`/`LargeTitleHeader`, toasts. This plan also lands the **P04 final-review carry-over**: the month/section `GroupHeader` pattern is extracted from `src/books/ExpensesSegment.tsx` into `src/ui/GroupHeader.tsx` (Reports is its third consumer; the Books copies are refactored onto it). The second carry-over — a shared `?seg=`+legacy-`?tab=` hook — does NOT land here: **Reports has no segments** (one list + push-route details, verified against asset §7), so the hook extraction moves to Plan 06 where Settings becomes the third consumer (Appendix B). Routes `/reports`, `/reports/periods/:id`, `/reports/periods/:id/submissions` replace the LegacyTabs Reports mount at the end; deleted with its test: `KmdView.tsx`. The spec's `/reports/periods/:id/lock` ROUTE is deliberately implemented as a keyed SHEET on the period detail (spec's own idiom: "actions get bottom sheets; irreversible operations get confirm" — a deep-linkable URL that opens an irreversible filing confirm is a foot-gun; the spec itself calls the lock flow "modal/sheet flow"). `LegacyTabs` SURVIVES this plan — the Settings mount still consumes it (dies in Plan 06). Spec: `docs/superpowers/specs/2026-07-08-spa-ux-redesign-design.md` (Reports subsection + Data display rules); canonical screen asset: `docs/superpowers/specs/assets/2026-07-09-screens-data-redesign.html` §7.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind 3 (foundation tokens), react-router-dom v7 (data mode), @tanstack/react-query v5 (incl. `useQueries`), vaul (Sheet), sonner (toasts), vitest + @testing-library/react (jsdom). All installed since Plan 01 — no new dependencies.

## Reality of the server contract (read this before touching any task)

These facts were verified against `packages/server/src` and BIND every task below:

1. **The periods REST surface is exactly six calls — and NO unlock, NO delete.** `GET /api/reporting-periods` → `{ reportingPeriods }` ordered by `start_date` ASC; `GET /api/reporting-periods/current` → the latest open period (404 when none); `GET /api/reporting-periods/:id`; `POST /api/reporting-periods` (name/start/end — 409 on any date overlap with an existing period); `POST /api/reporting-periods/next` (optional `start_date`/`end_date`/`name` overrides); `POST /api/reporting-periods/:id/lock`; `GET /api/reporting-periods/:id/warnings` (`reporting-periods/reporting-periods.controller.ts:19-91`). There is NO unlock endpoint anywhere (see Reality #3) and NO `DELETE` — `deleteEmptyPeriod` exists on the service (`reporting-periods.service.ts:66-91`) but is wired to the CLI only (`cli/cli.ts:241`), so this client offers no period deletion. A `ReportingPeriod` row carries `{ id, name, start_date, end_date, status: 'open'|'locked', filed_at, vat_report_snapshot_id, created_at }` (`reporting-periods/types.ts:4-15`).
2. **Lock is ONE atomic filing act, idempotent, and strictly oldest-first.** `lock(id)` (`reporting-periods.service.ts:176-233`): already-locked → returned unchanged (no snapshot regeneration); an EARLIER still-open period → 409 `"Cannot file period X: earlier period Y is still open — file it first"`; otherwise one transaction generates the immutable VAT snapshot AND flips the period to `locked` (setting `filed_at` + `vat_report_snapshot_id`) — there is no "locked without snapshot" state. Post-commit it records a system `prepared` submission event pinned to the exact frozen snapshot (ADR-0037). The client therefore treats the OLDEST open period as the only lockable one (mirroring the rule up front) and surfaces the 409 verbatim if a race slips through.
3. **There is NO unlock — an invariant, not a gap.** A `rejected` submission event "leaves the period locked and the snapshot untouched (no-unlock invariant)" (`statutory-submission/statutory-submission.service.ts:37-43`); ADR-0037 §4: a rejection never reopens the period — format rejections are resubmitted from the SAME snapshot, substantive errors are corrected FORWARD in the open period. The UI never renders an unlock affordance and the Lock sheet says so honestly.
4. **What a locked period rejects — and what gets redirected instead.** Direct posting with a tax point inside a locked period is rejected at the posting chokepoint: `PeriodLockService.assertPeriodOpen` throws 400 `"Cannot post into locked period X"` (`reporting-periods/period-lock.service.ts:54-67`). Corrections and late documents do NOT dead-end: they are detected up front and re-dated into the current OPEN period (ADR-0009), surfaced per-correction as `CorrectionResult.redirected`/`redirectedToPeriodId` (`corrections/types.ts:29-35` — already shown by the Books CorrectSheet, Plan 04). There is NO endpoint listing which vouchers were redirected INTO a period, so Reports explains redirection as lock-flow copy ("late documents and corrections will be re-dated into the next open period and surface in that return"), never as a fake per-period list.
5. **The KMD declaration is a derived read, integer cents, with plugin review flags.** `GET /api/reporting-periods/:id/kmd` → `KmdDeclaration` (`vat-report/types.ts:25-50`): `row1_base_24 … row7_other_acquisition`, `net_vat_due` (row 4 − row 5; **negative = reclaimable**), `vd_intra_eu_services` (the 3S total for the MANUALLY-filed VD koondaruanne), `review_flags: string[]` — all amounts integer cents. It is derived on EVERY read from the period's posted vouchers (`vat-report.service.ts:271-369`), never from the stored snapshot: an OPEN period's declaration is a genuine live preview; a LOCKED period's is stable only because the period rejects further postings (Reality #4). The client labels the two states explicitly (asset §7 decision 2).
6. **One review flag embeds RAW CENTS** — the VD flag is built as `` `File the VD koondaruanne manually (tähis 3S) for ${vd_intra_eu_services} cents of 0% intra-EU services…` `` (`vat-report.service.ts:361-366`), which violates data rule 3 if rendered verbatim. The client renders its OWN dedicated VD row (`fmtCents`, euros) + manual-filing notice whenever `vd_intra_eu_services > 0` and filters that one server flag by the `'VD koondaruanne'` substring (documented brittleness; structured flags are on the server follow-up list, Appendix A gap 3). All OTHER flags come from the country plugin's `classifyKmd(...).review` as human sentences and render verbatim.
7. **THE TRAP — `POST /api/reporting-periods/:id/vat-report` must NEVER be called by this client.** Snapshot generation is return-existing idempotent (`vat-report.service.ts:44-52`), and `lock()` reuses any existing snapshot (`reporting-periods.service.ts:203` → `generate(id, trx)`). Calling the generate endpoint on a still-open period therefore freezes a snapshot EARLY; postings continue; the eventual lock silently files the STALE snapshot. `src/api.ts` gets no wrapper for it, and Task 10 greps for the path (the same documented-trap discipline as Plan 03's `/post`-vs-approvals rule).
8. **Period-close warnings are advisory and typed — but their `description` embeds raw cents.** `GET /:id/warnings` → `PeriodWarning { type: 'pending_approval' | 'unposted_draft', object_type: 'expense' | 'sales_invoice', object_id, description }` (`reporting-periods/types.ts:35-40`), computed over in-period `pending`/`draft` expenses AND sales invoices; it "returns warnings but does NOT block locking — user decides" (`reporting-periods.service.ts:236-321`) — ADR-0015's warn-and-confirm verbatim. The `description` strings interpolate `gross_amount` as raw cents (`"(EUR 65000) awaiting approval"`, lines 262/280/298/316), so the client NEVER renders `description`; it joins `object_id` against the cached shared expense/invoice lists for the human line (supplier/number + `fmtCents`) and falls back to a typed generic line ("Expense · awaiting approval") when the join misses.
9. **The submission lifecycle is a real, complete API.** `GET /api/reporting-periods/:id/submission-state` → `{ status, currentSnapshotId, lastExternalRef, submissionCount, history }` — the status is a pure fold over the ordered event log (`statutory-submission/fold.ts:27-62`); a period with no events (open, or locked before ADR-0037 landed) folds to `not_started`. `POST /api/reporting-periods/:id/submission-events` `{ event_kind, external_ref?, note? }` appends an operator-attested event; `event_kind` is zod-restricted to `submitted | accepted | rejected | correction_submitted | correction_accepted` (`prepared` is system-emitted at lock ONLY — `statutory-submission/types.ts:15-22`); it 404s for a period with no frozen snapshot: `"…has no frozen VAT snapshot — lock it before recording submission events"` (`statutory-submission.service.ts:122-147`). Events carry `occurred_at` (unix seconds, server clock — the operator cannot backdate, honest limitation), `actor` (`'system'` for prepared, `'operator'` for the rest), `external_ref`, `note`. NOTE: every operator event is pinned to the period's ORIGINAL snapshot — the ADR-0015 amended-return snapshot (v2) does not exist server-side yet (Appendix A gap 5); `correction_submitted/accepted` still record honestly as lifecycle events.
10. **There is NO per-row KMD drill-down endpoint — asset §7's row expansion degrades.** The only per-declaration linkage the server exposes is `GET /api/vat-reports/:id/vouchers` → `{ voucher_ids }` (`vat-report/vat-report.controller.ts:68-79`) — voucher vocabulary that ADR-0001/0030 keep OFF the operator surface, and useless without a voucher read anyway. The honest client substitute: a **"dated in this period"** section — a client-side join over the cached shared expense/invoice lists by `tax_point_date ∈ [start_date, end_date]` (lexicographic string compare, no `new Date()`), live statuses only (`posted`/`reversed` — Plan 04 Reality #1), each row a REAL navigation to `/books/expenses/:id` / `/books/invoices/:id`. It is labeled as the period's documents, NOT as per-box composition (an expense's box routing is plugin logic the client cannot see); the per-box composition endpoint is Appendix A gap 1. Two-tap traceability survives: declaration → period documents → object detail → source document.
11. **INF gaps are NOT exposed as JSON — the client derives them.** The INF annex is built only inside the statutory-report DOWNLOAD path: `buildInfPart` filters reportable-rate B2B lines, applies the per-partner €1000 net threshold (`THRESHOLD_NET = 100000` cents, `plugins/estonia-kmd/kmd-inf.ts:13`), and emits `inf_missing_invoice_number` warnings (`kmd-inf.ts:48-53`) that the service converts into UNSTRUCTURED audit findings without object refs (`statutory-report/statutory-report.service.ts:118-124`) — nothing a UI can link from. BUT the server expense LIST rows carry `supplier_invoice_number` (`expenses/types.ts:19`), so the client derives its own candidate list: live in-period expenses whose supplier's in-period net (Σ |gross − vat|) ≥ the mirrored threshold and whose `supplier_invoice_number` is empty. Labeled as "may be needed" (the client cannot see VAT codes or reg-key presence, so it over-approximates); the server stays the authority at download time. Appendix A gap 2.
12. **The INF fix is real and period-guarded.** `PATCH /api/expenses/:id/document-metadata` `{ supplier_invoice_number }` sets the number on a POSTED expense with no ledger impact, returns the updated expense, and 400s when the expense's period is locked (`expenses/expenses.controller.ts:72-84`, `expenses.service.ts:217-233` — `assertPeriodOpen` on the expense's tax point). The fix affordance renders only on OPEN periods; a locked period shows the numbers as read-only facts with an explanation.
13. **The statutory download is a binary, mode-switched by period status, and can 400.** `GET /api/reporting-periods/:id/statutory-report?format=xml|csv|all` streams file attachment(s) (zip for `all`); mode is `draft` for open periods, `final` for locked (`statutory-report/statutory-report.service.ts:71-72`); a FINAL render without a declarant VAT registration number → 400 `"Cannot generate a final KMD without a declarant VAT registration number"` (`:80-84`). The existing `downloadStatutoryReport` (`src/api.ts:803-823`, `apiFetchRaw` + blob + content-disposition filename) is reused as-is; the 400 surfaces as an error toast. Each download of an open period ALSO regenerates INF audit findings server-side (`:118-124`) — a server-side duplication quirk this client cannot avoid, noted in Appendix A gap 2.
14. **Several periods can be open at once; "current" = latest open.** `getCurrent` picks the open period with the max `start_date` (`reporting-periods.service.ts:93-106`; same rule as `PeriodLockService.getCurrentOpenPeriod`, `period-lock.service.ts:74-83`). With an unfiled June alongside July, July is the hero and June renders as "open — file first" (Reality #2 makes June the only lockable one). Period names are compact plugin-frequency labels — `"2026-06"`, `"2026-Q1"`, `"2026-H1"`, `"2026"` (`reporting-periods/period-dates.ts:105-127`); frequency comes from the country plugin via `GET /api/organization/period-config` → `{ frequency_options, default_frequency }` (already typed in `src/api.ts:258-264`). The client humanizes known shapes ("June 2026", "Q1 2026") and passes operator-override names through verbatim.

## Global Constraints

- Working directory for all commands: `packages/web` (repo root: `/Users/alekseirevin/test/headless-bookkeeping.spa-redesign-foundation`).
- Test command: `npx vitest run <file>`; full suite: `npm test`; lint: `npm run lint`; build (typecheck + bundle): `npm run build`. Every task leaves the FULL suite green. **Never run `git stash` in any form** (shared cross-worktree stash stack).
- **Routes (binding):** `/reports` (periods list — no segments, no `?seg=`), `/reports/periods/:id` (declaration detail), `/reports/periods/:id/submissions` (event timeline). All deep-linkable, all survive F5. Legacy `/kmd` and `/periods` already redirect to `/reports` (`src/shell/router.tsx:41-42`) — unchanged.
- **Cache keys:** the periods list reads through the FROZEN `sharedKeys.reportingPeriods` (`src/queries/keys.ts`) via the existing `useReportingPeriods` (`src/queries/shared.ts`). New Reports-domain keys live under the `['reports', …]` prefix in `src/queries/reports.ts`. Every Reports mutation invalidates via `invalidateReports(qc)` (Task 3), which covers `['reports']`, `sharedKeys.reportingPeriods`, AND `sharedKeys.expenses` (the INF fix patches an expense; the straggler/in-period sections join the shared lists).
- **NO new polling.** Zero `refetchInterval` anywhere in `src/reports/` or `src/queries/reports.ts`. The bank import job (1.5s) and the Inbox lists (30s, route-scoped) remain the only intervals (Plans 02/03).
- **Dates lexicographically.** Period membership, boundaries, and ordering are ISO-string comparisons (`localeCompare` / `<=`) — NO `new Date()` in any money or date-compare path (`monthKey` discipline, `src/queries/books.ts:116-118`). Event timestamps (`occurred_at`, `filed_at` — unix seconds) display via `absoluteDate` (`src/inbox/format.ts`); ISO calendar dates via `absoluteDateFromIso`.
- **Colors through tokens** (`bg-surface`, `text-ink-2`, `text-ok`, `bg-warn-bg`, `border-line`, `bg-accent`, `bg-accent-deep`, `bg-alert`, …). Sanctioned one-offs (approved mockups, no token): icon tint `bg-[#E3EFE8]`, secondary-button grey `bg-[#E9EBE7]` (kit), chevron/handle greys `#C2C7C1`/`#D4D7D1` (kit). No other raw hex.
- **Anti-overlap rules (binding):** amounts never wrap (`AmountText` + `flex-none` containers); titles/subtitles single-line `truncate`; left column `min-w-0 flex-1`, right column `flex-none`.
- **Screen invariants:** exactly ONE primary button per state and its label states the outcome with the amount where one exists ("Close & freeze · VAT to pay 624.07 €" — never "Submit"); IDs are not data (no "#214" in titles; ids live in URLs); reasons are human sentences with formatted euros (never raw cents — Reality #6/#8); VAT belongs to detail, not lists.
- Money **inputs are euros** via `eurosToCents`/`centsToEuroInput` (`src/lib/money.ts`); the API speaks integer cents; display via `AmountText`/`fmtCents`. (This plan has no money inputs — the constraint binds copy and any future edit.)
- **Never** `window.prompt/confirm/alert`. Never render voucher/account/debit/credit words (ADR-0001/0030) — in particular `GET /api/vat-reports/:id/vouchers` stays untouched (Reality #10) and `vat_report_snapshot_id` stays off rendered copy. Irreversible actions (period lock) go through explicit warn-and-confirm — plan→confirm→receipt, never optimistic; the lock confirm is TYPED (the period name), per the spec's "requires typed-out confirm".
- **Sheets remount per object** — every action sheet carries `key={<objectId>}` or is rendered only while open, so state never leaks across objects (Plan 03 Task 13 lesson). Compute-before-mutate for anything that navigates after a mutation.
- UI copy is **English** (Russian in mockups is design annotation): "Reports", "Open period", "Close period…", "Live preview", "Frozen", "Submission history", "Record what happened…", "VAT to pay"/"VAT to reclaim", "file it first".
- Test mocking rule (Plan 03): modules import the REAL `fmtCents` from `../api`, so tests mock the api module with the spread-importOriginal pattern (`vi.mock('../api', async (io) => ({ ...(await io<typeof import('../api')>()), <fn>: vi.fn() }))`), never a bare object literal. `fireEvent` (not `userEvent`) inside vaul Drawer tests.
- Commit style: `feat(web): …`, one commit per task. React StrictMode double-mount safe (one-shot fetches via React Query; effects with cleanup).
- `KmdView` stays untouched and mounted until Task 9 swaps the router and deletes it; every intermediate task leaves the suite green.

---

### Task 1: API transport additions (periods lock/warnings, submission lifecycle, INF metadata patch)

**Files:**
- Modify: `packages/web/src/api.ts`
- Test: `packages/web/src/api.reports.test.ts` (new)

**Interfaces:**
- Consumes: existing `apiFetch`.
- Produces (all from `src/api.ts`):
  - `ReportingPeriod.status` retyped from `string` to `'open' | 'locked'` (verified `reporting-periods/types.ts:4`).
  - `Expense` (list subset) gains `supplier_invoice_number: string | null` (verified on every list row, `expenses/types.ts:19` — the Reports INF join needs it; Reality #11).
  - `PeriodWarning { type: 'pending_approval' | 'unposted_draft'; object_type: 'expense' | 'sales_invoice'; object_id: number; description: string }`; `getPeriodWarnings(periodId): Promise<PeriodWarning[]>` — `GET /api/reporting-periods/:id/warnings`, unwraps `{ warnings }` (Reality #8).
  - `lockPeriod(periodId): Promise<ReportingPeriod>` — `POST /api/reporting-periods/:id/lock` (Reality #2).
  - `SubmissionStatus`, `SubmissionEventKind`, `RecordableSubmissionKind`, `SubmissionEvent`, `SubmissionState`; `getSubmissionState(periodId): Promise<SubmissionState>`; `RecordSubmissionEventInput`; `recordSubmissionEvent(periodId, input): Promise<SubmissionEvent>` (Reality #9).
  - `setExpenseDocumentMetadata(id, patch: { supplier_invoice_number: string | null }): Promise<ExpenseDetail>` — `PATCH /api/expenses/:id/document-metadata` (Reality #12).
  - A trap comment next to `getKmd` documenting that `POST /api/reporting-periods/:id/vat-report` must never gain a wrapper (Reality #7).

- [ ] **Step 1: Write failing tests**

`src/api.reports.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setToken } from './auth';
import {
  getPeriodWarnings,
  getSubmissionState,
  lockPeriod,
  recordSubmissionEvent,
  setExpenseDocumentMetadata,
} from './api';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe('reports api additions', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('lockPeriod POSTs the lock endpoint and returns the locked period', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        id: 7,
        name: '2026-06',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        status: 'locked',
        filed_at: 1751600000,
      }),
    );
    const p = await lockPeriod(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/reporting-periods/7/lock');
    expect(init?.method).toBe('POST');
    expect(p.status).toBe('locked');
    expect(p.filed_at).toBe(1751600000);
  });

  it('getPeriodWarnings unwraps the warnings array', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        warnings: [
          {
            type: 'pending_approval',
            object_type: 'expense',
            object_id: 12,
            description: 'Expense #12 (rent, EUR 65000) awaiting approval',
          },
        ],
      }),
    );
    const rows = await getPeriodWarnings(7);
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/reporting-periods/7/warnings',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].object_type).toBe('expense');
    expect(rows[0].object_id).toBe(12);
  });

  it('getSubmissionState GETs the folded state with history', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        status: 'accepted',
        currentSnapshotId: 3,
        lastExternalRef: 'KMD-2026-06-001',
        submissionCount: 1,
        history: [
          {
            id: 1,
            reporting_period_id: 7,
            report_kind: 'EE_KMD',
            source_snapshot_type: 'vat_report',
            source_snapshot_id: 3,
            event_kind: 'prepared',
            external_ref: null,
            occurred_at: 1751600000,
            actor: 'system',
            note: null,
          },
        ],
      }),
    );
    const state = await getSubmissionState(7);
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/reporting-periods/7/submission-state',
    );
    expect(state.status).toBe('accepted');
    expect(state.lastExternalRef).toBe('KMD-2026-06-001');
    expect(state.history[0].event_kind).toBe('prepared');
    expect(state.history[0].actor).toBe('system');
  });

  it('recordSubmissionEvent POSTs the operator event body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({
        id: 2,
        reporting_period_id: 7,
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: 3,
        event_kind: 'submitted',
        external_ref: 'KMD-2026-06-001',
        occurred_at: 1751610000,
        actor: 'operator',
        note: null,
      }),
    );
    const ev = await recordSubmissionEvent(7, {
      event_kind: 'submitted',
      external_ref: 'KMD-2026-06-001',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/reporting-periods/7/submission-events');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      event_kind: 'submitted',
      external_ref: 'KMD-2026-06-001',
    });
    expect(ev.actor).toBe('operator');
  });

  it('setExpenseDocumentMetadata PATCHes the invoice number', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      ok({ id: 12, supplier_invoice_number: 'A-183' }),
    );
    const res = await setExpenseDocumentMetadata(12, {
      supplier_invoice_number: 'A-183',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/expenses/12/document-metadata');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({
      supplier_invoice_number: 'A-183',
    });
    expect(res.supplier_invoice_number).toBe('A-183');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/api.reports.test.ts
```

Expected: FAIL — `lockPeriod`, `getPeriodWarnings`, `getSubmissionState`, `recordSubmissionEvent`, `setExpenseDocumentMetadata` are not exported.

- [ ] **Step 3: Implement in `src/api.ts`**

3a. Retype the period status — in the `ReportingPeriod` interface (`src/api.ts:123-130`) replace `status: string;` with:

```ts
  status: 'open' | 'locked';
```

(Verified enum `reporting-periods/types.ts:4`. Structural widening nowhere depends on `string` — the Inbox hero only reads `name`.)

3b. Widen the `Expense` list subset — add after `tax_point_date: string;`:

```ts
  // Present on every list row (expenses/types.ts:19) — the Reports INF join
  // derives "missing invoice number" gaps from it (Plan 05 Reality #11).
  supplier_invoice_number: string | null;
```

3c. Period warnings + lock — add below `createNextPeriod`:

```ts
/**
 * Advisory pre-lock warnings (GET /api/reporting-periods/:id/warnings) —
 * ADR-0015 warn-and-confirm: the server NEVER blocks locking on these.
 * NOTE: `description` embeds raw cents ("EUR 65000") — do not render it;
 * join object_id against the shared lists instead (Plan 05 Reality #8).
 */
export interface PeriodWarning {
  type: 'pending_approval' | 'unposted_draft';
  object_type: 'expense' | 'sales_invoice';
  object_id: number;
  description: string;
}

export const getPeriodWarnings = (periodId: number) =>
  apiFetch<{ warnings: PeriodWarning[] }>(
    `/api/reporting-periods/${periodId}/warnings`,
  ).then((r) => r.warnings);

/**
 * File (lock) a period — ONE atomic act: freezes the VAT snapshot AND flips
 * the period to locked (ADR-0009/0037). Idempotent; 409 when an EARLIER
 * period is still open (filing proceeds oldest-first). There is NO unlock
 * endpoint — corrections go forward into the open period.
 */
export const lockPeriod = (periodId: number) =>
  apiFetch<ReportingPeriod>(`/api/reporting-periods/${periodId}/lock`, {
    method: 'POST',
  });
```

3d. Submission lifecycle — add below the block from 3c:

```ts
// ── Statutory submission lifecycle (ADR-0037: append-only event log) ──────
/** Folded filing status — the kind of the latest event (fold.ts). */
export type SubmissionStatus =
  | 'not_started'
  | 'prepared'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'correction_submitted'
  | 'correction_accepted';

export type SubmissionEventKind = Exclude<SubmissionStatus, 'not_started'>;

/** Operator-recordable kinds — `prepared` is system-emitted at lock only
 *  (statutory-submission/types.ts:15-22; the server zod-rejects it). */
export type RecordableSubmissionKind = Exclude<SubmissionEventKind, 'prepared'>;

/** Display subset of a persisted event — the snapshot linkage columns
 *  (report_kind, source_snapshot_*) stay off the typed surface: internal
 *  artifact plumbing, not operator data (ADR-0001/0030 discipline). */
export interface SubmissionEvent {
  id: number;
  reporting_period_id: number;
  event_kind: SubmissionEventKind;
  external_ref: string | null;
  occurred_at: number;
  actor: string;
  note: string | null;
}

/** Folded state + full ordered history. `currentSnapshotId` deliberately
 *  omitted (internal artifact id). A period with no events folds to
 *  status 'not_started' with an empty history. */
export interface SubmissionState {
  status: SubmissionStatus;
  lastExternalRef: string | null;
  submissionCount: number;
  history: SubmissionEvent[];
}

export const getSubmissionState = (periodId: number) =>
  apiFetch<SubmissionState>(
    `/api/reporting-periods/${periodId}/submission-state`,
  );

export interface RecordSubmissionEventInput {
  event_kind: RecordableSubmissionKind;
  external_ref?: string;
  note?: string;
}

/** Operator-attested lifecycle event (POST …/submission-events). 404s for a
 *  period with no frozen snapshot ("lock it before recording"). */
export const recordSubmissionEvent = (
  periodId: number,
  input: RecordSubmissionEventInput,
) =>
  apiFetch<SubmissionEvent>(
    `/api/reporting-periods/${periodId}/submission-events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
```

3e. INF metadata fix — add below `getExpense`:

```ts
/** Set the supplier invoice number on a POSTED expense — no ledger impact;
 *  400 when the expense's reporting period is locked (expenses.service.ts:
 *  217-233). The Reports INF-gap fix goes through this. */
export const setExpenseDocumentMetadata = (
  id: number,
  patch: { supplier_invoice_number: string | null },
) =>
  apiFetch<ExpenseDetail>(`/api/expenses/${id}/document-metadata`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
```

3f. The snapshot trap — extend the comment block above `getKmd` (`src/api.ts:282`) to:

```ts
// ── KMD declaration (GET /api/reporting-periods/:id/kmd) ──────────────────
// Derived on EVERY read from the period's posted vouchers — a live preview
// while the period is open; stable once locked only because locked periods
// reject postings. API TRAP (Plan 05 Reality #7): never add a wrapper for
// POST /api/reporting-periods/:id/vat-report — generating a snapshot on an
// OPEN period freezes it early and lock() would silently file the STALE
// snapshot (vat-report.service.ts:44-52 + reporting-periods.service.ts:203).
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/api.reports.test.ts && npm test
```

Expected: PASS (5 tests); full suite PASS. If any existing test constructed an `Expense` fixture object literal WITHOUT `supplier_invoice_number` under an exact type annotation, add `supplier_invoice_number: null` to it (fixtures cast `as never` are unaffected); if any test pinned `ReportingPeriod.status` to an arbitrary string, use `'open'`.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api.ts packages/web/src/api.reports.test.ts
git commit -m "feat(web): reports API transport — lock, warnings, submission lifecycle, INF metadata patch"
```

---

### Task 2: Extract `GroupHeader` into the UI kit (P04 carry-over) + refactor the Books copies

**Files:**
- Create: `packages/web/src/ui/GroupHeader.tsx`, `packages/web/src/ui/GroupHeader.test.tsx`
- Modify: `packages/web/src/books/ExpensesSegment.tsx`, `packages/web/src/books/InvoicesSegment.tsx`

**Interfaces:**
- Produces: `GroupHeader({ label, trailing }: { label: ReactNode; trailing?: ReactNode })` — section-header CONTENT for `ListGroup`'s `label` slot: name left, right-aligned tabular figure. Third-consumer rule: `ExpensesSegment` has a local `GroupHeader` component (`src/books/ExpensesSegment.tsx:22-39`) and `InvoicesSegment` an inline copy (`src/books/InvoicesSegment.tsx:112-118`); Reports (Tasks 4/6) would be the third — so the pattern moves into the kit now (P04 final-review carry-over a).
- **Carry-over b resolved here by decision, not code:** Reports has NO segments (one periods list + push-route details — asset §7 shows no segment control), so the shared `?seg=`+legacy-`?tab=` hook is NOT extracted in this plan; Plan 06 extracts it when Settings becomes its third consumer (Appendix B).

- [ ] **Step 1: Write failing tests**

`src/ui/GroupHeader.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GroupHeader } from './GroupHeader';

describe('GroupHeader', () => {
  it('renders label left and a tabular, non-wrapping trailing figure', () => {
    render(<GroupHeader label="July 2026" trailing="−650.00 € · 3" />);
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    const trailing = screen.getByText('−650.00 € · 3');
    expect(trailing.className).toContain('tabular-nums');
    expect(trailing.className).toContain('whitespace-nowrap');
  });

  it('omits the trailing span when not provided', () => {
    const { container } = render(<GroupHeader label="2026" />);
    expect(screen.getByText('2026')).toBeInTheDocument();
    expect(container.querySelectorAll('span.tabular-nums')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ui/GroupHeader.test.tsx
```

Expected: FAIL — module `./GroupHeader` does not exist.

- [ ] **Step 3: Implement `src/ui/GroupHeader.tsx`**

```tsx
import type { ReactNode } from 'react';

/** Section-header content for a ListGroup `label`: name left, right-aligned
 *  tabular figure (per-section totals recomputed under the active filter —
 *  data rule 6). Extracted in Plan 05 after two inline Books copies; Reports
 *  is the third consumer. */
export function GroupHeader({
  label,
  trailing,
}: {
  label: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <span className="flex w-full items-baseline justify-between">
      <span>{label}</span>
      {trailing != null && (
        <span className="whitespace-nowrap tabular-nums">{trailing}</span>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Refactor the two Books consumers (rendering must stay byte-identical)**

4a. `src/books/ExpensesSegment.tsx` — delete the whole local `GroupHeader` component (the `/** Month-section header content… */` block near the top; `fmtCents` stays imported — the trailing string below still uses it). Add the kit import and change the call site:

```tsx
import { GroupHeader } from '../ui/GroupHeader';
```

Replace the `label={…}` on the `ListGroup` with:

```tsx
          label={
            <GroupHeader
              label={g.label}
              trailing={`−${fmtCents(g.totalCents)} € · ${g.count}`}
            />
          }
```

4b. `src/books/InvoicesSegment.tsx` — add the same import; replace the inline `label={<span className="flex w-full items-baseline justify-between">…</span>}` block with:

```tsx
          label={
            <GroupHeader
              label={g.label}
              trailing={`+${fmtCents(g.totalCents)} € · ${g.count}`}
            />
          }
```

- [ ] **Step 5: Run the kit test, both segment test files, then the full suite**

```bash
npx vitest run src/ui/GroupHeader.test.tsx src/books/ExpensesSegment.test.tsx src/books/InvoicesSegment.test.tsx && npm test
```

Expected: PASS — the existing segment tests pin the header text (`−… € · n` / `+… € · n`), which is unchanged. If a segment test asserted DOM structure beyond text (it should not), follow the test's actual assertion and keep the rendering identical.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/ui/GroupHeader.tsx packages/web/src/ui/GroupHeader.test.tsx packages/web/src/books/ExpensesSegment.tsx packages/web/src/books/InvoicesSegment.tsx
git commit -m "feat(web): extract GroupHeader into the UI kit (P04 carry-over); Books segments consume it"
```

---

### Task 3: Reports query layer + pure model (period titles, in-period joins, INF gaps, fold labels)

**Files:**
- Create: `packages/web/src/queries/reports.ts`, `packages/web/src/queries/reports.test.tsx`

**Interfaces:**
- Consumes: `getKmd`, `getPeriodWarnings`, `getSubmissionState`, `getPeriodConfig` and the Task 1 types from `../api`; `sharedKeys` from `./keys`; `monthLabel` from `./books` (reused for monthly-period titles).
- Produces (all from `src/queries/reports.ts`):
  - `reportsKeys` — `all: ['reports']`, `kmd(id)`, `warnings(id)`, `submission(id)`, `periodConfig`.
  - Hooks: `useKmd(periodId)`, `usePeriodWarnings(periodId, enabled)`, `useSubmissionState(periodId, enabled)`, `useSubmissionStates(lockedIds): Map<number, SubmissionState>` (one `useQueries` fan-out — Reality #9; batch endpoint is Appendix A gap 4), `usePeriodConfig()`.
  - `invalidateReports(qc): Promise<void>` — `['reports']` + `sharedKeys.reportingPeriods` + `sharedKeys.expenses`.
  - Pure model: `periodTitle(name)`, `sortPeriodsNewestFirst(rows)`, `currentOpen(periods)`, `oldestOpen(periods)`, `inPeriod(isoDate, period)`, `LIVE_STATUSES`, `periodExpenses(expenses, period)`, `periodInvoices(invoices, period)`, `INF_THRESHOLD_NET`, `infGapCandidates(expenses, period)`, `KmdRowKey`/`KMD_ROWS`, `netVatLabel(cents)`, `isVdFlag(flag)`/`displayFlags(flags)`, `SUBMISSION_STATUS`, `submissionLine(state)`.

- [ ] **Step 1: Write failing tests**

`src/queries/reports.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getSubmissionState: vi.fn(),
}));
import {
  getSubmissionState,
  type Expense,
  type ReportingPeriod,
  type SubmissionState,
} from '../api';
import {
  currentOpen,
  displayFlags,
  inPeriod,
  infGapCandidates,
  invalidateReports,
  isVdFlag,
  KMD_ROWS,
  netVatLabel,
  oldestOpen,
  periodExpenses,
  periodTitle,
  reportsKeys,
  sortPeriodsNewestFirst,
  submissionLine,
  SUBMISSION_STATUS,
  useSubmissionStates,
} from './reports';
import { sharedKeys } from './keys';

const period = (over: Partial<ReportingPeriod> = {}): ReportingPeriod => ({
  id: 7,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'open',
  filed_at: null,
  ...over,
});

const expense = (over: Partial<Expense> = {}): Expense =>
  ({
    id: 1,
    supplier_id: 3,
    category: 'rent',
    gross_amount: 122000,
    vat_amount: 22000,
    currency: 'EUR',
    tax_point_date: '2026-06-10',
    status: 'posted',
    reconciled: false,
    supplier_invoice_number: null,
    ...over,
  }) as Expense;

describe('period titles and ordering (pure)', () => {
  it('humanizes plugin-frequency names and passes overrides through', () => {
    expect(periodTitle('2026-06')).toBe('June 2026');
    expect(periodTitle('2026-Q1')).toBe('Q1 2026');
    expect(periodTitle('2026-H2')).toBe('H2 2026');
    expect(periodTitle('2026')).toBe('2026');
    expect(periodTitle('custom period')).toBe('custom period');
  });

  it('sorts newest first lexicographically and picks current/oldest open', () => {
    const ps = [
      period({ id: 1, name: '2026-05', start_date: '2026-05-01', end_date: '2026-05-31', status: 'locked' }),
      period({ id: 2, name: '2026-06', start_date: '2026-06-01', end_date: '2026-06-30' }),
      period({ id: 3, name: '2026-07', start_date: '2026-07-01', end_date: '2026-07-31' }),
    ];
    expect(sortPeriodsNewestFirst(ps).map((p) => p.id)).toEqual([3, 2, 1]);
    // current = LATEST open (mirror of GET /current); oldest open = the only lockable one.
    expect(currentOpen(ps)?.id).toBe(3);
    expect(oldestOpen(ps)?.id).toBe(2);
    expect(currentOpen([ps[0]])).toBeNull();
  });

  it('inPeriod is inclusive lexicographic string math (no Date)', () => {
    const p = period();
    expect(inPeriod('2026-06-01', p)).toBe(true);
    expect(inPeriod('2026-06-30', p)).toBe(true);
    expect(inPeriod('2026-05-31', p)).toBe(false);
    expect(inPeriod('2026-07-01', p)).toBe(false);
  });
});

describe('in-period joins and INF gaps (pure)', () => {
  it('periodExpenses keeps live statuses in range, newest first', () => {
    const rows = [
      expense({ id: 1, tax_point_date: '2026-06-10' }),
      expense({ id: 2, tax_point_date: '2026-06-20', status: 'reversed' }),
      expense({ id: 3, tax_point_date: '2026-06-15', status: 'draft' }),
      expense({ id: 4, tax_point_date: '2026-07-02' }),
    ];
    expect(periodExpenses(rows, period()).map((e) => e.id)).toEqual([2, 1]);
  });

  it('infGapCandidates: supplier net ≥ 1000 € in-period AND missing number', () => {
    const rows = [
      // Supplier 3: net 2×(1220−220)€ = 2000 € ≥ threshold; one row lacks a number.
      expense({ id: 1, supplier_invoice_number: 'A-1' }),
      expense({ id: 2, tax_point_date: '2026-06-12' }),
      // Supplier 4: net 100 € — under threshold, missing number is NOT a gap.
      expense({
        id: 3,
        supplier_id: 4,
        gross_amount: 12200,
        vat_amount: 2200,
        tax_point_date: '2026-06-13',
      }),
      // No supplier — never an INF row (B2B only).
      expense({ id: 4, supplier_id: null, tax_point_date: '2026-06-14' }),
    ];
    expect(infGapCandidates(rows, period()).map((e) => e.id)).toEqual([2]);
  });
});

describe('declaration + submission display model (pure)', () => {
  it('KMD_ROWS covers the seven boxes with human-first labels', () => {
    expect(KMD_ROWS).toHaveLength(7);
    expect(KMD_ROWS[0]).toEqual({
      key: 'row1_base_24',
      label: 'Sales taxed at 24% — net (row 1)',
    });
    expect(KMD_ROWS.map((r) => r.key)).toContain('row5_input_vat');
    for (const r of KMD_ROWS) expect(r.label).not.toMatch(/^Row \d/);
  });

  it('netVatLabel is honest about reclaimable', () => {
    expect(netVatLabel(62407)).toBe('VAT to pay');
    expect(netVatLabel(-1)).toBe('VAT to reclaim');
    expect(netVatLabel(0)).toBe('VAT to pay');
  });

  it('filters ONLY the raw-cents VD server flag (Reality #6)', () => {
    const flags = [
      'Reverse charge on row 6 vs 7 — confirm the split',
      'File the VD koondaruanne manually (tähis 3S) for 48200 cents of 0% intra-EU services — the system does not submit it.',
    ];
    expect(isVdFlag(flags[1])).toBe(true);
    expect(displayFlags(flags)).toEqual([flags[0]]);
  });

  it('submissionLine folds status + ref into one honest line', () => {
    const state: SubmissionState = {
      status: 'accepted',
      lastExternalRef: 'KMD-2026-06-001',
      submissionCount: 1,
      history: [],
    };
    expect(submissionLine(state)).toBe('Accepted · ref KMD-2026-06-001');
    expect(
      submissionLine({ ...state, status: 'not_started', lastExternalRef: null }),
    ).toBe('No submission recorded');
    expect(SUBMISSION_STATUS.accepted.tone).toBe('ok');
    expect(SUBMISSION_STATUS.rejected.tone).toBe('err');
  });
});

describe('hooks', () => {
  const wrapper = (qc: QueryClient) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    };

  it('useSubmissionStates fans out one query per locked period and combines a Map', async () => {
    vi.mocked(getSubmissionState).mockImplementation(async (id: number) => ({
      status: id === 5 ? 'accepted' : 'prepared',
      lastExternalRef: id === 5 ? 'R-5' : null,
      submissionCount: id === 5 ? 1 : 0,
      history: [],
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSubmissionStates([5, 6]), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get(5)?.status).toBe('accepted');
    expect(result.current.get(6)?.status).toBe('prepared');
    expect(getSubmissionState).toHaveBeenCalledTimes(2);
  });

  it('invalidateReports covers the reports prefix + shared periods + shared expenses', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await invalidateReports(qc);
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(reportsKeys.all);
    expect(keys).toContainEqual(sharedKeys.reportingPeriods);
    expect(keys).toContainEqual(sharedKeys.expenses);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/queries/reports.test.tsx
```

Expected: FAIL — module `./reports` does not exist.

- [ ] **Step 3: Implement `src/queries/reports.ts`**

```ts
import { useQueries, useQuery, type QueryClient } from '@tanstack/react-query';
import {
  getKmd,
  getPeriodConfig,
  getPeriodWarnings,
  getSubmissionState,
  type Expense,
  type ReportingPeriod,
  type SalesInvoice,
  type SubmissionState,
  type SubmissionStatus,
} from '../api';
import { monthLabel } from './books';
import { sharedKeys } from './keys';

/**
 * Reports data layer. The periods list itself comes from the SHARED
 * useReportingPeriods (frozen sharedKeys.reportingPeriods — the Inbox hero
 * already populates it); this module adds the Reports-only reads and the
 * PURE model (period titles, lexicographic membership, INF gaps, fold
 * labels) so everything is unit-testable without React.
 * NO refetchInterval anywhere here (Global Constraints).
 */
export const reportsKeys = {
  all: ['reports'] as const,
  kmd: (periodId: number) => ['reports', 'kmd', periodId] as const,
  warnings: (periodId: number) => ['reports', 'warnings', periodId] as const,
  submission: (periodId: number) =>
    ['reports', 'submission', periodId] as const,
  periodConfig: ['reports', 'period-config'] as const,
};

/** Derived on every read — live preview for open periods (Reality #5). */
export const useKmd = (periodId: number) =>
  useQuery({
    queryKey: reportsKeys.kmd(periodId),
    queryFn: () => getKmd(periodId),
  });

/** Advisory ADR-0015 stragglers — enabled only where shown (open periods). */
export const usePeriodWarnings = (periodId: number, enabled: boolean) =>
  useQuery({
    queryKey: reportsKeys.warnings(periodId),
    queryFn: () => getPeriodWarnings(periodId),
    enabled,
  });

export const useSubmissionState = (periodId: number, enabled: boolean) =>
  useQuery({
    queryKey: reportsKeys.submission(periodId),
    queryFn: () => getSubmissionState(periodId),
    enabled,
  });

/** Folded submission line per LOCKED period (list screen): one small request
 *  per locked period — periods are few (one per month/quarter). A batch
 *  endpoint is on the server follow-up list (Appendix A gap 4). */
export function useSubmissionStates(
  lockedIds: number[],
): Map<number, SubmissionState> {
  return useQueries({
    queries: lockedIds.map((id) => ({
      queryKey: reportsKeys.submission(id),
      queryFn: () => getSubmissionState(id),
    })),
    combine: (results) => {
      const map = new Map<number, SubmissionState>();
      results.forEach((r, i) => {
        if (r.data !== undefined) map.set(lockedIds[i], r.data);
      });
      return map;
    },
  });
}

export const usePeriodConfig = () =>
  useQuery({ queryKey: reportsKeys.periodConfig, queryFn: getPeriodConfig });

/** After any Reports mutation: Reports reads, the shared periods list, AND
 *  the shared expenses list (the INF fix patches an expense; the straggler /
 *  in-period sections join it). */
export function invalidateReports(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: reportsKeys.all }),
    qc.invalidateQueries({ queryKey: sharedKeys.reportingPeriods }),
    qc.invalidateQueries({ queryKey: sharedKeys.expenses }),
  ]).then(() => undefined);
}

// ── Pure model ─────────────────────────────────────────────────────────────

/** Server period names are compact plugin-frequency labels
 *  (period-dates.ts:105-127): '2026-06' | '2026-Q1' | '2026-H1' | '2026'.
 *  Humanize the known shapes; operator overrides pass through verbatim. */
export function periodTitle(name: string): string {
  if (/^\d{4}-\d{2}$/.test(name)) return monthLabel(name);
  const quarterly = /^(\d{4})-([QH]\d)$/.exec(name);
  if (quarterly) return `${quarterly[2]} ${quarterly[1]}`;
  return name;
}

type PeriodLike = Pick<ReportingPeriod, 'start_date' | 'end_date' | 'status'>;

/** Lexicographic ISO ordering — no Date construction (Global Constraints). */
export const sortPeriodsNewestFirst = <T extends { start_date: string }>(
  rows: T[],
): T[] => [...rows].sort((a, b) => b.start_date.localeCompare(a.start_date));

/** The LATEST open period — mirror of GET /current
 *  (reporting-periods.service.ts:93-106). */
export function currentOpen<T extends PeriodLike>(periods: T[]): T | null {
  const open = periods.filter((p) => p.status === 'open');
  if (open.length === 0) return null;
  return open.reduce((a, b) => (b.start_date > a.start_date ? b : a));
}

/** The OLDEST open period — the only one the server will lock (filing is
 *  strictly oldest-first, Reality #2). */
export function oldestOpen<T extends PeriodLike>(periods: T[]): T | null {
  const open = periods.filter((p) => p.status === 'open');
  if (open.length === 0) return null;
  return open.reduce((a, b) => (b.start_date < a.start_date ? b : a));
}

/** Inclusive membership by tax point — pure string math, timezone-proof. */
export const inPeriod = (
  isoDate: string,
  p: Pick<ReportingPeriod, 'start_date' | 'end_date'>,
): boolean => p.start_date <= isoDate && isoDate <= p.end_date;

/** Statuses that are LIVE in the books — posted, plus reversed (= corrected;
 *  the corrected figures are what is live — Plan 04 Reality #1). */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'posted',
  'reversed',
]);

/** Live expenses dated in the period, newest tax point first. */
export function periodExpenses(
  expenses: Expense[],
  p: Pick<ReportingPeriod, 'start_date' | 'end_date'>,
): Expense[] {
  return expenses
    .filter((e) => LIVE_STATUSES.has(e.status) && inPeriod(e.tax_point_date, p))
    .sort((a, b) => b.tax_point_date.localeCompare(a.tax_point_date));
}

/** Live sales invoices dated in the period, newest tax point first. */
export function periodInvoices(
  invoices: SalesInvoice[],
  p: Pick<ReportingPeriod, 'start_date' | 'end_date'>,
): SalesInvoice[] {
  return invoices
    .filter((i) => LIVE_STATUSES.has(i.status) && inPeriod(i.tax_point_date, p))
    .sort((a, b) => b.tax_point_date.localeCompare(a.tax_point_date));
}

/** Client mirror of the per-partner INF net threshold (€1000 in cents —
 *  kmd-inf.ts:13). The server stays the authority at download time; this
 *  only makes the gap list honest up front (Reality #11). */
export const INF_THRESHOLD_NET = 100000;

/**
 * In-period live expenses that the INF annex will likely itemise but which
 * have NO supplier invoice number. Approximation, clearly labeled in the UI:
 * the client cannot see VAT codes or reg-key presence, so it filters only on
 * supplier net ≥ threshold + missing number. B2C (no supplier) never gaps.
 */
export function infGapCandidates(
  expenses: Expense[],
  p: Pick<ReportingPeriod, 'start_date' | 'end_date'>,
): Expense[] {
  const live = periodExpenses(expenses, p);
  const netBySupplier = new Map<number, number>();
  for (const e of live) {
    if (e.supplier_id == null) continue;
    netBySupplier.set(
      e.supplier_id,
      (netBySupplier.get(e.supplier_id) ?? 0) +
        Math.abs(e.gross_amount - e.vat_amount),
    );
  }
  return live.filter(
    (e) =>
      e.supplier_id != null &&
      (netBySupplier.get(e.supplier_id) ?? 0) >= INF_THRESHOLD_NET &&
      !e.supplier_invoice_number,
  );
}

export type KmdRowKey =
  | 'row1_base_24'
  | 'row2_base_reduced'
  | 'row3_base_zero'
  | 'row4_output_vat'
  | 'row5_input_vat'
  | 'row6_intra_eu_acquisition'
  | 'row7_other_acquisition';

/** Human-first labels (data rule 3) with the statutory row number as the
 *  secondary fact — never "Row 5 — input VAT" as the headline. */
export const KMD_ROWS: { key: KmdRowKey; label: string }[] = [
  { key: 'row1_base_24', label: 'Sales taxed at 24% — net (row 1)' },
  { key: 'row2_base_reduced', label: 'Sales at reduced 9/13% — net (row 2)' },
  { key: 'row3_base_zero', label: 'Zero-rated sales — exports, intra-EU (row 3)' },
  { key: 'row4_output_vat', label: 'VAT charged on sales (row 4)' },
  { key: 'row5_input_vat', label: 'VAT deductible on purchases (row 5)' },
  { key: 'row6_intra_eu_acquisition', label: 'Purchases from the EU — net (row 6)' },
  { key: 'row7_other_acquisition', label: 'Other reverse-charged purchases — net (row 7)' },
];

/** net_vat_due < 0 means reclaimable (vat-report/types.ts:44-45). */
export const netVatLabel = (cents: number): string =>
  cents < 0 ? 'VAT to reclaim' : 'VAT to pay';

/** The one server flag that embeds raw cents (Reality #6) — replaced by the
 *  client's own VD row + notice. Substring match is documented brittleness;
 *  structured flags are a server follow-up (Appendix A gap 3). */
export const isVdFlag = (flag: string): boolean =>
  flag.includes('VD koondaruanne');

export const displayFlags = (flags: string[]): string[] =>
  flags.filter((f) => !isVdFlag(f));

export const SUBMISSION_STATUS: Record<
  SubmissionStatus,
  { label: string; tone: 'ok' | 'warn' | 'err' | 'muted' }
> = {
  not_started: { label: 'No submission recorded', tone: 'muted' },
  prepared: { label: 'Prepared — not submitted', tone: 'warn' },
  submitted: { label: 'Submitted — awaiting confirmation', tone: 'warn' },
  accepted: { label: 'Accepted', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'err' },
  correction_submitted: { label: 'Correction submitted', tone: 'warn' },
  correction_accepted: { label: 'Correction accepted', tone: 'ok' },
};

/** One folded status line per period (asset §7 decision 6). */
export function submissionLine(
  state: Pick<SubmissionState, 'status' | 'lastExternalRef'>,
): string {
  const base = SUBMISSION_STATUS[state.status].label;
  return state.lastExternalRef !== null
    ? `${base} · ref ${state.lastExternalRef}`
    : base;
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/queries/reports.test.tsx && npm test
```

Expected: PASS (11 tests); full suite PASS (pure additions only).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/queries/reports.ts packages/web/src/queries/reports.test.tsx
git commit -m "feat(web): reports query layer + pure model — period titles, in-period joins, INF gaps, fold labels"
```

---

### Task 4: ReportsScreen — periods list with hero, folded submission lines, NewPeriodSheet

**Files:**
- Create: `packages/web/src/reports/ReportsScreen.tsx`, `packages/web/src/reports/NewPeriodSheet.tsx`, `packages/web/src/reports/ReportsScreen.test.tsx`

**Interfaces:**
- Consumes: `useReportingPeriods` (`../queries/shared`), `useKmd`/`useSubmissionStates`/`usePeriodConfig`/`invalidateReports` + pure model (`../queries/reports`), `createNextPeriod`/`fmtCents` (`../api`), kit (`LargeTitleHeader`, `ListGroup`/`ListRow`, `GroupHeader`, `Chip`, `EmptyState`/`SkeletonRows`, `LoadError`, `Button`, `Sheet`, `Field`/`TextInput`, toasts), `absoluteDateFromIso` (`../inbox/format`).
- Produces: `ReportsScreen()` — hero card (current open period: title, date range, live net-VAT line, links to detail), year-grouped period rows (title = `periodTitle`, subtitle = date range, chip = `open` / `open — file first` / folded submission tone+label), header "＋ New period" → `NewPeriodSheet({ open, onOpenChange })` (server-computed next period + the legacy override fields).

- [ ] **Step 1: Write failing tests**

`src/reports/ReportsScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { ReportsScreen } from './ReportsScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getReportingPeriods: vi.fn(),
  getKmd: vi.fn(),
  getSubmissionState: vi.fn(),
  getPeriodConfig: vi.fn(),
  createNextPeriod: vi.fn(),
}));
import {
  createNextPeriod,
  getKmd,
  getPeriodConfig,
  getReportingPeriods,
  getSubmissionState,
} from '../api';

const PERIODS = [
  {
    id: 5,
    name: '2026-05',
    start_date: '2026-05-01',
    end_date: '2026-05-31',
    status: 'locked' as const,
    filed_at: 1749800000,
  },
  {
    id: 6,
    name: '2026-06',
    start_date: '2026-06-01',
    end_date: '2026-06-30',
    status: 'open' as const,
    filed_at: null,
  },
  {
    id: 7,
    name: '2026-07',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    status: 'open' as const,
    filed_at: null,
  },
];

const KMD = {
  reporting_period_id: 7,
  period_name: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  row1_base_24: 483000,
  row2_base_reduced: 0,
  row3_base_zero: 0,
  row4_output_vat: 106260,
  row5_input_vat: 43853,
  row6_intra_eu_acquisition: 0,
  row7_other_acquisition: 0,
  net_vat_due: 62407,
  vd_intra_eu_services: 0,
  review_flags: [],
};

function mountList(periods = PERIODS) {
  vi.mocked(getReportingPeriods).mockResolvedValue(periods as never);
  vi.mocked(getKmd).mockResolvedValue(KMD as never);
  vi.mocked(getSubmissionState).mockResolvedValue({
    status: 'accepted',
    lastExternalRef: 'KMD-2026-05-01',
    submissionCount: 1,
    history: [],
  } as never);
  vi.mocked(getPeriodConfig).mockResolvedValue({
    frequency_options: ['monthly'],
    default_frequency: 'monthly',
  } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/reports']}>
        <AppToaster />
        <Routes>
          <Route path="/reports" element={<ReportsScreen />} />
          <Route path="/reports/periods/:id" element={<div>PERIOD DETAIL</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ReportsScreen', () => {
  it('hero = the LATEST open period with a live net-VAT line, linking to its detail', async () => {
    mountList();
    expect(await screen.findByText('July 2026')).toBeInTheDocument();
    expect(screen.getByText('01.07.2026 – 31.07.2026')).toBeInTheDocument();
    expect(await screen.findByText(/VAT to pay so far/)).toBeInTheDocument();
    expect(screen.getByText(/624\.07 €/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /July 2026/ }),
    ).toHaveAttribute('href', '/reports/periods/7');
  });

  it('an EARLIER open period wears "open — file first"; locked rows fold submission state', async () => {
    mountList();
    expect(await screen.findByText('open — file first')).toBeInTheDocument();
    // June (earlier open) links to its detail too.
    expect(screen.getByRole('link', { name: /June 2026/ })).toHaveAttribute(
      'href',
      '/reports/periods/6',
    );
    // May is locked: one folded status line, with the ref (asset §7 decision 6).
    expect(
      await screen.findByText('Accepted · ref KMD-2026-05-01'),
    ).toBeInTheDocument();
    // No raw ids, no raw server names as titles.
    expect(screen.queryByText('2026-05')).toBeNull();
  });

  it('NewPeriodSheet: opens from the header, submits the server-computed next period', async () => {
    vi.mocked(createNextPeriod).mockResolvedValue({
      id: 8,
      name: '2026-08',
      start_date: '2026-08-01',
      end_date: '2026-08-31',
      status: 'open',
      filed_at: null,
    } as never);
    mountList();
    await screen.findByText('July 2026');
    fireEvent.click(screen.getByRole('button', { name: /New period/ }));
    expect(
      await screen.findByText(/computed from your monthly filing frequency/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open next period' }));
    await waitFor(() =>
      expect(createNextPeriod).toHaveBeenCalledWith({}),
    );
    expect(
      await screen.findByText('Period August 2026 opened'),
    ).toBeInTheDocument();
  });

  it('NewPeriodSheet: the legacy override fields still reach the endpoint', async () => {
    vi.mocked(createNextPeriod).mockResolvedValue({
      id: 9,
      name: 'special',
      start_date: '2026-08-01',
      end_date: '2026-08-15',
      status: 'open',
      filed_at: null,
    } as never);
    mountList();
    await screen.findByText('July 2026');
    fireEvent.click(screen.getByRole('button', { name: /New period/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Override dates/ }));
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-08-15' },
    });
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'special' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open next period' }));
    await waitFor(() =>
      expect(createNextPeriod).toHaveBeenCalledWith({
        start_date: '2026-08-01',
        end_date: '2026-08-15',
        name: 'special',
      }),
    );
  });

  it('empty state offers opening the first period', async () => {
    mountList([]);
    expect(await screen.findByText('No reporting periods yet')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open first period' }),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/reports/ReportsScreen.test.tsx
```

Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/reports/NewPeriodSheet.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createNextPeriod } from '../api';
import {
  invalidateReports,
  periodTitle,
  usePeriodConfig,
} from '../queries/reports';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/**
 * Create-next-period flow (POST /api/reporting-periods/next) — the legacy
 * KmdView's "Create next period" + "Override" pair as one sheet. The server
 * computes the next window from the plugin filing frequency; the optional
 * overrides survive from legacy (all three independent, all optional).
 * Overlap → server 409 surfaced verbatim (Reality #1).
 */
export function NewPeriodSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const configQ = usePeriodConfig();
  const [showOverride, setShowOverride] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const input: { start_date?: string; end_date?: string; name?: string } =
        {};
      if (startDate) input.start_date = startDate;
      if (endDate) input.end_date = endDate;
      if (name) input.name = name;
      return createNextPeriod(input);
    },
    onSuccess: async (p) => {
      await invalidateReports(qc);
      toastOk(`Period ${periodTitle(p.name)} opened`);
      onOpenChange(false);
    },
    onError: (e) =>
      toastErr(e instanceof Error ? e.message : 'Could not open the period'),
  });

  const frequency = configQ.data?.default_frequency;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New period">
      <div className="space-y-3 px-6">
        <p className="text-[13.5px] text-ink-2">
          The next period is computed from your
          {frequency ? ` ${frequency} ` : ' '}filing frequency — normally you
          just confirm.
        </p>
        {!showOverride && (
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => setShowOverride(true)}
          >
            Override dates…
          </Button>
        )}
        {showOverride && (
          <div className="space-y-3">
            <Field label="Start date">
              <TextInput
                type="date"
                aria-label="Start date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </Field>
            <Field label="End date" hint="Leave empty to compute from the start date">
              <TextInput
                type="date"
                aria-label="End date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </Field>
            <Field label="Name" hint="Leave empty for the standard name (e.g. 2026-08)">
              <TextInput
                aria-label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          </div>
        )}
        <Button
          className="w-full"
          busy={create.isPending}
          onClick={() => create.mutate()}
        >
          Open next period
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Implement `src/reports/ReportsScreen.tsx`**

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtCents, type ReportingPeriod } from '../api';
import { absoluteDateFromIso } from '../inbox/format';
import {
  currentOpen,
  netVatLabel,
  oldestOpen,
  periodTitle,
  sortPeriodsNewestFirst,
  submissionLine,
  SUBMISSION_STATUS,
  useKmd,
  useSubmissionStates,
} from '../queries/reports';
import { useReportingPeriods } from '../queries/shared';
import { LargeTitleHeader } from '../shell/Headers';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { GroupHeader } from '../ui/GroupHeader';
import { ListGroup, ListRow } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { Button } from '../ui/Button';
import { NewPeriodSheet } from './NewPeriodSheet';

const dateRange = (p: Pick<ReportingPeriod, 'start_date' | 'end_date'>) =>
  `${absoluteDateFromIso(p.start_date)} – ${absoluteDateFromIso(p.end_date)}`;

/** Hero for the CURRENT open period: identity + a live net-VAT line from the
 *  derived declaration (Reality #5). The whole card navigates to the detail. */
function CurrentPeriodHero({ period }: { period: ReportingPeriod }) {
  const kmdQ = useKmd(period.id);
  const net = kmdQ.data?.net_vat_due;
  return (
    <Link
      to={`/reports/periods/${period.id}`}
      viewTransition
      className="mx-3.5 mb-3.5 block rounded-2xl bg-accent-deep p-4 text-white"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-[19px] font-extrabold">
          {periodTitle(period.name)}
        </span>
        <Chip tone="ok">open</Chip>
      </div>
      <p className="mt-0.5 text-[12.5px] text-white/70">{dateRange(period)}</p>
      <p className="mt-2 whitespace-nowrap text-[14px] font-bold tabular-nums">
        {net === undefined
          ? 'Live declaration ›'
          : `${netVatLabel(net)} so far · ${fmtCents(Math.abs(net))} €`}
      </p>
    </Link>
  );
}

/** /reports — the periods list. Current open period as a hero; every other
 *  period one row with ONE honest status line: open / open — file first /
 *  the folded submission state (ADR-0037, asset §7 decision 6). */
export function ReportsScreen() {
  const periodsQ = useReportingPeriods();
  const [newOpen, setNewOpen] = useState(false);

  const periods = sortPeriodsNewestFirst(periodsQ.data ?? []);
  const current = currentOpen(periods);
  const oldest = oldestOpen(periods);
  const lockedIds = periods
    .filter((p) => p.status === 'locked')
    .map((p) => p.id);
  const submissionStates = useSubmissionStates(lockedIds);

  const rows = periods.filter((p) => p.id !== current?.id);
  const byYear = new Map<string, ReportingPeriod[]>();
  for (const p of rows) {
    const year = p.start_date.slice(0, 4);
    const bucket = byYear.get(year);
    if (bucket) bucket.push(p);
    else byYear.set(year, [p]);
  }

  const statusChipFor = (p: ReportingPeriod) => {
    if (p.status === 'open') {
      return p.id === oldest?.id && p.id !== current?.id ? (
        <Chip tone="warn">open — file first</Chip>
      ) : (
        <Chip tone="ok">open</Chip>
      );
    }
    const state = submissionStates.get(p.id);
    if (state === undefined) return <Chip tone="muted">locked</Chip>;
    return (
      <Chip tone={SUBMISSION_STATUS[state.status].tone}>
        {submissionLine(state)}
      </Chip>
    );
  };

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <LargeTitleHeader
        title="Reports"
        trailing={
          <Button variant="secondary" onClick={() => setNewOpen(true)}>
            ＋ New period
          </Button>
        }
      />
      {periodsQ.isPending && <SkeletonRows count={4} />}
      {periodsQ.isError && (
        <LoadError
          message={
            periodsQ.error instanceof Error
              ? periodsQ.error.message
              : 'Failed to load periods'
          }
          onRetry={() => void periodsQ.refetch()}
        />
      )}
      {periodsQ.isSuccess && periods.length === 0 && (
        <EmptyState
          icon="📄"
          title="No reporting periods yet"
          hint="Open the first period to start collecting the VAT declaration"
          action={
            <Button onClick={() => setNewOpen(true)}>Open first period</Button>
          }
        />
      )}
      {current != null && <CurrentPeriodHero period={current} />}
      {[...byYear.entries()].map(([year, ps]) => (
        <ListGroup
          key={year}
          label={<GroupHeader label={year} trailing={`${ps.length}`} />}
        >
          {ps.map((p) => (
            <ListRow
              key={p.id}
              to={`/reports/periods/${p.id}`}
              title={periodTitle(p.name)}
              subtitle={dateRange(p)}
              chip={statusChipFor(p)}
            />
          ))}
        </ListGroup>
      ))}
      {newOpen && (
        <NewPeriodSheet open onOpenChange={(o) => !o && setNewOpen(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/reports/ReportsScreen.test.tsx && npm test
```

Expected: PASS (5 tests); full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/reports
git commit -m "feat(web): reports periods list — open-period hero, folded submission lines, new-period sheet"
```

---

### Task 5: PeriodScreen — declaration detail (live/frozen marking, human KMD rows, VD notice, flags, downloads)

**Files:**
- Create: `packages/web/src/reports/PeriodScreen.tsx`, `packages/web/src/reports/PeriodScreen.test.tsx`

**Interfaces:**
- Consumes: `useReportingPeriods`, `useKmd`, `useSubmissionState`, pure model (Task 3), `downloadStatutoryReport`/`fmtCents` (`../api`), `absoluteDate`/`absoluteDateFromIso` (`../inbox/format`), kit (`ScreenHeader`, `ListGroup`/`KeyValue`/`GroupLabel`, `Chip`, `ListRow`, `Button`, `SkeletonRows`, `LoadError`, toasts).
- Produces: `PeriodScreen()` at `/reports/periods/:id`. Tasks 6 and 7 EDIT this file (they add the insight sections and the lock entry) — the markers are the two comments `{/* Task 6 sections mount here */}` and `{/* Task 7 lock entry mounts here */}`; the screen is complete and shippable without them.

- [ ] **Step 1: Write failing tests**

`src/reports/PeriodScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { PeriodScreen } from './PeriodScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getReportingPeriods: vi.fn(),
  getKmd: vi.fn(),
  getSubmissionState: vi.fn(),
  downloadStatutoryReport: vi.fn(),
  // Read by the Task 6 sections (mounted from this screen from Task 6 on):
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getPeriodWarnings: vi.fn(),
}));
import {
  downloadStatutoryReport,
  getEntities,
  getExpenses,
  getInvoices,
  getKmd,
  getPeriodWarnings,
  getReportingPeriods,
  getSubmissionState,
} from '../api';

const OPEN_PERIOD = {
  id: 7,
  name: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  status: 'open' as const,
  filed_at: null,
};
const LOCKED_PERIOD = {
  id: 6,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'locked' as const,
  // 2026-07-03 12:00 UTC — midday so the local-time render is 03.07.2026
  // in any CI timezone (absoluteDate uses the local clock).
  filed_at: 1783080000,
};

const KMD = {
  reporting_period_id: 7,
  period_name: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  row1_base_24: 483000,
  row2_base_reduced: 0,
  row3_base_zero: 0,
  row4_output_vat: 106260,
  row5_input_vat: 43853,
  row6_intra_eu_acquisition: 0,
  row7_other_acquisition: 0,
  net_vat_due: 62407,
  vd_intra_eu_services: 48200,
  review_flags: [
    'Reverse charge on row 6 vs 7 — confirm the split',
    'File the VD koondaruanne manually (tähis 3S) for 48200 cents of 0% intra-EU services — the system does not submit it.',
  ],
};

function mountAt(periodId: number, periods = [OPEN_PERIOD, LOCKED_PERIOD], kmd = KMD) {
  vi.mocked(getReportingPeriods).mockResolvedValue(periods as never);
  vi.mocked(getKmd).mockResolvedValue({
    ...kmd,
    reporting_period_id: periodId,
  } as never);
  vi.mocked(getSubmissionState).mockResolvedValue({
    status: 'submitted',
    lastExternalRef: 'KMD-2026-06-001',
    submissionCount: 1,
    history: [],
  } as never);
  vi.mocked(getExpenses).mockResolvedValue([] as never);
  vi.mocked(getInvoices).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue([] as never);
  vi.mocked(getPeriodWarnings).mockResolvedValue([] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/reports/periods/${periodId}`]}>
        <AppToaster />
        <Routes>
          <Route path="/reports/periods/:id" element={<PeriodScreen />} />
          <Route path="/reports" element={<div>REPORTS LIST</div>} />
          <Route
            path="/reports/periods/:id/submissions"
            element={<div>SUBMISSIONS</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PeriodScreen', () => {
  it('open period: LIVE marking, human-labeled boxes, highlighted net line', async () => {
    mountAt(7);
    expect(await screen.findByText('July 2026')).toBeInTheDocument();
    expect(screen.getByText(/Live preview/)).toBeInTheDocument();
    expect(
      screen.getByText('Sales taxed at 24% — net (row 1)'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('VAT deductible on purchases (row 5)'),
    ).toBeInTheDocument();
    expect(screen.getByText('4830.00 €')).toBeInTheDocument();
    expect(screen.getByText('438.53 €')).toBeInTheDocument();
    // Net line: human label + amount, tonal highlight.
    expect(screen.getByText('VAT to pay')).toBeInTheDocument();
    expect(screen.getByText('624.07 €')).toBeInTheDocument();
    // Legacy vocabulary is dead:
    expect(screen.queryByText(/Row 1 —/)).toBeNull();
  });

  it('VD 3S renders as the client row + manual notice; the raw-cents server flag is filtered', async () => {
    mountAt(7);
    expect(
      await screen.findByText('Intra-EU services for the VD report (3S)'),
    ).toBeInTheDocument();
    expect(screen.getByText('482.00 €')).toBeInTheDocument();
    expect(
      screen.getByText(/File the VD koondaruanne \(tähis 3S\) manually in e-MTA/),
    ).toBeInTheDocument();
    // The plugin flag survives; the raw-cents VD flag does not (Reality #6).
    expect(
      screen.getByText('Reverse charge on row 6 vs 7 — confirm the split'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/48200 cents/)).toBeNull();
  });

  it('locked period: FROZEN marking with the filing date and a submission-history row', async () => {
    mountAt(6);
    expect(await screen.findByText('June 2026')).toBeInTheDocument();
    expect(screen.getByText(/Frozen — closed 03\.07\.2026/)).toBeInTheDocument();
    const row = await screen.findByRole('link', {
      name: /Submission history/,
    });
    expect(row).toHaveAttribute('href', '/reports/periods/6/submissions');
    expect(
      screen.getByText('Submitted — awaiting confirmation · ref KMD-2026-06-001'),
    ).toBeInTheDocument();
  });

  it('negative net VAT reads as reclaimable', async () => {
    mountAt(7, [OPEN_PERIOD, LOCKED_PERIOD], { ...KMD, net_vat_due: -12345 });
    expect(await screen.findByText('VAT to reclaim')).toBeInTheDocument();
    expect(screen.getByText('123.45 €')).toBeInTheDocument();
  });

  it('downloads call the statutory endpoint per format and surface a failure', async () => {
    vi.mocked(downloadStatutoryReport)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(
        new Error(
          'Cannot generate a final KMD without a declarant VAT registration number',
        ),
      );
    mountAt(7);
    await screen.findByText('July 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Download XML' }));
    await waitFor(() =>
      expect(downloadStatutoryReport).toHaveBeenCalledWith(7, 'xml'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(
      await screen.findByText(/declarant VAT registration number/),
    ).toBeInTheDocument();
    // Open period → files are honestly labeled draft.
    expect(screen.getByText(/Draft files — the declaration can still change/)).toBeInTheDocument();
  });

  it('unknown period id gets an honest not-found state, not a spinner', async () => {
    mountAt(99);
    expect(
      await screen.findByText('This period does not exist'),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/reports/PeriodScreen.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/reports/PeriodScreen.tsx`**

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  downloadStatutoryReport,
  fmtCents,
  type KmdDeclaration,
  type ReportingPeriod,
} from '../api';
import { absoluteDate, absoluteDateFromIso } from '../inbox/format';
import {
  displayFlags,
  KMD_ROWS,
  netVatLabel,
  periodTitle,
  submissionLine,
  useKmd,
  useSubmissionState,
} from '../queries/reports';
import { useReportingPeriods } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { ListGroup, ListRow, KeyValue, GroupLabel } from '../ui/List';
import { LoadError } from '../ui/LoadError';
import { toastErr } from '../ui/toast';

/** Info banner — live vs frozen is THE §7 marking decision. */
function StatusBanner({ period }: { period: ReportingPeriod }) {
  if (period.status === 'open') {
    return (
      <div className="mx-3.5 mb-3.5 rounded-2xl bg-[#E3EFE8] px-4 py-3 text-[13px] text-accent">
        Live preview — recomputed from the posted books every time you open
        this screen.
      </div>
    );
  }
  return (
    <div className="mx-3.5 mb-3.5 rounded-2xl bg-surface px-4 py-3 text-[13px] text-ink-2">
      Frozen — closed{' '}
      {period.filed_at !== null ? absoluteDate(period.filed_at) : 'earlier'}.
      The declaration can no longer change; corrections go forward into the
      open period.
    </div>
  );
}

/** The declaration itself: seven human-labeled boxes + the highlighted net
 *  line + the VD 3S row with its manual-filing notice (Reality #5/#6). */
function DeclarationGroup({ decl }: { decl: KmdDeclaration }) {
  return (
    <>
      <GroupLabel>KMD declaration</GroupLabel>
      <div className="mx-3.5 mb-1.5 overflow-hidden rounded-2xl bg-surface">
        {KMD_ROWS.map((r) => (
          <KeyValue key={r.key} k={r.label} v={`${fmtCents(decl[r.key])} €`} />
        ))}
        <div className="flex items-center justify-between gap-4 bg-ok-bg px-3.5 py-2.5 text-sm">
          <span className="font-bold">{netVatLabel(decl.net_vat_due)}</span>
          <span className="whitespace-nowrap font-bold tabular-nums">
            {fmtCents(Math.abs(decl.net_vat_due))} €
          </span>
        </div>
      </div>
      {decl.vd_intra_eu_services > 0 && (
        <div className="mx-3.5 mb-3.5 space-y-1.5">
          <div className="overflow-hidden rounded-2xl bg-surface">
            <KeyValue
              k="Intra-EU services for the VD report (3S)"
              v={`${fmtCents(decl.vd_intra_eu_services)} €`}
            />
          </div>
          <p className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
            File the VD koondaruanne (tähis 3S) manually in e-MTA — the system
            does not submit it.
          </p>
        </div>
      )}
    </>
  );
}

function ReviewFlags({ flags }: { flags: string[] }) {
  const shown = displayFlags(flags);
  if (shown.length === 0) return null;
  return (
    <>
      <GroupLabel>Review before filing</GroupLabel>
      <div className="mx-3.5 mb-3.5 space-y-1.5">
        {shown.map((f) => (
          <p
            key={f}
            className="rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn"
          >
            {f}
          </p>
        ))}
      </div>
    </>
  );
}

function Downloads({ period }: { period: ReportingPeriod }) {
  const [busy, setBusy] = useState<'xml' | 'csv' | null>(null);
  const run = (format: 'xml' | 'csv') => {
    setBusy(format);
    downloadStatutoryReport(period.id, format)
      .catch((e) =>
        toastErr(e instanceof Error ? e.message : 'Download failed'),
      )
      .finally(() => setBusy(null));
  };
  return (
    <div className="mx-3.5 mb-3.5 space-y-1.5">
      <div className="flex gap-2.5">
        <Button
          variant="secondary"
          className="flex-1"
          busy={busy === 'xml'}
          onClick={() => run('xml')}
        >
          Download XML
        </Button>
        <Button
          variant="secondary"
          className="flex-1"
          busy={busy === 'csv'}
          onClick={() => run('csv')}
        >
          Download CSV
        </Button>
      </div>
      <p className="px-1 text-[12px] text-ink-2">
        {period.status === 'open'
          ? 'Draft files — the declaration can still change until the period is closed.'
          : 'Final files from the frozen declaration.'}
      </p>
    </div>
  );
}

/** /reports/periods/:id — the KMD declaration reimagined per the data-display
 *  rules: human labels, tabular cents, explicit live/frozen state (asset §7). */
export function PeriodScreen() {
  const { id } = useParams();
  const periodId = Number(id);
  const periodsQ = useReportingPeriods();
  const period = (periodsQ.data ?? []).find((p) => p.id === periodId);
  const kmdQ = useKmd(periodId);
  const submissionQ = useSubmissionState(
    periodId,
    period?.status === 'locked',
  );

  if (periodsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Period" backTo="/reports" />
        <SkeletonRows count={5} />
      </div>
    );
  }
  if (periodsQ.isError) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Period" backTo="/reports" />
        <LoadError
          message={
            periodsQ.error instanceof Error
              ? periodsQ.error.message
              : 'Failed to load periods'
          }
          onRetry={() => void periodsQ.refetch()}
        />
      </div>
    );
  }
  if (period === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Period" backTo="/reports" />
        <EmptyState
          icon="🔍"
          title="This period does not exist"
          hint="It may have been removed — go back to Reports"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader
        title={periodTitle(period.name)}
        backTo="/reports"
        trailing={
          <Chip tone={period.status === 'open' ? 'ok' : 'muted'}>
            {period.status}
          </Chip>
        }
      />
      <p className="mb-2 px-5 text-[12.5px] text-ink-2">
        {absoluteDateFromIso(period.start_date)} –{' '}
        {absoluteDateFromIso(period.end_date)}
      </p>
      <StatusBanner period={period} />
      {period.status === 'locked' && submissionQ.data !== undefined && (
        <ListGroup>
          <ListRow
            to={`/reports/periods/${period.id}/submissions`}
            title="Submission history"
            subtitle={submissionLine(submissionQ.data)}
          />
        </ListGroup>
      )}
      {kmdQ.isPending && <SkeletonRows count={4} />}
      {kmdQ.isError && (
        <LoadError
          message={
            kmdQ.error instanceof Error
              ? kmdQ.error.message
              : 'Failed to load the declaration'
          }
          onRetry={() => void kmdQ.refetch()}
        />
      )}
      {kmdQ.data !== undefined && (
        <>
          <DeclarationGroup decl={kmdQ.data} />
          <ReviewFlags flags={kmdQ.data.review_flags} />
        </>
      )}
      {/* Task 6 sections mount here */}
      <Downloads period={period} />
      {/* Task 7 lock entry mounts here */}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/reports/PeriodScreen.test.tsx && npm test
```

Expected: PASS (6 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/reports/PeriodScreen.tsx packages/web/src/reports/PeriodScreen.test.tsx
git commit -m "feat(web): period detail — live/frozen marking, human KMD rows, VD notice, review flags, downloads"
```

---

### Task 6: Period insight sections — INF gaps with in-place fix, stragglers, "dated in this period"

**Files:**
- Create: `packages/web/src/reports/sections.tsx`, `packages/web/src/reports/FixInvoiceNumberSheet.tsx`, `packages/web/src/reports/sections.test.tsx`
- Modify: `packages/web/src/reports/PeriodScreen.tsx` (mount the three sections)

**Interfaces:**
- Consumes: `useExpenses`/`useInvoices`/`useEntities` (`../queries/shared`), `usePeriodWarnings`/`infGapCandidates`/`periodExpenses`/`periodInvoices`/`invalidateReports` (`../queries/reports`), `entityName`/`shortDate` (`../queries/books` — reused, not duplicated), `setExpenseDocumentMetadata`/`fmtCents`/`type PeriodWarning` (`../api`), kit (`ListGroup`/`ListRow`/`GroupLabel`, `GroupHeader`, `AmountText`, `Sheet`, `Field`/`TextInput`, `Button`, toasts).
- Produces (from `src/reports/sections.tsx`): `InfGapsSection({ period })`, `StragglersSection({ period })` (renders nothing for locked periods), `InPeriodSection({ period })`; (from `FixInvoiceNumberSheet.tsx`): `FixInvoiceNumberSheet({ expense, supplierName, open, onOpenChange })`.
- **Honesty contract:** the INF section is labeled as a MAY-need list (client approximation, Reality #11); straggler rows NEVER render the server `description` (raw cents, Reality #8); the in-period section is labeled by DATE membership, not per-box composition (Reality #10), and carries the ADR-0009 redirect note.

- [ ] **Step 1: Write failing tests**

`src/reports/sections.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { InfGapsSection, InPeriodSection, StragglersSection } from './sections';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
  getPeriodWarnings: vi.fn(),
  setExpenseDocumentMetadata: vi.fn(),
}));
import {
  getEntities,
  getExpenses,
  getInvoices,
  getPeriodWarnings,
  setExpenseDocumentMetadata,
} from '../api';

const PERIOD = {
  id: 7,
  name: '2026-07',
  start_date: '2026-07-01',
  end_date: '2026-07-31',
  status: 'open' as const,
  filed_at: null,
};

const EXPENSES = [
  {
    id: 1,
    supplier_id: 3,
    category: 'rent',
    gross_amount: 122000,
    vat_amount: 22000,
    currency: 'EUR',
    tax_point_date: '2026-07-10',
    status: 'posted',
    reconciled: true,
    supplier_invoice_number: null,
  },
  {
    id: 2,
    supplier_id: 3,
    category: 'rent',
    gross_amount: 122000,
    vat_amount: 22000,
    currency: 'EUR',
    tax_point_date: '2026-07-11',
    status: 'posted',
    reconciled: false,
    supplier_invoice_number: 'A-9',
  },
  {
    id: 3,
    supplier_id: 3,
    category: 'rent',
    gross_amount: 12200,
    vat_amount: 2200,
    currency: 'EUR',
    tax_point_date: '2026-07-12',
    status: 'draft',
    reconciled: false,
    supplier_invoice_number: null,
  },
];

const INVOICES = [
  {
    id: 4,
    customer_id: 9,
    invoice_number: 'INV-12',
    gross_amount: 244000,
    vat_amount: 44000,
    currency: 'EUR',
    tax_point_date: '2026-07-05',
    due_date: null,
    document_id: null,
    status: 'posted',
    sent_at: null,
    reconciled: false,
  },
];

const ENTITIES = [
  { id: 3, role: 'supplier', country: 'EE', name: 'AS Merko Ehitus', goods_vs_services: null },
  { id: 9, role: 'customer', country: 'EE', name: 'OÜ Klient', goods_vs_services: null },
];

function mount(ui: ReactElement) {
  vi.mocked(getExpenses).mockResolvedValue(EXPENSES as never);
  vi.mocked(getInvoices).mockResolvedValue(INVOICES as never);
  vi.mocked(getEntities).mockResolvedValue(ENTITIES as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AppToaster />
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InfGapsSection', () => {
  it('lists only real gap candidates with supplier titles, and fixes in place', async () => {
    vi.mocked(setExpenseDocumentMetadata).mockResolvedValue({
      id: 1,
      supplier_invoice_number: 'A-183',
    } as never);
    mount(<InfGapsSection period={PERIOD} />);
    // Expense 1: supplier net ≥ 1000 € and no number → the ONE gap row.
    expect(
      await screen.findByText('INF annex — invoice numbers to add'),
    ).toBeInTheDocument();
    const gapRow = screen.getByRole('button', { name: /AS Merko Ehitus/ });
    expect(screen.queryAllByRole('button', { name: /AS Merko/ })).toHaveLength(1);
    // The honest approximation note is visible:
    expect(
      screen.getByText(/suppliers with over 1000\.00 € of purchases/i),
    ).toBeInTheDocument();
    fireEvent.click(gapRow);
    const input = await screen.findByLabelText('Supplier invoice number');
    fireEvent.change(input, { target: { value: 'A-183' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save number' }));
    await waitFor(() =>
      expect(setExpenseDocumentMetadata).toHaveBeenCalledWith(1, {
        supplier_invoice_number: 'A-183',
      }),
    );
    expect(await screen.findByText('Invoice number saved')).toBeInTheDocument();
  });

  it('locked period: gaps are read-only with an explanation, no sheet', async () => {
    mount(
      <InfGapsSection
        period={{ ...PERIOD, status: 'locked', filed_at: 1751500800 }}
      />,
    );
    expect(
      await screen.findByText('INF annex — invoice numbers to add'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/period is locked — numbers can no longer be edited/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /AS Merko Ehitus/ })).toBeNull();
  });

  it('renders nothing when there are no gaps', async () => {
    vi.mocked(getExpenses).mockResolvedValue([] as never);
    vi.mocked(getEntities).mockResolvedValue([] as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <InfGapsSection period={PERIOD} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getExpenses).toHaveBeenCalled());
    expect(container.textContent).not.toContain('INF annex');
  });
});

describe('StragglersSection', () => {
  it('shows typed rows joined against the shared lists — never the raw description', async () => {
    vi.mocked(getPeriodWarnings).mockResolvedValue([
      {
        type: 'pending_approval',
        object_type: 'expense',
        object_id: 3,
        description: 'Expense #3 (rent, EUR 12200) awaiting approval',
      },
      {
        type: 'unposted_draft',
        object_type: 'sales_invoice',
        object_id: 4,
        description: 'SalesInvoice #INV-12 (EUR 244000) still in draft',
      },
    ] as never);
    mount(<StragglersSection period={PERIOD} />);
    expect(
      await screen.findByText('Not decided in this period'),
    ).toBeInTheDocument();
    // Approval straggler → Inbox; draft straggler → Books drafts.
    expect(
      screen.getByRole('link', { name: /1 awaiting approval/ }),
    ).toHaveAttribute('href', '/inbox?seg=approvals');
    expect(
      screen.getByRole('link', { name: /1 invoice draft not posted/ }),
    ).toHaveAttribute('href', '/books?seg=invoices&status=draft');
    // Raw cents from the server description never render (Reality #8):
    expect(screen.queryByText(/EUR 244000/)).toBeNull();
  });

  it('renders nothing for a locked period (warnings are a pre-lock aid)', () => {
    const { container } = mount(
      <StragglersSection
        period={{ ...PERIOD, status: 'locked', filed_at: 1751500800 }}
      />,
    );
    // enabled=false → the query never fires and the section is null synchronously.
    expect(getPeriodWarnings).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Not decided');
  });
});

describe('InPeriodSection', () => {
  it('purchases + sales groups with totals; every row is a Books navigation', async () => {
    mount(<InPeriodSection period={PERIOD} />);
    expect(await screen.findByText('Purchases in this period')).toBeInTheDocument();
    expect(screen.getByText('−2440.00 € · 2')).toBeInTheDocument();
    expect(screen.getByText('Sales in this period')).toBeInTheDocument();
    expect(screen.getByText('+2440.00 € · 1')).toBeInTheDocument();
    // Draft expense 3 is NOT live → excluded from the count above.
    const expenseLinks = screen.getAllByRole('link', { name: /AS Merko Ehitus/ });
    expect(expenseLinks[0]).toHaveAttribute('href', '/books/expenses/2');
    expect(
      screen.getByRole('link', { name: /OÜ Klient/ }),
    ).toHaveAttribute('href', '/books/invoices/4');
    // The ADR-0009 redirect note is present, in human words:
    expect(
      screen.getByText(/re-dated into the next open period/i),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/reports/sections.test.tsx
```

Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `src/reports/FixInvoiceNumberSheet.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setExpenseDocumentMetadata, type Expense } from '../api';
import { invalidateReports } from '../queries/reports';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/**
 * The INF fix-in-place: PATCH /api/expenses/:id/document-metadata — no
 * ledger impact; the server 400s if the period locked meanwhile (race) and
 * that text surfaces verbatim (Reality #12). Mounted per-expense (remount
 * discipline: rendered only while open, keyed by the caller).
 */
export function FixInvoiceNumberSheet({
  expense,
  supplierName,
  open,
  onOpenChange,
}: {
  expense: Expense;
  supplierName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: () =>
      setExpenseDocumentMetadata(expense.id, {
        supplier_invoice_number: value.trim(),
      }),
    onSuccess: async () => {
      await invalidateReports(qc);
      toastOk('Invoice number saved');
      onOpenChange(false);
    },
    onError: (e) =>
      toastErr(e instanceof Error ? e.message : 'Could not save the number'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={supplierName ?? 'Add invoice number'}
    >
      <div className="space-y-3 px-6">
        <p className="text-[13.5px] text-ink-2">
          The INF annex itemises this purchase — the tax authority wants the
          supplier's invoice number on it. Copy it from the source document.
        </p>
        <Field label="Supplier invoice number">
          <TextInput
            aria-label="Supplier invoice number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. A-183"
          />
        </Field>
        <Button
          className="w-full"
          disabled={value.trim() === ''}
          busy={save.isPending}
          onClick={() => save.mutate()}
        >
          Save number
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Implement `src/reports/sections.tsx`**

```tsx
import { useState } from 'react';
import {
  fmtCents,
  type Expense,
  type PeriodWarning,
  type ReportingPeriod,
} from '../api';
import { entityName, shortDate } from '../queries/books';
import {
  INF_THRESHOLD_NET,
  infGapCandidates,
  periodExpenses,
  periodInvoices,
  usePeriodWarnings,
} from '../queries/reports';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { AmountText } from '../ui/AmountText';
import { GroupHeader } from '../ui/GroupHeader';
import { GroupLabel, ListGroup, ListRow } from '../ui/List';
import { FixInvoiceNumberSheet } from './FixInvoiceNumberSheet';

type PeriodProp = Pick<
  ReportingPeriod,
  'id' | 'start_date' | 'end_date' | 'status'
>;

/**
 * INF annex gaps — client-DERIVED (no JSON endpoint exposes INF rows,
 * Reality #11): live in-period expenses of ≥-threshold suppliers with no
 * supplier invoice number. Labeled as an approximation; the fix is real
 * (Reality #12) and only offered while the period is open.
 */
export function InfGapsSection({ period }: { period: PeriodProp }) {
  const expensesQ = useExpenses();
  const entitiesQ = useEntities();
  const [fixing, setFixing] = useState<Expense | null>(null);

  const entities = entitiesQ.data ?? [];
  const gaps = infGapCandidates(expensesQ.data ?? [], period);
  if (gaps.length === 0) return null;

  const locked = period.status === 'locked';

  return (
    <>
      <GroupLabel>INF annex — invoice numbers to add</GroupLabel>
      <ListGroup>
        {gaps.map((e) => {
          const supplier = entityName(entities, e.supplier_id);
          const subtitle = `${e.category} · ${shortDate(e.tax_point_date)} · no invoice number`;
          const trailing = (
            <AmountText cents={-e.gross_amount} className="block text-[14px]" />
          );
          return locked ? (
            <ListRow
              key={e.id}
              title={supplier ?? e.category}
              subtitle={subtitle}
              trailing={trailing}
            />
          ) : (
            <ListRow
              key={e.id}
              onClick={() => setFixing(e)}
              title={supplier ?? e.category}
              subtitle={subtitle}
              trailing={trailing}
            />
          );
        })}
      </ListGroup>
      <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
        {locked
          ? 'The period is locked — numbers can no longer be edited here; the filed INF is what it is.'
          : `The INF annex itemises suppliers with over ${fmtCents(INF_THRESHOLD_NET)} € of purchases this period — these entries have no supplier invoice number yet. The downloaded KMD stays the authority.`}
      </p>
      {fixing !== null && (
        <FixInvoiceNumberSheet
          key={fixing.id}
          expense={fixing}
          supplierName={entityName(entities, fixing.supplier_id)}
          open
          onOpenChange={(o) => !o && setFixing(null)}
        />
      )}
    </>
  );
}

/** Aggregate straggler rows: [count, label suffix, link] per bucket. */
function stragglerRows(warnings: PeriodWarning[]) {
  const buckets = [
    {
      match: (w: PeriodWarning) => w.type === 'pending_approval',
      label: (n: number) => `${n} awaiting approval`,
      subtitle:
        'they enter the declaration only once approved — approving after close posts into the next open period',
      to: '/inbox?seg=approvals',
    },
    {
      match: (w: PeriodWarning) =>
        w.type === 'unposted_draft' && w.object_type === 'expense',
      label: (n: number) =>
        `${n} expense ${n === 1 ? 'draft' : 'drafts'} not posted`,
      subtitle: 'drafts are not part of the declaration',
      to: '/books?seg=expenses&status=draft',
    },
    {
      match: (w: PeriodWarning) =>
        w.type === 'unposted_draft' && w.object_type === 'sales_invoice',
      label: (n: number) =>
        `${n} invoice ${n === 1 ? 'draft' : 'drafts'} not posted`,
      subtitle: 'drafts are not part of the declaration',
      to: '/books?seg=invoices&status=draft',
    },
  ];
  return buckets
    .map((b) => ({ ...b, count: warnings.filter(b.match).length }))
    .filter((b) => b.count > 0);
}

/**
 * ADR-0015's "stranded items stay visible": the advisory pre-lock warnings
 * as navigations into Inbox/Books. Open periods only (the endpoint is a
 * pre-close aid); the server NEVER blocks on these. The raw `description`
 * (embeds cents, Reality #8) is never rendered.
 */
export function StragglersSection({ period }: { period: PeriodProp }) {
  const warningsQ = usePeriodWarnings(period.id, period.status === 'open');
  const warnings = warningsQ.data ?? [];
  const rows = stragglerRows(warnings);
  if (period.status !== 'open' || rows.length === 0) return null;

  return (
    <>
      <GroupLabel>Not decided in this period</GroupLabel>
      <ListGroup>
        {rows.map((r) => (
          <ListRow
            key={r.to}
            to={r.to}
            title={r.label(r.count)}
            subtitle={r.subtitle}
          />
        ))}
      </ListGroup>
    </>
  );
}

/**
 * The honest §7 drill-down substitute (Reality #10): every LIVE document
 * DATED in the period, as real Books navigations — declaration → documents
 * → object detail in two taps. Labeled by date membership, never as per-box
 * composition (the box routing is country-plugin logic).
 */
export function InPeriodSection({ period }: { period: PeriodProp }) {
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();
  const entities = entitiesQ.data ?? [];

  const purchases = periodExpenses(expensesQ.data ?? [], period);
  const sales = periodInvoices(invoicesQ.data ?? [], period);
  if (purchases.length === 0 && sales.length === 0) return null;

  const purchasesTotal = purchases.reduce((s, e) => s + e.gross_amount, 0);
  const salesTotal = sales.reduce((s, i) => s + i.gross_amount, 0);

  return (
    <>
      {sales.length > 0 && (
        <ListGroup
          label={
            <GroupHeader
              label="Sales in this period"
              trailing={`+${fmtCents(salesTotal)} € · ${sales.length}`}
            />
          }
        >
          {sales.map((i) => (
            <ListRow
              key={i.id}
              to={`/books/invoices/${i.id}`}
              title={entityName(entities, i.customer_id) ?? i.invoice_number}
              subtitle={`${i.invoice_number} · ${shortDate(i.tax_point_date)}`}
              trailing={
                <AmountText
                  cents={i.gross_amount}
                  showSign
                  className="block text-[14px]"
                />
              }
            />
          ))}
        </ListGroup>
      )}
      {purchases.length > 0 && (
        <ListGroup
          label={
            <GroupHeader
              label="Purchases in this period"
              trailing={`−${fmtCents(purchasesTotal)} € · ${purchases.length}`}
            />
          }
        >
          {purchases.map((e) => (
            <ListRow
              key={e.id}
              to={`/books/expenses/${e.id}`}
              title={entityName(entities, e.supplier_id) ?? e.category}
              subtitle={`${e.category} · ${shortDate(e.tax_point_date)}`}
              trailing={
                <AmountText
                  cents={-e.gross_amount}
                  className="block text-[14px]"
                />
              }
            />
          ))}
        </ListGroup>
      )}
      <p className="mx-6 -mt-2 mb-3.5 text-[12px] text-ink-2">
        Documents dated in this period. Late corrections against a closed
        period are re-dated into the next open period and appear there
        instead.
      </p>
    </>
  );
}
```

- [ ] **Step 5: Mount the sections in `src/reports/PeriodScreen.tsx`**

Add the import:

```tsx
import { InfGapsSection, InPeriodSection, StragglersSection } from './sections';
```

Replace the `{/* Task 6 sections mount here */}` marker with:

```tsx
      <InfGapsSection period={period} />
      <StragglersSection period={period} />
      <InPeriodSection period={period} />
```

- [ ] **Step 6: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/reports/sections.test.tsx src/reports/PeriodScreen.test.tsx && npm test
```

Expected: PASS (sections 6 tests; PeriodScreen's existing tests stay green — its mocks already stub `getExpenses`/`getInvoices`/`getEntities`/`getPeriodWarnings` with empty lists, so the new sections render nothing there); full suite PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/reports
git commit -m "feat(web): period insights — INF gaps with in-place fix, stragglers, dated-in-period drill-down"
```

---

### Task 7: LockSheet — the ADR-0015 filing guard (warn-and-confirm, typed confirmation, no unlock)

**Files:**
- Create: `packages/web/src/reports/LockSheet.tsx`, `packages/web/src/reports/LockSheet.test.tsx`
- Modify: `packages/web/src/reports/PeriodScreen.tsx` (mount the lock entry), `packages/web/src/reports/PeriodScreen.test.tsx` (two gating pins)

**Interfaces:**
- Consumes: `lockPeriod`/`fmtCents` + types (`../api`), `usePeriodWarnings`/`invalidateReports`/`netVatLabel`/`periodTitle` (`../queries/reports`), `useExpenses`/`useInvoices`/`useEntities` (`../queries/shared`), `entityName` (`../queries/books`), kit (`Sheet`, `Field`/`TextInput`, `Button`, toasts).
- Produces: `LockSheet({ period, netVatDueCents, open, onOpenChange })`. PeriodScreen mounts it behind ONE primary button "Close period…" shown only when the period is open AND is the OLDEST open period (Reality #2 mirrored up front; the 409 still surfaces verbatim on a race); a later open period shows the honest "file it first" hint instead.
- **Guard semantics (binding):** warn-and-confirm, NEVER a hard block (ADR-0015 — the warnings list renders but the confirm stays available); confirmation is TYPED (the period `name`, e.g. `2026-06` — spec: "requires typed-out confirm"); the mutation is non-optimistic (plan→confirm→receipt); the copy states all four consequences (declaration freezes; postings dated inside are rejected; late items/corrections redirect forward, ADR-0009; there is NO unlock, Reality #3).

- [ ] **Step 1: Write failing tests**

`src/reports/LockSheet.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { LockSheet } from './LockSheet';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  lockPeriod: vi.fn(),
  getPeriodWarnings: vi.fn(),
  getExpenses: vi.fn(),
  getInvoices: vi.fn(),
  getEntities: vi.fn(),
}));
import {
  getEntities,
  getExpenses,
  getInvoices,
  getPeriodWarnings,
  lockPeriod,
} from '../api';

const PERIOD = {
  id: 6,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'open' as const,
  filed_at: null,
};

function mountSheet(warnings: unknown[] = []) {
  vi.mocked(getPeriodWarnings).mockResolvedValue(warnings as never);
  vi.mocked(getExpenses).mockResolvedValue([
    {
      id: 3,
      supplier_id: 3,
      category: 'rent',
      gross_amount: 12200,
      vat_amount: 2200,
      currency: 'EUR',
      tax_point_date: '2026-06-12',
      status: 'pending',
      reconciled: false,
      supplier_invoice_number: null,
    },
  ] as never);
  vi.mocked(getInvoices).mockResolvedValue([] as never);
  vi.mocked(getEntities).mockResolvedValue([
    {
      id: 3,
      role: 'supplier',
      country: 'EE',
      name: 'AS Merko Ehitus',
      goods_vs_services: null,
    },
  ] as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AppToaster />
        <LockSheet
          period={PERIOD}
          netVatDueCents={62407}
          open
          onOpenChange={onOpenChange}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('LockSheet', () => {
  it('states the consequences incl. redirect and NO unlock; confirm label carries the amount', async () => {
    mountSheet();
    expect(
      await screen.findByText(/declaration is frozen exactly as shown/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/rejected after closing/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/re-dated into the next open period/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/There is no unlock/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Close & freeze · VAT to pay 624.07 €',
      }),
    ).toBeInTheDocument();
  });

  it('typed confirmation gates the button; warnings NEVER block (ADR-0015)', async () => {
    vi.mocked(lockPeriod).mockResolvedValue({
      ...PERIOD,
      status: 'locked',
      filed_at: 1751500800,
    } as never);
    mountSheet([
      {
        type: 'pending_approval',
        object_type: 'expense',
        object_id: 3,
        description: 'Expense #3 (rent, EUR 12200) awaiting approval',
      },
    ]);
    // Human straggler line joined from the shared lists — never raw cents.
    expect(
      await screen.findByText(/AS Merko Ehitus · −122\.00 € — awaiting approval/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/EUR 12200/)).toBeNull();
    const confirm = screen.getByRole('button', {
      name: 'Close & freeze · VAT to pay 624.07 €',
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type 2026-06 to confirm'), {
      target: { value: '2026-06' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(lockPeriod).toHaveBeenCalledWith(6));
    expect(
      await screen.findByText('June 2026 closed — declaration frozen'),
    ).toBeInTheDocument();
  });

  it('surfaces the in-order 409 verbatim and stays open', async () => {
    vi.mocked(lockPeriod).mockRejectedValue(
      new Error(
        'Cannot file period 2026-06: earlier period 2026-05 is still open — file it first',
      ),
    );
    const { onOpenChange } = mountSheet();
    fireEvent.change(
      await screen.findByLabelText('Type 2026-06 to confirm'),
      { target: { value: '2026-06' } },
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Close & freeze · VAT to pay 624.07 €',
      }),
    );
    expect(
      await screen.findByText(/earlier period 2026-05 is still open/),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
```

Append to `src/reports/PeriodScreen.test.tsx` (inside the existing `describe`; the mock block already stubs everything these need — add `lockPeriod: vi.fn(),` to the `vi.mock('../api', …)` factory there):

```tsx
  it('the OLDEST open period offers "Close period…"', async () => {
    // June (id 6) is open and oldest-open when July is also open.
    mountAt(6, [
      { ...LOCKED_PERIOD, id: 5, name: '2026-05', start_date: '2026-05-01', end_date: '2026-05-31' },
      { ...LOCKED_PERIOD, id: 6, name: '2026-06', status: 'open', filed_at: null },
      OPEN_PERIOD,
    ]);
    expect(await screen.findByText('June 2026')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close period…' }),
    ).toBeInTheDocument();
  });

  it('a LATER open period gets the honest file-first hint instead of a lock button', async () => {
    mountAt(7, [
      { ...LOCKED_PERIOD, id: 6, name: '2026-06', status: 'open', filed_at: null },
      OPEN_PERIOD,
    ]);
    expect(await screen.findByText('July 2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close period…' })).toBeNull();
    expect(
      screen.getByText(/File June 2026 first — filing proceeds oldest-first/),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/reports/LockSheet.test.tsx src/reports/PeriodScreen.test.tsx
```

Expected: FAIL — `LockSheet` does not exist; the two new PeriodScreen pins find no button/hint.

- [ ] **Step 3: Implement `src/reports/LockSheet.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fmtCents,
  lockPeriod,
  type PeriodWarning,
  type ReportingPeriod,
} from '../api';
import { entityName } from '../queries/books';
import {
  invalidateReports,
  netVatLabel,
  periodTitle,
  usePeriodWarnings,
} from '../queries/reports';
import { useEntities, useExpenses, useInvoices } from '../queries/shared';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Form';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/**
 * The ADR-0015 filing guard: surface every unresolved in-period item, state
 * the consequences in human terms, and require an explicit TYPED confirm —
 * but never hard-block (deadlines are real; a straggler is handled next
 * period). Non-optimistic: plan → confirm → receipt. There is no unlock
 * (Reality #3) and the copy says so.
 */
export function LockSheet({
  period,
  netVatDueCents,
  open,
  onOpenChange,
}: {
  period: ReportingPeriod;
  netVatDueCents: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const warningsQ = usePeriodWarnings(period.id, open);
  const expensesQ = useExpenses();
  const invoicesQ = useInvoices();
  const entitiesQ = useEntities();

  const warnings = warningsQ.data ?? [];
  const expenses = expensesQ.data ?? [];
  const invoices = invoicesQ.data ?? [];
  const entities = entitiesQ.data ?? [];

  /** Human line per straggler, joined from the cached lists — the server
   *  `description` embeds raw cents and is never rendered (Reality #8). */
  const warningLine = (w: PeriodWarning): string => {
    const suffix =
      w.type === 'pending_approval' ? 'awaiting approval' : 'still a draft';
    if (w.object_type === 'expense') {
      const e = expenses.find((x) => x.id === w.object_id);
      if (e !== undefined) {
        const who = entityName(entities, e.supplier_id) ?? e.category;
        return `${who} · −${fmtCents(e.gross_amount)} € — ${suffix}`;
      }
      return `Expense — ${suffix}`;
    }
    const inv = invoices.find((x) => x.id === w.object_id);
    if (inv !== undefined) {
      const who = entityName(entities, inv.customer_id) ?? inv.invoice_number;
      return `${who} · +${fmtCents(inv.gross_amount)} € — ${suffix}`;
    }
    return `Invoice — ${suffix}`;
  };

  const lock = useMutation({
    mutationFn: () => lockPeriod(period.id),
    onSuccess: async () => {
      await invalidateReports(qc);
      toastOk(`${periodTitle(period.name)} closed — declaration frozen`);
      onOpenChange(false);
    },
    onError: (e) =>
      toastErr(e instanceof Error ? e.message : 'Could not close the period'),
  });

  const confirmLabel =
    netVatDueCents !== null
      ? `Close & freeze · ${netVatLabel(netVatDueCents)} ${fmtCents(Math.abs(netVatDueCents))} €`
      : 'Close & freeze the declaration';

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Close ${periodTitle(period.name)}`}
    >
      <div className="space-y-3 px-6">
        <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">
          <li>The declaration is frozen exactly as shown and filed as-is.</li>
          <li>
            Anything dated {period.start_date} – {period.end_date} will be
            rejected after closing.
          </li>
          <li>
            Late documents and corrections are re-dated into the next open
            period and surface in that return.
          </li>
          <li>
            There is no unlock. A mistake is fixed forward with a correction
            in the open period — never by reopening this one.
          </li>
        </ul>
        {warnings.length > 0 && (
          <div className="rounded-2xl bg-warn-bg px-4 py-3">
            <p className="text-[13px] font-semibold text-warn">
              Not decided yet — closing strands these until they are resolved
              in a later period:
            </p>
            <ul className="mt-1 space-y-0.5 text-[13px] text-warn">
              {warnings.map((w) => (
                <li key={`${w.object_type}-${w.object_id}-${w.type}`}>
                  {warningLine(w)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label={`Type ${period.name} to confirm`}>
          <TextInput
            aria-label={`Type ${period.name} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={period.name}
          />
        </Field>
        <Button
          className="w-full"
          disabled={typed.trim() !== period.name}
          busy={lock.isPending}
          onClick={() => lock.mutate()}
        >
          {confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Mount the lock entry in `src/reports/PeriodScreen.tsx`**

4a. Add imports:

```tsx
import { oldestOpen } from '../queries/reports';
import { LockSheet } from './LockSheet';
```

(Merge `oldestOpen` into the existing `../queries/reports` import list instead of a second import statement.)

4b. Inside `PeriodScreen`, after the `submissionQ` line, add:

```tsx
  const [lockOpen, setLockOpen] = useState(false);
  const oldest = oldestOpen(periodsQ.data ?? []);
```

and add `useState` to the react import of this file (it is already imported by `Downloads` — the file has one `import { useState } from 'react';` at the top; reuse it).

4c. Replace the `{/* Task 7 lock entry mounts here */}` marker with:

```tsx
      {period.status === 'open' && period.id === oldest?.id && (
        <div className="mx-3.5 mb-3.5">
          <Button className="w-full" onClick={() => setLockOpen(true)}>
            Close period…
          </Button>
        </div>
      )}
      {period.status === 'open' && oldest !== null && period.id !== oldest.id && (
        <p className="mx-6 mb-3.5 text-[12.5px] text-ink-2">
          File {periodTitle(oldest.name)} first — filing proceeds oldest-first.
        </p>
      )}
      {lockOpen && (
        <LockSheet
          key={period.id}
          period={period}
          netVatDueCents={kmdQ.data !== undefined ? kmdQ.data.net_vat_due : null}
          open
          onOpenChange={(o) => !o && setLockOpen(false)}
        />
      )}
```

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/reports/LockSheet.test.tsx src/reports/PeriodScreen.test.tsx && npm test
```

Expected: PASS (LockSheet 3 tests + PeriodScreen 8); full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/reports
git commit -m "feat(web): lock sheet — ADR-0015 warn-and-confirm with typed confirmation, stragglers, no-unlock honesty"
```

---

### Task 8: SubmissionsScreen — the ADR-0037 event timeline + operator "Add event"

**Files:**
- Create: `packages/web/src/reports/SubmissionsScreen.tsx`, `packages/web/src/reports/SubmissionsScreen.test.tsx`

**Interfaces:**
- Consumes: `useSubmissionState`/`invalidateReports`/`periodTitle`/`submissionLine`/`SUBMISSION_STATUS` (`../queries/reports`), `useReportingPeriods` (`../queries/shared`), `recordSubmissionEvent` + types (`../api`), `absoluteDate` (`../inbox/format`), kit (`ScreenHeader`, `Chip`, `Button`, `Sheet`, `Field`/`TextInput`/`SelectInput`, `EmptyState`/`SkeletonRows`, `LoadError`, toasts).
- Produces: `SubmissionsScreen()` at `/reports/periods/:id/submissions` — folded status header, chronological event timeline (`prepared` is system-emitted, Reality #9), rejected-status guidance (ADR-0037 §4: format → resubmit same snapshot; substance → correct forward), and `AddEventSheet` (internal component) recording `submitted | accepted | rejected | correction_submitted | correction_accepted` with optional confirmation ref + note. An OPEN period gets an honest gate (the server 404s operator events pre-lock).

- [ ] **Step 1: Write failing tests**

`src/reports/SubmissionsScreen.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppToaster } from '../ui/toast';
import { SubmissionsScreen } from './SubmissionsScreen';

vi.mock('../api', async (io) => ({
  ...(await io<typeof import('../api')>()),
  getReportingPeriods: vi.fn(),
  getSubmissionState: vi.fn(),
  recordSubmissionEvent: vi.fn(),
}));
import {
  getReportingPeriods,
  getSubmissionState,
  recordSubmissionEvent,
} from '../api';

const LOCKED = {
  id: 6,
  name: '2026-06',
  start_date: '2026-06-01',
  end_date: '2026-06-30',
  status: 'locked' as const,
  filed_at: 1783080000,
};
const OPEN = { ...LOCKED, id: 7, name: '2026-07', status: 'open' as const, filed_at: null };

// All midday UTC so the local-time render keeps the date in any CI timezone.
const HISTORY = [
  {
    id: 1,
    reporting_period_id: 6,
    event_kind: 'prepared' as const,
    external_ref: null,
    occurred_at: 1783080000, // 03.07.2026 12:00 UTC
    actor: 'system',
    note: null,
  },
  {
    id: 2,
    reporting_period_id: 6,
    event_kind: 'submitted' as const,
    external_ref: 'KMD-2026-06-001',
    occurred_at: 1783166400, // 04.07.2026 12:00 UTC
    actor: 'operator',
    note: 'Uploaded via e-MTA',
  },
  {
    id: 3,
    reporting_period_id: 6,
    event_kind: 'rejected' as const,
    external_ref: null,
    occurred_at: 1783252800, // 05.07.2026 12:00 UTC
    actor: 'operator',
    note: 'Schema error in the XML',
  },
];

function mountAt(periodId: number, status = 'rejected', history = HISTORY) {
  vi.mocked(getReportingPeriods).mockResolvedValue([LOCKED, OPEN] as never);
  vi.mocked(getSubmissionState).mockResolvedValue({
    status,
    lastExternalRef: 'KMD-2026-06-001',
    submissionCount: 1,
    history,
  } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/reports/periods/${periodId}/submissions`]}>
        <AppToaster />
        <Routes>
          <Route
            path="/reports/periods/:id/submissions"
            element={<SubmissionsScreen />}
          />
          <Route path="/reports/periods/:id" element={<div>PERIOD DETAIL</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SubmissionsScreen', () => {
  it('renders the folded status and the chronological event timeline', async () => {
    mountAt(6);
    // 'Rejected' appears as BOTH the folded chip and the timeline event.
    expect(await screen.findAllByText('Rejected')).toHaveLength(2);
    expect(
      screen.getByText('Prepared — declaration frozen at close'),
    ).toBeInTheDocument();
    expect(screen.getByText('Submitted to the tax authority')).toBeInTheDocument();
    expect(screen.getByText(/03\.07\.2026 · system/)).toBeInTheDocument();
    expect(
      screen.getByText(/04\.07\.2026 · operator · ref KMD-2026-06-001/),
    ).toBeInTheDocument();
    expect(screen.getByText('Uploaded via e-MTA')).toBeInTheDocument();
  });

  it('rejected status shows the two-path guidance (never reopens the period)', async () => {
    mountAt(6);
    expect(
      await screen.findByText(/A rejection never reopens the period/),
    ).toBeInTheDocument();
    expect(screen.getByText(/download the XML again and resubmit/i)).toBeInTheDocument();
    expect(screen.getByText(/correct forward in the open period/i)).toBeInTheDocument();
  });

  it('Add event records an operator-attested event with ref and note', async () => {
    vi.mocked(recordSubmissionEvent).mockResolvedValue({
      id: 4,
      reporting_period_id: 6,
      event_kind: 'accepted',
      external_ref: 'OK-1',
      occurred_at: 1783339200, // 06.07.2026 12:00 UTC
      actor: 'operator',
      note: null,
    } as never);
    mountAt(6);
    await screen.findAllByText('Rejected');
    fireEvent.click(
      screen.getByRole('button', { name: 'Record what happened…' }),
    );
    fireEvent.change(await screen.findByLabelText('What happened'), {
      target: { value: 'accepted' },
    });
    fireEvent.change(screen.getByLabelText('Confirmation reference'), {
      target: { value: 'OK-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record: Accepted' }));
    await waitFor(() =>
      expect(recordSubmissionEvent).toHaveBeenCalledWith(6, {
        event_kind: 'accepted',
        external_ref: 'OK-1',
      }),
    );
    expect(await screen.findByText('Recorded — Accepted')).toBeInTheDocument();
  });

  it('an OPEN period gets an honest gate instead of the timeline', async () => {
    mountAt(7, 'not_started', []);
    expect(
      await screen.findByText(/Close the period first/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Record what happened…' }),
    ).toBeNull();
    // The state query never fires pre-lock (the events attach to the snapshot).
    expect(getSubmissionState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/reports/SubmissionsScreen.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/reports/SubmissionsScreen.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  recordSubmissionEvent,
  type RecordableSubmissionKind,
  type SubmissionEvent,
  type SubmissionEventKind,
} from '../api';
import { absoluteDate } from '../inbox/format';
import {
  invalidateReports,
  periodTitle,
  submissionLine,
  SUBMISSION_STATUS,
  useSubmissionState,
} from '../queries/reports';
import { useReportingPeriods } from '../queries/shared';
import { ScreenHeader } from '../shell/Headers';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyState, SkeletonRows } from '../ui/Feedback';
import { Field, SelectInput, TextInput } from '../ui/Form';
import { LoadError } from '../ui/LoadError';
import { Sheet } from '../ui/Sheet';
import { toastErr, toastOk } from '../ui/toast';

/** Human timeline labels per event kind (ADR-0037 lifecycle). */
const EVENT_LABELS: Record<SubmissionEventKind, string> = {
  prepared: 'Prepared — declaration frozen at close',
  submitted: 'Submitted to the tax authority',
  accepted: 'Accepted',
  rejected: 'Rejected',
  correction_submitted: 'Correction (parandusdeklaratsioon) submitted',
  correction_accepted: 'Correction accepted',
};

/** Short labels for the picker + the outcome-stating button. */
const RECORDABLE: { value: RecordableSubmissionKind; label: string }[] = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'correction_submitted', label: 'Correction submitted' },
  { value: 'correction_accepted', label: 'Correction accepted' },
];

function EventRow({ event }: { event: SubmissionEvent }) {
  const meta = [absoluteDate(event.occurred_at), event.actor];
  if (event.external_ref !== null) meta.push(`ref ${event.external_ref}`);
  return (
    <div className="flex gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
      <span aria-hidden className="mt-1.5 h-2 w-2 flex-none rounded-full bg-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">
          {EVENT_LABELS[event.event_kind]}
        </p>
        <p className="text-[12.5px] text-ink-2">{meta.join(' · ')}</p>
        {event.note !== null && (
          <p className="mt-0.5 text-[12.5px] italic text-ink-2">{event.note}</p>
        )}
      </div>
    </div>
  );
}

/** Operator-attested lifecycle record (Reality #9) — the timestamp is the
 *  SERVER clock at recording, honestly not backdatable. */
function AddEventSheet({
  periodId,
  open,
  onOpenChange,
}: {
  periodId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<RecordableSubmissionKind>('submitted');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');

  const record = useMutation({
    mutationFn: () => {
      const input: {
        event_kind: RecordableSubmissionKind;
        external_ref?: string;
        note?: string;
      } = { event_kind: kind };
      if (ref.trim() !== '') input.external_ref = ref.trim();
      if (note.trim() !== '') input.note = note.trim();
      return recordSubmissionEvent(periodId, input);
    },
    onSuccess: async (ev) => {
      await invalidateReports(qc);
      toastOk(`Recorded — ${EVENT_LABELS[ev.event_kind]}`);
      onOpenChange(false);
    },
    onError: (e) =>
      toastErr(e instanceof Error ? e.message : 'Could not record the event'),
  });

  const label = RECORDABLE.find((r) => r.value === kind)?.label ?? kind;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Record what happened">
      <div className="space-y-3 px-6">
        <p className="text-[13.5px] text-ink-2">
          The system never talks to e-MTA — you report back what happened
          there and it goes on the permanent record.
        </p>
        <Field label="What happened">
          <SelectInput
            aria-label="What happened"
            value={kind}
            onChange={(e) =>
              setKind(e.target.value as RecordableSubmissionKind)
            }
          >
            {RECORDABLE.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Confirmation reference" hint="e-MTA reference, if any">
          <TextInput
            aria-label="Confirmation reference"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
        </Field>
        <Field label="Note">
          <TextInput
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <Button
          className="w-full"
          busy={record.isPending}
          onClick={() => record.mutate()}
        >
          Record: {label}
        </Button>
      </div>
    </Sheet>
  );
}

/** /reports/periods/:id/submissions — the append-only filing history
 *  (ADR-0037): fold status on top, the event log below, add-event on demand. */
export function SubmissionsScreen() {
  const { id } = useParams();
  const periodId = Number(id);
  const periodsQ = useReportingPeriods();
  const period = (periodsQ.data ?? []).find((p) => p.id === periodId);
  const locked = period?.status === 'locked';
  const stateQ = useSubmissionState(periodId, locked);
  const [addOpen, setAddOpen] = useState(false);

  const title =
    period !== undefined ? `${periodTitle(period.name)} — filing` : 'Filing';

  if (periodsQ.isPending) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Filing" backTo="/reports" />
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (period === undefined) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title="Filing" backTo="/reports" />
        <EmptyState icon="🔍" title="This period does not exist" />
      </div>
    );
  }
  if (!locked) {
    return (
      <div className="mx-auto max-w-3xl pb-6">
        <ScreenHeader title={title} backTo={`/reports/periods/${period.id}`} />
        <EmptyState
          icon="🗓️"
          title="Close the period first"
          hint="Submission events attach to the frozen declaration — an open period has nothing filed yet"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-6">
      <ScreenHeader
        title={title}
        backTo={`/reports/periods/${period.id}`}
        trailing={
          stateQ.data !== undefined ? (
            <Chip tone={SUBMISSION_STATUS[stateQ.data.status].tone}>
              {SUBMISSION_STATUS[stateQ.data.status].label}
            </Chip>
          ) : undefined
        }
      />
      {stateQ.isPending && <SkeletonRows count={3} />}
      {stateQ.isError && (
        <LoadError
          message={
            stateQ.error instanceof Error
              ? stateQ.error.message
              : 'Failed to load the filing history'
          }
          onRetry={() => void stateQ.refetch()}
        />
      )}
      {stateQ.data !== undefined && (
        <>
          <p className="mb-2 px-5 text-[12.5px] text-ink-2">
            {submissionLine(stateQ.data)}
            {stateQ.data.submissionCount > 1 &&
              ` · filed ${stateQ.data.submissionCount}×`}
          </p>
          <div className="mx-3.5 mb-3.5 overflow-hidden rounded-2xl bg-surface">
            {stateQ.data.history.map((ev) => (
              <EventRow key={ev.id} event={ev} />
            ))}
            {stateQ.data.history.length === 0 && (
              <p className="px-3.5 py-3 text-[13px] text-ink-2">
                No events recorded for this period yet.
              </p>
            )}
          </div>
          {stateQ.data.status === 'rejected' && (
            <div className="mx-3.5 mb-3.5 rounded-2xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
              A rejection never reopens the period. Wrong file format —
              download the XML again and resubmit, then record another
              "Submitted". Wrong figures — correct forward in the open period
              via Books, then record the correction here.
            </div>
          )}
          <div className="mx-3.5 mb-3.5">
            <Button className="w-full" onClick={() => setAddOpen(true)}>
              Record what happened…
            </Button>
          </div>
        </>
      )}
      {addOpen && (
        <AddEventSheet
          key={period.id}
          periodId={period.id}
          open
          onOpenChange={(o) => !o && setAddOpen(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full suite**

```bash
npx vitest run src/reports/SubmissionsScreen.test.tsx && npm test
```

Expected: PASS (4 tests); full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/reports/SubmissionsScreen.tsx packages/web/src/reports/SubmissionsScreen.test.tsx
git commit -m "feat(web): submissions timeline — ADR-0037 event log with operator-attested add-event"
```

---

### Task 9: Router swap + KmdView deletion (the last legacy Reports surface dies)

**Files:**
- Modify: `packages/web/src/shell/router.tsx`, `packages/web/src/shell/router.test.tsx`
- Delete (WITH its test): `packages/web/src/components/KmdView.tsx`, `packages/web/src/components/KmdView.test.tsx` — 2 files (verified both exist with `ls src/components | grep Kmd`).

**What SURVIVES (explicitly):** `LegacyTabs` — the `/settings` mount still consumes it with five legacy views (`router.tsx:88-102`); it dies in Plan 06 with the settings-legacy cluster (`CategoriesView`, `EnrollView`, `EntitiesView`, `MailboxSettings`, `OrgView`, `SettingsView`, `components/Table.tsx`). The api-layer period functions (`getReportingPeriods`, `createNextPeriod`, `downloadStatutoryReport`, `getKmd`, `createReportingPeriod`, `getPeriodConfig`) all have NEW consumers in `src/reports/`/`src/queries/` — nothing in `api.ts` is orphaned by this deletion (`createReportingPeriod` remains unconsumed transport, as it was before this plan).

**LEGACY_REDIRECTS:** `/kmd` and `/periods` already point at `/reports` (`router.tsx:41-42`) — no change needed; the redirect target simply stops being LegacyTabs.

- [ ] **Step 1: Update `src/shell/router.tsx`**

Remove the `KmdView` import; add:

```tsx
import { PeriodScreen } from '../reports/PeriodScreen';
import { ReportsScreen } from '../reports/ReportsScreen';
import { SubmissionsScreen } from '../reports/SubmissionsScreen';
```

Replace the whole `path: '/reports'` LegacyTabs route object with:

```tsx
        { path: '/reports', element: <ReportsScreen /> },
        { path: '/reports/periods/:id', element: <PeriodScreen /> },
        {
          path: '/reports/periods/:id/submissions',
          element: <SubmissionsScreen />,
        },
```

- [ ] **Step 2: Delete the legacy files**

```bash
cd packages/web
git rm src/components/KmdView.tsx src/components/KmdView.test.tsx
```

- [ ] **Step 3: Verify zero residual references**

```bash
grep -rn "KmdView" src/ && echo "FAIL: dangling references" || echo "ok: KmdView fully gone"
```

Expected: `ok: KmdView fully gone`. If any reference surfaces, STOP and investigate before proceeding.

- [ ] **Step 4: Update `src/shell/router.test.tsx`**

The screens all carry their own behavior tests — the router test pins MOUNTING and REDIRECTS only. Concretely (read the file first; it already mounts `buildRoutes()` in a `createMemoryRouter` for the `/inbox`, `/bank`, and `/books` routes — Plans 03/04 established the pattern and the api mocks):

1. Any existing assertion that `/reports` renders LegacyTabs content (the "VAT / KMD" tab label or the legacy `Period` select) is DELETED with the view.
2. Using the file's existing mount helper, add mounting pins for: `/reports` → the "Reports" heading renders; `/reports/periods/7` → the period ScreenHeader (or, with the empty-mock periods list, the "This period does not exist" honest state) renders; `/reports/periods/7/submissions` → the Filing header renders.
3. Extend the existing LEGACY_REDIRECTS coverage (the file already walks redirect entries): `/kmd` and `/periods` must land on pathname `/reports`.
4. Whatever api functions the newly mounted screens call on mount must be added to the file's existing `vi.mock('../api', …)` block: `getReportingPeriods`, `getKmd`, `getSubmissionState`, `getPeriodConfig`, `getPeriodWarnings` (all `mockResolvedValue([])`/minimal objects, matching how the file already stubs bank/inbox/books reads — `getKmd` needs a minimal `KmdDeclaration` object with all seven rows, `net_vat_due`, `vd_intra_eu_services: 0`, `review_flags: []`; `getSubmissionState` a `{ status: 'not_started', lastExternalRef: null, submissionCount: 0, history: [] }`).

If the file's existing structure diverges from this description, follow the FILE (it is the tested reality), keep the pins above as the acceptance bar, and disclose any deviation in the commit message.

- [ ] **Step 5: Full suite, lint, build; record the test arithmetic**

```bash
npm test && npm run lint && npm run build
```

Expected: PASS. Record in the commit message: tests before − (deleted `KmdView.test.tsx` count — read the run summary before deleting) + (this plan's new tests) = tests after (Plan 02 Task 12 discipline).

- [ ] **Step 6: Commit**

```bash
git add -A packages/web
git commit -m "feat(web): mount Reports routes, delete legacy KmdView (last Reports legacy surface)"
```

---

### Task 10: Final verification + browser smoke against a real backend

**Files:** none new; fixes only if verification fails.

- [ ] **Step 1: Full suite, lint, build**

```bash
npm test && npm run lint && npm run build
```

Expected: all tests PASS, no lint errors, `tsc -b` + vite build succeed.

- [ ] **Step 2: Grep-level invariants**

```bash
grep -rn "window.prompt\|window.confirm\|window.alert" src/reports src/queries && echo "FAIL: banned dialogs" || echo "ok: no banned dialogs"
grep -rn "refetchInterval" src/reports src/queries/reports.ts && echo "FAIL: stray polling" || echo "ok: no new polling"
grep -rn "vat-report" src/ --include='*.ts' --include='*.tsx' | grep -v "test\|// " | grep "reporting-periods.*vat-report" && echo "FAIL: the premature-snapshot trap (Reality #7)" || echo "ok: no snapshot generation from the client"
grep -rn "voucher\|debit\|credit_line\|account_code" src/reports --include='*.tsx' --include='*.ts' && echo "CHECK: possible ledger vocabulary leak" || echo "ok: no ledger vocabulary"
grep -rn "new Date(" src/reports src/queries/reports.ts && echo "FAIL: Date in a compare path" || echo "ok: lexicographic dates only"
grep -rn "\.description" src/reports && echo "FAIL: raw warning description rendered (Reality #8)" || echo "ok: warnings joined, not dumped"
```

Expected: the six `ok:` lines.

- [ ] **Step 3: Manual browser smoke — real backend at PORT=3210, init-token pattern**

The dev-proxy targets `:3000` (`vite.config.ts:9-13`), so the smoke runs against the server's OWN static serving of the built SPA (serve-static of `@headless-bookkeeping/web/dist`, `server/src/app.module.ts:70-85`) — no proxy involved, real production wiring:

```bash
# 1. Build the SPA the server will serve:
cd packages/web && npm run build

# 2. Boot the backend on 3210 with a SCRATCH data dir (first boot of an empty
#    DATA_DIR prints the one-time init token — api-token.service.ts:40-63):
cd ../server && DATA_DIR=/tmp/bk-smoke-plan05 PORT=3210 npm run start:dev
# → copy the "INIT API TOKEN (log once, store securely): <hex>" line

# 3. Open http://localhost:3210 → TokenGate → paste the init token.
```

Seed through the UI itself (Settings → Organization: country EE, org type, VAT registration number — needed for FINAL downloads, Reality #13; a couple of suppliers via Settings → Entities; expenses via Books "+" — including one supplier with > 1000 € net and a missing invoice number, one draft, and one pending approval via a low policy ceiling). Resize between ~390px and ≥1024px — every check on BOTH widths.

Periods list:
- `/reports` shows the empty state → "Open first period" creates one via the sheet (server-computed window); the hero appears with the live net-VAT line.
- "＋ New period" with override dates creates a custom period; an overlapping override → the 409 message surfaces as a toast, sheet stays open.
- With two open periods, the LATER one is the hero and the EARLIER one wears "open — file first".
- Legacy bookmarks `/kmd` and `/periods` land on `/reports`; F5 everywhere restores state.

Period detail (open):
- Human-labeled KMD rows match the entered expenses/invoices; net line says pay/reclaim correctly; NO "Row 5 —" vocabulary anywhere.
- "Live preview" banner present; create one more expense in Books, return → the numbers moved (derived read, Reality #5).
- INF section lists exactly the seeded gap; tapping it → sheet → save a number → toast, the row leaves the list, and the number shows up on the Books expense detail.
- Stragglers row counts match the seeded draft + pending items and navigate to `/inbox?seg=approvals` / `/books?seg=…&status=draft`.
- "Dated in this period" totals match Books month totals for the same range; rows navigate to the object details and back (browser back preserved).
- Download XML while open → file named per content-disposition, draft hint shown.

Lock flow:
- On the NON-oldest open period: no lock button, the "file first" hint names the right period.
- On the oldest: "Close period…" → sheet lists the stragglers as human lines (spot-check: no raw cents), the confirm button is disabled until the exact period name is typed, and its label carries the net VAT amount.
- Confirm → receipt toast → the detail flips to "Frozen — closed <today>" with the submission-history row reading "Prepared — not submitted"; the periods list now folds that state onto the row.
- Try Books: correct a posted expense dated in the now-locked period → the Books redirect notice appears (ADR-0009) and the new figures land in the OPEN period's declaration, not the locked one.
- Verify the locked declaration did NOT change after the correction (frozen for real).

Submissions:
- `/reports/periods/:id/submissions` on the locked period shows the system `prepared` event with date + actor.
- Record "Submitted" with a ref → timeline grows, fold chip updates, the list row now says "Submitted — awaiting confirmation · ref …".
- Record "Rejected" → the two-path guidance box appears; record another "Submitted" (format-rejection path, same snapshot) → `filed 2×` shows.
- Record "Accepted" → ok chip everywhere; the open period's submissions route shows the "Close the period first" gate.
- Download XML on the locked period → FINAL file; if the org VAT number is removed (Settings), the download surfaces the server's 400 message verbatim.

- [ ] **Step 4: Commit any smoke fixes**

```bash
git add -A packages/web && git commit -m "fix(web): reports smoke fixes"
```

(Skip if nothing needed fixing.)

---

## Appendix A — Server gaps & degradation (binding for this plan)

Every gap below is a SERVER gap this client-only plan degrades around. The client behavior is the contract; server work is queued for a later dedicated step.

| # | Spec/mockup expectation | Server reality (verified) | Client degradation in this plan | Exact server ask |
|---|---|---|---|---|
| 1 | Asset §7: each KMD row expands into its constituent objects, each clickable ("цифра трассируется до расхода в два тапа") | NO per-row breakdown endpoint; the only linkage is `GET /api/vat-reports/:id/vouchers` → raw voucher ids (`vat-report.controller.ts:68-79`) — ledger vocabulary ADR-0001/0030 forbids surfacing, and box routing lives inside the country plugin (`classifyKmd`) | The "dated in this period" section: client-side join over the shared lists by tax point (lexicographic), live statuses only, every row a real Books navigation; labeled by DATE membership, never as per-box composition | A per-box composition endpoint in business terms: `GET /api/reporting-periods/:id/kmd/rows/:rowKey` → `[{ object_type, object_id, counterparty, base_cents, vat_cents }]` |
| 2 | INF gaps link straight to the specific expense's missing field | INF rows/warnings exist only inside the download path (`kmd-inf.ts:26-67`); warnings become unstructured audit findings WITHOUT object refs (`statutory-report.service.ts:118-124`); each draft download re-creates findings (duplication quirk) | Client-derived candidate list (threshold mirror `INF_THRESHOLD_NET = 100000` = `kmd-inf.ts:13`), honestly labeled an approximation (VAT-code/reg-key checks are invisible client-side); fix-in-place via the REAL `PATCH …/document-metadata` | An INF preview endpoint: `GET /api/reporting-periods/:id/inf` → `{ rows, warnings: [{ code, expense_id, counterparty }] }`; dedupe the findings on repeat draft renders |
| 3 | Reasons in human language with formatted numbers (data rule 3) | The VD review flag embeds RAW CENTS (`"for 48200 cents of…"`, `vat-report.service.ts:361-366`); `PeriodWarning.description` embeds raw cents too (`reporting-periods.service.ts:262,280,298,316`) | The VD flag is filtered by the `'VD koondaruanne'` substring and replaced by the client's own VD row + notice (documented brittleness); warning descriptions are never rendered — rows are joined from cached lists | Structured review flags (`{ code, params }`) and warnings without pre-baked prose (or euro-formatted prose) |
| 4 | Periods list shows the folded submission state on every row | Fold state is per-period only (`GET /:id/submission-state`); the list endpoint carries no fold | `useSubmissionStates` fans out one request per LOCKED period (small N — monthly/quarterly cadence) | Include the folded `submission_status` (+ last ref) on the periods list response, or add a batch state endpoint |
| 5 | ADR-0015: a large post-lock correction produces an AMENDED snapshot (v2) that supersedes the filing | `vat_report` is one-per-period, return-existing (`vat-report.service.ts:44-52`); operator events always pin to the ORIGINAL snapshot (`statutory-submission.service.ts:122-147`); no amendment machinery | `correction_submitted/accepted` events record honestly as lifecycle facts; no fake "v2" language anywhere | Amended-snapshot support per ADR-0015 (new snapshot referencing v1, `source_snapshot_id` of correction events pointing at it) |
| 6 | Operators sometimes need to remove a mistakenly created period | `deleteEmptyPeriod` is CLI-only (`cli.ts:241`); no REST DELETE | No delete affordance; the NewPeriodSheet's overlap-409 surfacing prevents most mistakes up front | Optional: expose `DELETE /api/reporting-periods/:id` (empty-open-only, same service guard) |
| 7 | Submission events carry when it REALLY happened at e-MTA | `occurred_at` is the server clock at recording (`statutory-submission.service.ts:33-35,48`); no backdating field | The timeline shows the recorded-at date labeled by actor; no fake "happened at" | Optional `occurred_at` override on the record DTO (audit-logged) if operators demand it |

**Deliberately NOT on the ask list:** unlock (the no-unlock invariant is the design, Reality #3) and client-callable snapshot generation (the trap, Reality #7).

## Appendix B — Follow-ups for later plans

- **Plan 06 (Settings):** extract the shared `?seg=` + legacy-`?tab=` alias hook — after this plan the inline pattern still has its occurrences in `InboxScreen`/`BooksScreen` and Settings will add the third-plus consumer (Reports added NONE — no segments); delete `LegacyTabs` + the five legacy settings views + `components/Table.tsx`; wire entity links (`/settings/entities/:id`) so the LockSheet straggler lines and in-period rows can name-link suppliers/customers; token sweep + a11y pass (accumulated Plan 01-04 triage).
- **Desktop power:** two-pane list+detail for Reports (`lg:` — periods list pane + period detail via `<Outlet/>`), matching the spec's desktop vision; ⌘K entries for periods.
- **`ui/Timeline` promotion:** `EventRow` in `SubmissionsScreen.tsx` is the first timeline consumer; promote to `src/ui/Timeline.tsx` when a second appears (annual accounts / fixed assets are the likely candidates — the spec reserves layout room).
- **Inbox `?period=` filter:** the stragglers row links to `/inbox?seg=approvals` unfiltered (Plan 03's Appendix B already flagged a `?period=` filter "if operators ask for it") — revisit when approvals volume grows.
- **Server list (new items from this plan):** per-box KMD composition (gap 1); INF preview endpoint + findings dedupe (gap 2); structured flags/warnings (gap 3); folded submission state on the list (gap 4); amended-snapshot support per ADR-0015 (gap 5); optional REST period delete (gap 6); optional `occurred_at` override (gap 7). Carried from Plan 04: corrections-history endpoint, `discarded` document status, object→bank-match refs, waiting-document persistence, `GET /api/sales-invoices/:id`, cosmetic attachment replacement, VAT-rate exposure.

## Appendix C — Spec coverage map (self-review)

Spec Reports bullet → this plan: "periods list: open/locked + folded submission state" → Task 4 ✅ (hero = latest open, `open — file first` for earlier open per Reality #14, one folded chip per locked row via `useSubmissionStates` + `submissionLine`); "KMD preview clearly labeled live draft vs frozen snapshot" → Task 5 ✅ (`StatusBanner`, live wording honest about derive-on-read, frozen wording carries `filed_at`); "KMD boxes (expandable)" → DEGRADED honestly (Reality #10 / gap 1 — `InPeriodSection` gives the two-tap trace to Books details; no fake per-box expansion) ✅; "review flags" → Task 5 ✅ (verbatim plugin sentences; the raw-cents VD flag filtered and replaced, Reality #6); "INF gaps with fix-link (`PATCH .../document-metadata`)" → Task 6 ✅ (client-derived gaps with the mirrored threshold + `FixInvoiceNumberSheet` on the REAL endpoint, open-periods-only per Reality #12 — this also closes Plan 04 Appendix B's routed item "INF-gap fix-links… from Reports directly"); "unresolved in-period items" → Task 6 ✅ (`StragglersSection` typed rows → `/inbox?seg=approvals`, `/books?seg=…&status=draft` — Plan 04's routed link targets); "downloads (XML/CSV)" → Task 5 ✅ (existing blob transport; draft/final honesty + the 400 surfaced, Reality #13); "lock flow lists stragglers and requires typed-out confirm" (`/lock`, ADR-0015) → Task 7 ✅ (warn-and-confirm never blocks; typed period name; consequences incl. redirect + NO unlock; 409 verbatim; implemented as a keyed sheet — deviation from the spec's route form documented in the Architecture header); "submissions screen is an append-only timeline with add event (submitted/accepted/rejected + ref)" (ADR-0037) → Task 8 ✅ (fold header, chronological events with actor/date/ref/note, recordable kinds exactly the server's zod set, open-period gate matching the server 404, rejection two-path guidance per ADR-0037 §4); "Reports must explain redirected corrections if the server exposes that" → exposed only per-correction (Reality #4): explained in the LockSheet consequences + the InPeriodSection footnote; no fake per-period redirect list ✅; "layout reserves room for annual accounts and fixed assets" → the periods-list year grouping + the detail's section stack leave natural insertion points; nothing hardcodes KMD-only navigation ✅. Asset §7 decisions: drill-down → gap 1 degradation ✅; live vs frozen marking ✅; INF warning leads to the concrete expense field ✅; straggler tail visible with Inbox link ✅; lock sheet-flow with "поздние документы уйдут в следующий период" copy ✅; period list fold + timeline with Add event ✅. Mandate carry-overs: `GroupHeader` extracted to `src/ui/` with both Books copies refactored (Task 2) ✅; `?seg=` hook explicitly NOT extracted (Reports has no segments) with the decision recorded (Task 2 + Appendix B) ✅; create-next-period preserved incl. legacy override fields (Task 4, `POST /next` verified) ✅; router swap + `KmdView.tsx` + `KmdView.test.tsx` deleted, zero residual references (Task 9) ✅; browser smoke on a real backend at `PORT=3210` with the boot-log init-token pattern (Task 10, serve-static path verified `app.module.ts:70-85`, token bootstrap `api-token.service.ts:40-63`) ✅. Global constraints carried: tokens + sanctioned one-offs only; English copy; one primary per state with outcome-stating labels (lock button carries the net VAT amount); amounts never wrap; no `window.*`; no ledger vocabulary; lexicographic ISO dates (grep-enforced in Task 10); NO new polling; sheet remount discipline (`key={id}` / render-while-open on `NewPeriodSheet`, `FixInvoiceNumberSheet`, `LockSheet`, `AddEventSheet`); non-optimistic irreversible lock with receipt; commit style; suite green per task. Placeholder scan: none — every code block is complete and runnable as written; the two PeriodScreen mount markers are consumed by Tasks 6/7 within this plan. Type consistency: every client field verified against server source (`reporting-periods/types.ts:4-15,35-40`, `statutory-submission/types.ts:5-65`, `expenses/types.ts:19`, `corrections/types.ts:29-35`, `vat-report/types.ts:25-50`); every referenced api export verified present in `src/api.ts` (`getReportingPeriods`, `createReportingPeriod`, `getPeriodConfig`, `createNextPeriod`, `getKmd`, `downloadStatutoryReport`, `fmtCents`, `getExpenses`, `getInvoices`, `getEntities`, `getExpense`) plus the six Task 1 adds (`lockPeriod`, `getPeriodWarnings`, `getSubmissionState`, `recordSubmissionEvent`, `setExpenseDocumentMetadata`, widened `Expense`/`ReportingPeriod`); helper imports verified (`monthLabel`/`entityName`/`shortDate` in `queries/books.ts`, `absoluteDate`/`absoluteDateFromIso` in `inbox/format.ts`, `useReportingPeriods`/`useExpenses`/`useInvoices`/`useEntities` in `queries/shared.ts`, kit components incl. the new `ui/GroupHeader.tsx`, `sharedKeys` frozen in `queries/keys.ts`).




