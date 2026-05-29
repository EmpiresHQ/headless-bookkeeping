# Wave 6: Agents + Periods + Admin

## Overview
This wave closes the system: period locking prevents posting into filed periods, VAT report snapshots freeze what was filed, the approval lifecycle handles human decisions on Policy-held vouchers, agent stubs provide the cron-driven scaffolding for future intelligence, and admin API endpoints give diagnostics and oversight. Runs after Waves 4 and 5 complete.

> **Detailed implementation plan (bite-sized TDD):** [`docs/superpowers/plans/2026-05-29-wave-6-agents-admin.md`](../../docs/superpowers/plans/2026-05-29-wave-6-agents-admin.md) — the step-by-step "how". This file remains the "what / why" spec.

## Prerequisites
- **Wave 4 complete**: Documents, Triage, Corrections, ReportingPeriod CRUD
- **Wave 5 complete**: Bank, Matching, Prepayments, Personal disposition, FX realized
- `docker compose up` starts successfully
- `npm run build` and `npm test` pass

## Definition of Done
- ReportingPeriods can be locked; posting into locked periods is rejected
- VAT report snapshots are immutable and include all period vouchers
- Approval lifecycle supports pending → approved/rejected/superseded
- 5 agent stubs exist with AuditAgent creating sample findings
- Admin API endpoints provide read-only diagnostics with simple API key auth
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

- [ ] 27. ReportingPeriod lock + filing guard

  **What to do**:
  - Implement period locking per ADR-0009 and ADR-0015:
    - `POST /api/reporting-periods/:id/lock` — changes status from `open` to `locked`, sets `filed_at`
    - Lock is idempotent (re-locking returns 200, not error)
    - **Hard process rule**: `PostingService` rejects any voucher whose `tax_point_date` falls in a locked period
      - Returns `400` with error "Cannot post into locked period {period_name}"
    - **Filing guard**: Before locking, warn if unresolved items exist in the period:
      - Query for pending approvals (Policy hold) with tax_point_date in period
      - Query for unposted drafts with tax_point_date in period
      - Return warning list but allow lock (not a hard block — deadlines are real)
  - `GET /api/reporting-periods/:id/warnings` — lists unresolved items before locking
  - Write tests for lock, posting rejection, and filing guard

  **Must NOT do**:
  - Do NOT implement VAT report computation on lock — that's Task 28
  - Do NOT implement amended return logic — deferred
  - Do NOT auto-reject lock if warnings exist — only warn, user decides

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Hard process rule enforcement, idempotent state transitions, warning queries
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 28, 29, 30, 31)
  - **Parallel Group**: Wave 6 (with Tasks 28, 29, 30, 31)
  - **Blocks**: Task 28 (VAT report needs locked period), Task 29 (approvals interact with lock)
  - **Blocked By**: Task 19 (ReportingPeriod schema), Task 9 (PostingService needs to check lock)

  **References**:
  - ADR-0009: "No posting into a locked period... hard process rule (legal, not arithmetic)"
  - ADR-0009: "A period locks on filing, not on the calendar"
  - ADR-0015: "Filing guard (warn-and-confirm)... surfaces all unresolved in-period items"
  - ADR-0015: "Stranded items stay visible... remain pending, keep nagging"

  **Acceptance Criteria**:
  - [ ] `POST /api/reporting-periods/1/lock` changes status to `locked`
  - [ ] Re-locking same period returns 200 (idempotent)
  - [ ] Posting voucher with tax_point_date in locked period returns 400
  - [ ] `GET /api/reporting-periods/1/warnings` lists pending items before lock
  - [ ] Tests pass: `reporting-periods-lock.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Lock a reporting period
    Tool: Bash (curl)
    Preconditions: App running, open period exists (id=1)
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/reporting-periods/1/lock`
    Expected Result: 200 with period JSON, status="locked", filed_at non-null
    Failure Indicators: 400/500, status not changed
    Evidence: .omo/evidence/task-27-lock-period.json

  Scenario: Posting into locked period is rejected
    Tool: Bash (curl)
    Preconditions: Period locked
    Steps:
      1. Try to post voucher with tax_point_date in locked period
    Expected Result: 400 with error message about locked period
    Failure Indicators: 200 OK (voucher posted), wrong error message
    Evidence: .omo/evidence/task-27-post-rejected.txt
  ```

  **Evidence to Capture**:
  - [ ] API responses for lock and posting rejection
  - [ ] SQLite query showing period status

  **Commit**: YES
  - Message: `feat(periods): reporting period lock + filing guard`
  - Files: `src/reporting-periods/reporting-periods.controller.ts`, `src/ledger/posting/posting.service.ts` (add lock check)
  - Pre-commit: `npm run build && npm test`

- [ ] 28. VAT report snapshot

  **What to do**:
  - `VATReportService.generate(periodId: number): VatReport`:
    - Query all vouchers with tax_point_date in the period range
    - Group VoucherLines by VAT code
    - Sum base_amount per VAT code (input VAT vs output VAT)
    - Compute net VAT payable/receivable
    - Create immutable snapshot in `vat_report` table: id, period_id, generated_at, voucher_ids (JSON), vat_summary (JSON), total_payable (INTEGER), total_receivable (INTEGER)
    - Compute Merkle root placeholder: store `merkle_root` column as NULL with comment "deferred to v1+"
  - `POST /api/reporting-periods/:id/vat-report` triggers generation
  - `GET /api/vat-reports/:id` returns the snapshot
  - `GET /api/vat-reports/:id/vouchers` returns the list of included vouchers
  - Write tests for report generation and immutability

  **Must NOT do**:
  - Do NOT compute real Merkle root — column reserved, logic deferred
  - Do NOT allow editing a VAT report after generation — immutable
  - Do NOT implement country-specific report formats (e.g., Danish VAT return) — just JSON summary

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Aggregation queries, snapshot creation, immutability
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 27, 29, 30, 31)
  - **Parallel Group**: Wave 6 (with Tasks 27, 29, 30, 31)
  - **Blocks**: None (last feature task)
  - **Blocked By**: Task 27 (period must be lockable), Task 7 (vouchers), Task 19 (periods)

  **References**:
  - ADR-0009: "VAT report: frozen snapshot... immutable (reproducibility of what was filed)"
  - ADR-0009: "Merkle root over each locked period's vouchers"
  - ADR-0013: "Merkle root per locked period... stored in VAT report"

  **Acceptance Criteria**:
  - [ ] `POST /api/reporting-periods/1/vat-report` creates snapshot with correct VAT summaries
  - [ ] `GET /api/vat-reports/1` returns immutable snapshot
  - [ ] Snapshot includes all vouchers from the period
  - [ ] Tests pass: `vat-report.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Generate VAT report for period
    Tool: Bash (curl)
    Preconditions: App running, locked period with posted vouchers exists
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/reporting-periods/1/vat-report`
    Expected Result: 201 with report JSON, vat_summary grouped by code, net amount computed
    Failure Indicators: 400/500, wrong totals, missing vouchers
    Evidence: .omo/evidence/task-28-vat-report.json

  Scenario: VAT report is immutable
    Tool: Bash (curl)
    Preconditions: Report exists
    Steps:
      1. `curl -s -X PUT http://localhost:3000/api/vat-reports/1` (any payload)
    Expected Result: 405 Method Not Allowed
    Failure Indicators: 200 OK, report modified
    Evidence: .omo/evidence/task-28-immutable.txt
  ```

  **Evidence to Capture**:
  - [ ] API response for VAT report generation
  - [ ] SQLite query showing vat_report table contents

  **Commit**: YES
  - Message: `feat(periods): VAT report snapshot generation`
  - Files: `src/vat-report/`
  - Pre-commit: `npm run build && npm test`

- [ ] 29. Approval lifecycle

  **What to do**:
  - Create `src/approvals/` module
  - `approval` table: id (INTEGER PK), object_type (TEXT — expense, sales_invoice), object_id (INTEGER), status (TEXT — enum: pending, approved, rejected, superseded), requested_by (TEXT), approved_by (TEXT, nullable), rejected_reason (TEXT, nullable), superseded_by (INTEGER FK to approval, nullable), created_at (INTEGER), resolved_at (INTEGER, nullable)
  - `POST /api/approvals` — creates an Approval when Policy holds a voucher (called by pipeline)
  - `POST /api/approvals/:id/approve` — changes status to `approved`, triggers idempotent posting
  - `POST /api/approvals/:id/reject` — changes status to `rejected`, returns draft to editable state with reason
  - `POST /api/approvals/:id/supersede` — changes status to `superseded` (called when newer version arrives)
  - `GET /api/approvals` — lists approvals with filters (status, type)
  - `GET /api/approvals/pending` — lists pending approvals (for admin/agent use)
  - Idempotent posting: approving twice does not double-post
  - Timeout behavior: no auto-resolve, just reminder (stub for Wave 6)
  - Write tests for all state transitions and idempotency

  **Must NOT do**:
  - Do NOT implement real notification channels (Telegram, email) — just state changes
  - Do NOT implement approval UI — API only
  - Do NOT auto-reject or auto-approve on timeout

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: State machine, idempotency, rejection handling
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 27, 28, 30, 31)
  - **Parallel Group**: Wave 6 (with Tasks 27, 28, 30, 31)
  - **Blocks**: Task 30 (AuditFinding may reference approvals)
  - **Blocked By**: Task 14 (Policy gate creates approval requests), Task 11-12 (business objects)

  **References**:
  - ADR-0015: "Approval lifecycle: pending → approved | rejected | superseded. Never auto-resolves"
  - ADR-0015: "Approved → idempotent posting; rejected → draft returns to draft with reason"
  - ADR-0015: "Superseded → newer version arrived while pending"
  - ADR-0016: "Action point is a button" — but Wave 6 is API-only, buttons deferred

  **Acceptance Criteria**:
  - [ ] Creating approval sets status to `pending`
  - [ ] Approving triggers posting, status becomes `approved`, voucher posted
  - [ ] Rejecting sets status `rejected`, expense returns to `draft` with reason
  - [ ] Double-approve does not double-post (idempotent)
  - [ ] Tests pass: `approvals.controller.spec.ts`, `approvals.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Approve a pending expense
    Tool: Bash (curl)
    Preconditions: App running, large expense in pending status (id=1)
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/approvals/1/approve`
    Expected Result: 200 with approval JSON, status="approved", expense.status="posted"
    Failure Indicators: status not changed, expense not posted, double-posted
    Evidence: .omo/evidence/task-29-approve.json

  Scenario: Reject a pending expense
    Tool: Bash (curl)
    Preconditions: App running, pending expense exists
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"reason":"Missing receipt"}' http://localhost:3000/api/approvals/2/reject`
    Expected Result: 200 with approval JSON, status="rejected", expense.status="draft", reason set
    Failure Indicators: status not changed, expense deleted
    Evidence: .omo/evidence/task-29-reject.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for approve and reject
  - [ ] SQLite query showing approval states

  **Commit**: YES
  - Message: `feat(approvals): approval lifecycle with approve/reject/supersede`
  - Files: `src/approvals/`
  - Pre-commit: `npm run build && npm test`

- [ ] 30. AuditFinding + Agent stubs

  **What to do**:
  - **AuditFinding** (ADR-0018):
    - `audit_finding` table: id (INTEGER PK), finding_type (TEXT — e.g., missing_receipt, pending_approval, period_deadline, unmatched_bank), severity (TEXT — enum: low, medium, high, critical), description (TEXT), referenced_object_type (TEXT), referenced_object_id (INTEGER), status (TEXT — enum: open, resolved, snoozed), created_at (INTEGER), resolved_at (INTEGER, nullable)
    - `POST /api/audit-findings` — creates a finding (typically called by AuditAgent cron or triggers)
    - `GET /api/audit-findings` — lists findings with severity filter
    - `POST /api/audit-findings/:id/resolve` — marks as resolved
    - `POST /api/audit-findings/:id/snooze` — marks as snoozed
  - **Agent stubs**:
    - Create `src/agents/` directory with stub implementations for 5 agents:
      - `AccountingAgent`: empty stub with `@Injectable()`
      - `ReconciliationAgent`: empty stub
      - `AuditAgent`: stub with method `sweep()` that creates sample AuditFindings (for testing)
      - `SecretaryAgent`: stub with method `notify()` that logs "would notify user" (no real channels)
      - `DevAgent`: empty stub, disabled by default
    - Each agent is a NestJS service, not a separate process
    - `AuditAgent` sweep runs on a NestJS `@Cron()` decorator (every hour) — creates sample findings for demo
    - `SecretaryAgent` reads open AuditFindings and logs them (no real Telegram/Slack)
  - Write tests for AuditFinding CRUD and agent stubs

  **Must NOT do**:
  - Do NOT implement real agent logic (AI, OCR, reconciliation algorithms) — stubs only
  - Do NOT integrate with external channels (Telegram, Slack, email) — log only
  - Do NOT run agents as separate processes — in-process NestJS services

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: AuditFinding schema + cron stubs, multiple services
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 27, 28, 29, 31)
  - **Parallel Group**: Wave 6 (with Tasks 27, 28, 29, 31)
  - **Blocks**: Task 31 (admin endpoints may list findings)
  - **Blocked By**: Task 1 (migration runner)

  **References**:
  - ADR-0018: "Agent architecture: five agents, split by zone + capability"
  - ADR-0018: "AuditAgent writes AuditFindings; SecretaryAgent reads and nags"
  - ADR-0018: "Severity drives nag cadence"
  - NestJS docs for `@nestjs/schedule` and `@Cron()` decorator

  **Acceptance Criteria**:
  - [ ] `GET /api/audit-findings` returns list including severity
  - [ ] `AuditAgent.sweep()` creates at least one sample finding when run
  - [ ] `SecretaryAgent.notify()` logs open findings (no external calls)
  - [ ] Cron decorator is present on `AuditAgent.sweep()` (every hour)
  - [ ] Tests pass: `audit-finding.controller.spec.ts`, `agents.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Create and list audit findings
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"finding_type":"missing_receipt","severity":"high","description":"Expense #123 has no attached document","referenced_object_type":"expense","referenced_object_id":123}' http://localhost:3000/api/audit-findings`
      2. `curl -s http://localhost:3000/api/audit-findings`
    Expected Result: Step 1 → 201; Step 2 → array including the new finding
    Failure Indicators: 400/500, finding not in list
    Evidence: .omo/evidence/task-30-findings.json

  Scenario: Agent sweep creates findings
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. `node -e "const { AuditAgent } = require('./dist/agents/audit.agent'); const a = new AuditAgent(); a.sweep(); console.log('sweep done');"`
      2. Query DB for new findings
    Expected Result: New audit_finding rows created
    Failure Indicators: No findings created, errors
    Evidence: .omo/evidence/task-30-agent-sweep.txt
  ```

  **Evidence to Capture**:
  - [ ] API responses for finding creation
  - [ ] Agent sweep output

  **Commit**: YES
  - Message: `feat(agents): AuditFinding schema + 5 agent stubs`
  - Files: `src/agents/`, `src/audit-findings/`
  - Pre-commit: `npm run build && npm test`

- [ ] 31. Admin API endpoints

  **What to do**:
  - Create `src/admin/` module with read-only or simple state-transition endpoints:
    - `GET /admin/accounts` — list all accounts with balances (sum of voucher lines)
    - `GET /admin/vouchers` — list all vouchers with filters (date range, period, status)
    - `GET /admin/vouchers/:id` — voucher details with lines
    - `GET /admin/periods` — list reporting periods with lock status
    - `POST /admin/periods/:id/lock` — alias for period lock (admin route)
    - `GET /admin/approvals` — list approvals with status filter
    - `GET /admin/approvals/pending` — list pending approvals
    - `GET /admin/findings` — list audit findings
    - `GET /admin/findings/open` — list open findings
    - `GET /admin/health` — admin health check (same as public health but with extra DB connectivity check)
  - All endpoints return JSON (no HTML, no React)
  - Simple API key auth: `X-Admin-Key: dev` header (hardcoded, no real auth system)
  - Write tests for all admin endpoints

  **Must NOT do**:
  - Do NOT build a React/Vite frontend — API only
  - Do NOT implement complex RBAC or permissions — one hardcoded admin key
  - Do NOT allow admin endpoints to mutate posted vouchers (read-only for ledger)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple CRUD/read-only endpoints, mostly aggregations
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 27, 28, 29, 30)
  - **Parallel Group**: Wave 6 (with Tasks 27, 28, 29, 30)
  - **Blocks**: None
  - **Blocked By**: Tasks 27-30 (all admin data sources)

  **References**:
  - VISION.md: "Admin UI only for: setup, integrations, reviews, diagnostics, configs"
  - ADR-0018: "Admin UI only for: setup, integrations, reviews, diagnostics, configs, LLM profiles, country plugins, supplier defaults, VAT settings"

  **Acceptance Criteria**:
  - [ ] `GET /admin/accounts` returns accounts with computed balances
  - [ ] `GET /admin/vouchers` supports date range filter
  - [ ] `GET /admin/approvals/pending` returns only pending approvals
  - [ ] `GET /admin/findings/open` returns only open findings
  - [ ] All admin endpoints require `X-Admin-Key: dev` header (return 401 otherwise)
  - [ ] Tests pass: `admin.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Access admin endpoints with valid key
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s -H "X-Admin-Key: dev" http://localhost:3000/admin/accounts | jq '.accounts | length'`
    Expected Result: Number ≥ 20 (all canonical accounts)
    Failure Indicators: 401, empty array, wrong count
    Evidence: .omo/evidence/task-31-admin-accounts.json

  Scenario: Admin endpoints reject without key
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s -w "%{http_code}" -o /dev/null http://localhost:3000/admin/accounts`
    Expected Result: HTTP code 401
    Failure Indicators: 200 OK (no auth enforced)
    Evidence: .omo/evidence/task-31-admin-auth.txt
  ```

  **Evidence to Capture**:
  - [ ] API responses for admin endpoints
  - [ ] Auth rejection output

  **Commit**: YES
  - Message: `feat(admin): read-only admin API endpoints`
  - Files: `src/admin/`
  - Pre-commit: `npm run build && npm test`

---

## Wave Acceptance Criteria
- [ ] All 5 tasks complete
- [ ] `docker compose up` starts and health responds 200
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with new tests
- [ ] Evidence files exist in `.omo/evidence/` for all tasks
- [ ] Git commit records Wave 6 changes

## Commit
- Message: `feat(agents): period lock + VAT report + approvals + agents + admin` — all Wave 6 files + tests
