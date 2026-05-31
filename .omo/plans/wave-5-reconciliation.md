# Wave 5: Reconciliation

## Overview
This wave implements bank statement ingestion, deterministic N:M matching, prepayment balances, personal disposition, FX realized auto-posting, and end-to-end reconciliation integration. It runs in parallel with Wave 4 (Intake) after Wave 3 completes.

> **Detailed implementation plan (bite-sized TDD):** [`docs/superpowers/plans/2026-05-29-wave-5-reconciliation.md`](../../docs/superpowers/plans/2026-05-29-wave-5-reconciliation.md) — the step-by-step "how". This file remains the "what / why" spec.

## Prerequisites
- **Wave 3 complete**: Business objects, Rules engine, Policy gate, Pipeline integration
- `docker compose up` starts successfully
- `npm run build` and `npm test` pass

## Definition of Done
- Bank statements and transactions are stored in SQLite
- Matching engine proposes N:M deterministic matches
- Prepayment vouchers are created for unmatched incoming/outgoing payments
- Personal disposition creates Owner's-drawings vouchers
- FX realized auto-posts on foreign-currency settlement
- End-to-end reconciliation flow works
- Agent-executed QA scenarios pass with evidence captured
- Git commit records the wave
- **Wave gate — ALL green, exactly as CI runs them** (see `.omo/plans/engineering-guardrails.md`): `npm run build && npm run lint && npm run test && npm run test:e2e`
- **Real-DI integration test** for every cross-module behavior — no all-mock coverage (G2)
- **Schema only in migrations** — grep clean: no `createTable`/`CREATE TABLE` outside `src/database/migrations/` (G4)
- **"Must NOT do" greps clean**; stated DB invariants are real DB constraints proven by a test (G5/G6)
- **Per-wave verification pass** (plan-compliance + code-quality + scope-fidelity) before commit (G8)
- Base currency and example payloads use **EUR** (Ireland default), per ADR-0004 — never DKK

---

## TODOs

- [ ] 21. BankStatement + BankTransaction schema

  **What to do**:
  - Create `src/bank/` module
  - `bank_statement` table: id (INTEGER PK), account_id (INTEGER FK to account — must be BANK_*), start_date (TEXT), end_date (TEXT), uploaded_at (INTEGER), file_path (TEXT, nullable)
  - `bank_transaction` table: id (INTEGER PK), statement_id (INTEGER FK), transaction_date (TEXT NOT NULL), description (TEXT), amount (INTEGER NOT NULL — cents, positive for credit/incoming, negative for debit/outgoing), currency (TEXT NOT NULL), reference (TEXT, nullable — invoice number or match key), matched_voucher_id (INTEGER FK to voucher, nullable), status (TEXT — enum: unmatched, matched, personal, bank_fee), created_at (INTEGER)
  - `POST /api/bank-statements` accepts JSON or CSV upload, creates statement + transactions
  - `GET /api/bank-statements` lists statements
  - `GET /api/bank-statements/:id/transactions` lists transactions for a statement
  - Write tests for statement creation and transaction parsing

  **Must NOT do**:
  - Do NOT implement real bank feed APIs (open banking, PSD2) — JSON/CSV upload only
  - Do NOT implement matching logic here — that's Task 22
  - Do NOT support all bank formats — one simple JSON/CSV format is enough

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Schema + file parsing (CSV/JSON), transaction representation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 22, 23, 24, 25)
  - **Parallel Group**: Wave 5 (with Tasks 22, 23, 24, 25)
  - **Blocks**: Task 22 (matching needs transactions), Task 26 (integration needs statements)
  - **Blocked By**: Task 1 (migration runner), Task 6 (needs BANK_* accounts)

  **References**:
  - ADR-0011: "An unmatched incoming payment is an on-account balance, not an error"
  - ADR-0017: "ReconciliationAgent must offer a 'personal' disposition"
  - `src/ledger/account/` — Pattern for account validation

  **Acceptance Criteria**:
  - [ ] Migration creates `bank_statement` and `bank_transaction` tables
  - [ ] `POST /api/bank-statements` with JSON payload creates statement + transactions
  - [ ] `GET /api/bank-statements/:id/transactions` returns transactions
  - [ ] Tests pass: `bank-statements.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Upload bank statement with transactions
    Tool: Bash (curl)
    Preconditions: App running, bank account exists
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"account_code":"BANK_EUR","start_date":"2024-01-01","end_date":"2024-01-31","transactions":[{"transaction_date":"2024-01-15","description":"Payment from Customer A","amount":12500,"currency":"EUR","reference":"INV-001"},{"transaction_date":"2024-01-16","description":"Bolt ride","amount":-1525,"currency":"EUR","reference":""}]}' http://localhost:3000/api/bank-statements`
    Expected Result: 201 with statement id, 2 transactions created
    Failure Indicators: 400/500, wrong transaction count, missing amounts
    Evidence: .omo/evidence/task-21-upload-statement.json

  Scenario: List bank statement transactions
    Tool: Bash (curl)
    Preconditions: Statement uploaded
    Steps:
      1. `curl -s http://localhost:3000/api/bank-statements/1/transactions`
    Expected Result: JSON array with 2 transactions, correct amounts and descriptions
    Failure Indicators: Empty array, wrong data
    Evidence: .omo/evidence/task-21-list-transactions.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for statement creation
  - [ ] Transaction listing output

  **Commit**: YES
  - Message: `feat(bank): bank statement + transaction schema`
  - Files: `src/bank/`
  - Pre-commit: `npm run build && npm test`

- [ ] 22. Matching engine (N:M deterministic)

  **What to do**:
  - Create `src/reconciliation/` module
  - `ReconciliationService` with `proposeMatches(statementId: number): MatchProposal[]`:
    - For each unmatched incoming transaction (amount > 0):
      - Find unpaid AR vouchers (SalesInvoice vouchers) with matching amount + date within ±7 days
      - Find CustomerPrepayment vouchers with matching amount + date within ±7 days
      - Return proposals sorted by confidence (exact amount match = highest)
    - For each unmatched outgoing transaction (amount < 0):
      - Find unpaid AP vouchers (Expense vouchers with AP line) with matching |amount| + date within ±7 days
      - Return proposals
  - `POST /api/bank-statements/:id/match` executes proposed matches
  - `reconciliation_match` table: id, bank_transaction_id, voucher_id, match_type (enum: exact, partial, prepayment), amount_matched (INTEGER), created_at
  - N:M matching: one transaction can match multiple vouchers, one voucher can match multiple transactions
  - Update voucher and transaction status on match
  - Write tests for matching logic

  **Must NOT do**:
  - Do NOT use ML/AI for matching — deterministic rules only (amount + date + counterparty)
  - Do NOT auto-execute matches without explicit action — only propose, user/agent must confirm
  - Do NOT implement fuzzy matching on descriptions — exact amount + date window only

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: N:M join logic, partial matching, status updates
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 21, 23, 24, 25)
  - **Parallel Group**: Wave 5 (with Tasks 21, 23, 24, 25)
  - **Blocks**: Task 23 (prepayments use matching), Task 26 (integration)
  - **Blocked By**: Task 21 (needs bank transactions), Task 7 (needs vouchers), Task 12 (needs AR/AP vouchers)

  **References**:
  - ADR-0011: "Drawn down by one or more later invoices via the same N:M matching, with a two-sided outstanding"
  - ADR-0015: "Settlement vouchers, outstanding balances, and partial-payment matching only exist because accrual opens a gap"
  - ADR-0014: "Supplier identity is anchored on a strong registration key" — matching uses counterparty references

  **Acceptance Criteria**:
  - [ ] Unmatched incoming transaction finds matching AR voucher by amount + date
  - [ ] Unmatched outgoing transaction finds matching AP voucher by amount + date
  - [ ] `POST /api/bank-statements/1/match` creates reconciliation_match records
  - [ ] N:M matching: one transaction can match 2 vouchers (partial + partial)
  - [ ] Tests pass: `reconciliation.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Propose match for incoming payment
    Tool: Bash (curl)
    Preconditions: App running, AR voucher exists (amount 12500, date 2024-01-10), bank transaction exists (amount 12500, date 2024-01-15)
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/bank-statements/1/propose-matches`
    Expected Result: 200 with proposals array, includes voucher id and match confidence
    Failure Indicators: No proposals, wrong voucher matched
    Evidence: .omo/evidence/task-22-propose-match.json

  Scenario: Execute N:M match
    Tool: Bash (curl)
    Preconditions: Proposals exist
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"matches":[{"transaction_id":1,"voucher_id":1,"amount":7000},{"transaction_id":1,"voucher_id":2,"amount":5500}]}' http://localhost:3000/api/bank-statements/1/match`
    Expected Result: 201 with match records, transaction status="matched"
    Failure Indicators: 400, only one match created, status not updated
    Evidence: .omo/evidence/task-22-execute-match.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for propose and execute match
  - [ ] SQLite query showing reconciliation_match records

  **Commit**: YES
  - Message: `feat(reconciliation): deterministic N:M matching engine`
  - Files: `src/reconciliation/`
  - Pre-commit: `npm run build && npm test`

- [ ] 23. Prepayment balances (liability/asset vouchers)

  **What to do**:
  - Implement prepayment voucher creation per ADR-0011:
    - **Customer prepayment** (incoming payment before invoice): Dr Bank / Cr CustomerPrepayments (liability)
    - **Supplier prepayment** (outgoing payment before bill): Dr SupplierPrepayments (asset) / Cr Bank
  - `PrepaymentService`:
    - `createCustomerPrepayment(transaction: BankTransaction): Voucher` — posts Dr Bank / Cr CUSTOMER_PREPAYMENTS
    - `createSupplierPrepayment(transaction: BankTransaction): Voucher` — posts Dr SUPPLIER_PREPAYMENTS / Cr Bank
    - `drawDownPrepayment(prepaymentVoucherId: number, invoiceVoucherId: number, amount: number): Voucher` — creates draw-down voucher clearing prepayment against invoice
  - `POST /api/bank-transactions/:id/prepayment` — marks as prepayment and creates voucher
  - `POST /api/prepayments/:id/draw-down` — links prepayment to invoice
  - `GET /api/prepayments` lists outstanding prepayments
  - Write tests for prepayment creation and draw-down

  **Must NOT do**:
  - Do NOT implement advance-VAT computation (EU Directive Art. 65) — deferred to country plugin
  - Do NOT implement automatic draw-down on invoice posting — manual or matching only
  - Do NOT handle multi-currency prepayments in v1 — assume same currency

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Voucher creation, liability/asset balance tracking, draw-down logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 21, 22, 24, 25)
  - **Parallel Group**: Wave 5 (with Tasks 21, 22, 24, 25)
  - **Blocks**: Task 26 (integration tests prepayment flow)
  - **Blocked By**: Task 9 (posting service), Task 6 (needs CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS accounts), Task 21 (needs bank transactions)

  **References**:
  - ADR-0011: "A prepayment is a liability, not a Receivable... lands in 'Customer prepayments / payments on account' liability balance"
  - ADR-0011: "Symmetric on the buy side: paying a supplier in advance is a prepaid-expense / supplier on-account asset"
  - ADR-0011: "Drawn down by one or more later invoices via the same N:M matching"

  **Acceptance Criteria**:
  - [ ] Unmatched incoming payment → `POST /api/bank-transactions/1/prepayment` creates voucher: Dr BANK, Cr CUSTOMER_PREPAYMENTS
  - [ ] Unmatched outgoing payment → prepayment voucher: Dr SUPPLIER_PREPAYMENTS, Cr BANK
  - [ ] Draw-down creates clearing voucher linking prepayment to invoice
  - [ ] `GET /api/prepayments` shows outstanding balance
  - [ ] Tests pass: `prepayment.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Create customer prepayment from unmatched incoming payment
    Tool: Bash (curl)
    Preconditions: App running, unmatched incoming bank transaction exists
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/bank-transactions/1/prepayment`
    Expected Result: 201 with voucher JSON, lines: Dr BANK, Cr CUSTOMER_PREPAYMENTS
    Failure Indicators: Wrong accounts, voucher not created, status not updated
    Evidence: .omo/evidence/task-23-customer-prepayment.json

  Scenario: Draw down prepayment against invoice
    Tool: Bash (curl)
    Preconditions: Customer prepayment exists, invoice voucher exists (AR)
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"invoice_voucher_id":2,"amount":12500}' http://localhost:3000/api/prepayments/1/draw-down`
    Expected Result: 201 with draw-down voucher, prepayment balance reduced
    Failure Indicators: No voucher created, balance not updated
    Evidence: .omo/evidence/task-23-draw-down.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for prepayment creation and draw-down
  - [ ] SQLite query showing prepayment balances

  **Commit**: YES
  - Message: `feat(reconciliation): prepayment balances + draw-down`
  - Files: `src/reconciliation/prepayment.service.ts`, `src/reconciliation/prepayment.controller.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 24. Personal disposition

  **What to do**:
  - Implement personal disposition per ADR-0017:
    - `POST /api/bank-transactions/:id/personal` — marks transaction as personal, creates voucher: Dr OWNERS_DRAWINGS / Cr BANK
    - For sole proprietors: Owner's-drawings (equity contra)
    - For companies (ApS): Receivable-from-owner (asset) — but for v1, use Owner's-drawings as default
    - `GET /api/bank-transactions/:id` shows disposition status
  - Write tests for personal disposition

  **Must NOT do**:
  - Do NOT implement company-type-specific logic (ApS vs sole proprietor) — default to Owner's-drawings

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Voucher creation for personal disposition, straightforward business rule
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 21, 22, 23, 25)
  - **Parallel Group**: Wave 5 (with Tasks 21, 22, 23, 25)
  - **Blocks**: Task 25 (FX realized), Task 26 (integration tests personal flow)
  - **Blocked By**: Task 9 (posting service), Task 6 (needs OWNERS_DRAWINGS account), Task 21 (bank transactions)

  **References**:
  - ADR-0017: "The ledger books it by org type: Dr Owner's-drawings / Cr Bank for a sole proprietor"
  - ADR-0017: "Approval-required (a judgment with tax consequences)" — but for Wave 5, just post directly (Policy in Wave 3 gates it)

  **Acceptance Criteria**:
  - [ ] `POST /api/bank-transactions/1/personal` creates voucher: Dr OWNERS_DRAWINGS, Cr BANK
  - [ ] Tests pass: `personal-disposition.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Mark bank transaction as personal
    Tool: Bash (curl)
    Preconditions: App running, outgoing bank transaction exists
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/bank-transactions/1/personal`
    Expected Result: 201 with voucher JSON, lines: Dr OWNERS_DRAWINGS, Cr BANK
    Failure Indicators: Wrong accounts, voucher not created
    Evidence: .omo/evidence/task-24-personal.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for personal disposition

  **Commit**: YES
  - Message: `feat(reconciliation): personal disposition`
  - Files: `src/reconciliation/personal-disposition.service.ts`, `src/reconciliation/personal-disposition.controller.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 25. FX realized auto-posting

  **What to do**:
  - Implement FX realized auto-posting per ADR-0004:
    - When settling a foreign-currency invoice from a foreign-currency bank account at a different rate than booked:
    - Auto-compute realized FX gain/loss: (invoice FX rate - settlement FX rate) * amount
    - Create system-generated voucher: Dr/Cr FX_GAIN or FX_LOSS + adjust Bank account
    - `FXRealizedService.computeAndPost(...)` — called by matching engine when FX rates differ
    - Stub for Wave 5: hardcoded rate comparison, real rate service deferred
  - Write tests for FX realized posting

  **Must NOT do**:
  - Do NOT implement unrealized FX revaluation — deferred to v1+
  - Do NOT integrate with external FX rate APIs — use stub rates from Task 4

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: FX computation and voucher creation, deterministic calculation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 21, 22, 23, 24)
  - **Parallel Group**: Wave 5 (with Tasks 21, 22, 23, 24)
  - **Blocks**: Task 26 (integration tests FX flow)
  - **Blocked By**: Task 9 (posting service), Task 6 (needs FX_GAIN, FX_LOSS accounts), Task 4 (FX rate stub), Task 21 (bank transactions), Task 22 (matching engine triggers FX)

  **References**:
  - ADR-0004: "Realized FX gain/loss is always computed in the kernel — posted automatically"
  - ADR-0004: "The base-currency VAT amount is converted at the prescribed reference rate"

  **Acceptance Criteria**:
  - [ ] FX realized computed when settling USD invoice from USD account at different rate
  - [ ] FX voucher lines balance to zero (e.g., Dr FX_LOSS 100, Cr BANK 100)
  - [ ] Tests pass: `fx-realized.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: FX realized auto-posted on settlement
    Tool: Bash (curl)
    Preconditions: USD invoice posted at rate 7.0, bank transaction at rate 7.14
    Steps:
      1. Match transaction to invoice
      2. Check for auto-created FX voucher
    Expected Result: FX voucher exists, lines: Dr FX_GAIN (or Cr FX_LOSS), amount = difference * base_amount
    Failure Indicators: No FX voucher, wrong calculation
    Evidence: .omo/evidence/task-25-fx-realized.json
  ```

  **Evidence to Capture**:
  - [ ] FX voucher details showing correct computation

  **Commit**: YES
  - Message: `feat(reconciliation): FX realized auto-posting`
  - Files: `src/reconciliation/fx-realized.service.ts`, `src/reconciliation/fx-realized.controller.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 26. Reconciliation integration

  **What to do**:
  - End-to-end integration test for reconciliation flow:
    1. Upload bank statement with multiple transactions
    2. Run matching proposals
    3. Execute matches (including partial N:M)
    4. Handle unmatched incoming as prepayment
    5. Handle unmatched outgoing as personal disposition
    6. Handle FX difference on settlement
    7. Verify all vouchers are posted and balances are correct
  - `test/reconciliation.e2e-spec.ts`
  - Also verify that `GET /api/accounts/BANK_EUR` shows correct balance after all transactions
  - This task is wiring test, not new logic

  **Must NOT do**:
  - Do NOT add new business logic — only wire existing services
  - Do NOT implement real bank feeds
  - Do NOT test period locking in reconciliation — that's Wave 6

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: End-to-end integration of bank → match → prepayment/personal/FX → vouchers
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (last in Wave 5, depends on all other Wave 5 tasks)
  - **Parallel Group**: Wave 5 (with Tasks 21, 22, 23, 24, 25)
  - **Blocks**: Task 26 itself is the integration capstone
  - **Blocked By**: Tasks 21-25 (all reconciliation components)

  **References**:
  - ADR-0011: Full prepayment/on-account flow
  - ADR-0017: Personal disposition
  - ADR-0004: FX realized
  - All Wave 5 service implementations

  **Acceptance Criteria**:
  - [ ] End-to-end test passes: upload → match → prepayment + personal + FX → all vouchers posted
  - [ ] Bank account balance reflects all transactions
  - [ ] Tests pass: `reconciliation.e2e-spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Full reconciliation flow
    Tool: Bash (shell script + curl)
    Preconditions: App running, accounts seeded, AR and AP vouchers exist
    Steps:
      1. Upload statement with 4 transactions: matched incoming, unmatched incoming, unmatched outgoing, FX settlement
      2. Propose matches
      3. Execute matches
      4. Create prepayment for unmatched incoming
      5. Mark personal for unmatched outgoing
      6. Verify bank balance
    Expected Result: All vouchers posted, bank balance correct, no unmatched transactions left
    Failure Indicators: Unhandled transactions, balance mismatch, missing vouchers
    Evidence: .omo/evidence/task-26-full-reconciliation.txt
  ```

  **Evidence to Capture**:
  - [ ] Shell script output for full flow
  - [ ] SQLite query verifying all transactions are matched/personal/prepayment

  **Commit**: YES
  - Message: `feat(reconciliation): end-to-end reconciliation integration`
  - Files: `test/reconciliation.e2e-spec.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 32. Persist OCR source VAT code as evidence (cross-border enabler)

  > **Origin:** Wave-4 intake review. The OCR triage stub already extracts a `vat_code` into `TriageResult`, but `TriageService.route` drops it — the field never lands on the business object. ADR-0010 calls this the "candidate VAT code"; it is the code/rate **printed on the source document**, which for a cross-border invoice (e.g. a Danish supplier billed to an Estonian org) is a *foreign* code at a foreign rate — NOT the local accounting code. We need to preserve it as evidence so a country plugin can later resolve the local treatment (reverse-charge, foreign-VAT-cost) from it. This task only **persists** the candidate; it does NOT make it authoritative and does NOT implement reverse-charge.

  **What to do**:
  - Migration: add `source_vat_code (TEXT, nullable)` to `expense` and `sales_invoice` (schema only in migrations — G4). The OCR-extracted monetary facts (`gross_amount`, `vat_amount`) are already persisted; this adds the document's printed VAT-code label as captured evidence.
  - Thread `TriageResult.vat_code` through `TriageService.route` → `createExpense` / `createInvoice` → the new column. Store verbatim (no normalization).
  - Surface `source_vat_code` in `GET /api/expenses/:id` and `GET /api/sales-invoices/:id` responses.
  - The voucher line `vat_code` continues to come **solely** from `plugin.resolveCategoryMapping(...)` — unchanged. `source_vat_code` is read-only evidence.
  - Write tests proving the source code is stored AND that the posted voucher line still carries the plugin-resolved local code, not the source code.

  **Must NOT do**:
  - Do NOT feed `source_vat_code` into voucher-line resolution or semantic validation — the country plugin stays the sole resolver of the booking VAT code (ADR-0002 §8). Doing so would let a foreign printed code drive a domestic booking.
  - Do NOT implement reverse-charge / intra-community resolution here — that needs `supplier.country` (intrinsic fact, deferred to ADR-0014 supplier-identity) and a real (non-null) country plugin. This task is evidence capture only.
  - Do NOT reconstruct or store a rate as authoritative — `vat_amount`/net already carry the monetary truth; this is the printed-code label, kept for audit/triage review.
  - Do NOT add a canonical cross-country VAT vocabulary (`REVERSE_CHARGE_SERVICES`, …) — explicitly rejected by ADR-0002 §7.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: One nullable column on two tables + thread a field through triage; no new logic.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (independent of bank/matching tasks)
  - **Parallel Group**: Wave 5 (with Tasks 21–26)
  - **Blocks**: nothing in Wave 5; unblocks future reverse-charge work (real country plugin + ADR-0014 supplier identity)
  - **Blocked By**: Wave 4 (documents + triage + expense/sales-invoice modules)

  **References**:
  - ADR-0002 §7-8: the country plugin is the **sole resolver** of a VAT code from `(Supplier intrinsic facts + Organization country/registration)`; a Supplier never stores a VAT code; no abstract canonical VAT layer.
  - ADR-0010: triage produces a draft with a "candidate VAT code, confidence" — this persists that candidate.
  - ADR-0004: base-currency VAT converted at the prescribed reference rate (the local treatment, plugin-owned).
  - ADR-0014: supplier identity / `supplier.country` — the real cross-border carrier (future wave).
  - Wave-4 review finding: OCR `vat_code` captured but dropped; only `gross_amount`/`vat_amount` survive to the business object.

  **Acceptance Criteria**:
  - [ ] Migration adds `source_vat_code` (nullable) to `expense` and `sales_invoice`; grep clean for DDL outside `src/database/migrations/` (G4).
  - [ ] Triaging an odd document stores `source_vat_code = 'IE_INPUT_23'` on the Expense; even stores `'IE_OUTPUT_23'` on the SalesInvoice (matches the current OCR stub).
  - [ ] `GET /api/expenses/:id` returns `source_vat_code`.
  - [ ] Real-DI integration test (G2): after posting, the voucher line `vat_code` equals the **plugin-resolved** code (`IE_INPUT_23` for transport), proving `source_vat_code` did not leak into the booking.
  - [ ] Tests pass.

  **QA Scenarios**:

  ```
  Scenario: OCR source VAT code persisted as evidence, not used for booking
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. Upload a document (odd id), triage it
      2. `curl -s http://localhost:3000/api/expenses/{id}` → assert source_vat_code present
      3. Post the expense, fetch the voucher
    Expected Result: expense.source_vat_code = OCR value; voucher line vat_code = plugin-resolved local code (unchanged)
    Failure Indicators: source_vat_code null/missing; voucher line carries the source code instead of the plugin code
    Evidence: .omo/evidence/task-32-source-vat-code.json
  ```

  **Evidence to Capture**:
  - [ ] API response showing `source_vat_code` on the business object
  - [ ] Voucher detail showing the plugin-resolved line `vat_code`

  **Commit**: YES
  - Message: `feat(intake): persist OCR source VAT code as evidence`
  - Files: migration + `src/triage/`, `src/expenses/`, `src/sales-invoices/`
  - Pre-commit: `npm run build && npm test`

---

## Wave Acceptance Criteria
- [ ] All 7 tasks complete
- [ ] `docker compose up` starts and health responds 200
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with new tests
- [ ] Evidence files exist in `.omo/evidence/` for all tasks
- [ ] Git commit records Wave 5 changes

## Commit
- Message: `feat(reconciliation): bank + matching + prepayments + personal + FX + integration` — all Wave 5 files + tests
