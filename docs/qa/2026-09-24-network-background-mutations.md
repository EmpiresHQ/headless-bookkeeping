# QA-007: Network interruption and backgrounding during mutations (issue #300)

This is a verification task, not an assumed bug. The run was a bounded,
mocked Chromium matrix on `main` `196b206`. No product code was changed.
**No physical device, native iOS/Android background/resume or OS
suspension was used, and no real backend was involved.** Every write below
went to an in-page mock or root’s local HTTP fixture. A mock's commit, dedup or replay behaviour says
nothing about the real server's accounting idempotency.

## Verdict

| Question                                                                   | Status                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native iOS/Android background, resume, app kill                            | **NOT RUN** (no device)                                                                                                                                                                                                                                                                     |
| Headless "background" (CDP freeze, window minimize, a second tab in front) | **Not exercised, inconclusive**: the page stayed `visible`, no `freeze`/`resume`/`visibilitychange` fired, and timers kept running (this run and root's two-tab probe). Only a _synthetic_ `visibilitychange` was dispatched; it is not a background state                                  |
| Upload: stages, lost responses, retry per stage, reload mid-stage          | Run (mock). **Pass**: status is truthful ("not confirmed" / partial), and the client never replays a write on its own. An explicit retry re-sends only the **unconfirmed** stage: a stage that was confirmed is never re-sent, but the unconfirmed one may already have been committed (U4) |
| Create & match (bank line): lost response per stage                        | Run (mock). Mostly pass; one copy defect, filed by root as [#373](https://github.com/EmpiresHQ/headless-bookkeeping/issues/373) (P3). The first M3d "duplicate match" model is **retracted** (below)                                                                                        |
| New expense: lost create response                                          | Run (mock), 1 representative control. **Pass**. Root ran the real-HTTP create variants                                                                                                                                                                                                      |
| Bank statement import (#254): lost upload response, status reads drop      | Run (mock). **Pass**, plus 1 observation                                                                                                                                                                                                                                                    |
| Issue #300                                                                 | **Stays OPEN**: native background/resume is untested                                                                                                                                                                                                                                        |

### Findings (not fixed here)

1. **M2d → [#373](https://github.com/EmpiresHQ/headless-bookkeeping/issues/373) (P3, filed by root after independent reproduction): the banner states as fact something the client doesn't know.**
   - The mock committed `POST /api/expenses/24/post`, then aborted the response. During the slow-reads window the form banner says "**Expense #24 was created as a draft but not posted.**"
   - The mock had posted it (`#24:posted`), and the receipt on the same screen says "posting it was not confirmed".
   - Source: `TxCreateExpense.tsx:293` renders `landed.posted === null` as "not posted". That value means "not confirmed". It does not distinguish a refusal from an unknown outcome.
   - What a Finish click would do then (a re-post) was **not run**: the real server's answer to re-posting a posted expense is not known here.
2. **M3d, corrected: "Finish" after a lost match response re-sends the match stage; the mock refuses it, and the UI recovers.** This is frontend retry behaviour, not a duplicate.
   - The mock committed `POST /api/bank-statements/3/match` (draft #20 plus pending approval #30), then aborted the response. The statement reads that follow were slow (4 s), not failed.
   - During those 4 s the form stays mounted, with "Already on the books … Expense #24 was created and posted. Retrying finishes the remaining steps for THAT expense" and **"Finish · expense #24" enabled**.
   - The client re-sends the stage because `createExpenseFromLine` records `stagedMatchIds` only on a `BookingPartialError` (`queries/bank.ts:470`). A network error from the `manualMatch` POST leaves nothing recorded, so Finish re-reads the candidates (`:438`) and POSTs the match again (`:458`). The second POST went out only after that fresh candidate read completed; root saw the same independently.
   - **Server rule (source):** migration `031_unique_reconciliation_match_pair.ts` adds an unconditional `UNIQUE(bank_transaction_id, voucher_id)` index, drafts included, registered in `migrations/index.ts:110`. `insertMatchRow` maps the violation to a 409 `ConflictException` "Duplicate reconciliation match: bank transaction … is already matched to voucher …" (`reconciliation.service.ts:1681-1688`).
   - **v2 run (mock enforces that rule):** the second POST got **409**. The receipt became `partial` "Posting of Expense #24 was confirmed; matching the line was not confirmed (409 Conflict: Duplicate reconciliation match: bank transaction 9 is already matched to voucher 7). Open the line for its current state…". When the reads landed, the line showed the **existing staged #20** as "Expense #24 — staged" with **Confirm match**.
   - Mock end: one row, `#20:draft` with `#30 pending`, awaiting the operator's Confirm. No new row, no "Done" claim, no second approval.
   - Remaining UX only: an offered "Finish" repeats a stage that may have committed, and the operator then sees a technical "Duplicate reconciliation match" reason before the recovery. No severity is proposed; root's call.
   - When the reads fail instead (M3b), or return quickly (M3a), the form is replaced and no second POST is sent.
   - Artifacts: `bank-results-M3d_match_commit_lost_slow_reads_click_finish.json`, `bank-M3d-v2.log`, `shots/M3d-v2-{in-window,after-click-1500,after,final}.png`.

**Root's independent corrected bank rerun** (`/tmp/hbk-300-browser/bank-review-unique-results.json`, `bank-review-unique.log`, own fixture with the unique pair enforced; cited, not rerun here) recorded 5 observations:

- Lost match + slow reads: an explicit Finish waits for fresh candidates, then the second match POST gets the source-derived 409 (the unique pair, mapped by `insertMatchRow` to `ConflictException`; the global `SqliteConstraintFilter` also maps unique violations to 409). No false Done; one original draft.
- Releasing the reads → Confirm match approves the original match 80 / approval 90, leaving one active row and zero pending.
- The fast-read and no-commit controls pass.
- Both lost-post cases pass; only slow reads show the categorical "not posted" contradiction (#373).
- Root's verdict: **no retry follow-up is warranted**, given the safe refusal and recovery.

### Retraction: M3d v1 duplicate-pair model

My first M3d run (`bank-results-M3b_M3d-v1-INVALID-duplicate-pair-model.json`, `bank-M3bd-v1-INVALID-duplicate-pair-model.log`, `bank-v1-INVALID-duplicate-pair-model.mjs`, `shots/M3d-v1-INVALID-model-*.png`) used a mock that let the same `(bank transaction, voucher)` pair be inserted twice. From that I reported a "second staged and approved match, with #20/#30 orphaned" as a proposed P2. I called it plausible on the real server from the `executeMatch` insert alone, and missed migration 031 and its 409 mapping. **That model and its conclusion are invalid and withdrawn.** No duplicate or orphan claim is made, and root filed no such issue (root's own superseded model: `/tmp/hbk-300-browser/bank-model-correction.json`). The M3b, M3a and M3c results are unaffected: each sent only one `POST …/match`, so the duplicate rule was never reached.

## Set-up

- **Build:** own `vite build` of `196b206` into `.review-300/dist` (untracked), unmodified. Product source and dependencies are identical to base; only this report is committed, and `.review-300/` is untracked. Served by `vite preview` on `127.0.0.1:5366`, which was stopped by PID afterwards.
- **Browser:** Chromium 153.0.8010.12 (Playwright build), headless, driven by Playwright 1.63.0 on Node 24.21.0 on Linux. Context: 390×844 CSS viewport, `isMobile` + `hasTouch`, DPR 1. That is not a device.
- **Mocking:** base chain `/tmp/hbk-25{1,2}-browser` (token `review-fixture`, other origins aborted, unknown non-GETs 500, unknown GETs 503 plus recorded), imported read-only.
  - Upload: `/tmp/hbk-258-browser/fixtures.mjs` `setupUpload` (document #19, `upload-258.png`, outcome expense #12, or triage).
  - Import: `/tmp/hbk-254-browser/fixtures.mjs` `setupImport` (job #41, `review.csv`, `BANK_EUR`).
  - Bank line: an **own stateful mock** in `.review-300/bank.mjs`, because the shared bank fixture keeps its state in a closure and cannot commit and then drop.
    - Line: statement 3, tx 9, −123.45 EUR, 2026-09-10, "Receipt coming later", category `office`.
    - Mock rules: expenses from #24, matches from #20, approvals from #30. Candidates are posted expenses. `lineRemaining` counts ACTIVE matches only. Approval re-checks over-allocation. A second `POST …/match` for an existing (line, voucher) pair answers 409 with the server's message (migration 031; added in v2 after root's review). Re-posting a non-draft answers 409, an _assumed_ rule that was never triggered.
  - New expense control (C1): gross `45.67`, date `2026-09-21`, category `office`.
- **Faults:** an override route registered last (so it runs first).
  - `abortNoCommit`: `route.abort('connectionreset')` with no state change.
  - `commitAbort`: the mock state is committed first, then the response is aborted. A later GET through the page confirms the stored row: document #19 `pending`/`processed`, expense `#24:draft`/`posted`, match `#20:draft`, and so on.
  - `hold`: the request is held open.
  - Slow reads: statement GETs delayed 4 s. Failed reads: the same GETs aborted.
  - These aborts happen inside Playwright's interception, before any socket exists, so Chromium's transport-level retries cannot occur here (see root's real-HTTP results below).
- **Counts:** every non-GET `/api` request is logged via `request`/`requestfinished`/`requestfailed`, with its real transition. `POST …/propose-matches` is a read-like POST fired by the statement screen, and is left out of the counts below. The mock's own log records what it received and committed.
- **Synthetic resume:** overrides `document.visibilityState`/`hidden`, dispatches `visibilitychange` on `document` and `window` (TanStack Query listens on `window`) plus `blur`, restores after 1–1.5 s, and dispatches again plus `focus`. This only drives app listeners.
- **Harness:** `.review-300/{common,upload,bank,import,probe,probe2}.mjs`. Results are the `*-results*.json` files; screenshots are in `.review-300/shots/`.

### Mechanism probes (`probe-results.json`, `probe2-results.json`)

| Proxy                                  | Observed                                                                                                           | Consequence                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `context.setOffline(true)`             | `navigator.onLine=false`; routed (`route.fulfill`) `/api/entities` **still 200**; unrouted asset `Failed to fetch` | Offline emulation is bypassed by fulfilled routes, so it was not used in this matrix |
| Other page `bringToFront`              | first page stays `visible`                                                                                         | no hidden state                                                                      |
| CDP `Page.setWebLifecycleState frozen` | call OK; 43 timer ticks in ~2.1 s (≈42 expected); no `freeze` event                                                | not frozen                                                                           |
| Window `minimized` + frozen            | `visible`; `evaluate` answered while "frozen"; timers slowed (36/56) but ran                                       | not frozen                                                                           |

Root's independent two-page probe was also negative, both with and without the three background-disable flags (`/tmp/hbk-300-browser/lifecycle-probe-results.json`).

## Results

"Writes" lists non-GET `/api` requests in order: `ok` = finished with 200, `✗` = `requestfailed net::ERR_CONNECTION_RESET`, `⏸` = never finished (the page was reloaded). "Idle" = 2 s of waiting, then a synthetic hidden→visible cycle, then 1 s; the column gives the new writes during it.

### Upload (`upload-results.json`, rerun; initial run kept)

| #   | Fault                                                           | Visible after the fault (receipt tone · button)                                                                                 | GET shows       | Idle | Explicit action → writes                                                   | Mock commits (upload/triage) | End                                                     |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---- | -------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| U1  | upload not received                                             | error "not confirmed — no document ID… may or may not be stored" · Upload & process                                             | 0 documents     | 0    | Upload & process → `documents ✗, documents ok, triage ok`                  | 1 / 1                        | `/books/expenses/12`, 1 receipt `ok` (superseded)       |
| U2  | upload **committed**, response lost                             | same error copy (makes no claim either way)                                                                                     | #19 `pending`   | 0    | Upload & process → `documents ✗, documents ok` (mock dedup) `, triage ok`  | 1 / 1                        | receipt "Already uploaded as document #19 — Processed…" |
| U3  | triage not received                                             | partial "Stored as document #19, but processing was not confirmed" · **Retry processing**, "does not upload the file again"     | #19 `pending`   | 0    | Retry processing → `documents ok, triage ✗, triage ok`                     | 1 / 1                        | expense #12, `ok`                                       |
| U4  | triage **committed**, response lost                             | same partial copy (truthful: not confirmed)                                                                                     | #19 `processed` | 0    | Retry processing → `documents ok, triage ✗, triage ok`                     | 1 / **2**                    | expense #12 (the mock replays the same outcome)         |
| U5  | triage-queue read lost (2 reads, including the query's 1 retry) | partial "stored and was processed, but its result could not be loaded" · **Reload result**                                      | —               | —    | Reload result → **0 writes**                                               | 1 / 1                        | `/inbox/doc/19`                                         |
| U6  | upload held; synthetic hidden 2 s while pending                 | sheet stays open and busy; the request stayed `pending`, not re-sent                                                            | —               | —    | release → `documents ok, triage ok`                                        | 1 / 1                        | expense #12                                             |
| U7  | triage held; **page reload**; then mock commits + response lost | before: `running` "processing…"; after reload: **partial** "processing was not confirmed: Failed to fetch…" (not `interrupted`) | #19 `processed` | —    | same file in a new sheet → `documents ok` (dedup, `processed`) → no triage | 1 / 1                        | `/books/documents/19`, "nothing was processed again"    |

- **U4:** an explicit Retry re-sends processing for a stage that was committed; the client cannot know it was. The mock answered with the same expense #12. The real server's replay (`uploadFlow.ts` comment: "Triage replays an already-routed document only when it has its own draft") was **not exercised**.
- **U2/U7 dedup** is the mock modelling the documented server hash dedup, not a server result.
- **U7:** the held fetch rejected during unload, and the chain wrote a terminal partial receipt before the page went away. Root saw the same race on create (a terminal "Failed/not confirmed" instead of "Interrupted"). Which label appears is not deterministic, but both are truthful "unknown". Playwright never reported the held request as finished or failed.
  - After the reload, the receipt still says "Retry processing while this upload sheet is still open". That copy is written for a sheet that is still open, and no sheet exists after the reload. Noted for root, no severity proposed.

### Create & match on a bank line (`bank-results-*.json`)

| #   | Fault                                           | Visible after the fault                                                                                                                                                                                                                                                                    | Idle | Then                                                                                                                                                       | Writes (no propose-matches)                                           | Mock end                                                |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| M1  | create **committed**, response lost             | form: "That did not complete — your input is kept. Check the message below before trying again. Failed to fetch"; receipt `error` "Creating the expense was not confirmed — no expense ID… It may exist as a draft: check the expenses in Books… before creating another"; GET `#24:draft` | 0    | Reload → "RECORDED EARLIER IN THIS SESSION" block with that warning over a fresh form (`M1-after-reload.png`). A deliberate new Create & match was clicked | `expenses ✗`; after the click: `expenses ok, 25/post, match, approve` | `#24:draft` + `#25:posted`, `#20:active` → Expense #25  |
| M2  | post **committed**, response lost (reads fast)  | receipt `partial` "Draft Expense #24 was created; posting it was not confirmed…"; the line re-routes to **Open items / Expense #24 · Match** (the form is gone)                                                                                                                            | 0    | —                                                                                                                                                          | `expenses ok, 24/post ✗`                                              | `#24:posted`                                            |
| M2d | same, reads slow 4 s                            | **banner: "created as a draft but not posted"** (finding 1, #373); Finish enabled                                                                                                                                                                                                          | —    | not clicked; after the reads, line → Open items                                                                                                            | `expenses ok, 24/post ✗`                                              | `#24:posted`                                            |
| M3a | match **committed**, response lost (reads fast) | receipt `partial` "Posting… confirmed; matching the line was not confirmed…"; the line re-routes to the staged match with **Confirm match**, no form                                                                                                                                       | 0    | Confirm → `approve 30`                                                                                                                                     | `expenses, post, match ✗, approve ok`                                 | `#20:active`, no pending                                |
| M3b | same, reads **fail**                            | the form is replaced by the load error "Failed to fetch · Retry" (reads only), no Finish                                                                                                                                                                                                   | —    | network back; the read Retry needed **3 presses** (one per failing query: tx, matches, candidates) → Confirm match → approve 30                            | `…, match ✗, approve 30 ok`                                           | `#20:active`, no pending                                |
| M3c | same as M3b                                     | as M3b                                                                                                                                                                                                                                                                                     | —    | network back + synthetic resume → 1 matches refetch → Confirm match shown                                                                                  | `…, match ✗`                                                          | `#20:draft`, `#30 pending` (not confirmed in this case) |
| M3d | same, reads **slow** 4 s (v2 model)             | form + enabled **Finish · expense #24**                                                                                                                                                                                                                                                    | —    | Finish clicked → 409 "Duplicate reconciliation match…" → receipt `partial` with that reason → line shows staged #20 + **Confirm match**                    | `…, match ✗, match 409`                                               | `#20:draft` + `#30 pending` (one row, awaiting Confirm) |
| M4  | approve **committed**, response lost            | receipt `partial` "…its match… was staged; the match's approval was not confirmed (Matches were staged but approval 30 failed (0/1 activated): Failed to fetch)…"; the line shows Matched                                                                                                  | 0    | —                                                                                                                                                          | `…, match ok, approve ✗`                                              | `#20:active`                                            |
| C1  | New expense create **committed**, response lost | sheet open, gross `45.67` kept; "Creating the draft expense was not confirmed — your input is kept. Check Books before creating it again, in case it was stored."; GET `#24:draft 4567`                                                                                                    | 0    | no retry (root covered create)                                                                                                                             | `expenses ✗`                                                          | `#24:draft`                                             |

- **M1:** the second expense was a deliberate fresh create after the warning, sent by the harness. It shows what the button does; it is not a production duplicate. The warning was visible in both the receipt and the reload block. The in-form heading for a network failure is the generic `DEFAULT_FAILURE_HEADING`, less specific than New expense's. That is copy only.
- **M4:** the receipt embeds the error text "approval 30 failed" (`queries/bank.ts:209`) for what was a lost response. The surrounding sentence says "not confirmed", and the line shows the current Matched state.
- **Existing unit tests (cited from source, not rerun):** `queries/bank.test.tsx` "a failed POST stage resumes on retry: the SAME expense is posted, never a second create" and "a failed approval leaves the match staged: retry never stages it again". No test covers a network-failed (not refused) `manualMatch` whose draft was stored, which is the M3d path (the stage is re-sent, and the server refuses it by the unique pair).

### Bank statement import (`import-results.json`)

| #   | Fault                                                | Visible                                                                                                                                                                                     | Writes             | Result                                                                                                                    |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| I1  | import upload **committed** (job #41), response lost | alert "Failed to fetch. The upload was not confirmed. If you are not sure it reached the server, check the statements list before uploading again."; no resume pointer; no result-log entry | `import ✗`; idle 0 | Reload → a plain empty form; the committed job is not visible to the UI (no id came back)                                 |
| I2  | accepted, then 2 status reads aborted                | "Couldn't check the status of import #41… Last known status: running… don't upload the file again", **Check again**, no re-upload offered; pointer kept                                     | `import ok`        | synthetic resume → 1 status read, error cleared; `/bank` → plain `/bank/import` → resumed `?job=41` → "Statement created" |

**Observation (I1, no severity):** an unconfirmed import is recorded only in the form's inline alert. Unlike upload/create, it gets no durable receipt, so after a reload nothing tells the operator that an attempt may have been stored.

## Root's independent real-HTTP runs (cited, not rerun here)

`/tmp/hbk-300-browser/http-create-final-results.json`, `diagnose-results.json`: a localhost HTTP fixture on port 5262, New expense, no Playwright routing.

- **Server drops an empty response after committing:** one app `fetch`, but **7 wire POSTs and 7 mock drafts**. A bare-fetch control with no app action also went out 3 times on the wire; a 409 control went out once. These are Chromium transport retries on localhost HTTP/1.1, **not app replay**. They also prove nothing about production or backend idempotency. My `route.abort` cases cannot observe this layer.
- **HTTP 200 body cut after commit:** one fetch, one POST, one commit. The UI said "unconfirmed", the input was kept, and a reload showed 1 record.
- **Offline before sending:** 0 server POSTs. An explicit retry sent 1. Reconnecting alone replayed nothing.
- **Held response while offline:** the mutation completed; the lazy detail chunk then failed ("Screen unavailable" with a Done receipt, as expected per #292). An explicit online reload recovered it, still with 1 POST.
- **Forced reload after the mock commit:** a terminal Failed/not-confirmed receipt (the race described above), 1 record, no replay.
- Root's first harness pass had wrong assertions (an exact heading, a strict Interrupted label, and an assumed wire == fetch count). Those are preserved in root's artifacts.

## Harness corrections (initial results kept)

- **Upload initial run** (`upload-initial.log`, `upload-results-initial.json`): U1/U3/U4/U6 ended with "Already uploaded as document #19".
  - Cause: my override set the mock's `dedup` after `route.fallback()`, which resolves before the helper builds its answer, so the first stored upload was answered as a duplicate. Fixed by deciding dedup before `fallback()`.
  - U7 initially expected an `interrupted` receipt; it is now checked as "not ok and not running" (see the U7 notes).
- **M3b:** the first two runs (`bank-M3b-initial.log`, `bank-M3b-2.log`, `bank-results-M3b-initial.json`) timed out looking for a "Create & match" retry.
  - Once an expense has landed, the button reads "Finish · expense #N". With failing reads, no form is shown at all: the screen shows the read-only load error.
  - The locator was fixed. The scenario was revised to press the read Retry (`bank-M3b-3.log`), and M3d was added for slow reads.
- **M3d v1:** an invalid duplicate-pair mock; retracted (see the Retraction section). Artifacts kept with `-v1-INVALID-` names.
- **M1:** the "Recorded earlier" text probe returned null because the heading renders uppercase. The block is visible in `M1-after-reload.png`.

## Not covered

Follow-up on `ea0b00c` (M2d Finish retry, #375 check, desktop, lost approve, and a correction to the M3d candidate model): [`2026-09-24-network-background-mutations-followup.md`](2026-09-24-network-background-mutations-followup.md).

- Native iOS/Android backgrounding, OS suspension or app kill; a real network change such as Wi-Fi↔cellular or captive portals; a real backend or database. Upload/import over real HTTP sockets was not run (root's real-HTTP runs cover New expense only).
- Retry by "Finish" after a lost **post** response (M2d), because the real re-post answer is unknown.
- Bank-fee / supplier / other chains, bulk "Book matches", Undo, approvals from the Inbox, and a desktop viewport.
