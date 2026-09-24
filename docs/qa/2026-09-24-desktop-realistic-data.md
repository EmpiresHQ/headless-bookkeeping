# QA-010: Desktop at realistic data volumes (issue #303)

This is a verification task, not an assumed bug. The run was a bounded,
mocked Chromium matrix at **1440×900** and **1920×1080** CSS px, DPR 1, on
`main` `f83cee8`. No product code, tests, configs or app assets were changed.
**No real backend was involved.** Every `/api` and `/admin` request was answered
by an in-page Playwright mock. The only writes were mocked Bank "Book" POSTs, and
the corrected run never reached them (see below). **Native iOS is out of scope
for this issue and was not run. No physical desktop browser and no Safari,
Firefox or Edge were used.**

Absence of a split-pane layout is not treated as a defect (per the issue).

## Verdict

| Area                                                           | Status                                                                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold load of 1k-row lists (Books, Inbox, Bank statement)       | Run, 1440 + 1920. **Pass**. 0.4–1.0 s to the full row set (table below)                                                                                                  |
| Repeated navigation (10 sidebar rounds)                        | Run, 1440 + 1920. **Pass**. Stable timings, heap back to 7–19 MB after each round, no DOM growth, 0 page errors                                                            |
| Scroll through 1k rows; fixed sidebar                          | Run, 1440 + 1920. **Pass**. p50 frame 16.7 ms; sidebar stays `position: fixed` at y=0; bottom reachable; no horizontal overflow                                           |
| Row layout with long names/amounts (xl columns)                | Run, 1440 + 1920. **Pass**. 0 overlapping cells and 0 overflowing rows across 1200 expense, 1000 Inbox and 1000 document rows                                            |
| Row open → Back position restore (Inbox, deep rows up to #990) | Run, 1440 + 1920. **Pass**. Δtop 0 px, the row is focused, the URL is kept                                                                                                |
| Search result correctness (`fill`)                             | Run at 1440 (debug check). **Pass**: Books "Showing 77 of 1200 expenses", Inbox "Showing 20 of 1000 tasks"; both equal the independent fixture computation              |
| Bank statement counts, preselection, Book amount               | Run, 1440 + 1920. **Pass**: `Unmatched 800` / `All 1000`, 200 of 300 proposals preselected (high confidence), button "Book 200 matches −170925.21 € net" = independent sum |
| Missing Bank "Book" button (run2 symptom)                      | **Harness timing, not a product defect.** Confirmed from rendered DOM and source (below)                                                                                 |
| Dropped search keystrokes (typing symptom)                     | **UNCONFIRMED candidate.** Reproduced only by synthetic Playwright key events; not independently confirmed; **no issue filed** (below)                                    |
| Books search/filter/date-range/order latency, Books open→Back  | **NOT MEASURED in the final run.** The case stopped at its keystroke step (the typing symptom)                                                                             |
| Bank search, Book (mocked) timing, Bank open→Back              | **NOT MEASURED in the final run** (same reason). Only the Bank load, counts, toggle, All-segment and scroll figures are final                                               |
| Real backend latency, server-side preview cost, real HTTP/1.1  | **NOT TESTED** (in-page mock; no connection-pool queueing is modelled)                                                                                                     |
| Native iOS / physical devices / other desktop browsers         | **NOT TESTED**                                                                                                                                                             |

**Confirmed product defects: none.** One candidate remains open (C1). Two
observations about scale follow (O1, O2).

## Set-up

- **Build:** a fresh production build of `packages/web` at `f83cee8`:
  `vite build --outDir ../../.review-303/dist` (exit 0, 6.8 s).
  `index.html` sha256 `0088245…f430`; `assets/index-B89dC_Y3.js` sha256
  `3a68762…37fb`. It was served by `vite preview` on `127.0.0.1:5371`, PID 571437,
  which was stopped afterwards. Port 5371 is free.
  - Caution: `vite preview` inherits the dev proxy (`/api` → `localhost:3000`),
    and port 3000 has a live local server on this host. The harness therefore
    answered **every** `/api` and `/admin` request in-page and aborted other
    origins. Nothing was proxied.
- **Browser:** Playwright 1.63.0 with its bundled headless Chromium
  (`chromium_headless_shell-1243`). Flags: `--js-flags=--expose-gc
  --enable-precise-memory-info` (for heap readings after `gc()`). Desktop
  contexts, no touch, DPR 1. Env: `TMPDIR=/root/.cache/hbk-browser-tmp`,
  `LD_LIBRARY_PATH=/tmp/hbk-browser-libs/root/usr/lib`,
  `FONTCONFIG_FILE=/tmp/hbk-browser-libs/fonts.conf`.
- **Machine:** Linux, Intel Core i5-7400T @ 2.40 GHz (4 cores), 7 GB RAM,
  Node 24.21.0. Load average was about 1 during the runs. All timings are
  harness wall-clock (Playwright round-trips included) on this machine and are
  indicative, not a performance budget.
- **App libs (from the existing `node_modules`):** react-router 7.18.0, React 18.

### Fixtures (deterministic, seed 303, generated in memory)

Generated on every run by `buildData(303)`. **No fixture files were saved.**

| Set                        | Size  | Variety                                                                                                                                                                          |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entities                   | 450   | 300 suppliers, 150 customers. Estonian/Latvian/Lithuanian/Polish/German names with diacritics (`Põhja-Eesti`, `Rīgas`, `Łódź`, `Müller & Söhne`). Every 37th name is ~96 characters |
| Expenses                   | 1200  | 2025-01-01…2026-09-24. Amounts 0.01 € … 12.3 M € (heavy tail). 5 % USD. Statuses draft 198 / pending 101 / posted 847 / reversed 54. 20 % without a supplier invoice number        |
| Sales invoices             | 1000  | Same distributions                                                                                                                                                               |
| Documents (archive)        | 1000  | 800 linked to expenses. Every 41st has a long filename                                                                                                                           |
| Inbox: needs-triage        | 600   | 7 reason types. Every 29th has a long filename. Some "today"                                                                                                                     |
| Inbox: pending approvals   | 400   | Expense approvals, 3 policy reasons                                                                                                                                              |
| Bank statements            | 24    | Statement #3: 2026-01-01…09-30 with **1000 lines**: 200 matched (active), 300 with AI proposals (200 high, 100 medium), 500 open                                                 |
| Reporting periods          | 2     | 2026-09 open, 2026-08 locked                                                                                                                                                     |
| Document preview (`/preview`) | —  | 1×1 PNG, 0 ms delay                                                                                                                                                              |

Search needle `kalamaja` occurs only in entity names. Expected counts
computed independently from the fixture: 77 expenses, 16 of them drafts; 20
Inbox tasks; Q1 2026 has 194 expenses, the largest EUR one 11 931 267.58 €.

## Results (final run, `final-results.json`)

Runner exit 1: 4/10 cases fully passed. Every failure is explained under
"Harness failures" below. The measured steps that completed are reported here.
There were **0 page errors and 0 unhandled requests in every case**, and **0
non-GET requests** (no mutation was reached).

### Load, navigation, scroll

| Measure                                              | 1440                          | 1920                          |
| ---------------------------------------------------- | ----------------------------- | ----------------------------- |
| Books › Expenses cold load to 1200 rows              | 684 ms                        | 621 ms                        |
| Inbox cold load to 1000 rows                         | 984 ms                        | 802 ms                        |
| Bank statement #3 load to 200 preselected            | 420 ms                        | 484 ms                        |
| Books › Documents (1000 rows), 3 visits              | 1432 / 1370 / 1585 ms         | 1545 / 1363 / 1563 ms         |
| …long tasks per Documents visit                      | 3 (≈630 ms total, max 433 ms) | 3–5 (≈600–800 ms, max 433 ms) |
| Sidebar nav, median / max of 10 rounds: Inbox        | 598 / 768 ms                  | 630 / 840 ms                  |
| Books                                                | 1002 / 1194 ms                | 957 / 1154 ms                 |
| Bank                                                 | 180 / 417 ms                  | 183 / 302 ms                  |
| Reports                                              | 64 / 93 ms                    | 68 / 141 ms                   |
| Heap after `gc()`: start → each round                | 3.8 → 7.2–17.3 MB (no trend)  | 3.8 → 7.2–19.4 MB (no trend)  |
| Inbox segment switch Triage / Approvals / All        | 642 / 171 / 665 ms            | 620 / 177 / 634 ms            |
| Bank All segment (1000 lines)                        | 287 ms                        | 233 ms                        |
| Bank toggle one proposal (row 250)                   | 82 ms                         | 82 ms                         |
| Inbox scroll, 600 px/frame: p50 / p95 / max frame    | 16.7 / 21.7 / 91.9 ms (3 >50) | 16.6 / 18.9 / 122.3 ms (5 >50) |
| Bank "All" scroll: p50 / p95 / max frame             | 16.7 / 16.9 / 17.2 ms         | 16.7 / 27.3 / 31.6 ms         |
| Horizontal overflow (`scrollWidth` = viewport)       | none                          | none                          |

- **Inbox open → Back** (rows #5, #300, #700, #990). Open took 94–235 ms. Back
  to a restored, focused row took 1.12–1.32 s. **Δtop = 0 px in all 8 cases**,
  and the URL was kept.
- **Sidebar:** `position: fixed`, x=0 y=0, full viewport height, before and
  after scrolling to the bottom of every list.
- **Cell geometry** (xl columns): 0 overlaps, 0 overflowing rows, 0
  clipped cells across Books › Expenses (1200), Inbox (1000) and Books ›
  Documents (1000). The ~96-character names wrap inside their column.
- Books search keystroke latency (URL-committed) was measured only for Inbox:
  23–83 ms per key, 0 long tasks.

### Observations (no defect claimed)

- **O1. Thumbnail previews: one GET per row, not cached.**
  - Inbox issues one `/api/documents/:id/preview` GET per triage row on every mount (600 per visit). Books › Documents issues 1000 per visit.
  - 10 navigation rounds made 6000 preview GETs. The Inbox case made 4204 in total, from reloads and Back returns.
  - Cause in source: `DocThumb` / `usePreviewObjectUrl` fetch eagerly with no lazy loading or shared cache (the blob URL is revoked on unmount). Against the 0 ms mock this cost 400–430 ms long tasks on Documents only.
  - Server-side rendering cost and HTTP/1.1 connection-pool queueing (6 per origin) were **not modelled**. Whether this delays detail reads against a real server is untested.
- **O2. The Bank "Book N matches" button sits after all proposal rows.**
  - With 300 proposals it is at document y = 20 889 px: 23 viewports down at 1440×900 and 19 at 1920×1080. It is not sticky.
  - The selection count is in the button label only.
  - This is a desktop-workspace/usability note for UI-039 (#283)-style follow-ups, not a rendering failure.

## Symptoms and their classification

### Bank "Book" button not found (run2): harness timing, not a product defect

- **Symptom:** run2 (1440) timed out after 30 s waiting for `getByRole('button', { name: /^Book \d+/ })`.
- **Rendered DOM check** (`/bank/statements/3`, 1440, after network idle):
  - Exactly one `<button>` with `<span>Book 200 matches</span><span>−170925.21 € net</span>`.
  - 200 of 300 `role=checkbox` proposals are `aria-checked=true`.
  - The radiogroup reads `Unmatched 800` / `All 1000`, and `getByRole(...)` count = 1.
- **Source:** `bank/StatementScreen.tsx` renders the button whenever `chosen.length > 0 || pending`.
- **Final run:** found the button at both widths with the text above. The count and net equal the independent sum.
- **Conclusion:** no product defect.

### Dropped search keystrokes: UNCONFIRMED candidate (C1), not filed

**Symptom.** A searchbox value was shorter than the characters typed into it.
This happened with fast synthetic typing into the Books › Expenses, Inbox and
Bank statement searches:

- `keyboard.type` one character per animation frame typed `kalamaja` into Books and ended with `klamaja`.
- `pressSequentially(…, { delay: 0 })` ended with `a`.

**Initial typing harness matrix** (`typing.log`; stopped early on request at
78 of 120 result rows, ending in the kill trace, so the 1920 small-data rows are missing). Each cell is 3 trials:

| Delay between keys | Full data (1k rows), 1440 | Full data, 1920 (partial) | Small data (≤20 rows), 1440 |
| ------------------ | ------------------------- | ------------------------- | --------------------------- |
| 0 ms               | 0/18 intact               | 0/12 intact               | 0/18 intact                 |
| 50 ms              | 17/18 intact (1 × `2.56`) | 8/12 (Books `1234.56` → `1456` ×3; Inbox `kalamaja` → `lmaja` ×1) | 18/18                |
| 100, 150, 250 ms   | 54/54                     | 30/30 intact (Bank rows not reached) | 54/54                       |

**Corrected harness (final run).** After each key, the harness waited until
`?q=` equalled the typed prefix, plus one frame.

- Inbox: 8/8 keys committed at both widths (23–83 ms per key).
- Books and Bank: the second key (`ka`) never reached the URL within 10 s at either width. The case stopped there. That is why Books search/filter/order and Bank search/Book are not measured.

**Why this is not classified as confirmed.**

- Every loss came from synthetic CDP key events: back-to-back, or at 50 ms without human key-down/up timing. The 0 ms loss also happens on 20-row data, so it is a property of synthetic input speed and not of data volume.
- The corrected wait uses the URL as its commit signal. `setSearchParams` updates history before React commits the controlled `value`, so the harness synchronisation itself is suspect.
- It was not reproduced by a human at a keyboard, with another input method (xdotool or a physical keyboard), or in another browser.

**Plausible mechanism, from source only.** `ui/SearchInput.tsx` is a controlled
input whose `value` is the URL's `?q=`. Each change goes through
`useSetFilterParam` → react-router `setSearchParams(…, { replace: true })`. That
builds the next params from the render's `params` and is not a synchronous
local state update. A key arriving before the router's update commits would
then be applied to the stale value. This is a hypothesis to confirm, not a
finding.

**To confirm before filing:**

1. Start the production build with the fixture above.
2. At 1920×1080, open Books › Expenses (1200 rows).
3. Type `1234.56` quickly with a physical keyboard or xdotool (about 50 ms between keys).
4. Compare the field and `?q=` with what was typed.

Per instructions, **no follow-up issue was filed.**

## Harness failures and corrections (artifacts kept)

| Run     | Result | Cause                                                                                                                                                                                                                                                              |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| initial | 2/10   | (a) The segmented-control radios are `sr-only` inputs; their `<label>` intercepts the click, so the harness now clicks the label (not a product issue). (b) Search row-count waits timed out: this was the first sighting of C1. Only repeat-nav passed at both widths |
| run2    | 2/5    | 1440 only. The C1 search waits again, and the Bank "Book" wait (classified above as harness timing)                                                                                                                                                                  |
| final   | 4/10   | Books and Bank: the corrected per-key wait timed out at the 2nd key (C1). Inbox: every measured step passed, but the harness compared `"20 1000 tasks"` to `"20 of 1000 tasks"`. This is a string-join bug in `showing()`; the page text is "Showing 20 of 1000 tasks" |

## Limitations

- In-page mock only: no server latency, no pagination semantics and no real
  preview rendering. HTTP/1.1 connection limits were not exercised, because
  route-fulfilled requests use no socket.
- The final run did not measure Books date range/order/status filter latency,
  Books open→Back or the mocked Bank Book timing. The run2 and initial
  artifacts contain no valid numbers for them either.
- One machine and one browser (headless Chromium). No GPU. No Safari,
  Firefox or Edge. No physical keyboard.
- Native iOS is out of scope (issue text) and was not run.

## Evidence (`.review-303/`, see `MANIFEST`)

Committed: `MANIFEST`, `final-results.json`, `final.log`, `initial.log`,
`typing.log`. Kept untracked, with sha256 recorded in `MANIFEST`: the harness
`fixtures.mjs`, `run.mjs`, `typing.mjs`; screenshots; the `dist/` build and
the preview/debug files.
