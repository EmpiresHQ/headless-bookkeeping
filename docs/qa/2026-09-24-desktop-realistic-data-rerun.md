# QA-010 re-run: Desktop at realistic data volumes (issue #303)

This re-runs QA-010 on current `main` **`2f22cab`**, which includes #378 (app-shell
landmarks) and #302 (focus held inside a busy modal). It follows the earlier
report [2026-09-24-desktop-realistic-data.md](2026-09-24-desktop-realistic-data.md)
(`main` `f83cee8`). That report left one **unconfirmed candidate, C1: dropped
search keystrokes**, and several steps unmeasured. This run **confirms C1 as a
web defect** and fixes it in `ui/SearchInput.tsx`, with a regression test. It
also measures the steps the earlier run missed.

The run was headless Chromium at **1440×900** and **1920×1080** CSS px, DPR 1,
against production builds. **No real backend was involved.** Every `/api` and
`/admin` request was answered by an in-page Playwright mock. Every non-GET
request was **held and never answered**, so no write reached any server. **Native
iOS is out of scope and was not run. No Safari, Firefox or Edge, and no physical
keyboard, were used.** Absence of a split-pane layout is not treated as a defect.

## Verdict

| Area | Status |
| --- | --- |
| **C1: search keystrokes dropped (Books, Inbox, Bank statement; also Settings › Entities)** | **CONFIRMED defect, fixed.** Before: 1k-row lists lose keys typed ≤60 ms apart, and some at 40–139 ms jitter. After: 180/180 intact (details below) |
| #378 landmarks at desktop widths | **Pass**, 1440 + 1920. One `main`; the visible `navigation` is "Primary" with 5 links; the search is inside `main`; no nav inside `main` |
| #302 focus while a submit is pending (desktop) | **Pass**, 1440 + 1920. "Delete this draft expense?" with the DELETE held: focus stays in the alertdialog after Delete and across 4×Tab + 2×Shift+Tab |
| Cold load of 1k-row lists | **Pass**. Books 1200 rows 511/545 ms; Inbox 1000 rows 792/780 ms; Bank statement 285/445 ms (1440/1920) |
| Repeated sidebar navigation (6 rounds × 4 screens) | **Pass**. No growth trend in timing, heap or DOM; 0 page errors from the app |
| Row geometry, long names/amounts, fixed sidebar | **Pass**. 0 overlapping cells and 0 overflowing rows (1200 + 1001 + 300 rows). No horizontal overflow. Sidebar `position: fixed` at y=0 after scrolling to the bottom |
| Books search / status filter correctness + latency (first measured here) | **Pass**. "Showing 86 of 1200", every row contains the needle; Draft 192 rows, all draft |
| Books open → Back (rows #5, #600, #1150; first measured here) | **Pass**. Δtop 0 px and the row is focused, 10/10 (see the harness race below) |
| Bank counts, preselection, Book (mocked) | **Pass**. 200 of 300 proposals preselected; "Book 200 matches +1234928.44 € net" equals the independent fixture sum. On click, the POST is held and the button is disabled |
| Real backend, server latency, HTTP/1.1 queueing, other browsers, native iOS | **NOT TESTED** |

## C1: dropped search keystrokes (confirmed, fixed)

**Symptom.** Characters typed quickly into a list search disappear. The field
and `?q=` end up shorter than what was typed. Examples before the fix:

- `1234.56` became `24.56` or `2.56` (Books, Inbox, 60 ms/key).
- `Põhja-Eesti` became `õhja-Eesti` (Inbox, 40–139 ms jitter).
- `kalamaja` became `a` (0 ms).

**Cause.** The Books, Inbox and Bank statement searches (and Settings ›
Entities) are controlled `SearchInput`s whose `value` is the URL's `?q=`. Each
change goes through `setSearchParams`. React Router 7's `RouterProvider`
applies that state inside `React.startTransition` (`react-router`
`dist/development/chunk-4ZMWKKQ3.mjs` ≈ line 6752). After the input event,
React finds no synchronous update to `value`. It therefore restores the DOM
field to the **old** value until the transition commits. A key arriving in that
window is applied to the old text, and the characters in between are lost. The
window grows with the cost of re-rendering the list.

**Mechanism measured directly** (`blank.mjs`). The probe presses one key into an
idle search and samples the field's DOM value every animation frame. It
reports the last frame that still showed the old value, and when the key first
appeared:

| Build | Data | Books | Inbox | Bank |
| --- | --- | --- | --- | --- |
| before | 1k rows | old value to 62–84 ms, key at 111–122 ms | 56–80 / 92–116 ms | 29–40 / 57–72 ms |
| before | ≤20 rows | 6–24 / 23–40 ms | 4–11 / 22–29 ms | 3–21 / 21–39 ms |
| after | 1k rows | never old; key at 8–22 ms | never old; 7–14 ms | never old; 6–7 ms |
| after | ≤20 rows | never old; 5–12 ms | never old; 3–6 ms | never old; 4–11 ms |

Each cell covers 3 trials × 2 widths. One key per trial, so this does not depend
on how fast synthetic typing is. The earlier report's doubt ("synthetic input
speed") is answered: the window is real app state, and it scales with data
volume.

**Keystroke matrix** (`typing.mjs`). The words were `kalamaja`, `1234.56` and
`Põhja-Eesti`, typed with Playwright `keyboard.type` one key at a time, then 1.5 s
idle. A cell is intact when the field and `?q=` both equal the word.

| Build, data | 0 ms | 30 ms | 60 ms | 100 ms | jitter 40–139 ms |
| --- | --- | --- | --- | --- | --- |
| before, 1k rows, 1440 (9 per cell, 3 screens) | 0/9 | 1/9 | 6/9 | 9/9 | **6/9** |
| before, 1k rows, 1920 (partial + fill-in) | 0/15 | 1/6 | 8/13 | 3/3 | 12/12 |
| before, ≤20 rows, 1920 | 0/9 | — | 9/9 | — | 9/9 |
| **after**, 1k and ≤20 rows, 1440 + 1920 | **36/36** | **36/36** | **36/36** | **36/36** | **36/36** |

The jitter losses (Inbox at 1440: `kalamaja`→`aa`, `1234.56`→`26`,
`Põhja-Eesti`→`õhja-Eesti`) are at human typing speed. **Priority: P2.** Search
input on the main desktop work queues silently produces a different query than
the one typed. That leads to wrong result sets, but no data is changed.

**Fix** (`packages/web/src/ui/SearchInput.tsx`). The field keeps its own text as
an urgent local state and still calls `onChange` on every key. `value` changes
that are echoes of what was typed, including late intermediate ones, leave the
text alone. Any other `value` (Reset, Back, a caller clearing it) replaces it.
All callers keep their API. Local-state callers (sheets, lookups) behave as
before because their echo is immediate.

**Regression test** (`src/ui/SearchInput.url.test.tsx`). `SearchInput` is bound
to `?q=` through `createMemoryRouter` + `RouterProvider` + `useSetFilterParam`.
The test types with native `input` events outside `act()`, as a browser
delivers them. Before the fix, `1234.56` failed: the field did not hold the
typed text. After the fix it passes. A second test checks that a `?q=` changed
from outside (navigate to `/`, then `/?q=next`) still replaces the field. A
plain `userEvent.type` does **not** reproduce the bug, because RTL wraps each
event in `act()`, which flushes the transition. The first probe showed this and
the test avoids it on purpose.

## Set-up

- **Builds:** `vite build` of `packages/web`.
  - **before:** unmodified `2f22cab`; `index.html` sha256 `3f66409…1ed6`.
  - **after:** `2f22cab` + fix; `index.html` sha256 `42d6c0f…59c8`.
  - Each build was served by a small static server (`h/serve.mjs`, no `/api` proxy) on 127.0.0.1:5374 (before) and :5373 (after). Both were stopped afterwards and both ports are free. Hashes are in `.review-303/MANIFEST`.
- **Browser:** Playwright 1.63.0, bundled headless Chromium, `--js-flags=--expose-gc --enable-precise-memory-info`. Desktop contexts, no touch, DPR 1. Env: `TMPDIR=/root/.cache/hbk-browser-tmp`, `LD_LIBRARY_PATH=/tmp/hbk-browser-libs/root/usr/lib`, `FONTCONFIG_FILE=/tmp/hbk-browser-libs/fonts.conf`.
- **Machine:** Linux, Intel Core i5-7400T @ 2.40 GHz (4 cores), 7 GB RAM, Node 24.21.0. Timings are harness wall-clock on this machine and indicative only.
- **Fixtures** (`h/fixtures.mjs`, seed 303, generated in memory, no files):
  - 450 entities (Estonian, Latvian, Lithuanian, Polish and German names with diacritics; every 37th ~100 characters).
  - 1200 expenses: 2025-01-01…2026-09-24, amounts 0.01 € to ~12 M € (heavy tail), 5 % USD, draft/pending/posted/reversed, 20 % without an invoice number.
  - 1000 sales invoices and 1000 documents (every 41st with a very long filename).
  - Inbox: 600 needs-triage items (7 reason types, long filenames) and 400 pending approvals.
  - 24 bank statements. Statement #3 has **1000 lines**: 200 matched, 300 AI proposals (200 high, 100 medium) and 500 open.
  - 2 reporting periods (one open, one locked); 1×1 PNG previews.
  - "Small" variant: at most 20 rows per list.

## Results (after build, `run-results.json`, `openback-results.json`)

| Measure | 1440 | 1920 |
| --- | --- | --- |
| Cold load: Books 1200 / Inbox 1000 / Bank #3 (300 proposals) | 511 / 792 / 285 ms | 545 / 780 / 445 ms |
| Sidebar nav, 6 rounds: Books | 496–785 ms | 534–1029 ms (first) |
| Bank list | 166–300 ms | 156–326 ms |
| Reports | 42–142 ms | 43–142 ms |
| Inbox | 619–720 ms | 585–672 ms |
| Heap after `gc()`, per round | 89–105 MB (start 100.7) | 64–115 MB (start 102.9), no trend |
| DOM nodes per round (Inbox) | 13 957–14 471 | 13 956–14 444, no growth |
| Books search `kalamaja` (fill → rows) | 687 ms, 86 rows | 547 ms, 86 rows |
| Books clear / Draft chip / All | 346 / 245 / 346 ms | 343 / 234 / 404 ms |
| Books open → Back, 5 rows (#5, #600, #1150, #5, #600) | open 162–182 ms, Back 400–520 ms | open 165–185 ms, Back 411–459 ms |
| Books Δtop after Back / row focused | 0 px / 5 of 5 | 0 px / 5 of 5 |
| Bank search `kalamaja` / All segment | 66 ms (23 proposals) / 174 ms | 76 ms / 160 ms |
| Bank Book click → button disabled (POST held) | 667 ms | 549 ms |

**Observations carried over (no defect claimed).**

- **O1 (thumbnail previews):** still one `/preview` GET per row on each mount, 5400 per width in this matrix.
- **O2 (Book button position):** the Bank "Book N matches" button is still after all proposal rows, at document y = 21 187 px, and is not sticky.

Both are as described in the earlier report. They are candidates for the
UI-039 (#283) workspace follow-ups, not rendering failures.

## Harness notes (not product defects)

- **1920 Books open→Back timeout in the full run.** `goto('/books')` ran on the URL the previous step had just left. Row #5 was then not yet attached within 20 s. At 1440 the same step recorded a 3.2 s open and 4.5 s Back for row #5. The screenshot at the timeout shows the list fully rendered. Re-run with `about:blank` before each `goto`: 10/10 pass with the timings above. This is classified as harness timing.
- **Before-build typing matrix crash** at row 68 (1920, Inbox). A 6.8 s stall during typing, then `waitFor(searchbox)` timed out on the next `goto`. The missing 1920 and small-data cells were re-run in the fill-in. The 1440 small-data before cells were not re-run. The earlier report already recorded 0/18 intact at 0 ms there.
- **Page errors "Failed to read 'localStorage'"** (3 in the main run and 5 in the open→Back run, per width) come from the harness init script on `about:blank`. None came from the app.
- **Unhandled mock paths:** only the Reports reads `/api/reporting-periods/2/kmd` and `/1/submission-state` (answered 503). The Reports heading rendered; Reports was only a navigation target here.
- **Held non-GETs:** only `POST /api/bank-statements/3/match` and `DELETE /api/expenses/10004`, and neither was answered.

## Checks

- `npx vitest run` in `packages/web`: **146 files, 1486 tests passed**. This ran with the fix before the `.at(-1)` → index change, which is equivalent. Re-run after the change: SearchInput, Books search, Inbox, Bank and Entities suites, 525 passed.
- `npx tsc -b`: clean. `npx eslint src`: clean. `prettier --check` on the changed files: clean.
- The regression test fails on unmodified `2f22cab` and passes with the fix.

## Limitations

- In-page mock only: no server latency, pagination or real preview rendering, and no HTTP/1.1 connection limits.
- The keystroke timing used Playwright's CDP key events. The single-key probe shows the stale window without depending on typing speed, but no physical keyboard was used.
- One machine, headless Chromium only, no GPU. Absolute timings will differ on other hardware; the stale window scales with render cost.
- Native iOS is out of scope and was not run.

## Evidence (`.review-303/`, see `MANIFEST`)

Committed:

- The harness `h/*.mjs`. The earlier run's harness was lost, so it is kept this time.
- `blank-{before,after}.json`, `typing-before*.{json,log}`, `typing-after.{json,log}`.
- `run-results.json`, `run.log`, `openback-results.json`, `openback.log`.

Screenshots are kept untracked. Builds were deleted and their hashes recorded.
