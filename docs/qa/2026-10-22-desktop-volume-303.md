# #303: desktop queues with a real isolated backend

**Bounded verification, not a blanket production-volume pass.** A real Chromium
browser exercised 1440×900 and 1920×1080 CSS px against Nest/SQLite over HTTP.
All fixtures are **SYNTHETIC**. One concrete defect was reproduced and fixed:
manual Bank match choices disappeared after opening a line and returning.
Root must independently review and publish the linked finding before resolving
#303. No push, PR, issue publication, merge, closure or deployment was performed.

## Environment and provenance

- Worktree `/root/.cache/hbk-worktrees/issue-303`, branch
  `qa/303-desktop-volume`, base `3d69ec5e98f92a323a483d49d4f8049c5c099b4e`.
- Production `tsc -b && vite build`; baseline index SHA-256
  `59ba1e6c5c33b6be7a7359e6825eae7966a54f800734d0ef2f335a5906b42875`;
  fixed index `eee9c124bf411922ff990ed59c320ae606a90ebc473e724b27ee8425f2879378`.
- Playwright 1.63.0, headless Chromium **153.0.8010.12**, Linux, DPR 1,
  desktop context without touch. Intel i5-7400T 2.40 GHz, 4 CPUs, 7.6 GiB RAM.
  Shared machine: timings include ordinary resource contention, without CPU or
  network throttling. No human task-completion study or load benchmark.
- Dependencies, browser libraries/fonts and data belong to this worktree.
  System Node changed from 24.21.0 to **26.8.2** after app-server restoration;
  the local native SQLite addon was rebuilt. No #397 files, ports or dependencies
  were modified. Root's dirty checkout was read only.
- Nest on **4303**, static production assets on **5303** with a real loopback
  HTTP proxy. No Playwright route mocks. Nest's direct `/books` returned 404
  locally, so this verifies the explicit static/proxy adapter, not deployed
  reverse-proxy/deep-link configuration.
- `.qa-data/app.sqlite` is local only. SQL seeds operational fixtures and
  draft/pending objects; 30 expenses are then posted through the ordinary
  pipeline and approved through REST (`post-fixtures.cjs`). No SQL ledger writes
  and no production mutations. Foreign-key check returned no violations.

## Exact data and rationale

| Synthetic object         | Count / range                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Entities                 | 450: 300 suppliers, 150 customers; every 17th name uses a long Estonian name with diacritics                                                  |
| Expenses                 | 1200: 770 draft, 400 pending, 30 posted; 1140 EUR and 60 USD                                                                                  |
| Amounts                  | 1.02 through 12,345,678.90 original currency; explicit large USD outlier                                                                      |
| Tax-point dates          | Generated calendar dates in 2025 and 2026 (full deterministic formula in seed)                                                                |
| Supplier invoice numbers | `SYNTHETIC-INVOICE-303-000617-LONG-IDENTIFIER` pattern                                                                                        |
| Inbox                    | 600 needs-triage Documents + 400 pending approvals = 1000 tasks                                                                               |
| Documents                | Long filenames; unique valid **1×1 PNG placeholders**, not readable invoices                                                                  |
| Statements               | 24; statement 3 has exactly 1000 open EUR movements, dates 1–30 Sep 2026                                                                      |
| Reconciliation           | Real algorithm yields 45 low-confidence proposals across 41 movements; 1004 navigation controls because four extra candidates share movements |

Read-only inspection of two historical local expense snapshots found 127 rows
in each, with file mtimes on 2026-10-19. Only container shape/count/mtime were
inspected; their contents were not copied into the repo. They are stale and
cannot establish today's production distribution. 1200 expenses is about 9.4×
that historical count. The 1000-task backlog and 1000-line statement are deliberate
stress scenarios (about 33 statement lines/day), not claims about customer usage.

[api-audit.json](issue-303/api-audit.json) records real HTTP 200 counts and payload
sizes: expenses 754143 bytes/1200, triage 128195/600, pending approvals 90599/400,
statements 3928/24, transactions 640344/1000. These APIs return complete arrays;
there are no pagination controls or server pagination semantics to pass here.
Client counts matched the complete server lists; this does not predict larger
server pagination or production latency.

## Verified results and measurements

[results.json](issue-303/results.json) and [browser.cjs](issue-303/browser.cjs)
retain individual cases, timings, request counts and failures. Timers are
`performance.now()` around automated actions and explicit DOM/URL predicates.
Search includes typing at 40 ms/character. Cold Books includes document load,
1200 rendered row links and network idle. Filter totals were independently
calculated from the deterministic seed. Navigation timings end when the expected
row count exists, not when a human has read the screen.

| Measure                                                            | 1440×900                        | 1920×1080                         |
| ------------------------------------------------------------------ | ------------------------------- | --------------------------------- |
| Books cold 1200-row list                                           | 1291 ms                         | 1325 ms                           |
| Search long invoice identifier, 1 exact hit, input and URL intact  | 1576 ms                         | 1564 ms                           |
| From/To 2026 + largest-per-currency order, 600 correct rows        | 2065 ms                         | 2104 ms                           |
| Draft filter, exactly 770 rows                                     | 1389 ms                         | 1261 ms                           |
| Books open, 5 repetitions (row ranks 5/600/1150/5/600)             | 87–182 ms                       | 89–218 ms                         |
| Books Back to row and focus                                        | 390–454 ms; Δtop 0 px, 5/5      | 405–508 ms; Δtop 0 px, 5/5        |
| Bank open, ranks 5/500/990 among 1004 controls                     | 408–784 ms                      | 378–777 ms                        |
| Bank Back to row and focus                                         | 317–467 ms; Δtop 0 px, 3/3      | 325–700 ms; Δtop 0 px, 3/3        |
| Inbox search, 1 filename hit (includes fresh list setup)           | 2698 ms                         | 2824 ms                           |
| Bank full counts → one reference hit → clear → toggle (whole case) | 2506 ms                         | 2543 ms                           |
| Checkbox toggle, 0 selected → 1 selected                           | 118 ms                          | 129 ms                            |
| Sidebar Books / Inbox / Bank, 3 rounds, ranges                     | 459–665 / 522–954 / 556–1607 ms | 552–1384 / 767–1248 / 622–2960 ms |

2026 filter: exactly 600 rows = 540 EUR + 60 USD; totals **−327245.40 EUR** and
**−12381433.49 USD**, not a cross-currency sum. All dates matched the bounds;
within each currency the complete sequence matched independent descending
amount order. Filters/order were present in the URL. Bank labels remained
`Unmatched 1000 / All 1000`; search found reference `000999` exactly once.

Books geometry: zero overflowing row boxes across 1200 rows and no horizontal
page overflow at either width. Screenshots `1440-books.png`, `1920-books.png`
show aligned desktop columns. This is not a per-cell clipping audit of every
other screen. No split-pane absence is classified as a defect.

Each Books/Bank open-return cycle used target scrolling, one row activation,
and browser Back: two navigation actions, retaining URL and row focus. Sidebar
matrix used 9 link activations per width. These are automated interaction counts,
not human effort or reading time. Bank selection inspection used checkbox →
line → Back, three activations, with no Book/Confirm submission.

### Inbox position: measured separately, strict assertion remains unproven

The main matrix's strict Inbox return assertion **failed at both widths**. Its
programmatic scroll after a previous Back can be re-anchored by the intentional
list-position guard, so it sampled a row tens of thousands of pixels offscreen
before Playwright's click scrolled it again. These timeout durations are **not**
valid workflow timings and are excluded from the table.

[inbox-return-results.json](issue-303/inbox-return-results.json) captures actual
row position at the history PUSH (the moment the focused row leaves), rather
than trusting the earlier scroll command. For ranks 5/500/990, focus returned
**6/6**; Δtop from that actual leave was **−8/0/0 px at 1440**, **0/0/+8 px at
1920**. Open: 153–202 ms / 243–1297 ms. Return: 958–1136 / 963–1446 ms, **including
an explicit 250 ms post-return observation pause**. These measurements establish
retained object context, not exact pixel equality at viewport edges. A later
wheel-based harness variant failed to obtain its focus predicate and produced no
usable samples; it is archived, not passed. No additional product bug is claimed
from those harness failures. Exact Inbox return-position acceptance needs root's
independent verification.

## Confirmed defect and focused fix

Baseline: select a low-confidence match, open its bank line, Back. The same
checkbox changes **true → false at both widths**. Evidence:
[selection-before.json](issue-303/selection-before.json). StatementScreen's local
selection was discarded on unmount and only default high-confidence proposals
were preselected on remount.

The fix saves explicit choices in the **same history entry**, including an empty
set. Restore requires the same statement, sign-in id and auth epoch. A fresh
visit and another sign-in retain normal defaults. Existing search/filter writes
preserve entry state. No token is stored in history; no matching or posting API
behavior changed. Existing current proposals still determine what can be booked.

Fixed production browser result: **true → true at both widths** in
[selection-results.json](issue-303/selection-results.json). The selection harness
waits for the detail URL before Back and identifies the exact proposal control
(the same object can be a candidate for several lines). Screenshots
`*-selection-before.png` / `*-selection-after.png` are from the fixed build.

Regression tests cover medium selection, high-confidence deselection, an
explicit empty set, new visits and another sign-in. On baseline, the new test
fails (**1 failed, 9 passed**); fixed related suites: **38 passed**. Production
web build/typecheck, scoped ESLint and Prettier checks passed. Node 26 requires
`NODE_OPTIONS=--no-experimental-webstorage` for these existing jsdom tests;
without it all tests failed in setup, not on the regression. No full suite run.

Proposed priority **P2**, because inspecting a candidate silently changes work
already selected for Book. Linked issue proposal for root:
`/tmp/hbk-issue-loop/issue303-linked-selection-proposal.md`. It was not published.

## Failures, limits and reproducibility

- Early Chromium attempts failed for absent libraries/fonts (Skia FontConfig
  fatal). The first tiny PNG fixture was corrupt and yielded preview 404s; it
  was replaced with valid unique PNGs from `png.cjs`. Neither failure is an app
  QA pass. The final matrix made 4201 real preview GETs per width; preview UUID
  blob requests are aggregated in the result file. One 404 per width remains:
  `/api/documents/596/pending-draft`, expected for a synthetic unclassified
  document without a pending draft. No app page errors were captured.
- App-server restoration changed Node ABI; native addon was rebuilt locally.
  One intermediate backend process stopped (exit 143); that interrupted run is
  archived separately. All reported final counts use the restored live backend.
- Earlier harness selectors included Inbox's extra “Start clearing” link;
  final counting uses marked queue rows. Order is selected as a combobox and
  sampled only after URL and actual row order commit. Initial harness failures
  are retained under `/tmp/hbk-303-run-archive/`, not silently passed.
- Reconciliation verification stops at inspection and selection retention.
  **No bulk match Book/Confirm was executed**, no end-to-end settlement timing,
  no FX settlement, no human source-document comparison. All proposals were low
  confidence; high-confidence deselection is covered by the focused regression,
  not a backend-generated browser fixture. Invoices/archive volume workflows,
  Reports totals and other browsers/OS/physical devices were not exercised.
- 1×1 sources do exercise real HTTP/preview rendering, but not realistic PDF/OCR
  cost, scanned-page legibility, document size or human reconciliation time.
  Adwaita fallback fonts were local, not macOS/Windows system fonts.
- Real current production distribution is unavailable. **#303 is not certified
  complete for production data or exact Inbox return geometry**. Root owns the
  acceptance decision, linked issue publication, independent review and deploy.

Run from this worktree with fresh local data (do not run seed against an
existing database). Install dependencies locally, build server/web, start Nest
with `DATA_DIR=$PWD/.qa-data PORT=4303`, allow migrations, then run:

```sh
node docs/qa/issue-303/seed.cjs "$PWD/.qa-data/app.sqlite"
node docs/qa/issue-303/post-fixtures.cjs
node docs/qa/issue-303/serve.cjs
# In another shell; use available Chromium libraries/fonts as needed:
FONTCONFIG_FILE="$PWD/.qa-tools/fonts.conf" \
LD_LIBRARY_PATH="$PWD/.qa-tools/libs/usr/lib" \
node docs/qa/issue-303/browser.cjs
# Independently reproduce the fixed selection and observe Inbox returns:
node docs/qa/issue-303/selection.cjs
node docs/qa/issue-303/inbox-return.cjs
```

Harnesses require Playwright at `.qa-tools/node_modules/playwright`; only
`browser.cjs` additionally accepts `PLAYWRIGHT_PATH`. Scripts and evidence are
under [issue-303/](issue-303/). Test logs are `regression-baseline.log` and
`targeted-tests.log`; screenshots contain synthetic data only. `MANIFEST.sha256`
records committed artifact hashes. No deployment result is asserted.
