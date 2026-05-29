# Wave 3: Posting Pipeline

## Overview
This wave implements the full business object → draft → Rules → Policy → posted Voucher flow. We build Expense and SalesInvoice business objects, the three-tier Rules engine (structural/hard/semantic), the Policy gate with Override logging, and wire everything together end-to-end. This is the core intelligence layer of the kernel.

> **This `.omo` file is the authoritative plan omo executes** — the "what / why" **and** the corrected model. The "Architecture corrections (AC-1…AC-11)" below override everything.
> A bite-sized "how" reference exists at [`docs/superpowers/plans/2026-05-29-wave-3-pipeline.md`](../../docs/superpowers/plans/2026-05-29-wave-3-pipeline.md), but it is **secondary**: it carries a reconciliation banner and its Tasks 14/15 detail is NOT fully reconciled — follow this file's AC-1…AC-11 wherever they differ.

## Prerequisites
- **Wave 2 complete + hardened**: Account chart, Voucher schema, Validation, Posting, Immutability — including the Wave-2 hardening pass (`.omo/plans/wave-2-hardening.md`: DB-level immutability triggers, per-line CHECKs, hash chain, single write path). Do NOT start Wave 3 until that gate is green.
- `docker compose up` starts successfully
- `npm run build` and `npm test` pass

## Definition of Done
- Expense and SalesInvoice can be created as drafts
- Draft vouchers are generated from business objects using CountryPlugin resolution
- Rules engine validates structural, hard, and semantic rules
- Policy gate auto-posts or holds for approval based on configurable thresholds
- Override logging captures human exceptions to semantic rules
- End-to-end pipeline works: create business object → generate draft → Rules → Policy → post
- Agent-executed QA scenarios pass with evidence captured
- Git commit records the wave
- **Wave gate — ALL green, exactly as CI runs them** (see `.omo/plans/engineering-guardrails.md`): `npm run build && npm run lint && npm run test && npm run test:e2e`
- **Real-DI integration test** for every cross-module behavior — no all-mock coverage (G2)
- **Schema only in migrations** — grep clean: no `createTable`/`CREATE TABLE` outside `src/database/migrations/` (G4)
- **"Must NOT do" greps clean**; stated DB invariants are real DB constraints proven by a test (G5/G6)
- **Per-wave verification pass** (plan-compliance + code-quality + scope-fidelity) before commit (G8)
- Base currency and example payloads use **EUR** (Ireland default), per ADR-0004 — never EUR

---

## Prologue — carried from the Wave-2 review (do first)

These are the non-load-bearing findings from the Wave-2 review, deferred here because they touch the HTTP/validation surface Wave 3 extends anyway. Knock them out before Task 11 so the pipeline builds on a clean controller layer.

- [ ] P1. **Error contract + Zod validation.** Add a global Zod-based `ValidationPipe` (e.g. `nestjs-zod` or a thin custom pipe) with a `DraftVoucher` Zod schema. Malformed/missing body → **400** (not the current `TypeError` → 500). Catch the `voucher_number` UNIQUE violation in the posting path → **409 Conflict**. (Use Zod, NOT class-validator.) Add e2e cases for both.
- [ ] P2. **Efficiency.** `PostingService` loads the whole chart per post → query only the draft's codes (`WHERE code IN (...)`). Insert lines in one batch instead of N sequential `INSERT...RETURNING`. Add an index on `voucher_line.voucher_id` (and `account_id`) — SQLite does not auto-index FKs; the append-only table will otherwise full-scan.
- [ ] P3. **Cosmetics.** Fix the `is_system` comment in `src/database/types.ts` (it wrongly says "1 = debit, 0 = credit"). Collapse the duplicated `mapRow` / `is_debit` 0-1 coercion into a shared helper now that the repos are read-only.
- [ ] P4. **Doc reconcile.** Annotate `.omo/notepads/wave-2-ledger/carry-forward.md` seam #2 as superseded by ADR-0004 (single net `FX_GAIN_LOSS`); annotate seam #5 as superseded by ADR-0020 (no unposted-voucher insert).
- [ ] P5. **CountryPlugin category mapping (seam #5).** Add `resolveCategoryMapping(category, supplierFacts, orgContext)` to the `CountryPlugin` interface and implement it in `NullCountryPlugin` with branches for **expense** categories (→ expense account + input-VAT code) **and `revenue`** (→ REVENUE + output-VAT code). Tasks 11/12 depend on this — it is not optional wiring. Real-DI test against the seeded chart.

---

## Architecture corrections (from the Wave-3 plan review — apply to every task below)

The plan as drafted contradicted several decisions. These corrections override the task bodies wherever they conflict:

- **AC-1 — A Voucher is minted only at posting (ADR-0020, ADR-0006, ADR-0015).** `generate-draft` returns a **transient, in-memory** draft Voucher (for preview + Rules input) — it is **never persisted**. A Policy-hold persists **no** voucher: the business object simply stays non-posted (`voucher_id` is `NULL` until posting). Only `PostingService.postVoucher` ever writes a voucher row, always already-posted + hash-chained. There is **no** "voucher_id set, posted_at=null" state.
- **AC-2 — Accrual basis + VAT split (ADR-0008, CONTEXT).** Expense draft lines are accrual, not cash: `Dr Expense (net) + Dr VAT_RECEIVABLE (input VAT) / Cr AP (gross)`. The later payment is a **separate** settlement voucher (not Wave 3). Never default to `Cr Cash`. Symmetric to the SalesInvoice split (`Dr AR / Cr Revenue / Cr VAT_PAYABLE`).
- **AC-3 — Rules structural tier delegates, never reimplements.** The structural tier calls the hardened `LedgerValidationService.validateVoucherLines(...)` — do not re-code balance/positivity/account-exists. One balance validator in the codebase.
- **AC-4 — Single account resolver (seam #4).** `account_code → {account_id, account_currency}` resolution lives in **one** place (extend `AccountService`/`PostingService`); both the Rules structural tier and posting consume **resolved** lines. `RulesService` does not re-resolve codes.
- **AC-5 — Rules reject; Policy only sorts Rules-valid (ADR-0005).** Structural/hard failures are rejected by **Rules**, before Policy. `PolicyDecision.action` is `'auto-post' | 'hold-for-approval'` only — no `'reject'`. The pipeline (Task 15) maps a Rules failure to a 4xx, never to a Policy decision.
- **AC-6 — Override is bound to the posting call (ADR-0005, ADR-0012).** No free-standing `POST /api/overrides` that can orphan. An Override is supplied **with** the submit/post of the specific voucher it excuses (semantic rule only), logged atomically with the post. `created_by` is a stubbed string until the auth model exists.
- **AC-7 — Draft lines must satisfy the hardened CHECKs (ADR-0004/0019).** Generated lines set `fx_rate=1, base_amount=amount` for EUR (the IE default); a foreign-currency line takes its rate from the plugin (Wave-3+) and must satisfy `fx_rate>0`, `base_amount>0`, and **account-currency-match** (a USD line cannot target a EUR-only account).
- **AC-8 — Real-DI integration tests (G2).** Rules (semantic), draft generation, and the pipeline are tested against the **real** seeded DB + `NullCountryPlugin` + real services — not `new RulesService()` with no deps. Stateless unit specs do not satisfy the wave gate.
- **AC-9 — Idempotent posting (ADR-0015).** `/post` must not double-post on retry (guard on business-object status + `voucher_number` UNIQUE → 409).
- **AC-10 — Migration numbering (seam #1).** `expense`=005, `sales_invoice`=006, `override`=007, `policy_config`=008. FKs to `voucher.id`/`account.id` are fine (those tables exist).
- **AC-11 — Terminology.** Structural invariant is "**debits equal credits in base currency**" (CONTEXT), not "balances to zero". `sales_invoice` send-state is a **separate field** from the posting lifecycle (don't fold `sent` into the `status` enum).

---

## TODOs

- [ ] 11. Expense business object + draft voucher generation

  **What to do**:
  - Create `src/expenses/` module with controller, service, types
  - `expense` table: id (INTEGER PK), document_id (INTEGER FK, nullable), supplier_id (INTEGER FK, nullable), category (TEXT NOT NULL), gross_amount (INTEGER NOT NULL), vat_amount (INTEGER NOT NULL), currency (TEXT NOT NULL), tax_point_date (TEXT NOT NULL), status (TEXT NOT NULL — enum: draft, pending, posted, reversed), voucher_id (INTEGER FK to voucher, nullable), created_at (INTEGER), updated_at (INTEGER)
  - `POST /api/expenses` creates an Expense in `draft` status
  - `POST /api/expenses/:id/generate-draft` returns a **TRANSIENT** draft Voucher (in-memory; **NOT persisted** — ADR-0020):
    - Uses `CountryPlugin.resolveCategoryMapping` to resolve category → expense account + **input**-VAT code
    - Creates VoucherLines (**accrual**, ADR-0008): `Dr Expense (net)` + `Dr VAT_RECEIVABLE (input VAT)` / `Cr AP (gross)`. **Never `Cr Cash`** (that is cash basis; payment is a separate settlement voucher, not Wave 3)
    - EUR: `fx_rate=1, base_amount=amount` — must satisfy the hardened CHECKs + account-currency match (AC-7)
    - Returns the draft for preview/Rules — **no DB write**
  - `GET /api/expenses` lists expenses
  - `GET /api/expenses/:id` returns expense with draft voucher if exists
  - Write tests for expense CRUD and draft generation

  **Must NOT do**:
  - Do NOT post the voucher automatically — only generate draft (posting is Policy-gated in Wave 3)
  - Do NOT **persist** the draft voucher — it is transient until posting (ADR-0020); `expense.voucher_id` stays NULL until posted
  - Do NOT credit Cash — accrual basis means `Cr AP`, and the VAT line (`Dr VAT_RECEIVABLE`) is never dropped
  - Do NOT implement supplier matching here — supplier_id is nullable for now
  - Do NOT implement document attachment — document_id is nullable

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Business object with draft generation, category resolution via plugin
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 12)
  - **Parallel Group**: Wave 3 (with Tasks 12, 13, 14, 15)
  - **Blocks**: Task 13 (Rules engine validates Expense drafts), Task 15 (integration needs Expense)
  - **Blocked By**: Task 6 (needs accounts), Task 7 (needs voucher schema), Task 3 (needs CountryPlugin)

  **References**:
  - ADR-0006: "Business objects are the source of fact; Voucher is their generated, immutable projection"
  - ADR-0006: "draft — no Voucher yet; the object is freely editable"
  - ADR-0020: a Voucher is minted only at posting — `generate-draft` is transient, not persisted
  - ADR-0008: accrual basis — recognize on bill received (`Dr Expense / Dr input VAT / Cr AP`); payment is separate
  - ADR-0002: "country plugin resolves category → account + vat_code"
  - `src/organization/` — Pattern for NestJS module structure

  **Acceptance Criteria**:
  - [ ] `POST /api/expenses` creates expense with status `draft`
  - [ ] `POST /api/expenses/1/generate-draft` returns a **transient** voucher, balanced, with accrual lines: `Dr EXPENSE (net)` + `Dr VAT_RECEIVABLE (input VAT)` / `Cr AP (gross)`
  - [ ] No voucher row is persisted by generate-draft (voucher table count unchanged)
  - [ ] Real-DI integration test (G2): draft generated against the seeded chart + real `NullCountryPlugin`
  - [ ] Tests pass: `expenses.controller.spec.ts`, `expenses.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Create expense and generate draft voucher
    Tool: Bash (curl)
    Preconditions: App running, accounts seeded, CountryPlugin loaded
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"category":"software","gross_amount":10000,"vat_amount":2500,"currency":"EUR","tax_point_date":"2024-01-15"}' http://localhost:3000/api/expenses`
      2. Extract id from response
      3. `curl -s -X POST http://localhost:3000/api/expenses/{id}/generate-draft`
    Expected Result: Step 1 → 201 with status=draft; Step 3 → 200 with TRANSIENT voucher JSON, lines: Dr EXPENSE_SOFTWARE 7500 + Dr VAT_RECEIVABLE 2500 / Cr AP 10000 (balanced); voucher table count unchanged (nothing persisted)
    Failure Indicators: Cr CASH instead of Cr AP, missing VAT_RECEIVABLE line, a persisted voucher row, posted_at set
    Evidence: .omo/evidence/task-11-expense-draft.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for expense creation and draft generation
  - [ ] Test output

  **Commit**: YES
  - Message: `feat(expenses): expense business object + draft voucher generation`
  - Files: `src/expenses/`
  - Pre-commit: `npm run build && npm test`

- [ ] 12. SalesInvoice business object + draft voucher generation

  **What to do**:
  - Create `src/sales-invoices/` module with controller, service, types
  - `sales_invoice` table: id (INTEGER PK), customer_id (INTEGER FK, nullable), invoice_number (TEXT NOT NULL UNIQUE), gross_amount (INTEGER NOT NULL), vat_amount (INTEGER NOT NULL), currency (TEXT NOT NULL), tax_point_date (TEXT NOT NULL), due_date (TEXT, nullable), status (TEXT NOT NULL — **posting lifecycle**: draft, pending, posted, reversed), sent_at (INTEGER, nullable — **send-state, separate from posting**, AC-11), voucher_id (INTEGER FK, nullable — set only at posting, ADR-0020), created_at (INTEGER), updated_at (INTEGER)
  - `POST /api/sales-invoices` creates a SalesInvoice in `draft` status
  - `POST /api/sales-invoices/:id/generate-draft` returns a **TRANSIENT** draft Voucher (not persisted — ADR-0020):
    - `Dr AR (gross)`, `Cr Revenue (net)`, `Cr VAT_PAYABLE (output VAT)`
    - Uses `CountryPlugin.resolveCategoryMapping('revenue', …)` for the output-VAT code
    - EUR: `fx_rate=1, base_amount=amount` (AC-7)
  - `POST /api/sales-invoices/:id/send` sets `sent_at` (send-state is separate from the posting `status` — AC-11; no real email)
  - `GET /api/sales-invoices` lists invoices
  - Write tests for CRUD, draft generation, and send action

  **Must NOT do**:
  - Do NOT post voucher automatically — only draft generation
  - Do NOT send real emails — status change only
  - Do NOT implement customer matching — customer_id nullable

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Business object with AR/Revenue/VAT split, similar to Expense but different accounts
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 11)
  - **Parallel Group**: Wave 3 (with Tasks 11, 13, 14, 15)
  - **Blocks**: Task 13 (Rules validates SalesInvoice drafts), Task 15 (integration)
  - **Blocked By**: Task 6 (accounts), Task 7 (voucher schema), Task 3 (CountryPlugin)

  **References**:
  - ADR-0006: SalesInvoice is a business object; generates Voucher on posting
  - ADR-0008: "Issuing a SalesInvoice immediately posts Dr AR / Cr Revenue / Cr output VAT"
  - ADR-0002: Country plugin resolves VAT code for revenue

  **Acceptance Criteria**:
  - [ ] `POST /api/sales-invoices` creates invoice with status `draft`
  - [ ] `POST /api/sales-invoices/1/generate-draft` returns a **transient** voucher (not persisted): Dr AR (gross), Cr REVENUE (net), Cr VAT_PAYABLE (VAT); balanced
  - [ ] `POST /api/sales-invoices/1/send` sets `sent_at` (posting `status` unchanged)
  - [ ] Real-DI integration test (G2) against seeded chart + `NullCountryPlugin`
  - [ ] Tests pass: `sales-invoices.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Create sales invoice and generate draft
    Tool: Bash (curl)
    Preconditions: App running, accounts seeded
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"invoice_number":"INV-2024-001","gross_amount":12500,"vat_amount":2500,"currency":"EUR","tax_point_date":"2024-01-15","due_date":"2024-02-15"}' http://localhost:3000/api/sales-invoices`
      2. `curl -s -X POST http://localhost:3000/api/sales-invoices/1/generate-draft`
    Expected Result: Step 2 → voucher with 3 lines: Dr AR 12500, Cr REVENUE 10000, Cr VAT_PAYABLE 2500
    Failure Indicators: Wrong line count, wrong accounts, amounts don't balance
    Evidence: .omo/evidence/task-12-sales-invoice-draft.json
  ```

  **Evidence to Capture**:
  - [ ] API response for draft generation showing correct lines
  - [ ] Test output

  **Commit**: YES
  - Message: `feat(sales-invoices): sales invoice business object + draft generation`
  - Files: `src/sales-invoices/`
  - Pre-commit: `npm run build && npm test`

- [ ] 13. Rules engine (structural, hard, semantic)

  **What to do**:
  - Create `src/rules/` module with service, types, guards
  - Implement three rule categories:
    1. **Structural rules** (inviolable) — **delegate to the hardened `LedgerValidationService.validateVoucherLines`** (AC-3), do NOT re-code: debits equal credits in base currency, account exists, `amount`/`base_amount`/`fx_rate` positive, line currency matches account. Codes are resolved to `{account_id, account_currency}` by the single resolver (AC-4) before this tier runs
    2. **Hard process rules** (inviolable): period containing tax_point_date is not locked (stub for now — period locking in Wave 6)
    3. **Semantic rules** (overridable via Override): VAT code is valid per CountryPlugin, category mapping exists, deductibility rules (stub)
  - `RulesService.validate(resolvedLines, validAccountIds, type: 'structural' | 'hard' | 'semantic'): RuleResult` — operates on **resolved** lines (codes already mapped to `{account_id, account_currency}` by the single resolver, AC-4); the structural tier **delegates** to `LedgerValidationService` (AC-3). Rules never re-resolves codes.
  - `RuleResult`: `{ passed: boolean, ruleType: string, message: string, overrideable: boolean }`
  - Structural and hard rules: `overrideable: false` — always reject if failed
  - Semantic rules: `overrideable: true` — can be logged Override with reason
  - Write tests for all three rule types, including overrideable vs non-overrideable behavior

  **Must NOT do**:
  - Do NOT allow overriding structural rules (enforce at code level)
  - Do NOT reimplement the balance/positivity check — delegate to `LedgerValidationService` (AC-3)
  - Do NOT test only with `new RulesService()` and no DB — semantic rules need a real-DI test against the seeded chart + `NullCountryPlugin` (AC-8)
  - Do NOT implement full period lock check — stub it (always pass until Wave 6)
  - Do NOT implement real deductibility logic — CountryPlugin stub returns safe defaults

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Core validation logic, three-tier rule system, must be bulletproof
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 11, 12, 14, 15)
  - **Parallel Group**: Wave 3 (with Tasks 11, 12, 14, 15)
  - **Blocks**: Task 14 (Policy gate calls Rules), Task 15 (integration uses Rules)
  - **Blocked By**: Task 8 (structural validation already exists — extend it), Task 3 (CountryPlugin for semantic rules), Task 9 (posting service calls Rules)

  **References**:
  - ADR-0005: "Three sorts: structural invariants, hard process rules, semantic rules"
  - ADR-0005: "A human may override a semantic rule... Structural invariants can never be overridden"
  - ADR-0012: "No break-glass... the only escape valve is the logged semantic Override"
  - `src/ledger/validation/` — Extend existing LedgerValidationService

  **Acceptance Criteria**:
  - [ ] Structural rule failure (unbalanced) → `passed: false, overrideable: false`
  - [ ] Hard rule failure (period locked stub) → `passed: false, overrideable: false`
  - [ ] Semantic rule failure (invalid VAT code) → `passed: false, overrideable: true`
  - [ ] Semantic rule + Override with reason → `passed: true`
  - [ ] Structural rule + Override attempt → still `passed: false`
  - [ ] Tests pass: `rules.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Structural rule cannot be overridden (real-DI — AC-8)
    Tool: Bash (jest)
    Preconditions: Build passes; rules.service.spec.ts implemented with real DI (seeded chart + LedgerValidationService delegation, AC-3). NOTE: do NOT `new RulesService()` — it injects the validator + resolver.
    Steps:
      1. `npx jest src/rules/rules.service.spec.ts -t "structural" --no-cache | tail -20`
    Expected Result: an unbalanced draft (lines addressed by account_code, resolved via AC-4) → passed:false, overrideable:false; an Override attempt on it stays passed:false
    Failure Indicators: overrideable:true on a structural rule, or an override flipping it to passed:true
    Evidence: .omo/evidence/task-13-structural.txt

  Scenario: Semantic rule can be overridden (real-DI)
    Tool: Bash (jest)
    Preconditions: Build passes; rules.service.spec.ts implemented (real DI + NullCountryPlugin)
    Steps:
      1. `npx jest src/rules/rules.service.spec.ts -t "semantic" --no-cache | tail -20`
    Expected Result: invalid VAT code → passed:false, overrideable:true; same draft with a logged Override reason → passed:true
    Failure Indicators: override ignored, or overrideable:false on a semantic rule
    Evidence: .omo/evidence/task-13-semantic-override.txt
  ```

  **Evidence to Capture**:
  - [ ] REPL output for all rule type tests
  - [ ] Test coverage report

  **Commit**: YES
  - Message: `feat(rules): three-tier Rules engine (structural/hard/semantic)`
  - Files: `src/rules/`
  - Pre-commit: `npm run build && npm test`

- [ ] 14. Policy gate + Override logging

  **What to do**:
  - Create `src/policy/` module
  - `PolicyService.decide(voucher: DraftVoucher, ruleResults: RuleResult[]): PolicyDecision`
  - Decision: `{ action: 'auto-post' | 'hold-for-approval', reason: string }`
  - Configuration (stored in `policy_config` table or hardcoded for v1):
    - `auto_post_amount_ceiling`: 100000 (cents = 1000 EUR) — above this, hold for approval
    - `auto_post_min_confidence`: 0.8 (stub — AI confidence not implemented yet, always 1.0)
    - `unknown_supplier_requires_approval`: true
    - `always_approve_operations`: ['correction', 'reversal', 'vat_lock'] (stub list)
  - For Wave 3: Policy defaults to `auto-post` for everything except structural/hard rule failures
  - `override` table: id, business_object_type, business_object_id, rule_type, rule_name, reason, created_by (stub string until auth exists), created_at
  - Override is supplied **with** the submit/post call (semantic rule only) and logged **atomically with the post** (AC-6) — NOT via a free-standing endpoint that could orphan
  - `GET /api/overrides` may list overrides for audit (read-only)
  - Write tests for Policy decisions and Override logging

  **Must NOT do**:
  - Do NOT implement real approval workflow yet — Policy just decides auto-post vs hold; actual approval lifecycle in Wave 6
  - Do NOT add `'reject'` to `PolicyDecision` — Rules rejects structural/hard failures before Policy is consulted (AC-5)
  - Do NOT expose a free-standing override-logging endpoint decoupled from posting (AC-6)
  - Do NOT allow override of structural/hard rules (enforce in code)
  - Do NOT implement AI confidence scoring — stub with 1.0

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Risk gate logic, configurable thresholds, audit trail
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 11, 12, 13, 15)
  - **Parallel Group**: Wave 3 (with Tasks 11, 12, 13, 15)
  - **Blocks**: Task 15 (integration uses Policy), Task 29 (Approval lifecycle depends on Policy decisions)
  - **Blocked By**: Task 13 (Rules engine provides rule results)

  **References**:
  - ADR-0005: "Policy decides (configurable risk gate) — auto-post vs require human approval"
  - ADR-0005: "Confidence is an input to Policy, never to Rules"
  - ADR-0012: "Override is an explicit, logged, human-authored exception to a semantic Rule"
  - ADR-0015: Approval lifecycle — but deferred to Wave 6

  **Acceptance Criteria**:
  - [ ] Voucher under amount ceiling + all rules pass → `action: 'auto-post'`
  - [ ] Voucher over amount ceiling → `action: 'hold-for-approval'`
  - [ ] Structural/hard failure is rejected by **Rules** (4xx) — Policy is never consulted; `PolicyDecision` has no `'reject'` (AC-5)
  - [ ] Semantic rule failure + Override (supplied with the post) → `action: 'auto-post'`, override logged atomically
  - [ ] Override record is created in the `override` table with reason, bound to the business object
  - [ ] Tests pass: `policy.service.spec.ts`, `override.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Small expense auto-posts
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. Create voucher with amount 50000 (below 100000 ceiling)
      2. Call PolicyService.decide()
    Expected Result: action: 'auto-post'
    Failure Indicators: 'hold-for-approval'
    Evidence: .omo/evidence/task-14-auto-post.txt

  Scenario: Large expense held for approval
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. Create voucher with amount 150000 (above ceiling)
      2. Call PolicyService.decide()
    Expected Result: action: 'hold-for-approval', reason mentions amount
    Failure Indicators: 'auto-post'
    Evidence: .omo/evidence/task-14-hold-approval.txt
  ```

  **Evidence to Capture**:
  - [ ] REPL output for Policy decisions
  - [ ] SQLite query showing override records

  **Commit**: YES
  - Message: `feat(policy): Policy gate + Override logging`
  - Files: `src/policy/`
  - Pre-commit: `npm run build && npm test`

- [ ] 15. Pipeline integration (end-to-end flow)

  **What to do**:
  - Create an integration test or endpoint that exercises the full pipeline:
    1. Create Expense (business object)
    2. Generate draft Voucher
    3. Run Rules validation (structural + hard + semantic)
    4. Run Policy gate
    5. If auto-post: `PostingService.postVoucher` mints the voucher (atomic, immutable, hash-chained); idempotent on retry (AC-9)
    6. If hold: object → `pending` (awaiting approval); **NO voucher persisted**, `voucher_id` stays NULL (ADR-0020)
    7. Return final state
  - `POST /api/expenses/:id/post` — full pipeline endpoint
  - `POST /api/sales-invoices/:id/post` — same for invoices
  - This task is about wiring the pieces together, not new logic
  - Write end-to-end tests: happy path (auto-post), policy-hold path, rule-rejection path

  **Must NOT do**:
  - Do NOT add new business logic — only wire existing services
  - Do NOT persist a voucher for a held item — hold sets object state only, voucher_id stays NULL (ADR-0020)
  - Do NOT double-post on a retried `/post` — guard on object status + `voucher_number` UNIQUE → 409 (AC-9)
  - Do NOT implement approval UI/workflow — Policy hold just sets state, Wave 6 handles lifecycle
  - Do NOT implement real AI/OCR — business objects created manually or via API

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Integration of multiple services, end-to-end flow verification
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (last in Wave 3, depends on all other Wave 3 tasks)
  - **Parallel Group**: Wave 3 (with Tasks 11, 12, 13, 14)
  - **Blocks**: Task 16-20 (intake needs posting pipeline), Task 22-26 (reconciliation needs posted vouchers)
  - **Blocked By**: Tasks 11, 12, 13, 14 (all pipeline components)

  **References**:
  - ADR-0005: "AI suggests → Rules validate → Policy decides → Voucher posts"
  - ADR-0006: "One source of truth for the fact (business object), one for the accounting (Voucher)"
  - All Wave 2 and Wave 3 service implementations

  **Acceptance Criteria**:
  - [ ] `POST /api/expenses/1/post` with small amount → expense.status = posted, voucher minted with posted_at + previous_hash set
  - [ ] `POST /api/expenses/2/post` with large amount → expense.status = pending; **no voucher row persisted** (voucher_id NULL)
  - [ ] `POST /api/expenses/3/post` with unbalanced lines → 400 (rejected by Rules), expense.status remains draft, no voucher
  - [ ] Re-`POST /api/expenses/1/post` (retry) → idempotent, no second voucher (AC-9)
  - [ ] Tests pass: `pipeline.e2e-spec.ts` (real-DI, G2)

  **QA Scenarios**:

  ```
  Scenario: Full pipeline auto-posts small expense
    Tool: Bash (curl)
    Preconditions: App running, accounts seeded, small expense created (amount 50000)
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/expenses/1/post`
    Expected Result: 200 with expense JSON, status="posted", voucher_id set, voucher posted_at non-null
    Failure Indicators: status="draft" or "pending", no voucher, errors
    Evidence: .omo/evidence/task-15-auto-post.json

  Scenario: Full pipeline holds large expense
    Tool: Bash (curl)
    Preconditions: App running, large expense created (amount 150000)
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/expenses/2/post`
    Expected Result: 200 with expense JSON, status="pending", voucher_id=null, voucher table count unchanged (no row persisted — ADR-0020)
    Failure Indicators: a persisted unposted voucher row, voucher_id set, status="posted"
    Evidence: .omo/evidence/task-15-hold-pending.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for auto-post and hold-for-approval scenarios
  - [ ] End-to-end test output

  **Commit**: YES
  - Message: `feat(pipeline): end-to-end posting pipeline integration`
  - Files: `src/expenses/expenses.controller.ts` (add post endpoint), `src/sales-invoices/sales-invoices.controller.ts` (add post endpoint), `test/pipeline.e2e-spec.ts`
  - Pre-commit: `npm run build && npm test`

---

## Wave Acceptance Criteria
- [ ] All 5 tasks complete
- [ ] `docker compose up` starts and health responds 200
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with new tests
- [ ] Evidence files exist in `.omo/evidence/` for all tasks
- [ ] Git commit records Wave 3 changes

## Commit
- Message: `feat(pipeline): business objects + rules + policy + integration` — all Wave 3 files + tests
