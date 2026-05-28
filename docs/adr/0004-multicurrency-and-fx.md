# Multi-currency transactions, single base-currency ledger, with realized FX

Transactions may be in any currency; the ledger and all reporting are in the Organization's single base currency. Every VoucherLine stores the original amount + currency, the base-currency amount, and the FX rate used. Foreign-currency Accounts (e.g. a USD bank account) are first-class: tracked in their own currency (to reconcile against the statement) and in base currency.

Three rules, split between kernel and country plugin to stay legal under EU/Danish accounting and VAT rules:

- **Realized FX gain/loss is always computed in the kernel** — posted automatically when a foreign-currency position moves. This is required for the ledger to balance, not optional.
- **The VAT-base conversion rate is prescribed, not free.** Per EU VAT Directive Art. 91, the base-currency VAT amount is converted at the prescribed reference rate (latest ECB / customs rate) at the tax point — distinct from the bank's own rate on the statement, which governs cash movement and realized FX, not the VAT base. The exact reference-rate rule lives in the country plugin.
- **Unrealized year-end revaluation of open foreign balances is deferred to v1+**, as a country-plugin / year-end-close responsibility, not a continuous engine. This is legal for ongoing bookkeeping and does not affect VAT compliance; it only matters for the final annual financial statements (EU Accounting Directive / Danish ÅRL expect monetary items at the closing rate), which is a periodic adjustment often made by the accountant. We must not present an interim balance sheet as a finalized GAAP report without it.

Confidence note: principle-level (IAS 21, Directive 2013/34/EU, Directive 2006/112/EC Art. 91). Exact Danish thresholds/treatment to be verified against Årsregnskabsloven and SKAT guidance and encoded in the DK plugin's rules + tests, not hardcoded in the kernel.
