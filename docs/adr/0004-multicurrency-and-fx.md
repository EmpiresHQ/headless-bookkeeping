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
