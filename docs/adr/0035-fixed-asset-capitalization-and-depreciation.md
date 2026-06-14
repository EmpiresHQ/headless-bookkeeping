# Fixed-asset capitalization with a lightweight register and straight-line pro-rata depreciation

## Status
Proposed (2026-06-13). **Supersedes ADR-0007.**

## Context
ADR-0007 expensed every purchase and deferred the depreciation engine, on the
premise the target user sits below the capitalization threshold. The
annual-accounts work (ADR-0034) targets small undertakings (**väikeettevõtja**)
that **do** buy vehicles and equipment. Expensing a car distorts both the balance
sheet (no põhivara) and the P&L (the whole cost hits one period); a correct
majandusaasta aruanne requires capitalization **and** depreciation. This
supersedes the deferral.

**RTJ 5 prescribes no fixed rate table** — the entity estimates useful life and
depreciates over it. The old TuMS declining-balance rates are tax-world and
effectively moot for an Estonian resident company (distributed-profit taxation —
no annual depreciation deduction). So "Estonian norms" means **conventional
useful lives encoded as plugin defaults**, not a statutory table.

## Decision

**1. Asset classes are categories.** New expense categories
`vehicle` / `it_equipment` / `machinery` / `furniture` resolve (via
`resolveCategoryMapping`) to **per-class** fixed-asset accounts
`FIXED_ASSETS_VEHICLES` / `_IT` / `_EQUIPMENT` / `_FURNITURE` (new neutral kernel
system accounts), each paired with an `ACCUM_DEPRECIATION_*` contra-asset, plus a
single `DEPRECIATION_EXPENSE` (põhivara kulum). Per-class accounts because the
class carries the useful life.

**2. A lightweight asset register in the kernel** — a `fixed_asset` table:
`id`, `name`, `asset_class`, `acquisition_voucher_id`, `acquisition_date`,
`cost_base_minor`, `useful_life_years`, `residual_value_minor`. It is **master
data** (depreciation parameters), not a parallel ledger — amounts stay sourced
from the ledger. Per-asset `useful_life_years` and `residual_value_minor` (the
operator may override the class defaults) are precisely why a register is
required: class-level grouping alone cannot carry them. `residual_value_minor`
defaults to **0** (correct for IT/equipment/furniture, which scrap at nil value)
but is **material for vehicles** — a car sold after its useful life retains
significant value, and depreciating its full cost overstates the annual charge
and distorts both põhivara and the P&L. Stored, never derived; book value stays
computed as `cost_base_minor − Σ depreciation vouchers`.

**3. Capex flows through the ordinary expense pipeline** (ADR-0005). When a posted
line lands on a `FIXED_ASSETS_*` account, the pipeline **atomically** creates the
register row from the intake payload (asset name + optional useful-life and
residual-value overrides; defaults supplied by the plugin per class). No separate
capex command. AI detection of "this should be capitalized" is out of scope — the
operator picks the asset category explicitly.

**4. Depreciation method and norms live in the plugin** (ADR-0002). Estonia:
straight-line; default useful lives `vehicle` 5 / `it_equipment` 3 /
`machinery` 5 / `furniture` 7 years (RTJ convention, overridable per asset);
default residual value **0** for every class **except** `vehicle`, where the
plugin supplies a conventional non-zero default (overridable per asset). The
kernel asks the plugin for default-life, default-residual, and method; it never
hardcodes them.

**5. Depreciation is a system-generated voucher** (the system-voucher class from
ADR-0007) posted at period close: `Dr DEPRECIATION_EXPENSE / Cr
ACCUM_DEPRECIATION_*`. The **depreciable base is `cost_base_minor −
residual_value_minor`**, spread straight-line over `useful_life_years`. **One
annual charge, pro-rata by months** from `acquisition_date` (a November purchase
charges 2/12 in its first year). No monthly schedule. The charge is capped so
accumulated depreciation never exceeds the depreciable base (the asset settles at
its residual value, not zero). The charge is computed by the **same engine** the
annual-accounts draft uses virtually (ADR-0034 §5) — deterministic; the LLM never
picks a figure.

**6. Disposal/sale is in scope** — an SMB that buys a vehicle *will* sell it
within the asset's life; deferring this would leave the car on the books forever
and make the very next year's report wrong. The operator records a disposal with a
date and optional proceeds; the kernel posts **two** system-generated vouchers in
one operation: (a) a **catch-up depreciation** charge pro-rata from the last
period close to the disposal date, so accumulated depreciation is current; then
(b) the **disposal voucher** that retires the asset — `Dr Bank` (proceeds, if
any), `Dr ACCUM_DEPRECIATION_*` (accumulated to date), `Cr FIXED_ASSETS_*`
(original cost), with the balancing line to a new neutral
`GAIN_LOSS_ON_ASSET_DISPOSAL` account (põhivara müügi kasum/kahjum; the plugin
maps it to the right RTJ line). Both figures are deterministic; the register row
is marked retired (not deleted — its acquisition voucher and history stay
traceable). A scrap/write-off is the same flow with zero proceeds.

**7. Out of scope for v1:** useful-life revision after acquisition, partial
disposals, trade-ins, monthly depreciation schedules, and buildings/land (the
target SMB rents — `EXPENSE_RENT`).

## Consequences
- The annual report (ADR-0034) now has real põhivara and kulum lines.
- The register and the ledger can drift (a hand-posted `FIXED_ASSETS` line with no
  register row); the annual-accounts draft surfaces a register-vs-ledger cost
  mismatch as a **soft** warning.
- Adding a class = one account pair + one plugin default-life/residual entry. Other
  jurisdictions supply their own lives/residual/method behind the same seam.
- Disposal adds one neutral kernel account (`GAIN_LOSS_ON_ASSET_DISPOSAL`) and a
  retired state on the register row; the full vehicle lifecycle (capitalize →
  depreciate → sell with gain/loss) closes in v1.
- `residual_value_minor` is operator-estimated; a wrong estimate only shifts the
  charge across years (the total over the asset's life is unaffected) and is
  correctable via the next-period close, never the locked year (ADR-0012).
