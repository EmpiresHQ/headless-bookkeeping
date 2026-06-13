# PRD: Fixed-asset capitalization, register & straight-line depreciation engine

> Source ADR: [ADR-0035](../adr/0035-fixed-asset-capitalization-and-depreciation.md) (supersedes ADR-0007). Foundational dependency for [the Annual Accounts PRD](./0034-annual-accounts.md).

## Problem Statement

The operator of a small Estonian company (väikeettevõtja) buys vehicles, computers, machinery and furniture. Today the system expenses every purchase in full in the period it lands (ADR-0007), so a €20 000 car hits one month's profit-and-loss and never shows up as põhivara (fixed assets) on the balance sheet. When the operator goes to file the majandusaasta aruanne (annual accounts), the report is wrong: there are no fixed assets, no depreciation (kulum), and a badly distorted annual profit. The operator has no way to tell the system "this purchase is a capital asset — depreciate it over its useful life," no way to see the asset's book value, and no way to record selling or scrapping the car later.

## Solution

The operator marks a purchase as a fixed asset by choosing a fixed-asset category (vehicle / IT equipment / machinery / furniture) at intake — exactly like choosing any other expense category, no separate "capex" command. The system capitalizes it: the posted line lands on a per-class fixed-asset account, and the posting pipeline atomically creates a lightweight register row carrying the depreciation parameters (useful life, residual value), pre-filled with sensible per-class defaults that the operator can override. A single deterministic engine computes the straight-line depreciation charge, pro-rata by months from the acquisition date, capped so the asset settles at its residual value. When the operator later sells or scraps the asset, they record a disposal with a date and optional proceeds; the system posts the catch-up depreciation and the disposal in one operation, leaving a clean gain or loss on disposal. Every figure traces to a real posted voucher — the LLM never picks a number.

## User Stories

1. As an operator, I want to categorize a purchase as a vehicle, so that the car is capitalized as põhivara instead of being expensed in one period.
2. As an operator, I want fixed-asset categories for IT equipment, machinery and furniture, so that each common capital purchase has a home.
3. As an operator, I want a capitalized purchase to post to a per-class fixed-asset account, so that the balance sheet shows fixed assets broken down by class.
4. As an operator, I want the system to create the asset register entry automatically when I post a capital purchase, so that I do not run a second, separate command to "register" the asset.
5. As an operator, I want to give the asset a name when I capitalize it, so that I can recognise it later in the register.
6. As an operator, I want each asset class to come with a conventional default useful life (vehicle 5y, IT 3y, machinery 5y, furniture 7y), so that I do not have to research depreciation periods.
7. As an operator, I want to override the useful life for a specific asset, so that an unusually long- or short-lived asset depreciates correctly.
8. As an operator, I want a residual value that defaults to zero for IT/equipment/furniture, so that scrap-at-nil-value assets depreciate their whole cost.
9. As an operator, I want vehicles to default to a non-zero residual value, so that a car's annual charge is not overstated by depreciating value it will still hold at end of life.
10. As an operator, I want to override the residual value for a specific asset, so that my own estimate of resale value drives the charge.
11. As an operator, I want the depreciation charge to be straight-line over the useful life, so that the annual cost is predictable and matches Estonian RTJ convention.
12. As an operator, I want the first-year charge pro-rated by months from the acquisition date, so that a November purchase only charges two months in its first year.
13. As an operator, I want accumulated depreciation never to exceed the depreciable base, so that the asset settles at its residual value and never goes negative.
14. As an operator, I want the depreciation charge posted as a system-generated voucher (Dr depreciation expense / Cr accumulated depreciation), so that kulum appears in the P&L and contra-asset on the balance sheet.
15. As an operator, I want the book value of an asset computed as cost minus accumulated depreciation vouchers, so that book value always reconciles to the ledger and is never stored separately.
16. As an operator, I want to record the disposal of an asset with a date and optional sale proceeds, so that a sold car leaves the books correctly.
17. As an operator, I want disposal to first post a catch-up depreciation charge from the last close to the disposal date, so that accumulated depreciation is current at the moment of sale.
18. As an operator, I want disposal to retire the asset by clearing its cost and accumulated depreciation and booking the gain or loss, so that the difference between proceeds and net book value lands in one place.
19. As an operator, I want a scrap/write-off to be the same flow with zero proceeds, so that I do not need a separate procedure for binning a dead asset.
20. As an operator, I want a disposed asset marked "retired" rather than deleted, so that its acquisition voucher and history stay traceable.
21. As an operator, I want disposal to be rejected (or redirected) when it would touch a locked period, so that the no-break-glass rule is never violated.
22. As an operator, I want to list my fixed-asset register, so that I can see every asset, its class, cost, parameters and current book value.
23. As a developer adding a new jurisdiction, I want depreciation method, default lives and default residuals to come from the country plugin, so that the kernel never hardcodes Estonian conventions.
24. As an accountant/auditor, I want every depreciation and disposal figure to be deterministic and voucher-backed, so that the books are reproducible and the integrity chain holds.
25. As an operator, I want a wrong residual-value estimate to be correctable only forward (next open period), so that a locked year is never edited.

## Implementation Decisions

- **New expense categories** `vehicle`, `it_equipment`, `machinery`, `furniture` are added to the country plugin's category set and resolve, via the existing `resolveCategoryMapping`, to **per-class** neutral fixed-asset accounts. No AI "should this be capitalized?" detection — the operator picks the category explicitly.
- **New neutral kernel system accounts** (added by migration, following the existing 28-account seed convention): `FIXED_ASSETS_VEHICLES`, `FIXED_ASSETS_IT`, `FIXED_ASSETS_EQUIPMENT`, `FIXED_ASSETS_FURNITURE` (type `asset`); a paired `ACCUM_DEPRECIATION_*` contra-asset per class; a single `DEPRECIATION_EXPENSE` (type `expense`); and `GAIN_LOSS_ON_ASSET_DISPOSAL`. Per-class fixed-asset accounts because the class carries the useful life.
- **New `fixed_asset` table** (master data, not a parallel ledger): `id`, `name`, `asset_class`, `acquisition_voucher_id`, `acquisition_date`, `cost_base_minor`, `useful_life_years`, `residual_value_minor`, plus a retired marker (e.g. `retired_at` / disposal reference). Amounts stay sourced from the ledger; only depreciation parameters live here. `residual_value_minor` is stored, never derived.
- **Capex flows through the ordinary posting pipeline** (ADR-0005). The pipeline gains a hook: when a posted line lands on a `FIXED_ASSETS_*` account, it atomically (same transaction as the voucher insert) creates the `fixed_asset` register row from the intake payload — asset name plus optional useful-life and residual-value overrides; defaults supplied by the plugin per class.
- **The plugin owns method and norms** (ADR-0002): Estonia returns straight-line, default lives (vehicle 5 / it_equipment 3 / machinery 5 / furniture 7), and default residuals (0 for every class except vehicle, which gets a conventional non-zero default). The kernel asks the plugin for default-life, default-residual, and method; it never hardcodes them. New plugin methods are added for these (fixed-asset defaults + depreciation method), behind the existing `CountryPlugin` seam.
- **A single deterministic depreciation engine** computes the charge: depreciable base = `cost_base_minor − residual_value_minor`, spread straight-line over `useful_life_years`, one annual charge pro-rata by months from `acquisition_date`, capped so accumulated depreciation never exceeds the depreciable base. This engine is a pure unit (register rows + a target date → per-asset charge) and is the **same** engine the annual-accounts draft (ADR-0034 §5) calls virtually — the fixed-assets work delivers and owns it; annual-accounts consumes it.
- **Depreciation posting** is a system-generated voucher (the `system-generated` posting-semantics class, which skips the intake semantic tier): `Dr DEPRECIATION_EXPENSE / Cr ACCUM_DEPRECIATION_*`. The *annual* depreciation posting at year-end close is orchestrated by the annual-accounts final mode (ADR-0034 §5) and is therefore in that PRD; this PRD delivers the engine and the disposal-time catch-up posting.
- **Disposal is a single kernel operation** exposed as `POST /api/fixed-assets/:id/disposal` (date + optional proceeds). It posts **two** system-generated vouchers in one transaction: (a) catch-up depreciation pro-rata from the last period close to the disposal date; then (b) the disposal voucher — `Dr Bank` (proceeds, if any), `Dr ACCUM_DEPRECIATION_*` (accumulated to date), `Cr FIXED_ASSETS_*` (original cost), balancing line to `GAIN_LOSS_ON_ASSET_DISPOSAL`. The register row is marked retired. Both figures are deterministic.
- **Register read** exposed as `GET /api/fixed-assets` (list with class, cost, parameters, computed book value). Book value is always computed (`cost_base_minor − Σ depreciation vouchers`), never stored.
- **Locked-period safety**: disposal and any depreciation posting respect the existing period-lock invariant (ADR-0009/0015). A disposal whose date falls in a locked period follows the established locked-period redirect / rejection path; corrections go forward, never into the locked year (ADR-0012).
- **DTOs are Zod-backed** (`createZodDto`), matching the existing convention, for the capex intake extension (asset name + overrides) and the disposal request.

## Testing Decisions

- **What makes a good test here**: assert external behavior — the posted vouchers (accounts, debit/credit, base amounts), the register row contents, and the computed book value — not the internal shape of the engine. Golden numeric cases (pro-rata first year, capped final year, vehicle with non-zero residual) are the heart of it.
- **Depreciation engine — pure unit tests**: feed register rows + a target date, assert the per-asset charge for: full-year asset, mid-year acquisition (e.g. November → 2/12), final-year cap at residual, residual = 0 vs non-zero vehicle. Deterministic, no DB. Prior art: the pure plugin unit tests in the country-plugin spec suite.
- **Capex → register — posting-pipeline integration tests** (in-memory SQLite, run all migrations, post an expense on a `FIXED_ASSETS_*` category): assert the voucher posts to the per-class account **and** the `fixed_asset` row is created atomically with the right defaults; assert overrides flow through. Prior art: the existing `PostingService` integration spec.
- **Disposal — integration tests**: post an acquisition, advance time, dispose with proceeds → assert both vouchers (catch-up depreciation, then the disposal voucher with the correct gain/loss to `GAIN_LOSS_ON_ASSET_DISPOSAL`), the register marked retired, and book value zeroed. Repeat with zero proceeds (scrap) and with a loss.
- **Plugin defaults — pure unit tests** on the Estonia plugin: assert the four default lives, the residual defaults (0 except vehicle), and the straight-line method, in isolation with no DB.
- **Locked-period safety — integration test**: a disposal dated into a locked period is redirected/rejected per the existing invariant; assert no write into the locked period.
- **Account seed — migration test**: assert the new neutral accounts exist with the correct `type`.

## Out of Scope

- Useful-life revision after acquisition, partial disposals, trade-ins.
- Monthly depreciation schedules (only one annual charge, pro-rata by months).
- Buildings and land (the target SMB rents — `EXPENSE_RENT`).
- AI detection of "this should be capitalized" — the operator categorizes explicitly.
- The year-end close that posts the annual depreciation charge and locks the year — delivered by the Annual Accounts PRD (ADR-0034), which consumes this engine.
- Resale-goods inventory / closing-stock (deferred to the V2 online-shop module).

## Further Notes

- **Supersedes ADR-0007** (expensing-default, depreciation-deferred). This PRD is the foundational dependency for the Annual Accounts PRD (ADR-0034): annual accounts cannot show real põhivara/kulum lines without the register and the engine delivered here.
- The register and ledger can legitimately drift (a hand-posted `FIXED_ASSETS` line with no register row); the annual-accounts draft surfaces a register-vs-ledger cost mismatch as a **soft** warning — that detection lives in the annual-accounts work, but it depends on the register existing.
- Adding a new asset class later = one account pair + one plugin default-life/residual entry.
