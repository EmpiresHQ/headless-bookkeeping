# QA-001 — scroll and focus across list → detail navigation (issue #294)

Verification task, not a pre-confirmed bug. This report records what a
production build actually does in a real (headless) Chromium. It changes no
product code.

## Scope and limits

- **Covered:** Books (Expenses, Invoices, Documents, Credit notes) and a bank
  Statement (list → transaction → Back). Checked: first open of a new detail,
  header `‹ Back`, browser Back and Forward, reload, deep link, a list with a
  search query, long rows or details, and delayed API answers. The Inbox
  results come from an independent run by the coordinating reviewer
  ([Inbox](#inbox-independent-run)).
- **Not covered:** physical iOS or Android devices, Safari/WebKit, Firefox,
  and real assistive technology. Narrow viewports are Chromium device
  emulation (`isMobile`, touch enabled). That is **not** a real-device
  result. Chromium's native history scroll restoration is timing- and
  engine-dependent. Other engines may differ, especially for browser Back.
- **Source state:** the current source calls `useReturnPosition`
  (`packages/web/src/lib/listPosition.ts`, issue #283) only from the four
  Books segments. No global scroll or focus manager exists and no route
  resets scroll on PUSH. The issue's "no scrollTo anywhere" is outdated. This
  source reading only guided the tests. Every defect below comes from browser
  observation.

## Environment

|           |                                                                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build     | Production build preview at `127.0.0.1:5252`, built by the coordinating reviewer; all 292 web source files were hash-checked against base `0391363` after the browser runs. Entry assets `index-IPih56Mh.js`, `index-BbYaLByP.css`. This worktree has no source changes |
| Browser   | Chromium 153.0.8010.12 (Playwright 1.63.0), headless, Linux                                                                                                                                                                                                             |
| Viewports | 1280×800 desktop; 390×844 and 320×460 phone emulation (`isMobile`, `hasTouch`). Inbox run: 1280×844, 390×844, 320×460                                                                                                                                                   |
| Scroller  | The window for these main list/detail pages; Sheet and document-viewer scrollers are outside this matrix                                                                                                                                                                |
| Date      | 2026-09-23                                                                                                                                                                                                                                                              |

### Data (all API responses mocked)

Every `/api/*` request was answered by a Playwright route. No backend,
real credentials or real data were used; the app was signed in with a fixed
fixture token in `localStorage` that no server ever saw. Requests to any
other origin were aborted. The Statement screen's read-only
`POST /api/bank-statements/3/propose-matches` was answered with an empty
mocked list and was not recorded. Every other non-GET request would have
been refused with 500 and recorded; none was recorded, and no request
reached a real backend. An unmocked GET would have been recorded as
`unhandled` and answered 503; none occurred in the final matrix. (The first discovery probe
hit an unmocked `/api/documents/:id/details`; a mock was added before the
matrix ran.)

- 60 rows per Books segment: expenses `100–159` (draft), invoices `300–359`
  (draft), documents `500–559` (processed), credit notes `700–759`.
- One statement `3` (1–30 Sep 2026) with 60 open lines `900–959`, no AI
  proposals, no matches. All 60 lines show under "Decide yourself".
- **Long** variant: row text roughly 90–160 characters longer (a long supplier
  name, references, file names), a 2.7 kB description, and 200 lines of OCR
  text.
- **Delayed** variant: the list read (`/api/expenses` or
  `/api/bank-statements/3/transactions`) and `/api/expenses/:id` each answer
  after 1500 ms.
- `/api/documents/:id/preview` returns **404 on purpose** (no thumbnail
  image). These 404s are expected fixture behaviour, not missing fixtures.

## Method

For each case, a fresh browser context signs in (a fixture token in
`localStorage`). It opens the list, scrolls with `window.scrollTo` so the
target row sits about 40% down the viewport, and waits for layout to settle.
It then clicks the row with a real pointer click. After each navigation the
harness waits for the URL and for the target screen to commit: the row
element for a list, the `‹ Back` control for a detail. It then polls until
`scrollY`, document height and DOM size stay unchanged for 400 ms. Only
after that does it measure `scrollY`, maximum scroll, the row's viewport
`top`, the `‹ Back` control's `top`, `document.activeElement`, and the
history index and key. Nothing calls `scrollIntoView` or `focus` after a
navigation. The row was placed only _before_ leaving the list. Screenshots
were taken at key steps. A run's first result was kept; no case was re-run
until it passed.

## Results — Books and Statement

`y` = `scrollY` / max scroll. `row` = the opened row's viewport top in px.
`focus` = the active element after the step.

### List → detail → Back (opened ids: expense 140, invoice 340, document 540, credit note 740, bank line 940)

| List         | Viewport | List before     | Detail first open                  | Header `‹ Back`               | Browser Back              | Forward, then Back again  |
| ------------ | -------- | --------------- | ---------------------------------- | ----------------------------- | ------------------------- | ------------------------- |
| Expenses     | 1280     | y 884, row 320  | y 0 / 16                           | **y 884, row 320, focus row** | y 884, row 320, focus row | y 0, row 1204, focus BODY |
| Expenses     | 390      | y 1581, row 337 | y 0 / 62                           | y 1581, row 337, focus row    | same                      | y 0, row 1918, BODY       |
| Expenses     | 320×460  | y 2091, row 184 | y 0 / 446                          | y 2091, row 184, focus row    | same                      | y 0, row 2275, BODY       |
| Invoices     | 1280     | y 884, row 320  | y 0 / 0                            | restored, focus row           | restored, focus row       | y 0, BODY                 |
| Invoices     | 390      | y 1348, row 338 | y 0 / 0                            | restored, focus row           | restored, focus row       | y 0, BODY                 |
| Invoices     | 320×460  | y 1502, row 184 | **y 185 / 185, `‹ Back` top −175** | restored, focus row           | restored, focus row       | y 185, row 1501, BODY     |
| Documents    | 1280     | y 2779, row 320 | y 0 / 0                            | restored, focus row           | restored, focus row       | y 0, BODY                 |
| Documents    | 390      | y 3618, row 338 | y 0 / 0                            | restored, focus row           | restored, focus row       | y 0, BODY                 |
| Documents    | 320×460  | y 4522, row 184 | **y 205 / 246, `‹ Back` top −195** | restored, focus row           | restored, focus row       | y 205, row 4501, BODY     |
| Credit notes | 1280     | y 891, row 320  | y 0 / 0                            | restored, focus row           | restored, focus row       | y 0, BODY                 |
| Credit notes | 390      | y 1644, row 338 | y 0 / 0                            | restored, focus row           | restored, focus row       | y 0, BODY                 |
| Credit notes | 320×460  | y 2154, row 184 | y 0 / 49                           | restored, focus row           | restored, focus row       | y 0, BODY                 |
| Statement    | 1280     | y 2476, row 320 | y 0 / 5                            | **y 5, row 2791, BODY**       | y 5, row 2791, BODY       | y 5, BODY                 |
| Statement    | 390      | y 2458, row 338 | y 0 / 47                           | **y 47, row 2749, BODY**      | y 47, row 2749, BODY      | y 47, BODY                |
| Statement    | 320×460  | y 2612, row 184 | y 0 / 469                          | **y 469, row 2327, BODY**     | y 469, row 2327, BODY     | y 469, BODY               |

"restored" means `scrollY` and row top were equal to "List before" (0 px
difference) and focus was on the opened row's link. After the table's
Back/Forward steps, the harness opened a **different** row (id + 5: 145,
345, 545, 745, 945) from
the returned list. Every Books detail opened at the same `y` as its "Detail
first open" column; Statement opened at y 0.

### Long data, delayed data, query, reload, deep link

| Case                                   | Viewport                                    | Observed                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long Expenses                          | 1280 / 390                                  | Detail opens at y 0 (max 202 / 0). Header Back restores y 5800 / 7138, row 320 / 338, focus row.                                                                                      |
| Long Documents                         | 1280 / 390                                  | Detail max scroll 0: OCR text is not shown on the page by default, so this case does **not** exercise a long detail. Back restores and focuses the row.                               |
| Long Statement                         | 1280 / 390                                  | Header Back: y 43 / 122 (the detail's max), row at 5363 / 8764, focus BODY.                                                                                                           |
| Delayed Expenses                       | 1280 / 390                                  | Header Back and browser Back both restore y 884 / 1581, row 320 / 337, focus row, after the list arrives.                                                                             |
| Delayed Statement                      | 1280                                        | Header Back: y 5, row 2791, BODY. **Browser Back: y 2429, row 367** (47 px from 320), BODY. Within this matrix, only the delayed-Statement browser Back got a native partial restore. |
| Delayed Statement                      | 390                                         | Header Back: y 47, BODY. Browser Back: y 2407, row 389 (51 px from 338), BODY.                                                                                                        |
| Expenses `?q=EXP` (search typed first) | 1280 / 390                                  | Header Back restores y 932 / 1639, row 320 / 337, focus row, and the query is kept. Forward then browser Back: y 0, BODY.                                                             |
| Statement `?q=Bank+line`               | 1280 / 390                                  | Query kept. Header and browser Back: y 5 / 47, BODY.                                                                                                                                  |
| Reload list                            | Expenses, Statement × 1280 / 390            | Always back at y 0.                                                                                                                                                                   |
| Reload detail, then header Back        | Expenses, Statement × 1280 / 390            | Detail y 0. Back returns to the list at the detail's max (16 / 62 / 5 / 47), row off-screen, BODY.                                                                                    |
| Deep link to detail (new tab)          | Expenses, Documents, Statement × 1280 / 320 | Detail at y 0. Header Back replaces history with the list (`/books`, `/books?seg=documents`, `/bank/statements/3`) at y 0, focus BODY. No history entry is left behind.               |

Across all 39 cases: 0 page errors, 0 unhandled requests, 0 writes.

## Inbox (independent run)

The coordinating reviewer ran this with their own fixture: 80 triage
documents, same browser and build. List `/inbox?seg=triage`, opened document 42.

| Case                                                         | Viewport   | Before                                           | Detail                                               | After                                                 |
| ------------------------------------------------------------ | ---------- | ------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------- |
| Header Back                                                  | 390×844    | y 3144, row 379                                  | y 0                                                  | **y 0, row 3523, BODY**                               |
| Browser Back                                                 | 390×844    | same                                             | y 0                                                  | y 0, row 3523, BODY                                   |
| Header Back                                                  | 320×460    | y 3336, row 187                                  | **y 105** (new detail not at top)                    | y 160, row 3363, BODY                                 |
| Browser Back                                                 | 320×460    | same                                             | y 105                                                | y 160, row 3363, BODY                                 |
| Header Back                                                  | 1280×844   | y 2572, row 388.5                                | y 0                                                  | y 0, row 2960.5, BODY                                 |
| Browser Back                                                 | 1280×844   | same                                             | y 0                                                  | **y 2572, row 388.5 (restored natively), focus BODY** |
| `?seg=triage&q=document`, keyboard Enter on row, header Back | 390×844    | y 3192, row 379, focus row link                  | y 0                                                  | y 0, row 3571, BODY; query kept                       |
| Auto-next after completing doc 12 → 13 (one mocked POST)     | 320×460    | doc 12 at y 186 before the action                | doc 13 at **y 131, heading top −21.75 (off-screen)** | —                                                     |
| Auto-next                                                    | 390 / 1280 | y 0                                              | doc 13 at y 0 (short detail, clamped to 0)           | —                                                     |
| Reload list / reload detail / deep link                      | 320×460    | list y 3336 → 0; detail y 160 → 0; deep link y 0 |                                                      |                                                       |

The first auto-next attempt failed in the harness: it expected a "Start
clearing" control that does not appear without an open period. The rows above
come from the corrected run, and the first failures were kept.

Independent spot checks with the older #283 Books fixture, 50 rows at
`?seg=expenses&q=DESKTOP&sort=newest`:

- **390:** header Back restores y 4073, row 639.25, focus on the row.
- **1280:** browser Back restores y 2027, row 747.5, focus on the row. The
  new 1280 expense detail opened at **y 163**, which was its maximum scroll
  (document height 1007). Its top was off-screen.
- **Back, Forward, Back again at 390 and 1280:** the list is at y 0, focus
  BODY. This reproduces D3 ([#356](https://github.com/EmpiresHQ/headless-bookkeeping/issues/356)).
- **Statement at `?seg=all&q=Counterparty`, keyboard Enter on line 930:**
  at 390, header Back went from y 1828 to 45; at 1280, browser Back went
  from y 1800 to 0. Focus went from the line button to BODY both times, and
  the query was kept.

## Defects

All three were reproduced independently by the coordinating reviewer and filed as P2.

### D1 — Inbox and Statement lose list position and focus on Back · **P2** · [#355](https://github.com/EmpiresHQ/headless-bookkeeping/issues/355)

- **What happens:** header Back and browser Back return to the top of the
  list, or to the detail's max scroll, with focus on BODY. The opened row is
  thousands of px off-screen. Seen in every Statement case (3 viewports ×
  header/browser, long, delayed, query) and in every Inbox return case except
  1280×844 browser Back.
- **Exceptions:** Chromium's native restoration sometimes lands close: Inbox
  1280 browser Back, and delayed-Statement browser Back (off by 47–51 px).
  Focus stayed on BODY even then.
- **Reproduce:** statement with ≥ 60 lines → scroll until a line far down
  the list (here line id 940) is mid-viewport → open it → `‹ Back`. Compare `scrollY` and the line's position before and after.
- **Cause:**
  - _Proven:_ `useReturnPosition` is used only by the Books segments.
    Statement rows are `<button>`s that call `navigate()`, and the Inbox
    list has no return-position handling.
  - _Hypothesis:_ the occasional native restoration depends on timing. A
    lazily loaded route can render after the browser applies its restored
    offset.
- **Impact:** long queues are the main work surface, and each round trip
  loses the user's place. DOM focus is on BODY after return (measured), so
  a keyboard user restarts from the top of the document. The effect on
  screen readers was not tested.

### D2 — New detail can open scrolled down, with its header off-screen · **P2** · [#357](https://github.com/EmpiresHQ/headless-bookkeeping/issues/357)

- **What happens:** a newly opened detail can start at a non-zero scroll
  offset instead of its top, with `‹ Back` and the title above the viewport.
  - Invoices 320×460: y 185 of 185, `‹ Back` at −175. The screenshot shows
    only Submit, Edit draft and Delete draft.
  - Documents 320×460: y 205; the settled page's max scroll was 246, so this
    is not simply a clamp to the final max.
  - Inbox doc 42 at 320×460: y 105. Inbox auto-next doc 13: y 131, heading
    off-screen.
  - Reviewer's 1280×844 expense: y 163 = max scroll (document height 1007).
- **Details that opened at 0:** most were no taller than the viewport (max
  scroll 0). A short detail clamping to 0 does **not** show that long
  details are handled. Some did open at 0 despite a larger final max scroll
  (Expenses 320×460: max 446; long Expenses 1280: max 202). Why was not
  instrumented.
- **Reproduce:** 320×460 → Books → Invoices, scroll until invoice 340 is
  mid-viewport → open it. Observed `scrollY` 185 (= max scroll) with
  `‹ Back` above the viewport.
- **Cause:**
  - _Proven:_ no code resets scroll on PUSH navigation or auto-next (source
    search), and the non-zero offsets above were measured on newly opened
    details.
  - _Hypothesis, not verified for every case:_ the previous screen's window
    offset carries over and is clamped by the new screen's height at first
    render. Whether a detail opens at 0 would then depend on how tall it is
    at that moment, for example whether it first renders a short loading
    state. Invoices (y = max) fits this; Documents (y 205 < final max 246)
    shows the final max is not always the limit.
- **Impact:** the user sees a mid-page view, sometimes with destructive
  actions but no title that identifies the record. Seen mostly at phone
  sizes (emulated).

### D3 — Books loses position on a second Back (Back → Forward → Back) · **P2** · [#356](https://github.com/EmpiresHQ/headless-bookkeeping/issues/356)

- **What happens:** after a correct return, going Forward to the detail and
  Back again leaves the list at y 0, or at the detail's non-zero offset
  (Invoices 320: y 185; Documents 320: y 205), with the opened row
  off-screen and focus on BODY. Seen in all 4 segments at all 3 viewports,
  after header or browser Back, and on the `?q=` list.
  The reviewer reproduced it independently.
- **Reproduce:** Books → Expenses, scroll until expense 140 is mid-viewport
  → open → Back (restored)
  → browser Forward → browser Back.
- **Cause:**
  - _Proven by instrumentation (Expenses, 1280×800):_ on the second return
    the app itself calls
    `window.scrollTo(0, 0)` twice. When Chromium's scroll event for Forward
    fires, the list is already unmounted: 0 rows, document height 816.
    Dispatching an extra `scroll` event after the first return does not
    change the result. Leaving a _freshly mounted_ list (via the sidebar or
    a row click) is later restored correctly.
  - _Hypothesis:_ the record written when leaving a list that was itself
    restored has no usable anchor and uses offset 0. The exact line was not
    identified; this was deliberately left for the fix cycle.

### Observations, not filed as defects

- Reloading a list returns it to y 0. Reloading a detail and then pressing
  Back returns the list to y 0 or the detail's small max scroll (5–62 px),
  with the row off-screen. The hook's documented design keeps records only in memory ("dies
  with the page"). The issue defines no expectation for reload. Recorded as
  fact.
- A deep link followed by header Back replaces the entry with the list at the
  top. This matches the `ScreenHeader` contract: no bounce back into the
  detail.

## Reproducing

The harness is local and not part of the repository. It uses Node and
Playwright, and mocks `/api/*` as described under **Data**. Any build can be
checked by hand with the steps under each defect and ≥ 60 rows. Measure
`scrollY`, the row's `getBoundingClientRect().top`, and
`document.activeElement` before leaving and after returning. Raw JSON,
instrumentation logs and screenshots are kept in an untracked `.review-294/`
directory for review and are not published.
