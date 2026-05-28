# Personal (non-business) disposition for company-funded personal spend

People routinely pay personal items with the corporate card by mistake (and often have no receipt). The ReconciliationAgent must offer a **"personal"** disposition for such a bank line — alongside match / business-expense / prepayment / bank-fee.

This is deliberately *not* a business expense:

- **No input VAT** is reclaimed (claiming VAT on personal spend is fraud) and it is **not deductible**.
- The ledger books it by org type (a country-plugin / config decision): `Dr Owner's-drawings / Cr Bank` for a sole proprietor, or `Dr Receivable-from-owner (shareholder loan) / Cr Bank` for a company.
- It is **approval-required** (a judgment with tax consequences).
- User-facing it is just the label **"personal"** — consistent with ADR-0001 (the user sees a semantic label; the ledger books the right account).

The plugin must surface country-specific tax traps as advisory: e.g. in Denmark a shareholder loan (*kapitalejerlån*) is legally restricted and taxed as salary/dividend on creation, so "personal on the corp card" in an ApS is "repay immediately / book as salary", not a benign receivable.
