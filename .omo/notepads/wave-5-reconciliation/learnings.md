# Wave 5 Reconciliation — Inherited Wisdom

## Key ADR Decisions (MANDATORY for all subagents)

### ADR-0002: Country Plugin Boundary
- Country plugin is the **sole resolver** of VAT codes
- Entity stores only intrinsic facts (country, goods-vs-services), NEVER a VAT code
- Cross-border VAT treatment is a plugin decision keyed on VAT-territory membership
- Foreign `document_vat_marking` is NEVER silently reclaimed as input VAT
- Unresolvable treatment → Approval (conservative default: gross-as-cost)

### ADR-0004: Multi-currency & FX
- Base currency: sourced from country plugin (`getDefaultBaseCurrency()`), with optional org override
- Default deployment: Ireland → EUR (never DKK)
- **Realized FX** = booked base − actual settled base (from bank line's `source_amount` × `fx_rate`)
- Single net `FX_GAIN_LOSS` account (NOT separate FX_GAIN/FX_LOSS)
- If bank line lacks BOTH `source_amount` AND `fx_rate` → flag for user feedback, NEVER stub-estimate
- Unrealized FX revaluation deferred to v1+

### ADR-0011: Prepayments
- Prepayment is a **liability** (customer) or **asset** (supplier), NOT AR/AP
- Customer prepayment: Dr Bank / Cr CustomerPrepayments
- Supplier prepayment: Dr SupplierPrepayments / Cr Bank
- Drawn down via N:M matching
- Advance-VAT (EU Art. 65) deferred to country plugin

### ADR-0014: Supplier/Entity Identity
- Identity anchored on **strong registration key** (CVR/VAT number), NEVER on name
- Names (legal + binavne + OCR variants) are aliases
- Classification memory = LLM context (advisory), NOT a deterministic gate
- Transactional memory = authoritative (identity keys, dedup, balances)

### ADR-0017: Personal Disposition
- NOT a business expense: no input VAT, not deductible
- Booking account resolved by **country plugin** via `resolvePersonalDispositionAccount(orgType)`
- `sole_proprietor` → OWNERS_DRAWINGS (equity contra)
- `company` → SHAREHOLDER_LOAN (receivable-from-owner, asset)
- **NEVER hardcode** the disposition account in service code
- `org_type` field on organization: `company` | `sole_proprietor`, default `company` (ADR-0023)
- Approval-required (tax consequences)

### ADR-0023: Dividends
- Primary owner-withdrawal path in v1 is **Dividend** (for companies)
- Sole proprietors take **drawings**
- `org_type` default is `company`

## Codebase Conventions
- Base currency is **EUR** (Ireland default) — never DKK
- All amounts in **cents** (positive integers)
- `is_debit` = 1 for debit, 0 for credit (unsigned magnitude + direction)
- `fx_rate` > 0 (DB CHECK constraint)
- Schema ONLY in `src/database/migrations/` — G4 gate
- Real-DI integration tests required — G2 gate
- DB constraints proven by tests — G6 gate
- Use `npm` (not bun) — `npm run build && npm run lint && npm run test && npm run test:e2e`

## Existing Accounts (from Wave 2 seeding)
- BANK_EUR, BANK_USD (foreign-currency accounts)
- AR, AP
- CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS
- OWNERS_DRAWINGS
- FX_GAIN_LOSS (single net account per ADR-0004)
- REVENUE, EXPENSE_*
- VAT_PAYABLE, VAT_RECEIVABLE

## Existing Database Tables
- organization, account, voucher, voucher_line, voucher_sequence
- expense, sales_invoice, override, policy_config
- reporting_period, document, document_source

## Important: No `matched_voucher_id` on bank_transaction (Q9 resolution)
- Matching is N:M and lives in `reconciliation_match` table
- Whether a transaction is unmatched/partially/fully matched is DERIVED from SUM(reconciliation_match.amount_matched) vs |amount|
- `status` carries only the disposition (open/prepayment/personal/bank_fee/dividend), NOT match-state

## Fixed: Tasks 24/34 Missing Interface Methods (Wave-5 Triage)

### Problem
- Tasks 24 (Personal disposition) and 34 (Cross-border VAT) subagents claimed to modify the plugin interface but did not.
- `personal-disposition.service.ts` called `this.plugin.resolvePersonalDispositionAccount(orgType)` which didn't exist.
- Migration 017 (`017_add_org_type.ts`) existed as a file but was **not registered** in `src/database/migrations/index.ts` — so its column never existed at runtime.

### Changes Made
1. **`src/database/types.ts`**: Added `org_type: Generated<string>` to `OrganizationTable` (Generated because migration 017 adds DEFAULT 'company').
2. **`src/plugins/country-plugin.interface.ts`**: Added `CrossBorderTreatment` type, `CrossBorderResolution` interface, `resolvePersonalDispositionAccount(orgType)` and `resolveCrossBorderTreatment(...)` methods.
3. **`src/plugins/null-country.plugin.ts`**: Implemented both methods — `resolvePersonalDispositionAccount` returns SHAREHOLDER_LOAN/OWNERS_DRAWINGS; `resolveCrossBorderTreatment` returns domestic for same-country, unresolvable for different.
4. **`src/organization/types.ts`**: Added `org_type: string` to `Organization` and `org_type?: 'company' | 'sole_proprietor'` to `UpdateOrganizationDto`.
5. **`src/organization/organization.service.ts`**: Added org_type handling in `mapRow` and `updateOrganization`.
6. **`src/database/migrations/index.ts`**: Registered migration 017 (`017_add_org_type`).

## Task 25 Fix: Wire FXRealizedService into executeMatch

### Problem
- `executeMatch` returned `ReconciliationMatchRecord[]` but the test expected `{ records, fxResults }`.
- `FXRealizedService.computeAndPost` was never called during match execution.

### Changes Made
1. **`reconciliation.types.ts`**: Added `ExecuteMatchResult { records, fxResults }` interface, importing `FXRealizedResult`.
2. **`reconciliation.service.ts`**: Injected `FXRealizedService`; `executeMatch` now caches bank-transaction lookups in a `Map<number, BankTransactionRecord>` during validation, then for each match record checks `source_currency !== null && source_currency !== currency` and calls `computeAndPost` for foreign-currency settlements. Returns `{ records, fxResults }`.
3. **`reconciliation.controller.ts`**: Changed `executeMatch` return type to `Promise<ExecuteMatchResult>`.
4. **`reconciliation.module.ts`**: Added `FXRealizedService` to providers, `PostingModule` to imports.
5. **`reconciliation.service.spec.ts`**: Added `FXRealizedService`, `PostingService`, `LedgerValidationService` to providers; updated `executeMatch` callers to destructure `result.records`.
6. **`fx-realized.service.spec.ts`**: No changes needed — already had correct providers and result access.

### Key Details
- `executeMatch` always pushes an `fxResults` entry per proposal — either `{ status: 'posted', voucher }` for foreign-currency matches, or `{ status: 'no_fx' }` for same-currency.
- Bank-transaction lookup is reused from the validation phase (no extra queries).
- `FXRealizedResult` and `ExecuteMatchResult` are proper types — no `any` casts needed.
- FX auto-posting uses the same `matchedAmount` as the match record (base-currency cents).
