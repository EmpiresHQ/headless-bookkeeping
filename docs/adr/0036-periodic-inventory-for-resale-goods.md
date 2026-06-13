# Periodic inventory for resale goods; closing stock by period-end count

## Status
Proposed (2026-06-13).

## Context
The väikeettevõtja target (ADR-0034) includes online shops that **buy goods for
resale**. Without an inventory concept, purchases hit a generic expense: the
shop's balance sheet shows no **varud** and the P&L overstates cost — the report
is wrong exactly where it matters. A full **perpetual** inventory system (per-SKU,
COGS per sale, lot tracking) is a large engine, disproportionate to v1.

## Decision

**1. Periodic method.** A new `goods_for_resale` category resolves to
`EXPENSE_GOODS` (kaubakulu; P&L skeem 1 line "Kaubad, toore, materjal ja
teenused"), a new neutral kernel expense account. A new `INVENTORY` asset account
(varud) holds closing stock. Both are kernel system accounts.

**2. Purchases of resale goods book straight to `EXPENSE_GOODS`** — no stock
movement at purchase time.

**3. Closing stock is a period-close adjustment.** The operator enters the
**counted** closing inventory and the system posts `Dr INVENTORY / Cr
EXPENSE_GOODS` for the unsold value. This corrects COGS and puts varud on the
balance sheet. The figure is a physical count, **operator-supplied** — we do not
derive it.

**4. The adjustment is one of the period-close vouchers** the annual-accounts
final posts and the draft computes virtually (ADR-0034 §4–5). "Inventory not
counted" is a **soft** draft warning.

**5. Out of scope:** perpetual inventory, per-SKU/lot valuation, COGS-on-sale, and
automatic cost flow (FIFO / weighted-average) — deferred to a future inventory ADR.

## Consequences
- A small shop can produce a correct annual report (proper COGS + varud) with one
  period-end count entry, no warehouse module.
- Interim-period balance sheets carry stale varud (trued-up only at period close) —
  acceptable for the periodic method and the target user, but called out so it is
  not mistaken for perpetual accuracy.
- Real-time gross margin per sale is unavailable (requires perpetual; deferred).
