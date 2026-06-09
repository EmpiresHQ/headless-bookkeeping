# Dividends: owner withdrawal as an equity distribution, with withholding and the profits-check in the plugin

The v1 target persona is a **one-person company**, and the primary way the owner takes money out is **dividends** (more tax-efficient than salary in the target jurisdictions). So dividends are first-class in v1 — while salary/payroll is deferred to a future domain plugin (ADR-0022) — and `organization.org_type` defaults to `company` (a sole proprietor, who takes drawings not dividends, is the secondary case).

A **dividend is an equity distribution, not an expense.** It never touches a P&L expense account:

- **Declaration:** `Dr Retained-earnings (Dividends-declared) / Cr Dividend-payable`.
- **Settlement:** `Dr Dividend-payable / Cr Bank` — reconciled against the outgoing bank line via a `dividend` **disposition** (draws down the payable, like an AP).
- New kernel accounts: `RETAINED_EARNINGS`, `DIVIDEND_PAYABLE` (extend the canonical chart, ADR-0002).
- **Approval-required** — a decision with tax consequences, like a personal disposition (ADR-0017).

**Withholding and the distributable-profits check are country-plugin rules** (ADR-0002), not kernel logic: dividend withholding tax (IE DWT, DK *udbytteskat*; with close-company / owner exemptions) and the legal cap that a dividend may not exceed distributable (retained) profits both vary by country. The v1 null plugin applies zero withholding and a soft profits-check; a real country plugin enforces them.

This is **not** a domain plugin (ADR-0022): dividends are ledger-native (two accounts + a Voucher), with no operational sub-domain or own store — unlike payroll. It stays in the kernel; only the *rules* (withholding, profits-cap) sit in the country plugin.

Sequencing: the `dividend` disposition draws down a declared `Dividend-payable`, so declaration must exist first — both declaration and the reconciliation disposition land in Wave 6; Wave 5 only reserves the `dividend` value in the bank-transaction disposition enum.

Chosen over booking owner withdrawals uniformly as drawings (correct only for a sole proprietor; for a company it would misstate equity, ignore withholding, and skip the legal profits-cap) and over modelling dividends as a domain plugin (overkill — there is no operational sub-domain, just a distribution).

## Amendment (Wave 6 grilling, 2026-06-04)

v1 has **no year-end close engine** — net income is never swept from the P&L accounts (`REVENUE`/`EXPENSE_*`) into `RETAINED_EARNINGS`. Two consequences for the dividend flow:

- **Distributable profits is computed live, not read off the `RETAINED_EARNINGS` balance.** The kernel passes the plugin a *computed* figure = `RETAINED_EARNINGS` balance + current net income (ΣRevenue − ΣExpense) − prior distributions. Feeding the bare account balance would be meaningless (it sits at ≈0 with no close), so the soft/strict profits-check operates on the computed equity. The plugin owns only the cap rule; the kernel owns the figure.
- **A declaration debits `RETAINED_EARNINGS` directly, so that account may be interim-negative** for a profitable company until a close engine exists (deferred past v1). The balance sheet still balances in aggregate (negative RE offset by undistributed P&L). Documented so a future reader does not "fix" a deliberately-negative RE.

The withholding split (`Cr Dividend-payable` net + `Cr` withholding-payable) needs a third kernel account: add **`DIVIDEND_WITHHOLDING_PAYABLE`** (liability) to the canonical chart alongside `RETAINED_EARNINGS` and `DIVIDEND_PAYABLE`. The plugin decides the rate and whether the split applies; the account itself is kernel-canonical (ADR-0002).
