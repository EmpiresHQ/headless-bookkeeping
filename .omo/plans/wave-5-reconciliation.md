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
  - `bank_transaction` table: id (INTEGER PK), statement_id (INTEGER FK), transaction_date (TEXT NOT NULL), description (TEXT), amount (INTEGER NOT NULL — cents in the **account** currency, positive credit / negative debit), currency (TEXT NOT NULL — account currency), source_currency (TEXT, nullable — the payment's original currency when the line was bank-converted, e.g. `USD`), source_amount (INTEGER, nullable — cents in `source_currency`), fx_rate (REAL, nullable — the bank's **actual** conversion rate), counterparty_iban (TEXT, nullable — present on SEPA transfers/DD, absent on card payments), counterparty_descriptor (TEXT, nullable — card merchant descriptor when no IBAN), reference (TEXT, nullable — parsed invoice number(s) / match key), status (TEXT — **disposition** enum: `open`, `prepayment`, `personal`, `bank_fee`, `dividend`; CHECK-constrained; minimal for now, expandable later. `dividend` is *reserved* here but wired in Wave-6 Task 37 — its draw-down needs a declared Dividend-payable), created_at (INTEGER)
  - **Foreign-leg capture (drives realized FX, Task 25):** parse `source_currency` + (`source_amount` and/or `fx_rate`) out of the statement-line description (free text, e.g. `"… 16.00 USD @ 1.08"`). Invariant: when `source_currency` is set and ≠ `currency`, at least one of `source_amount` / `fx_rate` must be present (the third is derived: `base × rate = foreign`). If **neither** is present → the transaction cannot be realized deterministically → it is flagged for **user feedback** (Approval / Action point), never stub-estimated (ADR-0004).
  - **No `matched_voucher_id`** (Q9 resolution): matching is N:M and lives in `reconciliation_match` (Task 22). Whether a transaction is unmatched / partially / fully matched is **derived** — `SUM(reconciliation_match.amount_matched) WHERE bank_transaction_id = ?` vs `|amount|` — never stored as a single-FK flag. `status` carries only the mutually-exclusive *disposition* (open / prepayment / personal / bank_fee), not match-state.
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
  - **Statement-line parse step:** extract structured tokens from the free-text `description`/`reference` — invoice number(s), counterparty IBAN, card merchant descriptor, FX foreign-leg (Task 21). Structured-token extraction is **deterministic** (not fuzzy).
  - `ReconciliationService` with `proposeMatches(statementId: number): MatchProposal[]` — signal hierarchy, strongest first:
    1. **Invoice number(s) in reference/description** → exact-match to the voucher(s). **Multiple numbers in one line → N:M split directly** (one transaction → several `reconciliation_match` rows). Strongest, deterministic.
    2. **Counterparty** — IBAN → Entity (deterministic, transfers); card merchant descriptor → Entity via a **learned alias** (transactional memory; first sight → user feedback teaches it). Used to filter/rank candidate AR/AP vouchers by counterparty; never name-fuzzy (ADR-0014).
    3. **Amount + date window (±7 days)** → baseline / confirmation, and the fallback when 1–2 are absent.
    - Incoming (amount > 0): candidate unpaid **AR** + **CustomerPrepayment** vouchers. Outgoing (amount < 0): candidate unpaid **AP** vouchers. Rank by the highest signal matched (invoice-no > counterparty+amount > amount+date).
  - `POST /api/bank-statements/:id/match` executes proposed matches
  - `reconciliation_match` table: id, bank_transaction_id, voucher_id, match_type (enum: exact, partial, prepayment), amount_matched (INTEGER), created_at
  - N:M matching: one transaction can match multiple vouchers, one voucher can match multiple transactions. **`reconciliation_match` is the single source of truth** for matching (Q9); there is no `matched_voucher_id` on the transaction.
  - Do NOT store a transaction match-flag — **derive** unmatched / partially_matched / fully_matched from `SUM(reconciliation_match.amount_matched)` vs `|amount|`. Only the *disposition* (`status`: open/prepayment/personal/bank_fee) is stored. (When an incoming transaction is dispositioned as a prepayment, set `status='prepayment'` — Task 23.)
  - Write tests for matching logic

  **Must NOT do**:
  - Do NOT use ML/AI for matching — deterministic rules only (amount + date + counterparty)
  - Do NOT auto-execute matches without explicit action — only propose, user/agent must confirm
  - Do NOT do **fuzzy** matching = approximate string similarity on free text / counterparty names (ADR-0014). **Structured-token extraction is allowed and is the primary signal**: parsing an invoice number or IBAN out of the description and *exact*-matching it is deterministic, not fuzzy. A card merchant descriptor maps to an Entity only via a *learned* alias (confirmed once via user feedback), never by name similarity.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: N:M join logic, partial matching, status updates
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 21, 23, 24, 25)
  - **Parallel Group**: Wave 5 (with Tasks 21, 23, 24, 25)
  - **Blocks**: Task 23 (prepayments use matching), Task 26 (integration)
  - **Blocked By**: Task 21 (needs bank transactions), Task 7 (needs vouchers), Task 12 (needs AR/AP vouchers), **Task 33 (Supplier/Entity — identity to match counterparties on, ADR-0014)**

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
  - Implement personal disposition per ADR-0017 — **the booking account is resolved by the country plugin, not hardcoded** (same boundary as VAT codes / cross-border, ADR-0002):
    - Migration: add `org_type` (TEXT NOT NULL, CHECK in (`company`,`sole_proprietor`), **default `company`** — v1 primary persona, ADR-0023) to `organization` (Wave-1 table; new column migration). Without it the plugin can't choose.
    - Add a `CountryPlugin` method `resolvePersonalDispositionAccount(orgType): accountCode`. Null/IE plugin: `sole_proprietor → OWNERS_DRAWINGS` (equity contra), `company → SHAREHOLDER_LOAN` (receivable-from-owner, asset). DK *kapitalejerlån* legal-restriction advisory deferred to a real plugin.
    - `POST /api/bank-transactions/:id/personal` — sets `status='personal'`, creates voucher `Dr {plugin-resolved account} / Cr BANK`.
    - `GET /api/bank-transactions/:id` shows disposition status.
  - Write tests: sole_proprietor → OWNERS_DRAWINGS, company → SHAREHOLDER_LOAN, both via the plugin (not a service constant).

  **Must NOT do**:
  - Do NOT hardcode the disposition account in `ReconciliationService` — it is a plugin decision keyed on `org_type` (+ country). v1 simplicity = the *default* `org_type` is `company`, NOT a hardcoded account.
  - Do NOT implement the DK kapitalejerlån tax-on-creation advisory here — that is a real-plugin concern (deferred).

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
  - Implement FX realized auto-posting per ADR-0004 — **computed from the bank line's ACTUAL settlement, not a reference/stub rate**:
    - On settling a foreign-currency receivable/payable, `realized = voucher.base_amount(settled portion) − bank_transaction.base_amount(actual)`, where the actual base is the EUR the bank moved (from `amount`, or derived from `source_amount` × `fx_rate` — Task 21 foreign-leg fields).
    - Create a **system-generated** voucher posting the difference to the single net **`FX_GAIN_LOSS`** account (ADR-0004 — NOT separate FX_GAIN/FX_LOSS) + adjust the bank/settlement side; balanced in base currency.
    - `FXRealizedService.computeAndPost(...)` — called by the matching engine when a foreign settlement is matched and the actual base ≠ booked base.
    - **No stub rate:** if the bank line lacks both `source_amount` and `fx_rate` (Task 21 invariant), realized FX cannot be computed → the settlement is flagged for **user feedback** (Approval / Action point), never estimated.
  - Write tests for FX realized posting (gain, loss, and the missing-data → user-feedback path).

  **Must NOT do**:
  - Do NOT implement unrealized FX revaluation — deferred to v1+ (ADR-0004).
  - Do NOT source the realized rate from a reference rate, Task-4 stub, or external API — realized FX uses the bank's **actual** settlement (ADR-0004); the plugin reference rate is for *booking* only.
  - Do NOT split into FX_GAIN / FX_LOSS — single net `FX_GAIN_LOSS` (ADR-0004).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: FX computation and voucher creation, deterministic calculation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 21, 22, 23, 24)
  - **Parallel Group**: Wave 5 (with Tasks 21, 22, 23, 24)
  - **Blocks**: Task 26 (integration tests FX flow)
  - **Blocked By**: Task 9 (posting service), Task 6 (needs the single `FX_GAIN_LOSS` account), Task 21 (bank transactions + foreign-leg fields), Task 22 (matching engine triggers FX)

  **References**:
  - ADR-0004: "Realized FX gain/loss is always computed in the kernel — posted automatically"
  - ADR-0004: "The base-currency VAT amount is converted at the prescribed reference rate"

  **Acceptance Criteria**:
  - [ ] FX realized computed when settling USD invoice from USD account at different rate
  - [ ] FX voucher lines balance to zero (e.g., Dr `FX_GAIN_LOSS` 100, Cr BANK 100; a net gain just makes the `FX_GAIN_LOSS` balance negative)
  - [ ] Tests pass: `fx-realized.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: FX realized auto-posted on settlement
    Tool: Bash (curl)
    Preconditions: USD invoice posted at rate 7.0, bank transaction at rate 7.14
    Steps:
      1. Match transaction to invoice
      2. Check for auto-created FX voucher
    Expected Result: FX voucher exists, lines: `FX_GAIN_LOSS` vs BANK, amount = booked base − actual settled base
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

- [ ] 32. Persist the Document VAT marking as evidence

  > **Origin:** Wave-4 intake review + cross-border grilling. The OCR triage stub extracts a `vat_code` into `TriageResult`, but `TriageService.route` drops it. That field is **not a VAT code** in our sense (a VAT code is plugin-owned, ours) — it is the **Document VAT marking**: the raw code/rate *printed on the counterparty's document*, which for a foreign supplier is a foreign label belonging to no plugin (see CONTEXT.md). Naming it `source_vat_code` was a trap. This task persists it as opaque evidence only; it does NOT make it authoritative and does NOT implement cross-border resolution (that is Task 33).

  **What to do**:
  - Migration: add `document_vat_marking (TEXT, nullable)` to `expense` and `sales_invoice` (schema only in migrations — G4). Monetary facts (`gross_amount`, `vat_amount`) are already persisted; this adds the printed marking as captured evidence.
  - Thread `TriageResult.vat_code` (rename the OCR field to `document_vat_marking` while here) through `TriageService.route` → `createExpense` / `createInvoice` → the new column. Store verbatim (no normalization).
  - Surface `document_vat_marking` in `GET /api/expenses/:id` and `GET /api/sales-invoices/:id`.
  - The voucher line `vat_code` continues to come **solely** from the country plugin — unchanged. The marking is read-only evidence.

  **Must NOT do**:
  - Do NOT feed `document_vat_marking` into voucher-line resolution or semantic validation — the plugin stays the sole resolver of the booking VAT code (ADR-0002). A foreign printed label must never drive a booking.
  - Do NOT reconstruct a rate as authoritative — `vat_amount`/net carry the monetary truth; this is the printed label, kept for audit/triage review and as a "was VAT charged?" hint.
  - Do NOT add a canonical cross-country VAT vocabulary — rejected by ADR-0002.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: One nullable column on two tables + rename/thread a field through triage; no new logic.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (independent of bank/matching tasks)
  - **Parallel Group**: Wave 5 (with Tasks 21–26)
  - **Blocks**: Task 33 (cross-border resolution reads the marking as a hint)
  - **Blocked By**: Wave 4 (documents + triage + expense/sales-invoice modules)

  **References**:
  - CONTEXT.md: **Document VAT marking** vs **VAT code** (distinct concepts; the marking is opaque evidence).
  - ADR-0002: country plugin is the sole resolver; no cross-country VAT vocabulary.

  **Acceptance Criteria**:
  - [ ] Migration adds `document_vat_marking` (nullable) to `expense` and `sales_invoice`; grep clean for DDL outside `src/database/migrations/` (G4).
  - [ ] Triaging stores the OCR marking on the business object; `GET /api/expenses/:id` returns it.
  - [ ] Real-DI integration test (G2): after posting, the voucher line `vat_code` equals the **plugin-resolved** code, proving the marking did not leak into the booking.
  - [ ] Tests pass.

  **Commit**: YES
  - Message: `feat(intake): persist Document VAT marking as evidence`
  - Files: migration + `src/triage/`, `src/expenses/`, `src/sales-invoices/`
  - Pre-commit: `npm run build && npm test`

- [ ] 33. Supplier / Entity aggregate + onboarding

  > **Origin:** Cross-border grilling — planning-gap finding. The **Supplier/Entity** aggregate is richly defined in CONTEXT.md and decided in ADR-0014, and is referenced by `expense.supplier_id`, by supplier memory, and by Wave-5 Task 22 (matching) — **but no wave ever builds it.** Verified: there is no `supplier`/`entity` table in any migration (001–012), no entry in `database/types.ts`, and no module/service. Worse, `expense.supplier_id` is a bare `integer` column (migration 006) — not even a declared FK, pointing at a non-existent table. Half of Wave 5 (matching, cross-border, memory) silently assumes this aggregate. This task builds it.

  **What to do**:
  - Migration: `entity` table per ADR-0014 — id (INTEGER PK), `role` (TEXT NOT NULL — CHECK in (`supplier`,`customer`)), `country` (TEXT NOT NULL — ISO), `name` (TEXT NOT NULL — legal/primary), `goods_vs_services` (TEXT — `goods`|`services`|`unknown`), `created_at`, `updated_at`.
  - **Typed identifiers as a child table** `entity_identifier` (id, entity_id FK, `kind` CHECK in (`registration_key`,`iban`,`merchant_descriptor`,`name_alias`), `value`, `confirmed` INTEGER) — NOT a single `registration_key` column, because counterparty keys are rail-dependent (grilling): `registration_key` (CVR/VAT) is strongest; `iban` is strong (SEPA transfers/DD — absent on card payments); `merchant_descriptor` is a **weak, learned** alias (card payments — bound to the entity only after a user confirms it once, then deterministic); `name_alias` is never an identity key, only a display/search aid. Matching (Task 22) resolves a bank line by the **strongest available** identifier. Classification-memory stays a separate child table (`entity_classification`). Identity is anchored on identifiers, never on raw name (ADR-0014).
  - Add the **real FK** `expense.supplier_id → entity.id` and `sales_invoice.customer_id → entity.id` (new migration; the existing columns are bare integers today). Keep nullable (drafts may precede identity).
  - `src/entities/` module: `EntityService` (create/onboard, find-by-registration-key, add-alias, list), `POST /api/entities` (onboard: role + country + registration key + name), `GET /api/entities`, `GET /api/entities/:id`.
  - Stores intrinsic, context-free facts only — **never a VAT code** (ADR-0002). `country` is the cross-border carrier (feeds Task 34).
  - Real-DI tests: onboarding, registration-key identity, alias resolution, FK linkage from expense/invoice.

  **Must NOT do**:
  - Do NOT anchor identity on name — registration key is the identity; names (legal + binavne + OCR variants) are aliases (ADR-0014).
  - Do NOT store a VAT code on the Entity — that depends on Organization context (ADR-0002).
  - Do NOT implement fuzzy/AI entity matching here — deterministic registration-key + alias lookup only (matching engine is Task 22).
  - Do NOT build classification-memory *scoring* — store the facts; weighing is an LLM-context concern (CONTEXT.md: classification memory is advisory, never a gate).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: New aggregate (schema + child tables + FKs + module) underpinning matching, memory, and cross-border.
  - **Skills**: []

  **Parallelization**:
  - **Schedule FIRST in Wave 5** — it has no Wave-5 blockers and underpins matching, cross-border, supplier memory, and the Policy known/unknown gate. Numbered 33 (added during grilling), but execute before Tasks 22/34/35.
  - **Can Run In Parallel**: only with Task 21 (bank schema, supplier-independent).
  - **Blocks**: Task 22 (identity to match on), Task 34 (needs `entity.country`), Task 35 (triage supplier resolution).
  - **Blocked By**: Task 1 (migration runner), Wave 3 (expense/sales-invoice tables to FK into).

  **References**:
  - ADR-0014: supplier memory & identity — registration-key anchor, aliases, classification memory.
  - ADR-0002: Entity stores intrinsic facts only, never a VAT code.
  - CONTEXT.md: **Entity**, **Supplier**, **Customer**.

  **Acceptance Criteria**:
  - [ ] Migration creates `entity` (+ `entity_alias`, `entity_classification`); `expense.supplier_id`/`sales_invoice.customer_id` become real FKs to `entity.id` (proven by a DB-constraint test — G6).
  - [ ] `POST /api/entities` onboards a supplier with `country`; find-by-registration-key returns it; an alias resolves to the same entity.
  - [ ] Real-DI test (G2): an Expense links to an onboarded supplier; `entity.country` is readable for downstream resolution.
  - [ ] Tests pass.

  **Commit**: YES
  - Message: `feat(entities): Supplier/Entity aggregate + onboarding (ADR-0014)`
  - Files: migrations + `src/entities/`
  - Pre-commit: `npm run build && npm test`

- [ ] 34. Cross-border VAT treatment resolution in the country plugin

  > **Origin:** Cross-border grilling. Today a foreign-supplier invoice is **silently mis-booked**: `NullCountryPlugin.resolveCategoryMapping` returns `IE_INPUT_23` regardless of supplier country, so a German invoice's VAT books as reclaimable Irish input VAT. The fix is NOT to read foreign codes — reverse-charge uses *our* code. The plugin must map the supplier's country to a **VAT territory** and decide the treatment. See ADR-0002 (amended) and CONTEXT.md **VAT territory**. **Prerequisite:** Task 33 (Supplier/Entity aggregate) — the supplier must carry a `country`.

  **What to do**:
  - Add a `CountryPlugin` method, e.g. `resolveCrossBorderTreatment(supplierFacts, orgContext, { vatCharged: boolean }): { treatment: 'domestic' | 'reverse_charge' | 'import' | 'foreign_cost' | 'unresolvable'; vatCode: VATCode | null }`. `supplierFacts.country` is already the input channel.
  - The plugin owns a **VAT-territory membership map** (EU VAT territory incl. enclave corrections like Canary Islands / Monaco, EAEU, third country) and the eligibility rule. Each plugin encodes its own jurisdiction's view (duplication of the EU list across EU plugins is acceptable).
  - Wire the draft generators (`expenses`/`sales-invoices`) to consult the treatment: `reverse_charge` → self-assess output+input VAT at *our* rate using our VAT code (supplier charged net); `import` → no input VAT on the supplier invoice (import VAT is a separate document); `foreign_cost` → book **gross as a cost**, no input VAT reclaimed; `domestic` → current behaviour; `unresolvable` → hold for **Approval** (ADR-0015), conservative default gross-as-cost.
  - `NullCountryPlugin`: implement conservatively — same-country → `domestic`; different country → `unresolvable` (hold), never silently reclaim.
  - Real-DI tests for each branch.

  **Must NOT do**:
  - Do NOT read or trust the `document_vat_marking` as the decision — it is at most a "was VAT charged?" hint; the decision is `supplier.country` + goods/services (ADR-0002).
  - Do NOT silently reclaim foreign VAT in any branch — `foreign_cost`/`unresolvable` never produce a `VAT_RECEIVABLE` line.
  - Do NOT put the territory map or eligibility rule in the kernel — it lives in the plugin (ADR-0002, amended).
  - Do NOT post import VAT from the supplier invoice — import VAT arrives via a separate customs document (out of scope here).

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: New plugin contract + branch wiring into both draft generators + correctness-critical VAT logic.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — depends on Task 32 (marking hint) and Task 33 (Supplier/Entity with `country`).
  - **Blocked By**: Task 32; Task 33 (Supplier/Entity aggregate).

  **References**:
  - ADR-0002 (amended): cross-border treatment is a plugin decision keyed on VAT-territory membership; foreign VAT never silently reclaimed; unresolvable → Approval.
  - ADR-0014: supplier identity / `supplier.country` — the real carrier.
  - ADR-0015: Approval lifecycle (the escape valve for `unresolvable`).
  - CONTEXT.md: **VAT territory**, **Document VAT marking**.

  **Acceptance Criteria**:
  - [ ] `NullCountryPlugin` returns `domestic` for same-country, `unresolvable` for foreign — proven by test.
  - [ ] A foreign-supplier expense never produces a `VAT_RECEIVABLE` line; it either holds for Approval or books gross-as-cost.
  - [ ] Reverse-charge branch self-assesses VAT with *our* VAT code, balanced — proven by a real-DI test (when a non-null test plugin is supplied).
  - [ ] Tests pass.

  **Commit**: YES
  - Message: `feat(plugins): cross-border VAT treatment via VAT-territory map`
  - Files: `src/plugins/`, `src/expenses/`, `src/sales-invoices/`, tests
  - Pre-commit: `npm run build && npm test`

- [ ] 35. Resolve the Supplier at intake (find / create-or-reuse), not at posting

  > **Origin:** Cross-border grilling. The Policy rule `unknown_supplier_requires_approval` is a **chicken-and-egg trap** if it gates at posting: we should *propose creating a Supplier*, not kill the voucher. Identity must be resolved **during intake**, so a posted voucher always carries a real `supplier_id`. The intake flow is: **(1) OCR → (2) Supplier check: lookup by registration key/alias; if found → reuse, else → propose create new (human-in-the-loop) → (3) create the business object WITH the resolved `supplier_id`.** Consequence: the Policy unknown-supplier gate becomes a **backstop that should never fire in the happy path** — defense-in-depth, not the primary mechanism.

  **What to do**:
  - Extend `TriageService.route`: after OCR, extract supplier hints (name + any registration key) and call `EntityService.findByRegistrationKey` / alias lookup (Task 33).
    - **Found** → reuse: set `supplier_id` on the created Expense/SalesInvoice.
    - **Not found** → return a triage outcome that **proposes supplier creation** (the human-in-the-loop / Action point — Telegram/Slack button or email confirmation, ADR-0016/CONTEXT.md), carrying the OCR-extracted candidate facts (name, country guess, registration key). On confirmation → `EntityService.onboard(...)` → link `supplier_id`. This is where the one-time "onboard supplier (incl. country)" happens.
  - The business object is created/finalized **with** `supplier_id` set → the pipeline never sees a null supplier in the happy path.
  - Wire the **backstop**: implement the currently-stubbed supplier check in `PolicyService` (`policy.service.ts:31` — "always pass") so `unknown_supplier_requires_approval` actually inspects `entity`. It should be **unreachable** in the normal flow (intake resolved it); if it ever fires, that signals an intake-bypass and correctly holds for Approval.
  - Real-DI tests: found→reuse; not-found→propose-create→onboard→link; posted voucher always has `supplier_id`; backstop holds only on a deliberately-bypassed intake.

  **Must NOT do**:
  - Do NOT gate the voucher at posting for an unknown supplier as the *primary* path — resolve at intake (propose-create). The Policy rule is only a backstop.
  - Do NOT auto-create a supplier silently from OCR — creation is a human-confirmed Action point (OCR facts are a proposal, not authority; CONTEXT.md classification memory is advisory).
  - Do NOT match on name alone — registration key / alias (ADR-0014).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Triage-flow change + human-in-the-loop create/reuse + Policy backstop wiring.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — depends on Task 33 (Entity registry + onboarding).
  - **Blocked By**: Task 33; Wave-4 triage.

  **References**:
  - ADR-0010 (amended): supplier identity is resolved at triage (find / create-or-reuse); Policy unknown-supplier is a backstop.
  - ADR-0014: registration-key identity, aliases.
  - ADR-0016: free-chat with Action-point commit (the create/reuse confirmation).
  - CONTEXT.md: **Action point**, **Approval**, **Entity**. DOMAIN-MODEL.md: intake flow.

  **Acceptance Criteria**:
  - [ ] Triaging a document whose supplier exists (by registration key/alias) links the existing `entity` — no new entity created.
  - [ ] Triaging an unknown supplier returns a propose-create outcome; on confirmation the entity is onboarded (with `country`) and linked.
  - [ ] A posted voucher in the happy path always has a non-null `supplier_id` (real-DI test).
  - [ ] The Policy backstop holds for Approval only when intake was bypassed (proven by a test); it does NOT fire in the normal flow.
  - [ ] Tests pass.

  **Commit**: YES
  - Message: `feat(triage): resolve supplier at intake (find/create-or-reuse); Policy backstop`
  - Files: `src/triage/`, `src/entities/`, `src/policy/`, tests
  - Pre-commit: `npm run build && npm test`

- [ ] 38. Remediate triage outcomes — purchase-side only (drop `sales_invoice`)

  > **Origin:** Cross-border grilling + Wave-4 review. Wave-4 shipped a triage outcome union `expense | invoice | unknown` and a stub routing even-id documents → **SalesInvoice**. That mis-models the domain (ADR-0010, amended): **intake is the purchase side** — an incoming document is an Expense, a correction, or a duplicate, never our own SalesInvoice (we issue those outbound). The union also omits ADR-0010's `correction`/`duplicate` outcomes. Self-billing (incoming = revenue) is deferred to v2 as a domain plugin (V2-ROADMAP), NOT this path.

  **What to do**:
  - Change `TriageOutcome` to `new_expense | correction | duplicate | unknown` (drop `invoice`; add `correction`, `duplicate`) — matches ADR-0010.
  - Fix the OCR stub (`ocr.service.ts`): both odd and even produce **purchase-side** documents (e.g. two different expense shapes, or one expense + one correction/duplicate scenario) — never a SalesInvoice.
  - Update `TriageService.route` to never create a SalesInvoice; wire `duplicate` (already-known hash → existing document) and a `correction` stub (links to original per ADR-0010) outcomes.
  - **Carry a real `tax_point_date` (Codex/Wave-6 review):** OCR must extract the **document/invoice date** (the tax point, a country-plugin rule, ADR-0009) and `TriageService` must use it for the business object's `tax_point_date` — NOT `doc.created_at` (arrival), which it does today. Period membership and the locked-period late-document redirect (Wave-6 Task 27) depend on the real tax point.
  - Update tests: `ocr.service.spec.ts`, `triage.integration.spec.ts`, and `test/intake.e2e-spec.ts` (scenario 3 "even → SalesInvoice" must become a purchase-side scenario).

  **Must NOT do**:
  - Do NOT route any incoming document to a SalesInvoice (sales invoices are outbound; self-billing is v2 — V2-ROADMAP).
  - Do NOT implement full correction logic here — `correction` outcome links to the original (stub), consistent with Wave-4 Task 18 scope.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Realign a discriminated union + stub + tests; no new subsystem.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (independent).
  - **Blocked By**: Wave-4 triage; benefits from Task 33 (Entity) for the `correction` link.

  **References**:
  - ADR-0010 (amended): intake = purchase side; outcomes `new_expense | correction | duplicate | unknown`; self-billing deferred to v2 domain plugin.
  - V2-ROADMAP.md: self-billing.

  **Acceptance Criteria**:
  - [ ] `TriageOutcome` has no `invoice`/`sales_invoice` member; has `correction` + `duplicate`.
  - [ ] No code path creates a SalesInvoice from an incoming document (grep clean).
  - [ ] OCR stub produces only purchase-side documents; tests updated and green.
  - [ ] `intake.e2e-spec.ts` scenario 3 reworked to a purchase-side flow.

  **Commit**: YES
  - Message: `fix(triage): purchase-side outcomes only; drop sales_invoice from intake`
  - Files: `src/triage/`, `test/intake.e2e-spec.ts`
  - Pre-commit: `npm run build && npm test`

---

## Wave Acceptance Criteria
- [ ] All 11 tasks complete
- [ ] `docker compose up` starts and health responds 200
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with new tests
- [ ] Evidence files exist in `.omo/evidence/` for all tasks
- [ ] Git commit records Wave 5 changes

## Commit
- Message: `feat(reconciliation): bank + matching + prepayments + personal + FX + integration` — all Wave 5 files + tests
