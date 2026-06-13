# PRD: Annual accounts behind the country-plugin seam — RIK-XBRL, draft/final over an immutable close

> Source ADR: [ADR-0034](../adr/0034-annual-accounts-country-plugin-seam.md). Depends on [the Fixed-assets PRD](./0035-fixed-assets.md) (register + depreciation engine). Feeds [the Submission-lifecycle PRD](./0037-statutory-submission-lifecycle.md) as its second snapshot consumer.

## Problem Statement

The kernel has a solid double-entry ledger but produces **no statutory annual report**. An Estonian company must file the majandusaasta aruanne with the e-Business Register portal (`ettevotjaportaal.rik.ee`), either by form-fill or by uploading an XBRL file. The operator today can compute VAT and even derive the KMD, but at year-end there is nothing that turns the ledger into a balance sheet and income statement in the shape RIK expects, nothing that validates the year is internally consistent before filing, and nothing that locks the year once it is filed. Account `type` alone (asset/liability/equity/revenue/expense) is too crude — the statutory form needs specific RTJ lines (käibevara/põhivara split, müügitulu, expense-by-nature, capital breakdown), which is jurisdiction knowledge that must not leak into the kernel.

## Solution

The operator asks for the annual accounts for a reporting year in one of two modes. In **draft** mode the system computes the period-end adjustments virtually (posting nothing, locking nothing), runs its own diagnostics, and emits a full RIK-XBRL file the operator can upload to the portal for the authoritative schema/dimension/calculation validation — repeatable as many times as needed. In **final** mode the system posts the close vouchers (the annual depreciation charge via the engine from the Fixed-assets PRD), locks the year through the existing period-lock, and emits the authoritative XBRL with identical numbers. The same computation feeds both modes, so a portal-validated draft equals the final. The report is a pure projection of the posted ledger — every figure traces to a voucher — and the jurisdiction-specific RTJ/XBRL mapping lives entirely in the Estonia country plugin. Auto-submission via a portal API is out of scope: the operator uploads the file.

## User Stories

1. As an operator, I want to generate a draft of my annual accounts for a year, so that I can see the balance sheet and income statement before I commit.
2. As an operator, I want the draft to compute period-end depreciation virtually without posting anything, so that I can preview the year without changing the books.
3. As an operator, I want to regenerate the draft as many times as I like, so that I can iterate after fixing data.
4. As an operator, I want the draft to emit a real RIK-XBRL file, so that I can upload it to the portal and let RIK authoritatively validate the schema, dimensions and calculations.
5. As an operator, I want the report to show two comparative year columns, so that RIK accepts it (a single period is rejected) and I can compare against last year.
6. As an operator in my first operating year, I want the prior column to be all zeros, so that the report is still valid with no history.
7. As an operator, I want the income statement laid out by nature (skeem 1), so that it matches our expense-by-nature chart without a functional cost split we do not maintain.
8. As an operator, I want the balance-sheet equity section to show share capital, prior-period retained earnings, and this year's result as three live lines, so that equity is correct without a year-end sweep.
9. As an operator, I want the balance sheet to balance because every voucher balances, so that I do not depend on a closing sweep to make Aktiva equal Kohustused + Omakapital.
10. As an operator, I want põhivara and kulum lines populated from the fixed-asset register and depreciation, so that capitalized assets and their depreciation show up correctly.
11. As an operator, I want to run the close as **final**, so that the depreciation vouchers are posted and the year is locked.
12. As an operator, I want final to lock the year via the existing period-lock, so that the closed year becomes immutable and no-break-glass.
13. As an operator, I want final to emit the authoritative XBRL with numbers identical to the validated draft, so that what I file equals what I previewed.
14. As an operator, I want final to be one-shot, so that a second finalize attempt on an already-closed year is rejected.
15. As an operator, I want final hard-blocked if the balance sheet does not balance, so that I cannot file an inconsistent year.
16. As an operator, I want final hard-blocked if any account with a nonzero balance is not mapped to an RTJ line, so that no amount silently vanishes from the report.
17. As an operator, I want soft warnings (not blocks) for suspense/`EXPENSE_OTHER` concentration, depreciation not yet run, and register-vs-ledger cost mismatch, so that I am alerted without being prevented from filing when I judge it fine.
18. As an operator, I want my own draft diagnostics to mirror the XBRL calculation linkbase (sub-items sum to totals), so that issues surface before I bother the portal.
19. As an operator who filed and then found an error, I want to correct it via a reversal/adjustment in the next open period, so that I never edit the locked year.
20. As an operator, I want the report never to compute a number it does not read from a posted voucher, so that every figure is traceable to the ledger and the integrity chain.
21. As a developer adding a new jurisdiction, I want to implement one plugin method to render that country's annual accounts, so that the kernel assembly and the REST/SPA path stay unchanged.
22. As a developer, I want the chart to stay semantic (a code is a label, not an RTJ number), so that the same neutral ledger can serve multiple jurisdictions' report shapes via plugin mapping tables.
23. As a maintainer, I want the XBRL taxonomy version pinned (2026) and a new version to be an additive plugin module, so that a taxonomy bump is a plugin-only change, not a kernel rewrite.
24. As an operator, I want the varud (inventory) line to stay empty for my services company, so that the report is correct for a persona that carries no stock.

## Implementation Decisions

- **New plugin seam** `CountryPlugin.generateAnnualAccounts(input, opts) → { artifacts, warnings }`, mirroring the existing `generateStatutoryReports` (ADR-0033/0002). The plugin stays **pure** (no DB) and owns the `account → RTJ line → XBRL concept` mapping and artifact rendering. `NullCountryPlugin` returns empty.
- **New kernel `AnnualAccountsService`** mirroring `StatutoryReportService`. It assembles a jurisdiction-neutral input: account balances for the period **and** the comparative prior period (via `LedgerBalanceService`), the fixed-asset register (from the Fixed-assets PRD), period net income, and retained earnings brought forward — then delegates to the active plugin resolved by `PluginLoader`.
- **Estonia plugin emits RIK-XBRL**: form = väikeettevõtja; P&L = skeem 1 (by nature); two comparative year columns (a first operating year emits a zero prior column); taxonomy version pinned to 2026; only the mandatory dimensional contexts of the väike form in v1.
- **Equity has no year-end close sweep.** The balance-sheet equity section is three live lines: Osakapital (`EQUITY`/`SHARE_CAPITAL`), Eelmiste perioodide jaotamata kasum (`RETAINED_EARNINGS`), Aruandeaasta kasum (period revenue − expense via `LedgerBalanceService`). Sweeping into retained earnings is a separate concern needed only to *open* the next year.
- **The report is a pure projection of the posted ledger.** Period-end adjustments — depreciation being the only one in scope for the services persona — are real vouchers posted before the report reads them. The report never computes a number it does not read.
- **One calculator, two modes:**
  - **draft** computes the period-end depreciation *virtually* (posts nothing, locks nothing) using the deterministic engine from the Fixed-assets PRD, runs our diagnostics, and emits a full RIK-XBRL file. Idempotent and repeatable. Exposed as `GET /api/reporting-periods/:id/annual-accounts` (no side effects).
  - **final** posts the close vouchers (the annual depreciation charge, computed by the **same** engine), locks the year via the existing period-lock (ADR-0015), and emits the authoritative XBRL with **identical** numbers. One-shot; a second run is rejected. Exposed as `POST /api/reporting-periods/:id/annual-accounts/finalize`.
- **Validation = own checks + the portal.** Draft diagnostics implement the semantics of the XBRL calculation linkbase (sub-items sum to totals); the portal is the authoritative validator on upload. No in-runtime XBRL processor dependency.
- **Gating.** final is **hard-blocked** on (a) a balance-sheet imbalance (Aktiva ≠ Kohustused + Omakapital), or (b) any nonzero-balance account **not mapped** to an RTJ line. **Soft** warnings (non-blocking): suspense/`EXPENSE_OTHER` concentration, depreciation not yet run, register-vs-ledger cost mismatch.
- **Post-final corrections** go through reversal/adjustment vouchers in the next open period (no break-glass, ADR-0012), never by editing the locked year.
- **Capital breakdown** reuses existing `EQUITY`/`RETAINED_EARNINGS`; a `SHARE_CAPITAL` split account is added only when needed. The varud line stays empty for the services persona.
- **DTOs are Zod-backed** (`createZodDto`) for any finalize request body, matching the existing convention.

## Testing Decisions

- **What makes a good test here**: assert external behavior — the artifacts the plugin returns (the XBRL content), the warnings, the hard-block decisions, and (for final) the posted close vouchers and the resulting period lock — not internal assembly details.
- **Plugin rendering — pure unit tests** on the Estonia plugin, the highest seam: feed a neutral `AnnualAccountsInput` and assert the RIK-XBRL output via golden-file comparison and calculation-linkbase semantics (sub-items sum to totals, two comparative columns present, zero prior column for a first year). No DB. Prior art: the existing Estonia KMD XML/XSD-anchored plugin tests.
- **Null plugin** returns empty artifacts — a one-line unit test.
- **draft mode — integration test** (in-memory SQLite, post a year of vouchers + a capitalized asset, call the draft seam): assert the depreciation is computed virtually (no new voucher rows after a draft), the balance sheet balances, and the XBRL numbers match what final will post. Prior art: `StatutoryReportService` / `PostingService` integration specs.
- **final mode — integration test**: call finalize → assert the annual depreciation voucher(s) are posted, the period is locked (status flip, `filed_at` stamped), the emitted XBRL equals the prior draft's numbers, and a second finalize is rejected.
- **Gating — integration tests**: an unmapped nonzero account hard-blocks final; an imbalance hard-blocks final; soft-warning conditions surface as warnings without blocking.
- **draft == final invariant — test**: the same scenario through draft then final yields byte-identical (or numerically identical) figures.

## Out of Scope

- Notes/disclosures beyond the mandatory väike lines; consolidation.
- X-tee / portal-API submission (the operator uploads the file).
- An offline/in-runtime XBRL processor (the portal is the authoritative validator).
- Renumbering the chart to an RTJ-prefixed scheme (the chart stays semantic; mapping is plugin data).
- The retained-earnings sweep that opens the next year (separate concern).
- Resale-goods inventory and its closing-stock adjustment (deferred to the V2 online-shop module).
- The fixed-asset register and depreciation engine themselves — delivered by the Fixed-assets PRD (this PRD consumes them).

## Further Notes

- v1 covers the balance sheet + income statement for the services solo-OÜ persona.
- The seam mirrors `generateStatutoryReports` precisely, so a new jurisdiction adds one plugin method and the kernel assembly + REST/SPA path are unchanged.
- Once final produces a frozen annual-accounts snapshot, it becomes the second consumer of the statutory-submission event log (`source_snapshot_type = annual_accounts`) — see the Submission-lifecycle PRD.
