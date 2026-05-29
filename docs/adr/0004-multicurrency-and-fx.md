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
