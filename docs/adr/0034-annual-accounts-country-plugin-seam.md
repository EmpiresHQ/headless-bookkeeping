# Annual accounts render behind the country-plugin seam as RIK-XBRL; draft/final over an immutable close

## Status
Proposed (2026-06-13).

## Context
The kernel has a solid double-entry ledger but produces **no statutory annual
report**. An Estonian company must file the **majandusaasta aruanne** with the
e-Business Register company portal (`ettevotjaportaal.rik.ee`), either by
form-fill or by uploading an **XBRL** file. The taxonomy (XBRL 2.1 + Dimensions
1.0, versioned yearly, published at `xbrl.eesti.ee`) is Estonia-specific and must
not leak into the kernel.

Account `type` (asset/liability/equity/revenue/expense) is enough for a crude
roll-up, but the statutory form needs specific **RTJ** lines: käibevara/põhivara
split, varud, capital breakdown, müügitulu, expense-by-nature. The bridge
`account → report line` is jurisdiction knowledge.

We deliberately keep the chart **semantic** (a code is a label, not an RTJ
number); we do **not** renumber to an RTJ-prefixed chart. The mapping is an
explicit plugin table.

## Decision

**1. A country-plugin renders the annual accounts from a neutral input.**
`CountryPlugin.generateAnnualAccounts(input, opts) → { artifacts, warnings }` is
the sole seam, mirroring `generateStatutoryReports` (ADR-0033, ADR-0002). The
kernel's annual-accounts service assembles a jurisdiction-neutral input — account
balances for the period **and** the comparative prior period, the fixed-asset
register (ADR-0035), period net income, and retained earnings brought forward —
and hands it to the active plugin. The plugin stays **pure** (no DB) and owns the
`account → RTJ line → XBRL concept` mapping and the artifact. `NullCountryPlugin`
returns empty.

**2. The Estonia plugin emits RIK-XBRL.** Form = **väikeettevõtja**; P&L =
**skeem 1** (by nature — matches our expense-by-nature chart; skeem 2 would need
a functional cost split we do not have). **Two comparative year columns** (RIK
rejects a single period; a first operating year emits a zero prior column). The
taxonomy version is **pinned (2026)**; a new version is an additive plugin
module, not a rewrite. Only the **mandatory dimensional contexts** of the väike
form are emitted in v1; optional breakdowns are deferred.

**3. Equity has no year-end close sweep.** The balance-sheet equity section is
three live lines: Osakapital (`EQUITY`/`SHARE_CAPITAL`), Eelmiste perioodide
jaotamata kasum (`RETAINED_EARNINGS`), Aruandeaasta kasum (period revenue −
expense via `LedgerBalanceService`). Because every voucher balances, the sheet
balances **without** a sweep; sweeping into retained earnings is needed only to
*open* the next year and is a separate concern.

**4. The report is a pure projection of the posted ledger.** Period-end
adjustments — depreciation (ADR-0035) being the only one in scope for the
services solo-OÜ persona — are **real vouchers posted before** the report reads
them, so every figure traces to a voucher (integrity layer, ADR-0013/0019). The
report never computes a number it does not read. (Resale-goods inventory and its
closing-stock adjustment are deferred to the V2 online-shop module — see
V2-ROADMAP.md; the services persona carries no stock.)

**5. One calculator, two modes.**
- **draft** computes the period-end adjustments *virtually* (posts nothing, locks
  nothing), runs our own diagnostics, **and** emits a full RIK-XBRL file so the
  operator can upload it to the portal for the **authoritative**
  schema/dimension/calculation validation. draft is idempotent and repeatable.
- **final** posts the close vouchers, **locks the year** via the existing
  period-lock (ADR-0015), and emits the authoritative XBRL with **identical**
  numbers. final is one-shot; a second run is rejected.

  The **same** computation code feeds both modes (virtual vs posting) so a
  portal-validated draft equals the final. Auto-submission via a portal API is
  out of scope — the operator uploads the file.

**6. Validation = own checks + the portal.** Our draft diagnostics are the
semantics of the XBRL calculation linkbase (sub-items sum to totals); the portal
is the authoritative validator on upload. No in-runtime XBRL processor dependency.

**7. Draft diagnostics and gating.** final is **hard-blocked** on: a
balance-sheet imbalance (Aktiva ≠ Kohustused + Omakapital), or any nonzero-balance
account **not mapped** to an RTJ line (its amount would silently vanish — the #1
cause of an unbalanced close). **Soft** warnings (non-blocking):
suspense/`EXPENSE_OTHER` concentration, depreciation not yet run,
register-vs-ledger cost mismatch.

**8. Post-final corrections** go through reversal/adjustment vouchers in the next
open period (no break-glass, ADR-0012), never by editing the locked year.

## Consequences
- New jurisdictions add a plugin method; the kernel assembly and the REST/SPA path
  are unchanged.
- The chart is **not** renumbered; `account → RTJ line` is plugin data, so the same
  neutral ledger can serve multiple jurisdictions' report shapes.
- XBRL correctness is validated by the portal, not an offline processor, so a
  taxonomy bump is a plugin-only change. If offline schema validation is later
  required, an XBRL processor can sit behind the same seam without touching the
  kernel.
- New neutral kernel accounts are required so the väike lines have somewhere to
  land: see ADR-0035 (fixed-asset, accumulated-depreciation, depreciation-expense).
  The capital breakdown reuses existing `EQUITY`/`RETAINED_EARNINGS` (a
  `SHARE_CAPITAL` split is added when needed). The varud (inventory) line stays
  empty for the services persona; the resale-goods accounts arrive with the V2
  online-shop module.
- v1 covers the balance sheet + income statement. Notes/disclosures beyond the
  mandatory väike lines, consolidation, and X-tee/API submission are deferred.
