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

## FX gain/loss account granularity

The canonical chart carries a **single net** `FX_GAIN_LOSS` account (`type: expense`; a net gain simply makes the balance negative), not separate `FX_GAIN` / `FX_LOSS` accounts. The account is hidden from the SMB user (ADR-0001), so gain-vs-loss split is pure P&L presentation granularity — over-built for a micro-SMB. The door stays open: a later split is the Wave-5 conditional "add `FX_GAIN` if absent" migration, to be done only if a jurisdiction's presentation requires it. This supersedes carry-forward seam #2's "add `FX_GAIN` in Wave 2".
