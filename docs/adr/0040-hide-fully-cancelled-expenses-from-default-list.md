# Fully cancelled expenses are hidden from the default list — keyed on correction kind, never on a recomputed net effect

An expense undone by a reversal **with no replacement** (correction kind `reversal`, "reversal-only") is a fully cancelled purchase: the mirrored reversal nets the original voucher exactly, so the net accounting effect is zero. Such expenses disappear from the **default list** — the `GET /api/expenses` response and the web Books → Expenses view — together with their month groups, month totals, and row counts. Nothing else moves: the ledger entries, vouchers, reversal links, source documents, and audit history stay exactly as they were (ADR-0006, ADR-0012); `GET /api/expenses/:id` keeps returning the record by direct id; and `?include_cancelled=1` on the list opts back in.

The trigger was the historical cleanup in override OÜ (reversal vouchers 274–289, Bright Data / GitHub purchases): fully reversed purchases stayed in the list as negative amounts with a `corrected` badge, and month headings carried negative totals and counts — cancelled purchases looked like active negative expenses. The owner's request: «если после сторно остаток 0 — не надо показывать».

## Keyed on correction kind, not on a recomputed net effect

The hiding rule is **the correction kind**, not a test that sums the voucher lines of a chain to zero:

- A mirrored reversal is net-zero **by construction** — summing lines re-derives what the kind already states.
- The "net" of a redirected correction spans periods and currencies (ADR-0009: the reversal lands in the current open period while the original sits in a locked one), so a line-sum "net zero" test would be period- and FX-fragile for zero additional information.
- The kind is derivable from data that already exists, with no schema, migration, or status-machine change: a reversal-only correction deliberately leaves `expense.voucher_id` pointing at the **original** voucher (no `reverses_id`, no `corrects_object_*`), while a financial correction re-points the object at its **corrected** voucher. So `cancelled = (status = 'reversed') ∧ (live voucher is not a correction artifact)` — one batched voucher lookup over the reversed rows.

## Scope decisions (grilled 2026-10-04, issue #397)

- **Both layers, one boundary.** The default is set at the API: `GET /api/expenses` excludes fully cancelled rows unless `include_cancelled=1` is passed. The web **always** passes it and applies hiding as a presentation rule. The additive `cancelled: boolean` flag on the payload is what makes the two `reversed` kinds distinguishable at all — without it they are identical (`status='reversed'`), and the vouchers that differ are hidden from the UI (ADR-0001).
- **Credit notes never hide.** A purchase fully refunded by a credit note also nets to zero, but hiding is keyed on the reversal kind, not on zero net: a credit-noted expense stays `posted` and visible. (The issue's *principle* said "net accounting effect of zero"; its enumerated cases said reversal chains only. The enumeration wins — net-zero-by-credit-note is a different, legitimate state of the world, not a cancellation.)
- **Search is exempt.** With an active search query, hiding does not apply: an explicit search is the operator asking for history, and searching `EI248128016` must find the cancelled purchase. This is why the web always fetches with `include_cancelled=1` — search over the rows, and truthful chip counts, require the cancelled rows to be in the response.
- **The web hides iff** the status filter is `all` **and** the search query is empty. Date ranges, `nodoc`, and ordering never un-hide.
- **One `corrected` for both kinds.** No new status, no new chip: `reversed` remains terminal (ADR-0006), and the `corrected` chip and badge keep covering both fully cancelled and financially corrected expenses. Two acceptance items from issue #397 are void as written: **"multiple corrections"** cannot exist (a correction chain is at most original → reversal → corrected; re-correcting a reversed object is explicitly rejected), and **"pagination"** does not exist (the list is returned whole and grouped client-side).
- **Internal consumers are untouched.** `ExpensesService.getExpenses()` keeps returning everything (the AI classification memory reads it); the default-exclusion lives at the API boundary (the controller), not in the service.

## Consequences

- Additive `cancelled` flag on the expense payload: `packages/server/src/expenses/types.ts`, the OpenAPI response schema, `cli:codegen`, and `AGENT_API_GUIDE.md` (the default, and `include_cancelled`).
- Month groups, month totals, and visible-row counts recompute automatically on the web — sections are built from the filtered rows, so a group with no remaining visible entries vanishes on its own.
- The "shown X of total Y" line keeps counting all rows as `total`: cancelled rows remain discoverable through the `corrected` chip, through search, and by direct id.
- Financial corrections remain visible with the **effective** amount shown once (their amounts are patched in place when the corrected voucher is posted — already the existing behavior).
- This is a presentation-layer decision. VAT reports, annual accounts, and reconciliation read vouchers, not the expense list, and are unaffected.
- Coverage: full reversal hidden (including one redirected into an open period — still keyed on kind); financial correction visible once; fully paid unreversed expense visible (the key is `reversed` + kind, never `reconciled`); credit-noted expense visible; search finds a cancelled record by supplier invoice number; detail-by-id returns a cancelled record.
