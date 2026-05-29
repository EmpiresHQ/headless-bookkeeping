# Wave 2: Ledger Primitives

## Overview
This wave builds the core double-entry ledger: the canonical chart of accounts, the Voucher and VoucherLine schema, the double-entry validation service, the atomic posting service, and immutability enforcement. This is the accounting kernel — everything after this depends on it.

> **Detailed implementation plan (bite-sized TDD):** [`docs/superpowers/plans/2026-05-29-wave-2-ledger.md`](../../docs/superpowers/plans/2026-05-29-wave-2-ledger.md) — the step-by-step "how". This file remains the "what / why" spec.

## Prerequisites
- **Wave 1 complete**: Migration runner, Organization singleton, CountryPlugin interface, Currency service, Health endpoint
- `docker compose up` starts successfully
- `npm run build` and `npm test` pass

## Definition of Done
- Canonical chart of accounts seeded in SQLite
- Voucher and VoucherLine tables created with all columns including `previous_hash`
- Double-entry validation rejects unbalanced vouchers
- Atomic posting service creates vouchers within SQLite transactions
- PUT/DELETE on posted vouchers returns 405
- Agent-executed QA scenarios pass with evidence captured
- Git commit records the wave
- **Wave gate — ALL green, exactly as CI runs them** (see `.omo/plans/engineering-guardrails.md`): `npm run build && npm run lint && npm run test && npm run test:e2e`
- **Real-DI integration test** for every cross-module behavior — no all-mock coverage (G2)
- **Schema only in migrations** — grep clean: no `createTable`/`CREATE TABLE` outside `src/database/migrations/` (G4)
- **"Must NOT do" greps clean**; stated DB invariants are real DB constraints proven by a test (G5/G6)
- **Per-wave verification pass** (plan-compliance + code-quality + scope-fidelity) before commit (G8)
- Base currency and example payloads use **EUR** (Ireland default), per ADR-0004 — never EUR

---

## TODOs

> **FORMAT**: Task labels MUST use bare numbers: `6.`, `7.`, `8.` — NOT `T6.`, `Task 6.`, etc.

- [x] 6. Account chart schema + canonical seed data

  **What to do**:
  - Create migration for `account` table: id (INTEGER PK), code (TEXT NOT NULL UNIQUE), name (TEXT NOT NULL), type (TEXT NOT NULL — enum: asset, liability, equity, revenue, expense), currency (TEXT, nullable — for foreign-currency accounts), parent_id (INTEGER FK to account, nullable), is_system (BOOLEAN DEFAULT false)
  - Seed canonical chart of accounts in migration or seed script:
    - Assets: CASH, BANK_EUR, BANK_USD, AR, SUPPLIER_PREPAYMENTS, RECEIVABLE_FROM_OWNER
    - Liabilities: AP, CUSTOMER_PREPAYMENTS, VAT_PAYABLE
    - Equity: EQUITY, OWNERS_DRAWINGS
    - Revenue: REVENUE
    - Expenses: EXPENSE_SOFTWARE, EXPENSE_TRANSPORT, EXPENSE_TRAVEL, EXPENSE_MARKETING, EXPENSE_SALARY, EXPENSE_CONTRACTOR, EXPENSE_RENT, EXPENSE_TAX, EXPENSE_BANK_FEE, EXPENSE_MEALS, EXPENSE_INSURANCE, EXPENSE_EDUCATION, EXPENSE_OTHER, FX_LOSS, BAD_DEBT_EXPENSE
    - (Note: VAT_RECEIVABLE is an asset — input VAT we reclaim; VAT_PAYABLE is liability — output VAT we owe)
  - Add `account` to Kysely Database interface
  - Create `AccountService` with `getAccounts()`, `getAccountByCode()`
  - Create `AccountController` with `GET /api/accounts`
  - Write tests for account seeding and retrieval

  **Must NOT do**:
  - Do NOT create country-specific accounts — only kernel-canonical accounts
  - Do NOT allow editing or deleting system accounts via API
  - Do NOT implement account hierarchy traversal (parent/child) beyond schema — tree queries deferred

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Schema + seed data, standard CRUD
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2 (with Tasks 7, 8, 9, 10)
  - **Blocks**: Task 9 (posting needs accounts), Task 11-12 (business objects need expense/revenue accounts)
  - **Blocked By**: Task 1 (migration runner)

  **References**:
  - ADR-0001: Hidden double-entry ledger — "kernel keeps a real double-entry ledger... chart of Accounts"
  - ADR-0002: Country-plugin boundary — "kernel owns a thin canonical chart of Accounts..."
  - `src/database/types.ts` — Pattern for adding tables to Database interface

  **Acceptance Criteria**:
  - [ ] Migration creates `account` table with correct columns
  - [ ] Seed inserts all canonical accounts (≥20 rows)
  - [ ] `GET /api/accounts` returns all accounts as JSON array
  - [ ] `GET /api/accounts/CASH` returns the Cash account
  - [ ] Tests pass: `account.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Canonical accounts are seeded
    Tool: Bash (node REPL)
    Preconditions: Fresh DB, migrations run
    Steps:
      1. `sqlite3 data/app.sqlite "SELECT code FROM account ORDER BY code;"`
    Expected Result: Output includes CASH, BANK_EUR, BANK_USD, AR, AP, EQUITY, REVENUE, EXPENSE_SOFTWARE, VAT_PAYABLE, etc.
    Failure Indicators: Missing accounts, wrong codes, no seed data
    Evidence: .omo/evidence/task-6-seeded-accounts.txt

  Scenario: List accounts via API
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s http://localhost:3000/api/accounts | jq '.accounts | length'`
    Expected Result: Number ≥ 20
    Failure Indicators: 404, empty array, wrong count
    Evidence: .omo/evidence/task-6-list-accounts.json
  ```

  **Evidence to Capture**:
  - [ ] SQLite query showing all seeded accounts
  - [ ] API response for GET /api/accounts

  **Commit**: YES
  - Message: `feat(ledger): canonical account chart schema + seed data`
  - Files: `src/ledger/account/`, database migration
  - Pre-commit: `npm run build && npm test`

- [ ] 7. Voucher + VoucherLine schema + repository

  **What to do**:
  - Create migration for `voucher` table: id (INTEGER PK), voucher_number (TEXT NOT NULL UNIQUE), tax_point_date (TEXT NOT NULL), posted_at (INTEGER, nullable — set on posting), previous_hash (TEXT, nullable — reserved for hash chain), reverses_id (INTEGER FK to voucher, nullable), corrects_object_type (TEXT, nullable), corrects_object_id (INTEGER, nullable), reason (TEXT, nullable)
  - Create migration for `voucher_line` table: id (INTEGER PK), voucher_id (INTEGER NOT NULL FK), account_id (INTEGER NOT NULL FK), amount (INTEGER NOT NULL — cents in original currency), currency (TEXT NOT NULL), base_amount (INTEGER NOT NULL — cents in base currency), fx_rate (REAL NOT NULL), vat_code (TEXT, nullable), is_debit (BOOLEAN NOT NULL)
  - Add `voucher`, `voucher_line` to Kysely Database interface
  - Create `VoucherRepository` with `createVoucher()`, `getVoucherById()`, `getVouchers()`
  - Create `VoucherLineRepository` with `createVoucherLine()`, `getLinesByVoucherId()`
  - Ensure `previous_hash` column exists (nullable) even though hash chain logic is deferred
  - Write tests for voucher and voucher line CRUD

  **Must NOT do**:
  - Do NOT implement hash chain logic — only reserve the column
  - Do NOT implement posting logic — that's Task 9
  - Do NOT implement reversal/correction flow — that's Task 18

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Schema definition + repository pattern, no complex business logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2 (with Tasks 6, 8, 9, 10)
  - **Blocks**: Task 8 (validation needs lines), Task 9 (posting needs voucher+lines), Task 10 (immutability needs voucher)
  - **Blocked By**: Task 1 (migration runner), Task 6 (lines need accounts)

  **References**:
  - ADR-0001: Voucher is "immutable, balanced accounting document... set of debit/credit lines"
  - ADR-0006: Voucher has "reverses" and "corrects_object" references
  - ADR-0013: "previous_hash column in SQLite" for hash chain
  - ADR-0004: VoucherLine carries "original amount + currency, base-currency amount, FX rate"
  - `src/database/types.ts` — Pattern for Kysely table interfaces

  **Acceptance Criteria**:
  - [ ] `voucher` table created with all columns including `previous_hash`
  - [ ] `voucher_line` table created with all columns
  - [ ] `VoucherRepository.createVoucher()` inserts a voucher row and returns it with id
  - [ ] `VoucherLineRepository.createVoucherLine()` inserts a line row linked to voucher
  - [ ] `GET /api/vouchers` returns list (empty initially)
  - [ ] Tests pass: `voucher.repository.spec.ts`, `voucher-line.repository.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Create voucher and lines
    Tool: Bash (curl)
    Preconditions: App running, accounts seeded
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"voucher_number":"V-2024-001","tax_point_date":"2024-01-15","lines":[{"account_code":"EXPENSE_SOFTWARE","amount":10000,"currency":"EUR","base_amount":10000,"fx_rate":1,"is_debit":true},{"account_code":"CASH","amount":10000,"currency":"EUR","base_amount":10000,"fx_rate":1,"is_debit":false}]}' http://localhost:3000/api/vouchers`
    Expected Result: 201 Created with voucher JSON including lines
    Failure Indicators: 400/500, missing lines, wrong amounts
    Evidence: .omo/evidence/task-7-create-voucher.json

  Scenario: previous_hash column exists
    Tool: Bash
    Preconditions: Fresh DB with migrations
    Steps:
      1. `sqlite3 data/app.sqlite ".schema voucher"`
    Expected Result: Schema includes `previous_hash` column
    Failure Indicators: Column missing
    Evidence: .omo/evidence/task-7-schema.txt
  ```

  **Evidence to Capture**:
  - [ ] API response for voucher creation
  - [ ] SQLite schema showing voucher and voucher_line tables

  **Commit**: YES
  - Message: `feat(ledger): voucher + voucher_line schema + repository`
  - Files: `src/ledger/voucher/`, database migration
  - Pre-commit: `npm run build && npm test`

- [ ] 8. Double-entry validation service

  **What to do**:
  - Create `LedgerValidationService` in `src/ledger/validation/`
  - Method `validateVoucherLines(lines: VoucherLine[]): ValidationResult`:
    - Sum of all debit amounts must equal sum of all credit amounts (in base currency)
    - Each line must reference an existing account (account_id exists in `account` table)
    - Amounts must be positive integers (cents)
    - Currency must not be empty
    - base_amount must equal amount * fx_rate (within rounding tolerance of 1 cent)
    - Return `{ isValid: boolean, errors: string[] }`
  - This is the **structural invariant** layer — pure arithmetic, no business rules
  - Write exhaustive tests: balanced voucher, unbalanced voucher, missing account, negative amount, FX mismatch

  **Must NOT do**:
  - Do NOT check period locking here — that's a hard process rule (Task 13)
  - Do NOT check VAT code applicability — that's a semantic rule (Task 13)
  - Do NOT post the voucher — only validation

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Core invariant logic, must be bulletproof; requires thorough testing
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 9, 10)
  - **Blocks**: Task 9 (posting service calls validation), Task 13 (Rules engine extends structural validation)
  - **Blocked By**: Task 7 (needs voucher line structure), Task 6 (needs accounts)

  **References**:
  - ADR-0001: "Voucher has two or more VoucherLines, which sum to zero"
  - ADR-0005: "structural invariants (kernel: voucher balances to zero, account exists, amounts numeric)"
  - ADR-0005: "structural invariants can never be overridden"

  **Acceptance Criteria**:
  - [ ] Balanced voucher (Dr 100, Cr 100) passes validation
  - [ ] Unbalanced voucher (Dr 100, Cr 99) fails with error "Voucher lines do not balance"
  - [ ] Line with non-existent account fails with error "Account does not exist"
  - [ ] Negative amount fails with error "Amount must be positive"
  - [ ] FX mismatch (amount=100, rate=7.14, base_amount=500) fails
  - [ ] Tests pass: `ledger-validation.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Balanced voucher passes validation
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. `node -e "const { LedgerValidationService } = require('./dist/ledger/validation/ledger-validation.service'); const v = new LedgerValidationService(); console.log(v.validateVoucherLines([{account_id:1,amount:10000,currency:'EUR',base_amount:10000,fx_rate:1,is_debit:true},{account_id:2,amount:10000,currency:'EUR',base_amount:10000,fx_rate:1,is_debit:false}]));"`
    Expected Result: { isValid: true, errors: [] }
    Failure Indicators: isValid: false, unexpected errors
    Evidence: .omo/evidence/task-8-balanced.txt

  Scenario: Unbalanced voucher fails validation
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. Similar to above but amounts differ (10000 vs 9999)
    Expected Result: { isValid: false, errors: ["Voucher lines do not balance"] }
    Failure Indicators: isValid: true, wrong error message
    Evidence: .omo/evidence/task-8-unbalanced.txt
  ```

  **Evidence to Capture**:
  - [ ] REPL output for all validation test cases
  - [ ] jest test coverage report

  **Commit**: YES
  - Message: `feat(ledger): double-entry validation service`
  - Files: `src/ledger/validation/`
  - Pre-commit: `npm run build && npm test`

- [ ] 9. Posting service (atomic voucher creation)

  **What to do**:
  - Create `PostingService` in `src/ledger/posting/`
  - Method `postVoucher(draft: DraftVoucher): PostedVoucher`:
    1. Validate lines using `LedgerValidationService`
    2. If invalid, throw `ValidationError` (do not post)
    3. If valid, insert voucher row with `posted_at = now()`
    4. Insert all voucher lines with `voucher_id`
    5. Return posted voucher with lines
  - All within a single SQLite transaction (better-sqlite3 supports transactions via Kysely)
  - `DraftVoucher` type: voucher_number, tax_point_date, lines[]
  - `PostedVoucher` type: includes id, posted_at, and lines with ids
  - `POST /api/vouchers` endpoint calls `PostingService.postVoucher()`
  - Write integration tests: valid post, invalid post (should rollback), concurrent posts

  **Must NOT do**:
  - Do NOT check period locking here — that's hard process rule (Task 13)
  - Do NOT check VAT code semantic rules here (Task 13)
  - Do NOT implement reversal/correction — that's Task 18
  - Do NOT set `previous_hash` — deferred to v1+

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Atomic transaction logic, critical for data integrity
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8, 10)
  - **Blocks**: Task 11-12 (business objects need posting), Task 13 (Rules engine calls posting)
  - **Blocked By**: Task 7 (needs voucher+line schema), Task 8 (needs validation)

  **References**:
  - ADR-0005: "Voucher posts (deterministic, atomic, immutable)"
  - ADR-0006: Business object → Voucher → immutable ledger entries
  - ADR-0012: No break-glass — "structural invariants can never be overridden"
  - better-sqlite3 docs for transactions via Kysely

  **Acceptance Criteria**:
  - [ ] Valid voucher posts successfully (201) with posted_at timestamp
  - [ ] Invalid voucher (unbalanced) returns 400, no DB changes (transaction rolled back)
  - [ ] Posted voucher lines are queryable via `GET /api/vouchers/:id`
  - [ ] Integration test proves atomicity (invalid post doesn't create partial records)
  - [ ] Tests pass: `posting.service.spec.ts`, `voucher.e2e-spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Post a valid voucher
    Tool: Bash (curl)
    Preconditions: App running, accounts seeded
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"voucher_number":"V-2024-002","tax_point_date":"2024-01-15","lines":[{"account_code":"EXPENSE_SOFTWARE","amount":10000,"currency":"EUR","base_amount":10000,"fx_rate":1,"is_debit":true},{"account_code":"CASH","amount":10000,"currency":"EUR","base_amount":10000,"fx_rate":1,"is_debit":false}]}' http://localhost:3000/api/vouchers`
    Expected Result: 201 with voucher JSON, posted_at is non-null
    Failure Indicators: 400/500, posted_at null, lines missing
    Evidence: .omo/evidence/task-9-post-valid.json

  Scenario: Invalid voucher is rejected atomically
    Tool: Bash (curl)
    Preconditions: App running, accounts seeded
    Steps:
      1. Post unbalanced voucher (debit 100, credit 99)
      2. Query DB: `sqlite3 data/app.sqlite "SELECT COUNT(*) FROM voucher WHERE voucher_number='V-2024-003';"`
    Expected Result: 400 error, DB count = 0 (no partial insert)
    Failure Indicators: 200 OK, count > 0 (partial insert leaked)
    Evidence: .omo/evidence/task-9-rejected-atomic.txt
  ```

  **Evidence to Capture**:
  - [ ] API responses for valid and invalid posts
  - [ ] SQLite query proving no partial inserts on failure
  - [ ] Integration test output

  **Commit**: YES
  - Message: `feat(ledger): atomic posting service`
  - Files: `src/ledger/posting/`
  - Pre-commit: `npm run build && npm test`

- [ ] 10. Immutability enforcement at API layer

  **What to do**:
  - Enforce that posted vouchers cannot be modified or deleted:
    - `PUT /api/vouchers/:id` → returns `405 Method Not Allowed`
    - `DELETE /api/vouchers/:id` → returns `405 Method Not Allowed`
    - `PATCH /api/vouchers/:id` → returns `405 Method Not Allowed`
  - `GET /api/vouchers/:id` remains allowed (read-only)
  - This is enforced at the controller/guard level, not the service level (service should also check)
  - Add `ImmutabilityGuard` or inline checks in `VoucherController`
  - Write tests proving all mutating HTTP methods are rejected for posted vouchers
  - Also test that GET succeeds for posted vouchers

  **Must NOT do**:
  - Do NOT implement reversal/correction endpoints here — those are separate (Task 18)
  - Do NOT allow editing draft vouchers (if drafts exist — they don't yet in Wave 2, but when they do, drafts can be edited)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Guard/controller logic, no complex business rules
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8, 9)
  - **Blocks**: Task 18 (corrections work within immutability — they create new vouchers, not edit)
  - **Blocked By**: Task 7 (needs voucher schema), Task 9 (needs posted voucher to test against)

  **References**:
  - ADR-0001: "Once posted it is never edited — only reversed by a counter-voucher"
  - ADR-0006: "Voucher history is never mutated"
  - ADR-0012: "If a structural rule is genuinely buggy, the fix is the code/plugin — never punching the bug's output permanently into the ledger"

  **Acceptance Criteria**:
  - [ ] `PUT /api/vouchers/1` returns 405 with message "Posted vouchers are immutable"
  - [ ] `DELETE /api/vouchers/1` returns 405
  - [ ] `GET /api/vouchers/1` returns 200 with voucher data
  - [ ] Tests pass: `voucher.controller.spec.ts` (immutability tests)

  **QA Scenarios**:

  ```
  Scenario: PUT on posted voucher is rejected
    Tool: Bash (curl)
    Preconditions: App running, voucher V-2024-002 posted in Task 9
    Steps:
      1. `curl -s -X PUT -w "%{http_code}" -o /dev/null http://localhost:3000/api/vouchers/1`
    Expected Result: HTTP code 405
    Failure Indicators: 200, 201, 404 (wrong behavior)
    Evidence: .omo/evidence/task-10-put-rejected.txt

  Scenario: GET on posted voucher succeeds
    Tool: Bash (curl)
    Preconditions: App running, voucher exists
    Steps:
      1. `curl -s -X GET -w "%{http_code}" http://localhost:3000/api/vouchers/1`
    Expected Result: HTTP code 200, JSON body with voucher data
    Failure Indicators: 405, 404, empty body
    Evidence: .omo/evidence/task-10-get-succeeds.json
  ```

  **Evidence to Capture**:
  - [ ] curl output showing 405 for PUT/DELETE
  - [ ] curl output showing 200 for GET

  **Commit**: YES
  - Message: `feat(ledger): immutability enforcement on posted vouchers`
  - Files: `src/ledger/voucher/voucher.controller.ts` (or guard)
  - Pre-commit: `npm run build && npm test`

---

## Wave Acceptance Criteria
- [ ] All 5 tasks complete
- [ ] `docker compose up` starts and health responds 200
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with new tests
- [ ] Evidence files exist in `.omo/evidence/` for all tasks
- [ ] Git commit records Wave 2 changes

## Commit
- Message: `feat(ledger): account chart + voucher + posting + immutability` — all Wave 2 files + tests
