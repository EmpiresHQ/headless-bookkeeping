# QA-007 follow-up: lost-response retries on the bank line (issue #300)

This is a follow-up to [`2026-09-24-network-background-mutations.md`](2026-09-24-network-background-mutations.md) (#374).
It covers three things the first run left open: the "Finish" retry after a lost **post** response
(M2d, "not run"), a check of the #373 copy fix (#375) on current `main`, and a desktop viewport.
It also covers a lost **Confirm match** (approve) response on a staged line.

It is a bounded, mocked Chromium run on `main` `ea0b00c`. **No product code was changed.
No real backend, device, native background/resume or OS suspension was used.** Every write
went to a Playwright route in the page, so no financial write left the browser. The mock follows
server rules read from source (cited below). It does not show what the real server does.

## Verdict

| Question                                                            | Status                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #373 copy after a lost post response (fixed by #375)                | **Pass** at 390 and 1280: "posting it was not confirmed — it may or may not be posted". The old "created as a draft but not posted" text is gone                                            |
| "Finish" after a lost post response (M2d retry, previously not run) | **Pass**, no duplicate: 1 create, 2 post POSTs (the second got 409 "Expense 24 is already posted"), 0 match POSTs. After the reads return, the line shows **Open items / Expense #24**      |
| "Finish" after a lost match response, reads slow (M3d at 1280)      | **Pass**, no duplicate: **no second match POST**. The candidates read leaves out the voucher, so the chain stops. The line then shows the staged match, and Confirm match activated it once |
| Lost Confirm match (approve) response, 390 and 1280                 | **Pass**: the approval is not sent again. The line shows Matched, full coverage. Idle and synthetic resume sent 0 writes                                                                    |
| Automatic replay of any write (idle 2 s + synthetic resume)         | **None** in any scenario                                                                                                                                                                    |
| Confirmed defects                                                   | **None.** No fix and no new issue. Two copy observations and one out-of-scope badge observation are listed below                                                                            |
| Native iOS/Android background, resume, app kill                     | **NOT RUN** (no device). The first report's negative headless probes still apply. **#300 stays open for this row**                                                                          |

### Correction to the first report's M3d model

The first report's M3d v2 mock kept Expense #24 among the line's match candidates after the draft
match had been stored. A second `POST …/match` then got a 409 from the unique pair.
The real server does not offer that voucher again. `getMatchCandidates` skips every voucher that is
already matched to **this line**, as a draft or active (`reconciliation.service.ts:273-285`, comment:
"booking it again hits UNIQUE(bank_txn, voucher) and 409s"). With that rule modelled (P4), Finish
re-reads the candidates and does not find #24. It fails with "Expense was created and posted but did
not appear among match candidates — match it manually." and sends **no** second match POST. The 409
is still the server's backstop, but this path does not reach it. The first report's M3d conclusion
(no duplicate, recovery through Confirm match) still holds, and now holds with fewer writes.

## Set-up

- **Build:** `vite build` of `ea0b00c`, unmodified, into the session scratchpad (`h/dist`). It was served by
  `vite preview` on `127.0.0.1:5367` and stopped afterwards (port checked closed). Dependencies were
  symlinked from a worktree with an identical `package-lock.json`. The symlink is git-ignored and nothing
  under `packages/` changed.
- **Browser:** Chromium 153.0.8010.12 (Playwright `chrome-headless-shell`), headless, Playwright 1.63.0,
  Node 24.21.0, Linux. Shared libraries and fonts came from `/tmp/hbk-browser-libs`. Without
  `FONTCONFIG_FILE` no text renders and locators time out. The first attempt failed this way and was
  discarded.
- **Contexts:** 390×844 `isMobile` + `hasTouch` (P1, P5, P7) and 1280×844 desktop, `hasTouch` (P2–P4, P6).
  DPR 1 for both. Neither is a real device.
- **Fixtures:** `/tmp/hbk-251-browser/bank-fixtures.mjs` `setupBank`, imported read-only. It provides the
  token `review-fixture`, aborts other origins, and answers unknown non-GETs with 500. On top of it the
  harness registers its own stateful route, which runs first:
  - Line: statement 3, tx 9, −123.45 EUR, 2026-09-10, "Receipt coming later", category `office`.
    Expense #24, voucher 7, match #20, approval #30.
  - **Re-post:** a non-draft expense gets 409 `Expense 24 is already <status>`. This is the conditional
    `draft→posted` claim in `status-transition.service.ts:167-193`, reached from
    `posting-pipeline.service.ts` `atomicPost`.
  - **Match:** a second pair gets 409 "Duplicate reconciliation match…" (migration 031).
    **Candidates:** a voucher with any match on this line is left out (see the correction above).
  - **Approve:** an approval that is already approved gets 200 with the same approval
    (`approvals.service.ts:157-161`, "Idempotency: already approved").
  - **Line status:** it stays `open` after matching. On the server only dispositions change
    `bank_transaction.status` (`updateStatus` callers: personal, prepayment). The first attempt of this
    run copied a `status: 'matched'` rule from the shared fixture. That made the app show "This line is
    settled as a disposition" for a matched line, which was a mock artifact. The run was redone, and the
    v1 artifacts are kept apart (see Evidence).
- **Faults:** `commit then abort`. The mock state is committed, then `route.abort('connectionreset')`.
  "Slow reads" holds the four statement GETs (`matches`, `transactions`, `reconciliation`,
  `match-candidates`) until the harness releases them.
- **Synthetic resume:** override `document.visibilityState`/`hidden` and dispatch `visibilitychange` on
  `document` and `window`, plus `blur`. After 1.2 s, restore and dispatch again with `focus`, then wait
  1 s. This drives only the app's listeners. It is **not** a background state (see the first report's
  probes).
- **Counts:** non-GET `/api` requests come from `request`, `requestfinished` and `requestfailed`, with
  their real outcome. `propose-matches` is a read-like POST and is excluded. The mock counts its own
  post, match and approve calls.

## Results

"Writes" lists the non-GET `/api` requests in order: `✗` = `net::ERR_CONNECTION_RESET`, a number = the
HTTP status. "Idle" = new writes during the synthetic resume.

| #   | Viewport | Fault                                               | Visible after the fault                                                                                                                                                                                                                                                      | Idle | Explicit action → result                                                                                                                                                                                                                                                    | Writes                                            | Mock end                     |
| --- | -------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------- |
| P1  | 390      | post **committed**, response lost; reads slow       | Receipt `Partly done`: "Draft Expense #24 was created; posting it was not confirmed (Failed to fetch)… do not create another expense". Banner: "posting it was not confirmed — it may or may not be posted". **Finish · expense #24** is enabled. A fresh GET shows `posted` | 0    | Finish → `post` **409** "Expense 24 is already posted". The receipt and form show that reason, and the banner stays "may or may not be posted". Reads released → the line shows **Open items: Expense #24, outstanding 123.45 €**. The form and Finish are gone             | `expenses 200, 24/post ✗, 24/post 409`            | `#24:posted`, 0 matches      |
| P2  | 1280     | same as P1                                          | same as P1 (desktop layout, sidebar nav)                                                                                                                                                                                                                                     | 0    | same as P1                                                                                                                                                                                                                                                                  | same as P1                                        | same as P1                   |
| P3  | 1280     | post **committed**, response lost; reads fast       | same receipt. The line shows **Open items / Expense #24** right away, with no form                                                                                                                                                                                           | 0    | —                                                                                                                                                                                                                                                                           | `expenses 200, 24/post ✗`                         | `#24:posted`                 |
| P4  | 1280     | match **committed**, response lost; reads slow      | Receipt: "Posting of Expense #24 was confirmed; matching the line was not confirmed (Failed to fetch)…". Banner: "created and posted". Finish is enabled                                                                                                                     | 0    | Finish → a candidates read (held, then released) with no #24 → error "did not appear among match candidates — match it manually." **No second match POST.** The line shows **Expense #24 — staged**, **Confirm match** → approve 30 → full coverage, `Confirmed · 123.45 €` | `expenses 200, 24/post 200, match ✗, approve 200` | `#20:active`, `#30:approved` |
| P5  | 390      | Confirm match: approve **committed**, response lost | Toast "Failed to fetch". The line reads **Matched**, Expense #24, coverage **full · 123.45 of 123.45 €**, Unmatch only (no Confirm)                                                                                                                                          | 0    | — (no retry offered, and none needed)                                                                                                                                                                                                                                       | `approve ✗`                                       | `#20:active`, `#30:approved` |
| P6  | 1280     | same as P5                                          | same as P5                                                                                                                                                                                                                                                                   | 0    | —                                                                                                                                                                                                                                                                           | `approve ✗`                                       | same as P5                   |
| P7  | 390      | control: Confirm match succeeds                     | Matched, full coverage                                                                                                                                                                                                                                                       | 0    | —                                                                                                                                                                                                                                                                           | `approve 200`                                     | same as P5                   |

No scenario logged a page error. None created a second expense, a second match or a second approval.

### Observations (no severity proposed; not filed)

1. **P1/P2, copy:** after the re-post returns 409 "Expense 24 is already posted", the receipt still reads
   "posting it was not confirmed (409 Conflict: Expense 24 is already posted)". The banner still reads
   "it may or may not be posted". The server has in effect said it is posted, but the text stays in the
   "unknown" wording and never becomes false. Pressing Finish again would send the same 409. The screen
   recovers once the statement reads return. The chain treats any post-stage error the same way
   (`queries/bank.ts` `createExpenseFromLine`, `progress.posted` stays `null`).
2. **P4, copy:** the error reason says "match it manually" while a staged match is already there. The
   receipt's own next sentence ("Open the line for its current state — if it is still unmatched…") and
   the Confirm match on the line lead the operator to the right step.
3. **Nav Inbox badge (P5–P7, not about the network):** after Confirm match on the bank line, the badge
   stays at `1` in the fault cases **and** in the success control. `invalidateStatement`
   (`queries/bank.ts:166-176`) does not invalidate the inbox keys. The global `staleTime` is 15 s
   (`lib/queryClient.ts:29`), so the synthetic resume at about 3 s did not refetch. The comment on
   `useInboxCount` says this is by design: it updates on Inbox refetches and focus after the stale
   window. The badge was **not** watched past 15 s.

## Evidence

In the session scratchpad `h/` (not committed):

- `run.mjs` (sha256 `847224574d03d9e8ca4b43a6f68387f881c2a88b59adcf6aab6e3487f9b16416`) and `run.log`
- `results.json`, with the full page text, write log, mock state, `pendingReads` and nav text for each
  snapshot
- `shots/P{1..7}-*-{after-fault,after-finish,after-reads,after-confirm,after-resume}.png`
- `v1-mock-status-matched/`: the discarded first pass with the invalid `status: 'matched'` line model.
  It had the same write counts, and its only visible difference was the "disposition" text.

## Not covered

- Native iOS/Android backgrounding, OS suspension, app kill, a real network change, a real backend or
  database. Headless Chromium cannot enter a real hidden or frozen state (first report's probes). Only a
  synthetic `visibilitychange` was used.
- A real-HTTP socket drop for post, match or approve. Chromium's transport-level POST retries (seen by
  root on localhost for create) cannot happen under `route.abort`.
- Upload, import and New expense. They were not rerun here, and the first report's results for them are
  on `196b206`.
- Held-for-approval posting, bank-fee, supplier and other chains, bulk "Book matches", Undo, and
  approvals from the Inbox.
