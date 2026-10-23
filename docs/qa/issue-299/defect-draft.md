# Proposed P3: rapid same-task Back aborts a pending create despite restored Sheet/history

Related: #299, #251, #267. Draft for coordinator triage/publication; no issue was created by this agent.

On base `940648810402abd58390c28610629d206cfed73b`, Linux headless Chromium153.0.8010.12 / Playwright1.64.1, 390×844 mobile/touch context, an actual pending POST is aborted by the browser when two `history.back()` calls are issued in the same task. No physical or native system gesture is claimed.

Reproduce with `H4-pending-same-task-double-back` in `browser.cjs`: Books → Settings → Books, open New expense, select software, Gross45.67/VAT0/date2026-09-10; submit with proxy holding the actual 201 response after server commit, scroll form, then `history.back(); history.back()`. The browser traverses idx2→1→0 and guard restoration returns idx2/Books/Sheet. The POST fires requestfailed `net::ERR_ABORTED`, facts remain locked in the unconfirmed state, and releasing the original response does not open the created expense. A second Back can encounter the failure state and ask discard. Single browser Back and no-navigation controls retain pending and complete normally.

Expected for the pending-completion criterion: refused modal dismissal preserves the in-flight create until its response completes, then navigates once to that persisted draft. Actual: the navigation entry is restored but the original transport is cancelled; user must keep editing and explicitly retry. This may instead be accepted as a documented Chromium transport limitation; do not call the original-completion requirement PASS without that product decision.

Persisted safety is verified: explicit retry uses the original operation key; both 201 bodies refer to the same expense, with exactly one new expense and one operation row, no vouchers. Proposed **P3** because the bounded edge case is recoverable and no duplicate or ledger effect was observed. This is distinct from #420's resolved duplicate-draft defect.

Evidence: `results.json` H4 includes browser request failure, POP timeline, real HTTP response bodies and DB snapshots; `H4-pending-same-task-double-back-unconfirmed.png`; `audit.json`. H8/H9 are controls. Harness PASS and product requirement FAIL are intentionally separate.

Minimal investigation seam: browser transport lifecycle for `POST /api/expenses` versus rejected rapid POP. A narrowly scoped fetch keepalive experiment could test whether this Chromium cancellation can be avoided, with real browser regression and payload constraints before changing the contract. Do not change all mutation lifecycles or financial architecture; no keepalive fix is asserted here. Any shared Sheet/navigation guard edit requires coordination with #302's owner. Product code remains unchanged pending triage.
