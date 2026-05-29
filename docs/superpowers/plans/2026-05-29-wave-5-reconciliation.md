# Wave 5 — Bank Reconciliation, Prepayments & Realized FX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest bank statements, deterministically match their transactions N:M against AR/AP vouchers, and book the leftovers as prepayments, personal disposition, or kernel-computed realized FX — all the way to a posted, balanced ledger.

**Architecture:** A new `src/bank/` module owns statement + transaction schema and upload/list endpoints; a new `src/reconciliation/` module owns the deterministic matching engine, prepayment/draw-down vouchers, personal-disposition vouchers, and realized-FX auto-posting, each calling the existing Wave 2 `PostingService` so every booking is a balanced, immutable Voucher. Realized FX is computed in the kernel via the existing `FXRateService` + `CurrencyService` (ADR-0004), and all schema lives exclusively in `src/database/migrations/` (G4). Base currency is always resolved through `CurrencyService` — never hardcoded — and the home bank account is `BANK_EUR`, with foreign accounts (e.g. `BANK_USD`) keeping their own currency.

**Tech Stack:** NestJS, Kysely, better-sqlite3, Jest, TypeScript

---

## Assumptions about prior-wave types (treated as implemented, do NOT re-build)

- **Wave 1**: `CurrencyService.getBaseCurrency(): Promise<string>` and `CurrencyService.convertToBase(amount, currency, rate): number`; `FXRateService.getRate(from, to): number`; `OrganizationService`; `PluginLoader` + `NullCountryPlugin`; the real-DI integration harness in `src/currency/currency.resolution.spec.ts` (the pattern to copy). `migrations` record exported from `src/database/migrations/index.ts`; `Database` interface in `src/database/types.ts`; `KYSELY_MODULE_CONNECTION_TOKEN()` from `nestjs-kysely`.
- **Wave 2**: `account` table seeded with canonical codes incl. `BANK_EUR`, `BANK_USD`, `AR`, `AP`, `CUSTOMER_PREPAYMENTS`, `SUPPLIER_PREPAYMENTS`, `OWNERS_DRAWINGS`, `FX_LOSS`, and an `FX_GAIN` revenue account; `AccountService.getAccountByCode(code): Promise<AccountRow>`. `voucher` + `voucher_line` tables; `PostingService.postVoucher(draft: DraftVoucher): Promise<PostedVoucher>` where `DraftVoucher = { voucher_number, tax_point_date, lines: DraftLine[] }` and `DraftLine = { account_code, amount, currency, base_amount, fx_rate, vat_code?, is_debit }`; `LedgerValidationService`; immutability enforced.
- **Wave 3**: `SalesInvoice` (AR voucher: Dr AR / Cr REVENUE / Cr VAT_PAYABLE) and `Expense` (AP-line variant) business objects with `voucher_id`, `gross_amount`, `currency`, `tax_point_date`, `status`. AR/AP outstanding is read from posted vouchers via the voucher's `corrects_object`/business-object link.

> If the canonical chart in Wave 2 lacks an `FX_GAIN` revenue account, Task 25 adds it via a **new migration** (never an ad-hoc CREATE/INSERT in a service — G4). `FX_LOSS` already exists per Wave 2.

## Types Wave 6 depends on (exported here, consumed later)

- `bank_statement` / `bank_transaction` tables and `BankTransaction.status` enum (`unmatched | matched | personal | bank_fee`) — Wave 6 period-lock checks read these.
- `reconciliation_match` table (`bank_transaction_id`, `voucher_id`, `match_type`, `amount_matched`) — the two-sided outstanding Wave 6 reporting reads.
- The realized-FX voucher shape (system-generated, `FX_GAIN`/`FX_LOSS` + `BANK_*`) — Wave 6 VAT/period snapshots include these vouchers.
- Wave 5 does **not** enforce period locking on any reconciliation booking (explicitly Wave 6 — see Task 26 "Must NOT do").

---

## File Structure

```
src/
  bank/
    bank.module.ts
    bank-statement.controller.ts
    bank-statement.service.ts
    bank-statement.types.ts
    bank-transaction.repository.ts
    bank-statement.service.spec.ts          # real-DI integration (G2)
    bank-statement.controller.spec.ts
  reconciliation/
    reconciliation.module.ts
    reconciliation.controller.ts
    reconciliation.service.ts               # N:M matching engine
    reconciliation.types.ts
    reconciliation-match.repository.ts
    prepayment.service.ts
    prepayment.controller.ts
    personal-disposition.service.ts
    personal-disposition.controller.ts
    fx-realized.service.ts
    fx-realized.controller.ts
    reconciliation.service.spec.ts          # real-DI integration (G2)
    prepayment.service.spec.ts              # real-DI integration (G2)
    personal-disposition.service.spec.ts    # real-DI integration (G2)
    fx-realized.service.spec.ts             # real-DI integration (G2)
  database/
    migrations/
      00X_create_bank_statement.ts          # Task 21
      00Y_create_reconciliation_match.ts    # Task 22
      00Z_add_fx_gain_account.ts            # Task 25 (only if FX_GAIN missing)
      index.ts                              # register each new migration (G4)
    types.ts                                # add table interfaces (G4)
  app.module.ts                             # import BankModule, ReconciliationModule
test/
  reconciliation.e2e-spec.ts               # Task 26 capstone
```

> **G4 reminder for every task:** schema changes touch ONLY `src/database/migrations/*.ts` + `src/database/migrations/index.ts` + `src/database/types.ts`. After each task run:
> `grep -rn "createTable\|CREATE TABLE\|alterTable\|ALTER TABLE" src --include=*.ts | grep -v "src/database/migrations/"` → must be empty.

---

## Task 21 — BankStatement + BankTransaction schema

Creates the `src/bank/` module: `bank_statement` and `bank_transaction` tables, upload (JSON), and list endpoints. JSON/CSV upload only — NO open-banking/PSD2, NO matching logic (Task 22), NO multi-format support.

**Files:**
- `src/database/migrations/00X_create_bank_statement.ts` (new)
- `src/database/migrations/index.ts` (register)
- `src/database/types.ts` (add `BankStatementTable`, `BankTransactionTable`)
- `src/bank/bank-statement.types.ts` (new)
- `src/bank/bank-transaction.repository.ts` (new)
- `src/bank/bank-statement.service.ts` (new)
- `src/bank/bank-statement.controller.ts` (new)
- `src/bank/bank.module.ts` (new)
- `src/bank/bank-statement.service.spec.ts` (new — real-DI integration, G2)
- `src/bank/bank-statement.controller.spec.ts` (new)
- `src/app.module.ts` (import `BankModule`)

**Steps:**

- [ ] Write the FULL failing migration test `src/bank/bank-statement.service.spec.ts` first (copy harness from `src/currency/currency.resolution.spec.ts`): boot in-memory SQLite, run `migrateToLatest`, assemble `AccountService`, `BankStatementService`, `BankTransactionRepository` against the real DB. Assert:
  - `createStatement({ account_code: 'BANK_EUR', start_date: '2024-01-01', end_date: '2024-01-31', transactions: [ { transaction_date: '2024-01-15', description: 'Payment from Customer A', amount: 12500, currency: 'EUR', reference: 'INV-001' }, { transaction_date: '2024-01-16', description: 'Bolt ride', amount: -1525, currency: 'EUR', reference: '' } ] })` returns a statement with an `id` and 2 created transactions.
  - `listTransactions(statementId)` returns exactly those 2 rows, with `amount` 12500 and -1525 preserved (signed cents) and `status === 'unmatched'`.
  - **G6 constraint test (raw write):** inserting a `bank_transaction` with `status = 'bogus'` is rejected by the DB (the migration adds a `CHECK (status IN ('unmatched','matched','personal','bank_fee'))`). Use a raw `db.insertInto('bank_transaction')...execute()` and `await expect(...).rejects.toThrow()`.
  - **G6 FK test:** inserting a `bank_statement` whose `account_id` does not exist is rejected (real FK to `account`). Note: enable `PRAGMA foreign_keys = ON` in the harness DB.
  - **G3 discriminating value:** assert the negative amount round-trips as `-1525` (not defaulted to 0/positive) and `currency` round-trips as a non-default value distinct from base by also creating one `USD` transaction and asserting `currency === 'USD'`.
- [ ] Run: `npm run test -- bank-statement.service` → expect **FAIL** (no migration, no service, no repository, no table).
- [ ] Write the FULL minimal migration `src/database/migrations/00X_create_bank_statement.ts` (mirror style of `001_create_organization.ts`):
  - `bank_statement`: `id INTEGER PRIMARY KEY`, `account_id INTEGER NOT NULL REFERENCES account(id)`, `start_date TEXT NOT NULL`, `end_date TEXT NOT NULL`, `uploaded_at INTEGER NOT NULL`, `file_path TEXT` (nullable).
  - `bank_transaction`: `id INTEGER PRIMARY KEY`, `statement_id INTEGER NOT NULL REFERENCES bank_statement(id)`, `transaction_date TEXT NOT NULL`, `description TEXT`, `amount INTEGER NOT NULL` (signed cents: + = incoming/credit, − = outgoing/debit), `currency TEXT NOT NULL`, `reference TEXT` (nullable), `matched_voucher_id INTEGER REFERENCES voucher(id)` (nullable), `status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','personal','bank_fee'))`, `created_at INTEGER NOT NULL`. Provide a `down()` dropping both tables.
- [ ] Register the migration in `src/database/migrations/index.ts` and add `BankStatementTable` + `BankTransactionTable` to `src/database/types.ts` (use `Generated<number>` for ids; `matched_voucher_id: number | null`; `file_path: string | null`; `reference: string | null`).
- [ ] Write the FULL minimal `bank-statement.types.ts` (`CreateStatementInput`, `BankStatementRecord`, `BankTransactionRecord`, `BankTransactionStatus` union), `bank-transaction.repository.ts` (`insertMany`, `findByStatementId`, `findById`, `updateStatus`), and `bank-statement.service.ts` (`createStatement` resolves `account_code` → `account_id` via `AccountService.getAccountByCode`, rejects a non-`BANK_*` account code with a `BadRequestException`, inserts statement + transactions in one Kysely transaction; `listStatements`; `listTransactions`).
- [ ] Run: `npm run test -- bank-statement.service` → expect **PASS**.
- [ ] Write the FULL minimal `bank-statement.controller.ts` (`POST /api/bank-statements`, `GET /api/bank-statements`, `GET /api/bank-statements/:id/transactions`) + `bank.module.ts`, and import `BankModule` in `src/app.module.ts`. Write `bank-statement.controller.spec.ts` asserting `POST` returns 201 with statement id + 2 transactions and `GET .../:id/transactions` returns the array.
- [ ] Run: `npm run test -- bank` → expect **PASS**.
- [ ] **G4 grep gate:** `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"` → empty.
- [ ] **G1 gate then commit:** `npm run build && npm run lint && npm run test && npm run test:e2e` all green, then commit `feat(bank): bank statement + transaction schema`.

---

## Task 22 — Matching engine (N:M deterministic)

Creates `src/reconciliation/` with the deterministic matching engine and the `reconciliation_match` table. Amount + date-window (±7 days) only. NO ML/AI, NO fuzzy description matching, NO auto-execution (propose then explicitly confirm).

**Files:**
- `src/database/migrations/00Y_create_reconciliation_match.ts` (new)
- `src/database/migrations/index.ts` (register)
- `src/database/types.ts` (add `ReconciliationMatchTable`)
- `src/reconciliation/reconciliation.types.ts` (new)
- `src/reconciliation/reconciliation-match.repository.ts` (new)
- `src/reconciliation/reconciliation.service.ts` (new)
- `src/reconciliation/reconciliation.controller.ts` (new)
- `src/reconciliation/reconciliation.module.ts` (new)
- `src/reconciliation/reconciliation.service.spec.ts` (new — real-DI integration, G2)
- `src/app.module.ts` (import `ReconciliationModule`)

**Steps:**

- [ ] Write the FULL failing test `src/reconciliation/reconciliation.service.spec.ts` (real-DI harness, in-memory SQLite, real migrations). Seed: post an AR voucher (Dr AR 12500 / Cr REVENUE 10000 / Cr VAT_PAYABLE 2500, `tax_point_date` 2024-01-10) via the real `PostingService`; create a `BANK_EUR` statement with an incoming transaction `amount: 12500, transaction_date: '2024-01-15'` and an outgoing transaction `amount: -7000, transaction_date: '2024-01-15'` plus a posted AP voucher of 7000. Assert:
  - `proposeMatches(statementId)` returns a `MatchProposal[]` containing one proposal linking the incoming transaction to the AR voucher with `match_type: 'exact'`, `amount_matched: 12500`, and the highest `confidence` (exact amount within window).
  - **G3 discriminating window:** an AR voucher dated 2024-01-01 (15 days before, outside ±7) for the same amount is **not** proposed, proving the date window is actually evaluated rather than amount-only.
  - The outgoing transaction proposes the AP voucher (`|amount|` match).
  - `executeMatches({ matches: [ { transaction_id, voucher_id, amount: 7000 }, { transaction_id, voucher_id: <second voucher>, amount: 5500 } ] })` for **one transaction → two vouchers** inserts two `reconciliation_match` rows and sets that transaction's `status` to `'matched'` (N:M proven).
  - **G6 constraint test:** inserting a `reconciliation_match` with `match_type = 'bogus'` is rejected by the DB `CHECK (match_type IN ('exact','partial','prepayment'))` (raw write, `rejects.toThrow`).
- [ ] Run: `npm run test -- reconciliation.service` → expect **FAIL**.
- [ ] Write migration `00Y_create_reconciliation_match.ts`: `reconciliation_match` → `id INTEGER PRIMARY KEY`, `bank_transaction_id INTEGER NOT NULL REFERENCES bank_transaction(id)`, `voucher_id INTEGER NOT NULL REFERENCES voucher(id)`, `match_type TEXT NOT NULL CHECK (match_type IN ('exact','partial','prepayment'))`, `amount_matched INTEGER NOT NULL`, `created_at INTEGER NOT NULL`. Register in `index.ts`; add `ReconciliationMatchTable` to `types.ts`.
- [ ] Write the FULL minimal `reconciliation.types.ts` (`MatchProposal`, `MatchType` union, `ExecuteMatchesInput`), `reconciliation-match.repository.ts` (`insert`, `findByTransactionId`, `findByVoucherId`), and `reconciliation.service.ts`:
  - `proposeMatches(statementId)`: for each `unmatched` incoming transaction (`amount > 0`), query posted AR vouchers (SalesInvoice-linked) + `CUSTOMER_PREPAYMENTS` vouchers whose base-currency amount equals the transaction amount and whose `tax_point_date` is within ±7 days of `transaction_date`; for each `unmatched` outgoing (`amount < 0`), query posted AP vouchers with `|amount|` match in window. Sort proposals by `confidence` descending (exact amount = 1.0). Date math: pure day-difference helper, no fuzzy logic.
  - `executeMatches(input)`: in one Kysely transaction, insert a `reconciliation_match` per requested `{ transaction_id, voucher_id, amount }`, then set each touched transaction's `status` to `'matched'` and its `matched_voucher_id` to the first matched voucher.
- [ ] Run: `npm run test -- reconciliation.service` → expect **PASS**.
- [ ] Write `reconciliation.controller.ts` (`POST /api/bank-statements/:id/propose-matches`, `POST /api/bank-statements/:id/match`) + `reconciliation.module.ts`; import in `app.module.ts`.
- [ ] Run: `npm run test -- reconciliation` → expect **PASS**.
- [ ] **G4 + G5 greps:** schema grep empty; `grep -rn "tensorflow\|openai\|fuzzy\|levenshtein\|ml-\|auto-execute\|autoExecute" src/reconciliation --include=*.ts` empty (no ML/fuzzy/auto-execute) → confirms Must-NOT-do.
- [ ] **G1 gate then commit:** `npm run build && npm run lint && npm run test && npm run test:e2e` green, then commit `feat(reconciliation): deterministic N:M matching engine`.

---

## Task 23 — Prepayment balances (liability/asset vouchers)

`PrepaymentService` books unmatched payments as prepayments per ADR-0011 and draws them down against invoices. Same-currency only in v1. NO advance-VAT (Art. 65 — country plugin), NO automatic draw-down on invoice posting, NO multi-currency prepayments.

**Files:**
- `src/reconciliation/prepayment.service.ts` (new)
- `src/reconciliation/prepayment.controller.ts` (new)
- `src/reconciliation/reconciliation.module.ts` (register provider/controller)
- `src/reconciliation/prepayment.service.spec.ts` (new — real-DI integration, G2)

**Steps:**

- [ ] Write the FULL failing test `src/reconciliation/prepayment.service.spec.ts` (real-DI harness, real `PostingService`, real `CurrencyService`/`AccountService`). Seed a `BANK_EUR` statement with an incoming `amount: 12500, currency: 'EUR'` unmatched transaction and an outgoing `amount: -8000, currency: 'EUR'` unmatched transaction. Assert:
  - `createCustomerPrepayment(transactionId)` posts a balanced voucher with lines **Dr BANK_EUR 12500 / Cr CUSTOMER_PREPAYMENTS 12500** (base currency resolved via `CurrencyService.getBaseCurrency()` → `'EUR'`, `fx_rate: 1`), and sets the transaction's `status`/`matched_voucher_id` to the new voucher. Assert the credited account code is exactly `CUSTOMER_PREPAYMENTS` (liability) — **not** `AR` (ADR-0011 discriminator).
  - `createSupplierPrepayment(transactionId)` posts **Dr SUPPLIER_PREPAYMENTS 8000 / Cr BANK_EUR 8000**.
  - `drawDownPrepayment(prepaymentVoucherId, invoiceVoucherId, 5000)` posts a clearing voucher (Dr CUSTOMER_PREPAYMENTS 5000 / Cr AR 5000) and a `reconciliation_match` row of `match_type: 'prepayment'`; the outstanding prepayment credit is reduced by 5000.
  - **G3 discriminating value:** assert each posted voucher's lines balance to zero via the real `LedgerValidationService`, and that the prepayment outstanding after draw-down is `12500 - 5000 = 7500` (a computed non-default, not the original 12500).
- [ ] Run: `npm run test -- prepayment.service` → expect **FAIL**.
- [ ] Write the FULL minimal `prepayment.service.ts`: build each `DraftVoucher` (resolve base currency via `CurrencyService`, `fx_rate: 1` for same-currency v1, `base_amount === amount`), call `PostingService.postVoucher`, update transaction status, and for draw-down also insert a `reconciliation_match` (`prepayment`). Add `getOutstandingPrepayments()` summing posted prepayment vouchers minus draw-downs.
- [ ] Run: `npm run test -- prepayment.service` → expect **PASS**.
- [ ] Write `prepayment.controller.ts` (`POST /api/bank-transactions/:id/prepayment`, `POST /api/prepayments/:id/draw-down`, `GET /api/prepayments`); register in `reconciliation.module.ts`.
- [ ] Run: `npm run test -- prepayment` → expect **PASS**.
- [ ] **G5 grep:** `grep -rni "art.\?65\|advance.\?vat\|auto.\?draw" src/reconciliation --include=*.ts` empty (no advance-VAT, no auto draw-down).
- [ ] **G1 gate then commit:** four commands green, then commit `feat(reconciliation): prepayment balances + draw-down`.

---

## Task 24 — Personal disposition

`PersonalDispositionService` books a flagged outgoing bank line as Owner's-drawings per ADR-0017. Default to `OWNERS_DRAWINGS` only — NO company-type (ApS vs sole proprietor) branching in v1.

**Files:**
- `src/reconciliation/personal-disposition.service.ts` (new)
- `src/reconciliation/personal-disposition.controller.ts` (new)
- `src/reconciliation/reconciliation.module.ts` (register)
- `src/reconciliation/personal-disposition.service.spec.ts` (new — real-DI integration, G2)

**Steps:**

- [ ] Write the FULL failing test `src/reconciliation/personal-disposition.service.spec.ts` (real-DI harness, real `PostingService`/`CurrencyService`). Seed a `BANK_EUR` statement with an outgoing `amount: -4200, currency: 'EUR'` unmatched transaction. Assert:
  - `markPersonal(transactionId)` posts a balanced voucher with lines **Dr OWNERS_DRAWINGS 4200 / Cr BANK_EUR 4200** (base currency via `CurrencyService`, `fx_rate: 1`), and sets the transaction `status` to `'personal'` with `matched_voucher_id` set.
  - **G3 discriminator:** assert the debited account is exactly `OWNERS_DRAWINGS` (equity contra) and the credit is `BANK_EUR`, and the voucher passes real `LedgerValidationService` (balances to zero). Use the non-default amount 4200 (≠ any other task's amount).
  - Re-running `markPersonal` on an already-`personal` transaction is rejected (`BadRequestException`) — proves idempotent guard, not silent double-post.
- [ ] Run: `npm run test -- personal-disposition.service` → expect **FAIL**.
- [ ] Write the FULL minimal `personal-disposition.service.ts`: load the transaction, guard against non-`unmatched` status, build `DraftVoucher` (Dr `OWNERS_DRAWINGS` / Cr `BANK_*` of the statement's account), `postVoucher`, update status to `'personal'`.
- [ ] Run: `npm run test -- personal-disposition.service` → expect **PASS**.
- [ ] Write `personal-disposition.controller.ts` (`POST /api/bank-transactions/:id/personal`, and `GET /api/bank-transactions/:id` returning disposition status); register in `reconciliation.module.ts`.
- [ ] Run: `npm run test -- personal-disposition` → expect **PASS**.
- [ ] **G5 grep:** `grep -rni "aps\|shareholder\|receivable.from.owner\|orgType\|org_type" src/reconciliation/personal-disposition.service.ts` empty (no company-type branching).
- [ ] **G1 gate then commit:** four commands green, then commit `feat(reconciliation): personal disposition`.

---

## Task 25 — FX realized auto-posting

`FXRealizedService` computes realized FX gain/loss **in the kernel** (ADR-0004) using the existing `FXRateService` + `CurrencyService`, and auto-posts a system-generated voucher when a foreign-currency invoice settles from a foreign account at a different rate. NO unrealized revaluation, NO external FX APIs (reuse the existing stub rate service).

**Files:**
- `src/database/migrations/00Z_add_fx_gain_account.ts` (new — only if `FX_GAIN` absent from Wave 2 chart)
- `src/database/migrations/index.ts` (register, if added)
- `src/reconciliation/fx-realized.service.ts` (new)
- `src/reconciliation/fx-realized.controller.ts` (new)
- `src/reconciliation/reconciliation.module.ts` (register)
- `src/reconciliation/fx-realized.service.spec.ts` (new — real-DI integration, G2)

**Steps:**

- [ ] Write the FULL failing test `src/reconciliation/fx-realized.service.spec.ts` (real-DI harness; real `PostingService`, `FXRateService`, `CurrencyService`, `AccountService`). Base currency resolves to `EUR`. Seed a USD SalesInvoice voucher booked at FX rate `r_invoice` (USD→EUR) and a `BANK_USD` transaction settling it at a different rate `r_settle`. Assert:
  - `computeAndPost({ invoiceVoucherId, bankTransactionId, foreignAmount, currency: 'USD', invoiceRate: r_invoice, settlementRate: r_settle })` computes the realized FX delta in **base currency** = `CurrencyService.convertToBase(foreignAmount, 'USD', r_settle) - CurrencyService.convertToBase(foreignAmount, 'USD', r_invoice)` (rounded to cents).
  - When `r_settle > r_invoice` (we received more base) → a **gain** voucher **Dr BANK_USD <delta> / Cr FX_GAIN <delta>**; when `r_settle < r_invoice` → a **loss** voucher **Dr FX_LOSS <delta> / Cr BANK_USD <delta>**. Cover both directions in two `it` blocks.
  - The FX voucher balances to zero via the real `LedgerValidationService`, and the `FX_GAIN`/`FX_LOSS` line's `base_amount` equals the computed delta (the load-bearing assertion).
  - **G3 discriminating value:** use rates where the delta is a clearly non-zero, non-default number (e.g. `foreignAmount` 100000 cents, `invoiceRate` and `settlementRate` differing in the 2nd decimal) and assert the exact computed delta — so a hardcoded 0 or echoed input cannot pass. When `r_settle === r_invoice`, assert **no** voucher is posted.
  - The amounts come from `FXRateService.getRate(...)` resolution path (not literals embedded in the service) — proving kernel computation per ADR-0004.
- [ ] Run: `npm run test -- fx-realized.service` → expect **FAIL**.
- [ ] If `FX_GAIN` is absent from the Wave 2 chart, write `00Z_add_fx_gain_account.ts` inserting an `FX_GAIN` account (type `revenue`, `is_system = true`) and register it in `index.ts`. (`FX_LOSS` already exists.) Do NOT create accounts in any service.
- [ ] Write the FULL minimal `fx-realized.service.ts`: compute base-currency delta via `CurrencyService.convertToBase` with rates from the inputs (sourced upstream from `FXRateService`), decide gain vs loss by sign, build the balanced `DraftVoucher` (foreign `currency`, `fx_rate = settlementRate`, `base_amount = delta`), short-circuit to no-op when delta is 0, and `postVoucher`. System-generated: no AI/business-object source.
- [ ] Run: `npm run test -- fx-realized.service` → expect **PASS**.
- [ ] Write `fx-realized.controller.ts` (`POST /api/reconciliation/fx-realized` for explicit invocation / inspection); register in `reconciliation.module.ts`.
- [ ] Run: `npm run test -- fx-realized` → expect **PASS**.
- [ ] **G5 grep:** `grep -rni "unrealized\|revaluation\|fetch(\|axios\|http" src/reconciliation/fx-realized.service.ts` empty (no unrealized, no external API).
- [ ] **G4 grep** empty; **G1 gate then commit:** four commands green, then commit `feat(reconciliation): FX realized auto-posting`.

---

## Task 26 — Reconciliation integration (end-to-end)

End-to-end wiring test of the whole reconciliation flow against the real DI graph. Wiring only — NO new business logic, NO real bank feeds, NO period-locking tests (Wave 6).

**Files:**
- `test/reconciliation.e2e-spec.ts` (new — boots the full Nest app + in-memory/real DB, copy the e2e style of `test/health.e2e-spec.ts` but with the full `AppModule` and migrated DB)

**Steps:**

- [ ] Write the FULL failing e2e test `test/reconciliation.e2e-spec.ts`: boot the full `AppModule`, run migrations, seed accounts (real seed), post an AR voucher and an AP voucher via the real endpoints/pipeline. Then drive over HTTP (supertest):
  1. `POST /api/bank-statements` with a `BANK_EUR` statement of 4 transactions: (a) matched incoming 12500 (matches AR), (b) unmatched incoming 9000, (c) unmatched outgoing -4200, (d) a `BANK_USD` FX settlement leg.
  2. `POST /api/bank-statements/:id/propose-matches` → proposals include the AR voucher for (a).
  3. `POST /api/bank-statements/:id/match` executes (a) (include a partial N:M split across two vouchers to exercise N:M).
  4. `POST /api/bank-transactions/:id/prepayment` for (b) → Dr BANK_EUR / Cr CUSTOMER_PREPAYMENTS.
  5. `POST /api/bank-transactions/:id/personal` for (c) → Dr OWNERS_DRAWINGS / Cr BANK_EUR.
  6. FX realized for (d) on the USD settlement.
  - Assert: every transaction ends `matched` / `personal` (none left `unmatched`); every booked voucher balances to zero; `GET /api/accounts/BANK_EUR` (or its balance endpoint) reflects the net of all EUR transactions. Resolve base currency via `CurrencyService` — never assert a hardcoded `'EUR'` literal as the *source of truth*; assert it equals `await currency.getBaseCurrency()`.
- [ ] Run: `npm run test:e2e -- reconciliation` → expect **FAIL** (flow not yet wired/asserted; if any earlier task left a gap, fix it in that task's module, not by adding logic here).
- [ ] Make the e2e pass by WIRING only: ensure `BankModule` + `ReconciliationModule` are imported in `AppModule`, controllers route correctly, and any missing balance-read endpoint already exists from Wave 2 (`GET /api/accounts/:code`). Add NO new business rules.
- [ ] Run: `npm run test:e2e -- reconciliation` → expect **PASS**.
- [ ] **G5 grep:** `grep -rni "period.lock\|locked\|psd2\|open.banking\|new business" test/reconciliation.e2e-spec.ts` confirms no period-lock / real-feed scope creep.
- [ ] **G1 gate then commit:** `npm run build && npm run lint && npm run test && npm run test:e2e` all green, then commit `feat(reconciliation): end-to-end reconciliation integration`.

---

## Wave-end verification (G8 — run before declaring Wave 5 done)

- [ ] **plan-compliance:** all six tasks' acceptance criteria met; every cross-module behavior (Task 21 statement creation, Task 22 matching, Task 23 prepayment, Task 24 personal, Task 25 FX, Task 26 e2e) has a real-DI integration test on in-memory SQLite (G2).
- [ ] **code-quality:** `npm run lint` clean (G1); no `as any` slop, no empty catches, no dead code.
- [ ] **scope-fidelity greps (must be clean):**
  - G4: `grep -rn "createTable\|CREATE TABLE\|alterTable\|ALTER TABLE" src --include=*.ts | grep -v "src/database/migrations/"` → empty.
  - G5 Must-NOT-do: no ML/fuzzy/auto-execute matching; no advance-VAT/auto-draw-down; no ApS/company-type branching in personal disposition; no unrealized FX/external FX API; no PSD2/open-banking; no period-lock logic (Wave 6).
  - Base-currency discipline: realized FX and all base amounts resolve through `CurrencyService` — no hardcoded base-currency literal as the source of truth.
- [ ] **G6:** DB constraints proven by tests — `bank_transaction.status` CHECK, `reconciliation_match.match_type` CHECK, and the `account_id`/`voucher_id` FKs each have a rejecting-write test.
- [ ] **G1 final:** `npm run build && npm run lint && npm run test && npm run test:e2e` all green, exactly as CI runs them.
