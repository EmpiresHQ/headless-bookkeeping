# Wave 3: Posting Pipeline

## Overview
This wave implements the full business object → draft → Rules → Policy → posted Voucher flow. We build Expense and SalesInvoice business objects, the three-tier Rules engine (structural/hard/semantic), the Policy gate with Override logging, and wire everything together end-to-end. This is the core intelligence layer of the kernel.

## Prerequisites
- **Wave 2 complete**: Account chart, Voucher schema, Validation, Posting, Immutability
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

---

## TODOs

- [ ] 11. Expense business object + draft voucher generation

  **What to do**:
  - Create `src/expenses/` module with controller, service, types
  - `expense` table: id (INTEGER PK), document_id (INTEGER FK, nullable), supplier_id (INTEGER FK, nullable), category (TEXT NOT NULL), gross_amount (INTEGER NOT NULL), vat_amount (INTEGER NOT NULL), currency (TEXT NOT NULL), tax_point_date (TEXT NOT NULL), status (TEXT NOT NULL — enum: draft, pending, posted, reversed), voucher_id (INTEGER FK to voucher, nullable), created_at (INTEGER), updated_at (INTEGER)
  - `POST /api/expenses` creates an Expense in `draft` status
  - `POST /api/expenses/:id/generate-draft` generates a draft Voucher from the Expense:
    - Uses CountryPlugin to resolve category → account + vat_code
    - Creates VoucherLines: Dr Expense account, Cr Cash/Bank/AP (depending on payment status — for v1, assume Cash)
    - Returns draft Voucher (not posted yet)
  - `GET /api/expenses` lists expenses
  - `GET /api/expenses/:id` returns expense with draft voucher if exists
  - Write tests for expense CRUD and draft generation

  **Must NOT do**:
  - Do NOT post the voucher automatically — only generate draft (posting is Policy-gated in Wave 3)
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
  - ADR-0002: "country plugin resolves category → account + vat_code"
  - `src/organization/` — Pattern for NestJS module structure

  **Acceptance Criteria**:
  - [ ] `POST /api/expenses` creates expense with status `draft`
  - [ ] `POST /api/expenses/1/generate-draft` returns a Voucher with correct lines (Dr Expense, Cr Cash)
  - [ ] Draft voucher is NOT posted (posted_at is null)
  - [ ] Tests pass: `expenses.controller.spec.ts`, `expenses.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Create expense and generate draft voucher
    Tool: Bash (curl)
    Preconditions: App running, accounts seeded, CountryPlugin loaded
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"category":"software","gross_amount":10000,"vat_amount":2500,"currency":"DKK","tax_point_date":"2024-01-15"}' http://localhost:3000/api/expenses`
      2. Extract id from response
      3. `curl -s -X POST http://localhost:3000/api/expenses/{id}/generate-draft`
    Expected Result: Step 1 → 201 with status=draft; Step 3 → 200 with voucher JSON, lines include Dr EXPENSE_SOFTWARE and Cr CASH, posted_at=null
    Failure Indicators: Wrong accounts, voucher posted immediately, missing lines
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
  - `sales_invoice` table: id (INTEGER PK), customer_id (INTEGER FK, nullable), invoice_number (TEXT NOT NULL UNIQUE), gross_amount (INTEGER NOT NULL), vat_amount (INTEGER NOT NULL), currency (TEXT NOT NULL), tax_point_date (TEXT NOT NULL), due_date (TEXT, nullable), status (TEXT NOT NULL — enum: draft, pending, posted, reversed, sent), voucher_id (INTEGER FK, nullable), created_at (INTEGER), updated_at (INTEGER)
  - `POST /api/sales-invoices` creates a SalesInvoice in `draft` status
  - `POST /api/sales-invoices/:id/generate-draft` generates a draft Voucher:
    - Dr AR (Accounts Receivable), Cr Revenue, Cr VAT Payable
    - Uses CountryPlugin for VAT code resolution
  - `POST /api/sales-invoices/:id/send` marks as `sent` (just status change for now, no real email)
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
  - [ ] `POST /api/sales-invoices/1/generate-draft` returns voucher with Dr AR, Cr REVENUE, Cr VAT_PAYABLE
  - [ ] `POST /api/sales-invoices/1/send` changes status to `sent`
  - [ ] Tests pass: `sales-invoices.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Create sales invoice and generate draft
    Tool: Bash (curl)
    Preconditions: App running, accounts seeded
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"invoice_number":"INV-2024-001","gross_amount":12500,"vat_amount":2500,"currency":"DKK","tax_point_date":"2024-01-15","due_date":"2024-02-15"}' http://localhost:3000/api/sales-invoices`
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
    1. **Structural rules** (inviolable): voucher balances to zero, account exists, amounts are positive integers, currency not empty
    2. **Hard process rules** (inviolable): period containing tax_point_date is not locked (stub for now — period locking in Wave 6)
    3. **Semantic rules** (overridable via Override): VAT code is valid per CountryPlugin, category mapping exists, deductibility rules (stub)
  - `RulesService.validate(draftVoucher, type: 'structural' | 'hard' | 'semantic'): RuleResult`
  - `RuleResult`: `{ passed: boolean, ruleType: string, message: string, overrideable: boolean }`
  - Structural and hard rules: `overrideable: false` — always reject if failed
  - Semantic rules: `overrideable: true` — can be logged Override with reason
  - Write tests for all three rule types, including overrideable vs non-overrideable behavior

  **Must NOT do**:
  - Do NOT allow overriding structural rules (enforce at code level)
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
  Scenario: Structural rule cannot be overridden
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. `node -e "const { RulesService } = require('./dist/rules/rules.service'); const s = new RulesService(); const r = s.validate({lines:[{account_id:1,amount:100,currency:'DKK',base_amount:100,fx_rate:1,is_debit:true}]}, 'structural'); console.log(r);"`
    Expected Result: passed: false, overrideable: false
    Failure Indicators: overrideable: true, passed: true
    Evidence: .omo/evidence/task-13-structural.txt

  Scenario: Semantic rule can be overridden
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. Validate a voucher with invalid VAT code
      2. Call with override reason: "Migration from legacy system"
    Expected Result: Without override → passed: false, overrideable: true; With override → passed: true
    Failure Indicators: Override doesn't work, overrideable: false
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
    - `auto_post_amount_ceiling`: 100000 (cents = 1000 DKK) — above this, hold for approval
    - `auto_post_min_confidence`: 0.8 (stub — AI confidence not implemented yet, always 1.0)
    - `unknown_supplier_requires_approval`: true
    - `always_approve_operations`: ['correction', 'reversal', 'vat_lock'] (stub list)
  - For Wave 3: Policy defaults to `auto-post` for everything except structural/hard rule failures
  - `Override` table: id, voucher_id, rule_type, rule_name, reason, created_by, created_at
  - `POST /api/overrides` logs an override (only for semantic rule failures)
  - `GET /api/overrides` lists overrides
  - Write tests for Policy decisions and Override logging

  **Must NOT do**:
  - Do NOT implement real approval workflow yet — Policy just decides auto-post vs hold; actual approval lifecycle in Wave 6
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
  - [ ] Structural rule failure → `action: 'reject'` (no override allowed)
  - [ ] Semantic rule failure + Override logged → `action: 'auto-post'`
  - [ ] Override record is created in `override` table with reason
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
    5. If auto-post: post Voucher (atomic, immutable)
    6. If hold: leave in pending state (link voucher to business object as pending)
    7. Return final state
  - `POST /api/expenses/:id/post` — full pipeline endpoint
  - `POST /api/sales-invoices/:id/post` — same for invoices
  - This task is about wiring the pieces together, not new logic
  - Write end-to-end tests: happy path (auto-post), policy-hold path, rule-rejection path

  **Must NOT do**:
  - Do NOT add new business logic — only wire existing services
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
  - [ ] `POST /api/expenses/1/post` with small amount → expense.status = posted, voucher.posted_at set
  - [ ] `POST /api/expenses/2/post` with large amount → expense.status = pending, voucher not posted
  - [ ] `POST /api/expenses/3/post` with unbalanced lines → 400 error, expense.status remains draft
  - [ ] Tests pass: `pipeline.e2e-spec.ts`

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
    Expected Result: 200 with expense JSON, status="pending", voucher_id set but posted_at=null
    Failure Indicators: status="posted" (Policy ignored), 400 (wrong rejection)
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
