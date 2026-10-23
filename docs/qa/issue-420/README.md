# #420 — Expense create replay regression evidence

Base: `eb92556f578f410ad5eed4be0a79d879e6a0b164`. Own worktree:
`/root/.cache/hbk-worktrees/issue-420`. Product change is limited to optional
`Idempotency-Key` on Expense creation and its New expense/bank-line callers.
[ADR-0040 amendment](../../adr/0040-specialized-client-operation-lifecycles.md)
records the coordinator-approved evolution of the earlier exclusion.

## Real-seam browser result

Chromium **153.0.8010.12** headless shell build 1243, Playwright **1.64.1**,
Node **24.21.0**, Arch Linux x86_64; 1440×900 CSS pixels, DPR 1, desktop.
Production Vite build; the final `index.html` digest is in every case and full
asset digests are in `build.json`. No browser API response mocks are used.

The real Nest/SQLite backend runs on loopback 4420, production assets and an HTTP
fault proxy on 5420. All data and the token are synthetic. OCR/classification are
deterministic substituted external providers, unused by these manual-create
scenarios; accounting, validation, Policy, posting, reconciliation, approval,
operation-key persistence and HTTP controllers are real. Automatic intake polling
and cron are disabled. The fixture explicitly enables auto-posting for the bank
chain; production settings and data are untouched.

| Case | Fault / action                                                                  | Browser create requests | Actual server create POSTs | Persisted Expenses | Persisted create operations | Returned IDs |
| ---- | ------------------------------------------------------------------------------- | ----------------------- | -------------------------- | ------------------ | --------------------------- | ------------ |
| N1   | New expense: empty response after commit; Chromium transport replay             | 1                       | 2                          | 6→7                | 6→7                         | 7, 7         |
| N2   | New expense: body truncated after commit; explicit retry with locked facts      | 2                       | 2                          | 7→8                | 7→8                         | 8, 8         |
| B1   | Bank-line create: empty response after commit; Chromium transport replay        | 1                       | 2                          | 8→9                | 8→9                         | 9, 9         |
| B2   | Bank-line create: body truncated after commit; explicit retry with locked facts | 2                       | 2                          | 9→10               | 9→10                        | 10, 10       |

**All four scoped requirement verdicts are PASS**, with no page errors. Each pair
of server requests carries the same nonempty key, has equal original 201 response
bodies and creates exactly one Expense/operation record. New forms use distinct
keys even for identical supplier-less purchase facts. Each bank chain subsequently
posts once and activates one match; its two vouchers are the purchase and its
settlement, not repeated posting. `[N2|B2]-unknown.png` captures the frozen facts
before explicit retry. `results.json` contains wire responses, snapshots and UI
text; `audit.json` contains a read-only derivative with no implicit PASS fallback.

The database retains earlier runs, including two initial bank scenarios whose
accounting completed but whose driver waited for a Matched heading after the
product correctly navigated to the statement. The driver destination was corrected;
those records were retained, not deleted or edited. Earlier-build records and
screenshots are archived under `/tmp/hbk-issue-loop/420-logs/earlier-build/`.
Final deltas above, rather than the total fixture count, prove the regression.
Readonly audit covers all 12 retained vouchers: balance, hash-chain, foreign keys
and integrity pass; no repeated reconciliation pair or over-allocation exists.
Every retained create key has its original response and one distinct Expense ID.

## Automated acceptance regressions

`packages/server/test/expenses-metadata.e2e-spec.ts` exercises actual HTTP and
migrated SQLite for eight simultaneous same-key creates, conflicting concurrent
facts, optional insert-default normalization, distinct keys with identical facts,
legacy no-key creates, original-response replay after editing/posting/deletion,
invalid headers/bodies, preserved business duplicate guard and transactional
rollback of key/Expense/override audit on an injected failure. Deletion replay is
historical and does not resurrect the draft.

Web regressions exercise stable key/fact retention after an unknown result,
locked input, a separate form's fresh key, bank-chain retry of the original facts,
fresh key after a definite refusal and no repeated post/match stages. Existing
caller assertions also require the added key argument. API callers without a key
remain compatible and receive **no new idempotency guarantee**.

## Reproduction

Run with Node 24.21.0 and own dependencies. These guarded scripts only operate in
a worktree named `issue-420`. All runtime files stay in ignored `data/qa-420/`.
Keep the current database/evidence; use a separate fresh owned fixture if replaying
all cases, rather than deleting historical records. Ports must be free.

1. `npm ci`; `npm run build -w @headless-bookkeeping/web`.
2. `node docs/qa/issue-420/backend.cjs` and
   `node docs/qa/issue-420/proxy.cjs` in separate processes.
3. Provide Playwright using `QA_PLAYWRIGHT_MODULE` (the captured run reads the
   earlier isolated `/tmp/hbk-397-browser/node_modules/playwright` installation),
   cached Chromium build 1243, and `FONTCONFIG_FILE`/`LD_LIBRARY_PATH` pointing to
   its previously unpacked fonts/libraries. No shared dependencies are modified.
4. `node docs/qa/issue-420/browser.cjs` uses real HTTP socket faults. Completed
   case IDs are skipped. Never run two drivers against one fixture/proxy. The
   captured final bank lines are 5/6; a clean fixture creates all eight seed lines.
5. `node docs/qa/issue-420/audit.cjs` only reads SQLite and regenerates `audit.json`.

Raw logs are under `/tmp/hbk-issue-loop/420-logs/`. Backend/proxy were stopped and
4420/5420 are free; fixture data remains preserved. No push, PR, merge, issue close
or deployment was performed by this pane.

## Boundaries

Keys/facts survive the live form/chain's transport and explicit retries. They do
not gain cross-reload/form persistence: after closing/reloading, check Books and
the recorded result before deliberately starting a separate create. The original
create response is historical; use GET for current state. Operation receipts are
retained without expiry, including after draft deletion. Distinct operations still
obey the existing purchase duplicate guard; amount/date are not operation identity.

This extends Expense creation only. Invoice creation, posting, matching, approval
and all other mutation contracts are unchanged. Physical device suspension, real
network handoff, TLS/HTTP2 behavior, live OCR/AI and production financial data were
not tested; no universal network/backgrounding or all-mutation idempotency claim
is made. #300's physical-device limitations are not resolved by this fix.

## Final checks

- Full server: 200 suites / 2478 tests passed; 3 suites / 13 tests skipped
  (`server-full.log`). The outer chained command was terminated after that
  complete Jest summary, before starting web; successful server tests were not
  repeated. Remaining commands were run separately.
- Full e2e: 33 suites / 203 tests passed, one worker with
  `--workerIdleMemoryLimit=256MB` (`e2e-full.log`). Focused create regressions:
  11/11 (`focused-e2e-final.log`).
- Full web: 149 suites / 1544 tests passed; one old assertion expected fields to
  unlock after 503. That expectation was updated to the new preserved-facts
  contract and strengthened to compare retry key/body. The entire affected file
  then passed 9/9 (`web-full.log`, `web-pending-recheck.log`). No product change
  was needed after the final browser run, and no broad web repeat was made.
- Production web/server builds, final server/web type checks, scoped lint,
  Prettier, harness syntax, OpenAPI/codegen and `git diff --check` passed. Generated
  CLI outputs are repository-ignored. The existing Vite large-chunk warning
  remains. Raw logs are under `/tmp/hbk-issue-loop/420-logs/`.
