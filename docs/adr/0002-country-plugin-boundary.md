# Country-plugin boundary: thin canonical kernel, country specifics in plugins

The kernel owns a thin canonical chart of Accounts — Cash, Bank (per currency), AR, AP, Revenue, Expense-by-category, VAT-payable, VAT-receivable, Equity, Customer-prepayments, Supplier-prepayments/prepaid-expense, FX-gain/loss, Bad-debt-expense, Accumulated-depreciation + Depreciation-expense (when assets are enabled), and Suspense. These are universal double-entry mechanics, country-agnostic. A country plugin owns everything country-specific: the authoritative VAT codes (e.g. `DK_INPUT_25`), VAT rates, deductibility rules, `category → account + vat_code` mappings, rounding, and report export formats. A plugin may extend/refine the chart, never replace it.

Two deliberate decisions:

- **VAT reports are built from the country-specific VAT code.** There is no abstract, kernel-canonical VAT vocabulary. We considered a thin canonical "VAT treatment" layer (`REVERSE_CHARGE_SERVICES`, …) to feed AI and make supplier memory portable across countries, and rejected it: deciding a code's applicability requires country context regardless, so the abstract layer earns the AI nothing, and the only remaining use (cross-country analytics) is not a real need for single-country freelancers / micro-SMBs. It can be re-added later as derived data if multi-country aggregation becomes a requirement.
- **The country plugin is the sole resolver of a VAT code**, from `(Supplier intrinsic facts + the Organization's country/registration)`. A Supplier stores only intrinsic, context-free facts (country, goods-vs-services, default category, aliases) — never a VAT code, because the code depends on the Organization's context.

Chosen over a fully kernel-canonical model (too rigid for divergent national VAT regimes) and a fully plugin-defined model (duplicates ledger/reporting logic per country).
