# #300: real-service network interruption QA

**QA complete for this bounded environment; acceptance is not fully satisfied.**
One reproducible defect needs a coordinator-created linked issue (proposed P2,
text below). Physical-device suspension remains untested. No product fix,
publication or production mutation was performed.

This extends the earlier [mocked run](2026-09-24-network-background-mutations.md)
and [mocked follow-up](2026-09-24-network-background-mutations-followup.md).
Those reports' claims about real accounting idempotency were explicitly limited;
this run uses real accounting services and an actual SQLite database.

## Environment and method

- Base/build: `bc1cb5af1578ed3a2cf744e630c2342918b2b818`, own production
  `npm run build -w @headless-bookkeeping/web`. No product source changed.
- Arch Linux x86_64; Node **24.21.0**, Playwright **1.64.1**, Chromium
  **153.0.8010.12** (headless shell build 1243). Viewports: 1440×900 desktop;
  390×844, touch/mobile emulation, DPR 1 for C2/U4/B4. These are not devices.
- Own worktree `issue-300`; backend `127.0.0.1:4300`, asset/fault proxy
  `127.0.0.1:5300`; `data/qa-300/app.sqlite` and local document storage only.
  Real Nest controllers, validation, authorization, migrations, document hash
  dedup, intake routing, posting, policy, approvals, reconciliation and ledger.
  **No Playwright `page.route` response mocks.**
- All data is **synthetic**. Token `synthetic-300-local-only` is a public local
  fixture value. Seed: IE organization, EUR, one supplier and bank lines.
  OCR and classification alone are deterministic substituted providers; no
  external model, mailbox or physical receipt was used. Intake polling and cron
  are disabled. This does not test automatic queue scheduling or live inference.
- Upload controls use the default master switch **auto-post disabled**, so
  intake creates one pending Expense/Approval. Bank controls explicitly seed
  auto-post enabled, unknown-supplier hold disabled and confidence minimum 0.
  No production Policy was changed. Bank amounts are distinct (125–129 EUR).
- The HTTP proxy forwards each received request once. `before` fails before
  forwarding; `after` waits for the real backend response then truncates the
  downstream JSON body; `empty-after` closes before sending any response bytes;
  `hold-after` buffers a completed real response until released. The truncated
  body faults intentionally have headers, preventing the empty-response retry
  from being confused with application retry.
- Every case captures real server response events, persisted business records,
  counts before/after, UI text, screenshot and page errors. `harnessPass` means
  the scenario/observational assertions completed; `verdict` overrides it for
  the two **FAIL** defect observations. No page errors occurred in the final matrix.

## Results

| Case        | Fault and recovery                                                                                 | Persisted result / verdict                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C1          | Create blocked before upstream; reconnect, explicit retry                                          | First attempt 0 drafts; retry 1 draft. PASS                                                               |
| C2          | Create committed, body lost; explicit repeat after truthful warning                                | First attempt 1 draft; repeat creates another. Known unknown-outcome limitation, not a no-duplicate pass  |
| C3          | One New expense submit; create committed, empty response                                           | **FAIL: 1 browser request, 2 wire POSTs, 2 drafts. UI reports Done for the second**                       |
| C4          | Create response held after commit; Escape and SPA Back; offline/reconnect/listener events; release | Pending navigation refused; response release completes the original flow. One draft. PASS                 |
| C5          | Reload while committed create response held; release old response                                  | One draft; retained unknown/interrupted operation result; no automatic replay or late navigation. PASS    |
| C6          | Chromium offline before submit; reconnect, explicit retry                                          | 0 server POSTs until explicit retry; then 1 draft. PASS                                                   |
| C7          | Single bare fetch, same empty-response fault, no app handler                                       | **FAIL: 1 fetch/request, 2 wire POSTs, 2 drafts**; independent control confirms transport retry           |
| U1          | Upload blocked before upstream; retry                                                              | One Document, one pending Expense, one Approval. PASS                                                     |
| U2          | Upload committed, body lost; repeat same file                                                      | Hash dedup returns existing Document, then intake runs once; one Expense/Approval. PASS                   |
| U3          | Triage blocked before upstream; Retry processing                                                   | Retry does not re-upload; one Document/Expense/Approval. PASS                                             |
| U4          | Triage committed, body lost; Retry processing                                                      | Existing outcome replayed; one Document/Expense/Approval. PASS                                            |
| B1          | Bank-line create blocked before upstream; repeat                                                   | One Expense, posting and match activation once. PASS                                                      |
| B2          | Bank-line posting committed, body lost                                                             | One Expense/Voucher; honest partial receipt. Reload shows the existing open item. PASS                    |
| B2 recovery | Select that open item and Match                                                                    | Existing Expense settled, no new Expense. One active match. PASS                                          |
| B3          | Match staging committed, body lost; Confirm match                                                  | One original staged pair/Approval; confirmation activates it once. PASS                                   |
| B4          | Approval committed, body lost                                                                      | Existing match is active; no repeat approval or duplicate settlement. PASS                                |
| B5          | Match blocked before upstream; select existing item and Match                                      | First attempt stores no match; recovery uses existing Expense, one active pair. PASS                      |
| L1          | CDP frozen/active and second foreground tab probe                                                  | **Not an actual suspension**: 9 timer ticks in 900ms, no freeze/resume events, visibility remains visible |

After handled faults, offline/reconnect plus synthetic blur/visibility/focus
listener events produced **zero automatic mutation POSTs**. Synthetic listener
signals were dispatched while actual visibility remained visible; they must not
be called real backgrounding. C4 exercises them while a committed mutation's
response is still held. A real mobile OS may behave differently.

The read-only [audit](issue-300/audit.json) verifies all 10 persisted vouchers
are balanced and their hash chain is intact, zero duplicate reconciliation
pairs, no over-allocation, valid foreign keys and SQLite integrity. The database
also retains preliminary harness attempts (wrong route/initial approval policy
and a Back to `about:blank` control); their counts are not attributed to valid
cases. Final case deltas are authoritative, not the total fixture row count.
The four Documents have five source records: hash-deduplicated re-upload retains
provenance; this is not a duplicate Document.

## Confirmed defect — proposed linked issue text (P2)

**Title:** One create action can create two Expense drafts when Chromium retries
an empty response after server commit.

**Related:** #300, #251, #259, ADR-0040. Priority proposal: **P2** — reproducible
extra unposted business object and misleading single-success attribution; this
run does not establish duplicate posted ledger entries.

**Steps:** use the real backend and synthetic database as below. In New expense,
leave Supplier empty, choose Software, gross 43.03 EUR, VAT 0, tax point
2026-09-10. Arm `empty-after` for `POST /api/expenses`. Submit once. The proxy
forwards the request, receives 201 for Expense #4, closes the reused HTTP/1.1
connection without sending response bytes; Chromium retries it. The backend
returns another 201 for Expense #5. The UI shows Done and opens #5. IDs refer to
C3 in the captured matrix, not a fresh database.

**Actual:** one page request event, two independently logged backend 201
responses with identical facts and different IDs, two actual draft rows. C7
reproduces with one bare fetch, ruling out React event handlers/query retries.
Explicitly retrying an unconfirmed create (C2) can also produce a second draft,
but is a separate known limitation with truthful warning.

**Expected:** a transport replay of one create operation must not create another
business object. A retry should resolve the original outcome. A stable operation
key must distinguish retries from legitimate separate purchases; deduplication
by amount/date/supplier alone is not an acceptable fix.

**Evidence:** [C3 screenshot](issue-300/C3-empty-response.png),
[request/response and DB snapshots](issue-300/results.json),
[independent failing assertion](issue-300/repro-red.json).
`QA_ASSERT_IDEMPOTENT=1` makes the real bare-fetch scenario fail with
`One fetch created duplicate draft expenses` (exit 1).

**Scope/decision:** no product fix was made in this QA ticket. ADR-0040 explicitly
excluded new server idempotency and acknowledged lost-create duplicates. Extending
that contract across client create and server persistence is a separate decision
for the coordinator; the transport-level manifestation is now demonstrated on the
real backend. No shared dialog code owned by #297 was changed. The linked defect
has not been published; its creation/status belongs to the coordinator.

## Reproduction and artifacts

Run only in `/root/.cache/hbk-worktrees/issue-300`, with Node 24.21.0 first on PATH.
Use a fresh **own** `data/qa-300` for a clean replay; keep existing captured evidence
and databases rather than deleting history. Do not run against production.

1. `npm ci` and `npm run build -w @headless-bookkeeping/web`.
2. `node docs/qa/issue-300/backend.cjs` (4300 must be free).
3. `node docs/qa/issue-300/proxy.cjs` (5300 must be free).
4. Install Playwright in an isolated tooling directory, set `QA_PLAYWRIGHT_MODULE`
   to its module path, and provide Chromium headless shell build 1243. The captured
   run used `/tmp/hbk-397-browser/node_modules/playwright` read-only, plus its own
   previously unpacked libraries/fonts through `LD_LIBRARY_PATH` and
   `FONTCONFIG_FILE`. `browser.cjs` names the exact cached browser executable.
5. `node docs/qa/issue-300/browser.cjs`. Existing successful case IDs are skipped;
   `QA_RERUN=1` opts into rerunning, and `QA_CASES` selects comma-separated IDs.
   A new `QA_RESULTS` filename preserves existing results. Never run two browser
   harnesses concurrently against one backend/proxy.
6. `node docs/qa/issue-300/audit.cjs` (read-only).
7. Minimal red reproducer, while backend/proxy run:
   `QA_CASES=C7-bare-fetch-empty-response QA_ASSERT_IDEMPOTENT=1 QA_RESULTS=/tmp/qa300-repro.json node docs/qa/issue-300/browser.cjs`.
   It makes fresh synthetic writes and is expected to exit **1** until fixed.

[Harness and evidence](issue-300/) includes scripts, results, read-only audit,
screenshots and SHA256 manifest. Runtime/build logs and discarded harness errors
are in `/tmp/hbk-issue-loop/300-logs/`; the first navigation probe targeted an
inaccessible sidebar link behind a modal, then Back without an SPA history entry.
Those are harness corrections, not product defects. Early bank attempts used the
default approval-required policy and did not reach matching; they are excluded
from the bank verdict. No successful full test suites were repeated: product code
is unchanged; production web build, actual HTTP/browser matrix, syntax/format and
DB audit are the relevant checks.

**Still open:** linked defect publication/fix, physical mobile suspension/resume,
physical network switching, TLS/HTTP2 transport behavior, automatic intake worker
scheduling, live OCR/AI/provider outages, production Policy/data. No physical-device,
production, or universal accounting-idempotency pass is claimed.

The owned backend/proxy were stopped after QA; ports 4300/5300 are free.
The synthetic database and uploaded files are preserved under ignored
`data/qa-300/` (moved there from the initial `.qa-data` scratch path); the final
harness points to that location. No worktree or captured evidence was removed.
