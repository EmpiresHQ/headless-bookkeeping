# Multi-currency transactions, single base-currency ledger, with realized FX

Transactions may be in any currency; the ledger and all reporting are in the Organization's single base currency. Every VoucherLine stores the original amount + currency, the base-currency amount, and the FX rate used. Foreign-currency Accounts (e.g. a USD bank account) are first-class: tracked in their own currency (to reconcile against the statement) and in base currency.

Three rules, split between kernel and country plugin to stay legal under EU/Danish accounting and VAT rules:

- **Realized FX gain/loss is always computed in the kernel** — posted automatically when a foreign-currency position moves. This is required for the ledger to balance, not optional.
- **The VAT-base conversion rate is prescribed, not free.** Per EU VAT Directive Art. 91, the base-currency VAT amount is converted at the prescribed reference rate (latest ECB / customs rate) at the tax point — distinct from the bank's own rate on the statement, which governs cash movement and realized FX, not the VAT base. The exact reference-rate rule lives in the country plugin.
- **Unrealized year-end revaluation of open foreign balances is deferred to v1+**, as a country-plugin / year-end-close responsibility, not a continuous engine. This is legal for ongoing bookkeeping and does not affect VAT compliance; it only matters for the final annual financial statements (EU Accounting Directive / Danish ÅRL expect monetary items at the closing rate), which is a periodic adjustment often made by the accountant. We must not present an interim balance sheet as a finalized GAAP report without it.

## Base-currency resolution (origin and override)

The base currency is sourced from the **country plugin**, with an optional **Organization-level override**:

- The country plugin exposes `getDefaultBaseCurrency()` — the national currency for that jurisdiction (e.g. an Irish plugin returns `EUR`, a Danish plugin `DKK`). This keeps "what currency does this country book in?" inside the same boundary that owns VAT codes and period frequency, rather than as a free-form kernel setting.
- The Organization carries a **nullable** `base_currency` override. `NULL` means "inherit from the country plugin"; a value pins an explicit override (e.g. an Irish entity that elects to report in USD). Resolution is therefore `organization.base_currency ?? pluginLoader.resolve(organization.country).getDefaultBaseCurrency()`.
- A country plugin is **mandatory**: there is always at least a default plugin. If no plugin resolves at all, the system fails loud rather than silently falling back to a guessed currency (consistent with ADR-0012, no break-glass).

The default/bootstrap Organization is seeded as **Ireland with no override** (`country='IE'`, `base_currency=NULL`), resolving to `EUR` via the default plugin. (This supersedes the earlier DK/DKK scaffolding default.)

Confidence note: principle-level (IAS 21, Directive 2013/34/EU, Directive 2006/112/EC Art. 91). Exact Danish thresholds/treatment to be verified against Årsregnskabsloven and SKAT guidance and encoded in the DK plugin's rules + tests, not hardcoded in the kernel.

## Ledger validation boundary (Wave 2)

The Wave-2 ledger **trusts** the `amount` / `currency` / `base_amount` / `fx_rate` it receives on a draft line — it never sources or recomputes the rate, because the prescribed reference rate lives in the country plugin (above). The ledger's job is **internal consistency**, not rate-correctness:

- `fx_rate > 0` (DB CHECK).
- `base_amount ≈ round(amount × fx_rate)` within ±1 cent (sanity, not rate authority).
- **Account-currency match**: when an `Account` pins a `currency` (e.g. `BANK_USD`), a line posted to it must carry that same currency. Base-currency control accounts (`currency IS NULL`) accept any currency. This is a structural Rule — a EUR line cannot land in a USD-only account.

Rate sourcing, the prescribed VAT-base rate, and realized-FX computation are pipeline/plugin concerns (Wave 3+), not the ledger primitive.

## Wave-3 review amendment — the plugin owns the rate via `getReferenceRate`

The Wave-3 draft generators shipped with a placeholder that defeated this design: `const fxRate = isBaseCurrency ? 1 : 1` (a dead ternary) and `base_amount = amount` for every currency. A non-base-currency document therefore posted at an implicit 1:1 — and because most chart accounts carry `currency = NULL`, the account-currency-match guard did not catch it, so the ledger could silently accept an unconverted foreign amount as base. That is a silent integrity hole, not an acceptable deferral.

The remediation (Wave-4 prologue, carried from the Wave-3 review) makes the rate real and sources it from the plugin, exactly where this ADR already says it lives:

- The `CountryPlugin` interface gains **`getReferenceRate(fromCurrency, toCurrency, taxPointDate): number`** — the prescribed VAT-base reference rate (Art. 91) at the tax point. The kernel still never invents a rate.
- Draft generation calls `getReferenceRate` and `CurrencyService.convertToBase` to set each line's `fx_rate` and `base_amount = round(amount × rate)`, then the structural tier enforces the **account-currency match** (a USD line cannot land in a EUR-only account).
- `NullCountryPlugin` returns `1.0` for same-currency conversions and a documented fixed stub (or a small seeded reference table) for cross-currency, so the path is exercisable end-to-end; real ECB/customs rates land in real country plugins.
- **Realized FX gain/loss stays out of scope** until a settlement/payment voucher exists (there is none in Wave 3) — recognition at the tax point uses a single uniform rate across the draft's lines, so the voucher still balances in base currency within the ±1-cent tolerance. The realized gain/loss only arises when a foreign position later moves, per the kernel rule above.

## Realized FX uses the bank's actual settlement, not a reference rate (Wave-5)

Realized FX is the gap between the **booked** base value (the receivable/payable, at the prescribed reference rate) and the **actually settled** base value (the cash). It must therefore be computed from the **bank line's own data**, never from a reference rate or a hardcoded stub — a reference rate would just compare one estimate to another, not realize the actual gap.

A bank line, even when booked in the base currency (EUR), carries in its description the currency the payment arrived in, and almost always either the original foreign amount (e.g. `16 USD`) or the conversion rate. So `bank_transaction` captures `source_currency`, and at least one of `source_amount` / `fx_rate` (parsed from the statement line); the third is derived (`base × rate = foreign`). Realized FX = `voucher.base_amount (of the settled portion) − bank.base_amount`, posted automatically to the single net `FX_GAIN_LOSS` account.

When a foreign-currency line carries **neither** the source amount **nor** the rate, the kernel does **not** guess (no stub): it escalates to **user feedback** (Approval / Action point) to supply the missing datum. Silent estimation of a realized figure is forbidden.

## FX gain/loss account granularity

The canonical chart carries a **single net** `FX_GAIN_LOSS` account (`type: expense`; a net gain simply makes the balance negative), not separate `FX_GAIN` / `FX_LOSS` accounts. The account is hidden from the SMB user (ADR-0001), so gain-vs-loss split is pure P&L presentation granularity — over-built for a micro-SMB. The door stays open: a later split is the Wave-5 conditional "add `FX_GAIN` if absent" migration, to be done only if a jurisdiction's presentation requires it. This supersedes carry-forward seam #2's "add `FX_GAIN` in Wave 2".

## The reference rate is an authoritative observation, not a constant (issue #203)

The Wave-3 amendment above put the rate behind `CountryPlugin.getReferenceRate` and let the null plugin answer with "a documented fixed stub (or a small seeded reference table)". The live Estonia plugin took that licence and shipped a hardcoded `RATES` map — `USD→EUR 0.92`, `GBP→EUR 1.16` — whose `date` parameter was named `_date` and never read. Every foreign-currency voucher, whatever its tax point, was booked at one constant. That is not a deferred integration; it is an unsupported base amount in an immutable ledger, and it reached the VAT base.

Four things change, and one deliberately does not.

**The rate has a source, and the source is a real authority.** A new `FxRateSource` seam is the single boundary at which rates enter the system. Production binds it to the ECB's euro foreign exchange reference rates (`data-api.ecb.europa.eu`, dataflow `EXR`, series `D.<QUOTE>.EUR.SP00.A`). A test binds it to a deterministic fixture. There is no "use fixed rates" flag inside production code: a test constant reachable from a production build is the defect, not the mitigation.

For Estonia the authority is prescribed, not chosen. KMS § 29 lg 13: for a non-import transaction whose VAT data is in a foreign currency, the applicable rate is the ECB euro rate **in force** on the day determined under § 11 — Estonia's enactment of Art. 91. (Imports take the customs rate under the Union Customs Code instead; that path is not yet implemented and is out of this issue's scope.) The plugin still owns the rule; the kernel still never invents a rate.

**`getReferenceRate` is asynchronous, and returns provenance.** A real rate must be looked up — from a cache, and on a miss over the network — so the synchronous signature had to go; it was itself what forced the placeholder. It now returns `{ rate, rateDate, source }`. The kernel's single-connection SQLite constraint makes the call site a correctness question, not a style one: every posting path already resolves its draft **before** opening a transaction (account resolution, validation, entity resolution all do), and rate resolution joins them there. No network call happens inside a transaction.

**The applied date and source are persisted on the VoucherLine.** `fx_rate` alone cannot be audited: 0.92 on a 2024 line and 0.92 on a 2026 line look identical, which is how this stayed invisible. `fx_rate_date` also makes the non-business-day rule visible after the fact — the ECB publishes only on TARGET working days, around 16:00 CET, and the statutory "in force" wording means the last publication governs until the next, so a Saturday tax point legitimately carries Friday's `fx_rate_date`. The fallback is bounded (7 days, covering the longest real TARGET closing run with margin); beyond that a rate is stale, not in force, and the conversion is **refused**. There is no silent fall-back to a latest, current or constant rate, and no forward fall-back to a later publication.

Both columns are **nullable**, and that nullability is load-bearing. A line posted before this change has no provenance and must stay distinguishable as such. Back-filling a source onto it would erase the only signal that separates "traceable" from "nobody knows", and would bless a rate that was never checked. `NULL` means *provenance unknown*, which is a finding, not a defect to be papered over.

**Observations are cached append-only, and coverage is tracked separately.** `fx_reference_rate` holds one row per `(source, base, quote, rate_date)`, in the authority's own quotation convention, and rejects UPDATE at the database level. An upstream revision therefore cannot revalue history: what was posted stays explicable by what is stored, and the divergence is logged for an append-only correction instead.

A second table, `fx_rate_probe`, records which date windows were actually asked about. Without it the cache would answer a never-fetched Monday from a cached Friday row — reproducing date-blind rates across a whole lookback window, the exact defect, one layer down. A probe's `to_date` is clamped to strictly before the current day, because today is not settled: a fetch at 10:00 CET legitimately finds nothing yet, and freezing that as coverage would keep serving yesterday's rate to new postings after the 16:00 publication.

**The hash chain is deliberately untouched.** `computeVoucherHash` commits to an explicit field list that the two provenance columns do not join. Adding them would change the canonical form of every voucher and break verification of the existing chain — to commit to an attribute of a rate the chain already commits to.

Realized FX is unaffected by all of this and stays as the Wave-5 section describes: it is measured against the bank's **own** statement data, never a reference rate. Cash legs are now labelled `bank_statement` so they cannot be mistaken for an ECB observation, and base-currency legs are labelled `identity` so they are not mistaken for unattributed ones.

Historical exposure is assessed **without** rewriting anything: `GET /api/fx/provenance-audit` classifies posted lines by rate and provenance and flags unattributed rates repeated across multiple tax-point dates. See `docs/runbooks/fx-rate-provenance-assessment.md`, including the read-only production assessment of 2026-09-20 and what it does and does not establish.
