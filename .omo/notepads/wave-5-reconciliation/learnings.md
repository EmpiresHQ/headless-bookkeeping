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
