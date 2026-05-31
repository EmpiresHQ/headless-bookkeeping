# Wave 6: Agents + Periods + Admin

## Overview
This wave closes the system: period locking prevents posting into filed periods, VAT report snapshots freeze what was filed, the approval lifecycle handles human decisions on Policy-held vouchers, agent stubs provide the cron-driven scaffolding for future intelligence, and admin API endpoints give diagnostics and oversight. Runs after Waves 4 and 5 complete.

> **This `.omo` file is the canonical, authoritative spec — execute from it.** The old `docs/superpowers/plans/2026-05-29-wave-6-agents-admin.md` "how" plan is **SUPERSEDED / stale** (it still shows `X-Admin-Key`, `voucher_ids` JSON, `merkle_root: null`) — do NOT follow it; re-derive any step-by-step from this file.

## Prerequisites
- **Wave 4 complete**: Documents, Triage, Corrections, ReportingPeriod CRUD
- **Wave 5 complete**: Bank, Matching, Prepayments, Personal disposition, FX realized
- `docker compose up` starts successfully
- `npm run build` and `npm test` pass

## Definition of Done
- ReportingPeriods can be locked; posting into locked periods is rejected
- VAT report snapshots are immutable and include all period vouchers
- Approval lifecycle supports pending → approved/rejected/superseded
- 5 agent stubs exist; **AuditAgent sweep is a no-op** — demo findings come only via a seed/fixture, never the cron (Task 30)
- Admin API endpoints provide read-only diagnostics behind the **table-backed `ApiTokenGuard`** (Task 39), not a hardcoded key
- **Task 39 (API token) lands BEFORE the final QA pass.** Once it does, every `/api` + `/admin` QA curl / e2e uses `Authorization: Bearer <token>` (use the seeded dev token); only `/health` and the open document-ingest webhook stay unauthenticated. (The per-task QA snippets below omit the header for brevity — add it.)
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
    - **Hard process rule (reject — for DIRECT posts):** `PostingService` rejects any voucher whose `tax_point_date` falls in a locked period
      - Returns `400` with error "Cannot post into locked period {period_name}". Never silently re-dates.
    - **Redirect path (corrections + late documents → current open period, ADR-0009):** the reject is only for a *direct* post. The **correction** flow (un-stub Wave-4 Task 18's locked branch) and the **late-arriving-document** flow detect a locked target *up front* and re-route into the **current open period** — re-dated to it, carrying `reverses`/`corrects_object` where applicable — instead of hitting the wall. A late new Q1 expense whose document arrives after Q1 is filed lands in the current open period (the "next VAT return" rule). This redirect is what makes the warn-and-allow filing guard sound (else legitimate late items strand forever). Provide a helper, e.g. `ReportingPeriodsService.currentOpenPeriod()` + a `resolvePostingPeriod(taxPointDate)` that returns the open period to re-date into when the natural target is locked.
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
  - Do NOT **silently re-date a direct post** to dodge the lock — a direct post into a locked period is a hard 400. Re-dating happens only inside the explicit correction / late-document flows (ADR-0009).
  - Do NOT let a correction or late document **dead-end on 400** — those must redirect to the current open period, never strand.

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
  - [ ] A **direct** post with tax_point_date in a locked period returns 400
  - [ ] A **correction** of a locked-period item posts (reversal + corrected) into the **current open period**, re-dated, carrying `reverses`/`corrects_object` — real-DI test (G2).
  - [ ] A **late-arriving document** whose tax-point falls in a filed period lands in the current open period — real-DI test.
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
    - Create immutable snapshot in `vat_report` table: id, period_id, generated_at, vat_summary (JSON — frozen computed boxes), total_payable (INTEGER), total_receivable (INTEGER), `merkle_root` (TEXT NOT NULL), `version` (INTEGER NOT NULL DEFAULT 1), `supersedes_id` (INTEGER, nullable, FK to vat_report — forward-compat for an **amended return** "Q1 v2" that supersedes a prior filing, CONTEXT.md). The amend *flow* is v2 — these columns are **reserved now** so the immutable table needn't be migrated later; v1 always writes version 1 / NULL supersedes.
    - **Included vouchers as a join table** `vat_report_voucher` (vat_report_id FK, voucher_id FK) — NOT a `voucher_ids` JSON blob (queryable, FK-constrained; `GET /vat-reports/:id/vouchers` reads it).
    - **Compute the real Merkle root** over the included vouchers' hashes. Contract (Codex review): the schema stores only `voucher.previous_hash`, not each voucher's own hash — so **recompute** `computeVoucherHash(voucher, lines)` (the existing W3-3 function) for each included voucher in a deterministic order (e.g. by voucher_number), then fold into a Merkle root. No new `voucher.hash` column needed. This is the cryptographic "proof of exactly what was filed" (ADR-0013/0009); do NOT defer it. Store in `merkle_root`.
  - `POST /api/reporting-periods/:id/vat-report` triggers generation
  - **Link + one snapshot per period (Codex review):** on generate, set `reporting_period.vat_report_snapshot_id` to the new report id; a period files **once** — re-generating a period that already has a snapshot is rejected (a corrected filing is an amended return = `version`+`supersedes_id`, v2). Prevents ambiguous filed snapshots.
  - `GET /api/vat-reports/:id` returns the snapshot
  - `GET /api/vat-reports/:id/vouchers` returns the list of included vouchers
  - Write tests for report generation and immutability

  **Must NOT do**:
  - Do NOT defer / NULL the Merkle root — compute it for real (ADR-0013/0009); the voucher hashes already exist (W3-3), so it is cheap and it is what makes the snapshot a *proof*.
  - Do NOT store included vouchers as a JSON blob — use the `vat_report_voucher` join table.
  - Do NOT allow editing a VAT report after generation — immutable.
  - Do NOT implement country-specific report formats (e.g., Danish VAT return) — just the JSON summary + Merkle root.

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
  - [ ] `merkle_root` is non-NULL and **deterministic** — recomputing over the same voucher set yields the identical root (test); changing any included voucher's hash changes the root.
  - [ ] Included vouchers live in `vat_report_voucher` (join table, FK); `GET /vat-reports/:id/vouchers` reads it.
  - [ ] Generating sets `reporting_period.vat_report_snapshot_id`; re-generating an already-filed period is rejected.
  - [ ] `GET /api/vat-reports/1` returns immutable snapshot
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
  - `approval` table: id (INTEGER PK), object_type (TEXT — **CHECK in the full approval-required set**: `expense`, `sales_invoice`, `dividend`, `personal_disposition`, `bad_debt`, `correction`; migration-extensible as new approvable kinds land — NOT just expense/sales_invoice, or ADR-required approvals for dividend/personal/bad-debt/correction would bounce on the constraint), object_id (INTEGER — `(object_type, object_id)` is the polymorphic reference to the approvable business object or system action), status (TEXT — enum: pending, approved, rejected, superseded), requested_by (TEXT), approved_by (TEXT, nullable — for the solo persona typically equals `requested_by`; the approver is the owner, ADR-0016), rejected_reason (TEXT, nullable), superseded_by (INTEGER FK to approval, nullable), created_at (INTEGER), resolved_at (INTEGER, nullable)
  - `POST /api/approvals` — creates an Approval when Policy holds a voucher (called by pipeline)
  - **Wire the pipeline hold path (Codex review):** today `PostingPipelineService` Policy-hold only sets the object to `pending` (`claimForApproval`) and creates **no** approval row. Change it to also create the `Approval` (pending) in the same step — this is the "called by pipeline" contract. The integration test below proves it.
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
  - [ ] **Pipeline contract (real-DI, G2):** a Policy-held post (e.g. large expense / semantic hold) leaves `expense.status='pending'` AND creates **exactly one** `approval` row for it — no approval is created on an auto-post.
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
    - `audit_finding` table: id (INTEGER PK), finding_type (TEXT — e.g., missing_receipt, pending_approval, period_deadline, unmatched_bank), severity (TEXT — enum: low, medium, high, critical), description (TEXT), referenced_object_type (TEXT), referenced_object_id (INTEGER), status (TEXT — enum: open, resolved, snoozed), severity_scored_at (INTEGER — last re-score sweep), last_nagged_at (INTEGER, nullable — SecretaryAgent anti-spam, ADR-0018), created_at (INTEGER), resolved_at (INTEGER, nullable)
    - **UNIQUE natural key** `(finding_type, referenced_object_type, referenced_object_id)` — a real DB constraint (G6, prove with a test): one finding per (issue-type, object), so a re-sweep **re-scores** it, never duplicates it (ADR-0018).
    - **Finding FSM** (like Approval / ReportingPeriod — findings are state-machine-governed, not free status writes): states `open → snoozed → open`, `open|snoozed → resolved`, and `resolved → open` (**reopen** when a sweep re-detects an issue that was resolved — same row via the UNIQUE key, transition logged). The service enforces legal transitions and rejects illegal ones; `severity` re-scores while `open`/`snoozed` (ADR-0018 dynamic severity). `resolved` is soft-terminal (reopenable), not delete.
    - **Resolution provenance** — objects *created in response to* a finding link back to it: a child table `finding_reference` (finding_id FK, object_type, object_id, created_at). When uploading the missing receipt, posting a correction, or making a match to clear a finding, record the link, so the audit trail shows *what was done to resolve finding F* (mirrors the Voucher's `corrects_object`). A finding may have several resolution references.
    - `POST /api/audit-findings` — creates a finding (typically called by AuditAgent cron or triggers)
    - `GET /api/audit-findings` — lists findings with severity filter
    - `POST /api/audit-findings/:id/resolve` — marks as resolved
    - `POST /api/audit-findings/:id/snooze` — marks as snoozed
  - **Agent stubs**:
    - Create `src/agents/` directory with stub implementations for 5 agents:
      - `AccountingAgent`: empty stub with `@Injectable()`
      - `ReconciliationAgent`: empty stub
      - `AuditAgent`: stub with method `sweep()` that is a **no-op** (logs "would sweep", writes nothing) — or runs real detection later. It **upserts** by the UNIQUE key (re-score, not duplicate); it never fabricates sample findings on a live schedule. Sample findings for demo come only from an explicit **seed/test fixture**, never the cron.
      - `SecretaryAgent`: stub with method `notify()` that logs "would notify user" (no real channels)
      - `DevAgent`: empty stub, disabled by default
    - Each agent is a NestJS service, not a separate process
    - `AuditAgent` sweep is wired to a NestJS `@Cron()` decorator (e.g. hourly), but the stub sweep is a **no-op** (no fabricated findings); when real, it **upserts** by the UNIQUE key and drives the finding **FSM** (re-score / resolve / reopen). The cron never writes demo data.
    - `SecretaryAgent` reads `open` AuditFindings and logs them (no real Telegram/Slack), respecting `last_nagged_at` vs `severity` for anti-spam cadence (ADR-0018).
  - Write tests for AuditFinding CRUD and agent stubs

  **Must NOT do**:
  - Do NOT implement real agent logic (AI, OCR, reconciliation algorithms) — stubs only
  - Do NOT integrate with external channels (Telegram, Slack, email) — log only
  - Do NOT run agents as separate processes — in-process NestJS services
  - Do NOT fabricate sample findings on the live cron — sweep is a no-op/real-detection; demo data comes only from a seed/fixture.
  - Do NOT write `status` arbitrarily — only via the **FSM** transitions (reject illegal ones).
  - Do NOT insert a duplicate finding for the same `(finding_type, ref_type, ref_id)` — upsert/re-score the existing row.

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
  - [ ] UNIQUE `(finding_type, ref_type, ref_id)` is a real DB constraint — a second insert for the same triple is rejected / upserts (G6 test).
  - [ ] A re-sweep **re-scores** the existing finding (no duplicate row); a `resolved` finding re-detected **reopens** (FSM transition logged).
  - [ ] FSM rejects an illegal transition (e.g. `resolved → snoozed` direct write) — test.
  - [ ] Resolving via a created object records a `finding_reference` (provenance) link.
  - [ ] `SecretaryAgent.notify()` logs open findings respecting `last_nagged_at` (no external calls).
  - [ ] Sample findings come from a seed/fixture; the cron sweep writes none.
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

  Scenario: Re-sweep re-scores, does not duplicate (dedup + FSM)
    Tool: Bash (curl) + a seeded finding
    Preconditions: App running; one finding seeded for (missing_receipt, expense, 123)
    Steps:
      1. Trigger the AuditAgent sweep (DI-resolved service; not `new AuditAgent()`)
      2. `curl -s http://localhost:3000/api/audit-findings | jq '[.[]|select(.referenced_object_id==123)] | length'`
    Expected Result: still exactly 1 finding for object 123 (re-scored, not duplicated); a resolved-then-re-detected finding shows status back to `open`
    Failure Indicators: duplicate rows for the same (type,object); sweep fabricating demo findings; illegal status writes
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
  - Auth via the **`ApiTokenGuard`** (Task 39) — `Authorization: Bearer <token>`; no hardcoded key.
  - Write tests for all admin endpoints

  **Must NOT do**:
  - Do NOT build a React/Vite frontend — API only
  - Do NOT implement complex RBAC or permissions — single owner token (Task 39); RBAC is v2 (uncertain)
  - Do NOT reintroduce a hardcoded key — use the `ApiTokenGuard` (Task 39)
  - Do NOT allow admin endpoints to mutate posted vouchers (read-only for ledger)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple CRUD/read-only endpoints, mostly aggregations
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 27, 28, 29, 30)
  - **Parallel Group**: Wave 6 (with Tasks 27, 28, 29, 30)
  - **Blocks**: None
  - **Blocked By**: Tasks 27-30 (all admin data sources), Task 39 (ApiTokenGuard)

  **References**:
  - VISION.md: "Admin UI only for: setup, integrations, reviews, diagnostics, configs"
  - ADR-0018: "Admin UI only for: setup, integrations, reviews, diagnostics, configs, LLM profiles, country plugins, supplier defaults, VAT settings"

  **Acceptance Criteria**:
  - [ ] `GET /admin/accounts` returns accounts with computed balances
  - [ ] `GET /admin/vouchers` supports date range filter
  - [ ] `GET /admin/approvals/pending` returns only pending approvals
  - [ ] `GET /admin/findings/open` returns only open findings
  - [ ] All admin endpoints require a valid `Authorization: Bearer <token>` via `ApiTokenGuard` (return 401 otherwise)
  - [ ] Tests pass: `admin.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Access admin endpoints with valid key
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/admin/accounts | jq '.accounts | length'`
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

- [ ] 36. Conversation aggregate + router resolution

  > **Origin:** Cross-border/intake grilling — planning-gap finding. Communication is multi-turn (client → agent → client → agent): the first email carries the **Document**; replies do not re-attach it. Without a persisted, auditable **Conversation**, a bare reply is orphaned and the original Document can't be reused. ADR-0016 treats per-channel context as transient router input; ADR-0018 puts "conversational-state" in Mastra (ephemeral). Neither persists an auditable thread with artifacts. This builds the **Conversation** aggregate. See CONTEXT.md (**Conversation**, **Message**, **Artifact**), ADR-0016 (amended), ADR-0018 (amended), and DOMAIN-MODEL.md (intake flow + Conversation lifecycle).

  **What to do**:
  - Migration: `conversation` (id, channel, thread_key TEXT — email `Message-ID`/`References` root or chat thread id, `status` TEXT CHECK in (`open`,`closed`), created_at, updated_at, closed_at nullable); `message` (id, conversation_id FK, direction CHECK in (`inbound`,`outbound`), sender, body, threading_keys, dkim_spf_pass nullable, created_at); `artifact` (id, conversation_id FK, kind CHECK in (`inbound_attachment`,`outbound_output`), document_id FK nullable, storage_path, created_at); association tables `conversation_document` and `conversation_business_object` (M:N).
  - `ConversationService`:
    - **`resolve(channel, threadKeys)`** — deterministic lookup by `(channel, thread_key)`; returns the existing Conversation (reopening it + logging the transition if it was `closed`) or creates a new `open` one. This is the router's first step, *before* probabilistic intent routing (ADR-0016).
    - `appendMessage(...)`, `attachArtifact(...)` (inbound artifacts feed Document dedup via the existing `DocumentsService`), `associate(documentId | businessObjectRef)`.
    - **`close(conversationId)`** — allowed only when all associated in-flight business objects are terminal (Voucher posted / rejected).
    - `getForObject(businessObjectRef)` — returns associated Conversations (open or closed) for **correction/modification context** (ADR-0010/ADR-0006).
  - **Scope (Codex review): the `ConversationService` aggregate only — no live channel adapters / no router wiring in this wave.** There is no email/Telegram adapter task in Wave 6, and intake today is `TriageService.route(documentId)` with no message/thread context. So `resolve(channel, threadKeys)` is exercised **directly at the service level** (callers pass thread keys); wiring it into a real channel router is deferred to the channels/agents work. This keeps Task 36 to the durable aggregate + its FSM, testable without a live channel.
  - Real-DI tests: reply on an existing thread binds to the same Conversation and reuses the original Document; reply on a closed Conversation reopens it (logged); close blocked while an object is non-terminal; `getForObject` returns the closed thread for a later correction.

  **Must NOT do**:
  - Do NOT make Conversation resolution probabilistic/LLM — it is a deterministic thread-key lookup (ADR-0016). Intent classification stays separate.
  - Do NOT hash-chain the Conversation log or treat it as the accounting system of record — the **Voucher** log is (ADR-0013). The Conversation is an auditable *operational* record.
  - Do NOT mutate a closed Conversation to rewrite history — reopen+append or new-linked-Conversation only (append-only).
  - Do NOT gate ingest by whitelist — ingest is open; only conversation/commands/approval are whitelist-gated (ADR-0016).

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: New aggregate (3 tables + 2 association tables), deterministic resolution, lifecycle, router wiring, audit semantics.
  - **Skills**: []

  **Parallelization**:
  - **Blocked By**: Wave-4 Documents (dedup/artifacts); benefits from Wave-5 Task 33 (Entity, for associating counterparties). (No channel-adapter dependency — service-level only; live channel/router wiring deferred.)
  - **Blocks**: durable multi-turn dialogue for all agents (ADR-0018), correction-with-context flows.

  **References**:
  - CONTEXT.md: **Conversation**, **Message**, **Artifact** + lifecycle.
  - ADR-0016 (amended): router resolves Conversation deterministically before intent routing.
  - ADR-0018 (amended): transient Mastra memory vs durable Conversation.
  - ADR-0010/ADR-0006: correction flow consumes the retrieved Conversation for context.

  **Acceptance Criteria**:
  - [ ] Migration creates `conversation`/`message`/`artifact` + M:N association tables; FKs are real (G6).
  - [ ] `resolve` binds a reply to the existing Conversation by thread key; the original Document is reused (no re-attach needed) — real-DI test.
  - [ ] A message resolving to a closed Conversation reopens it; the transition is logged.
  - [ ] `close` is rejected while any associated business object is non-terminal.
  - [ ] `getForObject` returns the (closed) Conversation for a later correction — real-DI test.
  - [ ] Tests pass.

  **Commit**: YES
  - Message: `feat(conversations): Conversation aggregate + deterministic router resolution`
  - Files: migrations + `src/conversations/`, router wiring
  - Pre-commit: `npm run build && npm test`

- [ ] 37. Dividend distribution (declaration + settlement disposition)

  > **Origin:** Cross-border/withdrawal grilling. The v1 primary persona is a one-person **company** whose **main owner-withdrawal path is dividends** (payroll deferred to a domain plugin, ADR-0022). Dividends were unmodelled. A dividend is an **equity distribution, not an expense** (ADR-0023): declare → Dividend-payable → settle against a bank line. Withholding tax and the distributable-profits cap are **country-plugin** rules. Wave-5 already reserved the `dividend` value in the bank-transaction disposition enum (Task 21); this wires the whole flow.

  **What to do**:
  - Migration: extend the canonical chart with `RETAINED_EARNINGS` (equity) and `DIVIDEND_PAYABLE` (liability) accounts (schema/seed in migrations — G4).
  - **Generalize the pipeline first (Codex review):** `PostingPipelineParams.businessObjectType` is currently `expense | sales_invoice` only. To post dividends *through* the pipeline (not bypass it / not special-case), widen that union to include `dividend` (and align it with the `approval.object_type` set from Task 29). Without this, dividends would either skip Rules→Policy or get a dirty special-case — both forbidden (ADR-0012/0019).
  - **Declaration** (owner/admin action, approval-required): `POST /api/dividends` — books `Dr RETAINED_EARNINGS / Cr DIVIDEND_PAYABLE` via the pipeline (Rules → Policy → post). Reject (or hold) if the country plugin's distributable-profits check fails.
  - Add `CountryPlugin` methods: `dividendWithholdingRate(orgContext): number` and `assertDistributable(amount, retainedEarnings): boolean`. Null/IE plugin: withholding `0`, soft profits-check (warn, don't block). A real plugin enforces IE DWT / DK udbytteskat + the legal cap.
  - If withholding applies, the declaration voucher splits the payable into net-to-owner + withholding-tax-payable (plugin-driven).
  - **Settlement disposition:** wire the `dividend` value (reserved in Wave-5 Task 21) — `POST /api/bank-transactions/:id/dividend` draws down `DIVIDEND_PAYABLE` against the outgoing bank line (`Dr DIVIDEND_PAYABLE / Cr BANK`), via N:M `reconciliation_match` (Wave-5 Q9).
  - Real-DI tests: declare → payable exists; settle → payable drawn down, bank reconciled; withholding split when plugin rate > 0; profits-check path.

  **Must NOT do**:
  - Do NOT book a dividend to any P&L expense account — it is an equity distribution (ADR-0023).
  - Do NOT hardcode withholding or the profits-cap in the kernel — they are country-plugin rules (ADR-0002).
  - Do NOT write the ledger outside the pipeline (ADR-0012/0019).
  - Do NOT model dividends as a domain plugin — they are ledger-native (ADR-0022/0023).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: New equity accounts + declaration voucher + plugin hooks + reconciliation draw-down.
  - **Skills**: []

  **Parallelization**:
  - **Blocked By**: Wave-3 pipeline (posting); Wave-5 Tasks 21/22 (bank txn + `reconciliation_match` + reserved `dividend` enum).
  - **Blocks**: nothing (capstone of the owner-withdrawal path for v1).

  **References**:
  - ADR-0023: dividend = equity distribution; withholding + profits-cap = plugin.
  - ADR-0002: account/rule resolution is the country plugin's.
  - ADR-0017: sibling owner-money-out disposition (personal); same approval-required posture.

  **Acceptance Criteria**:
  - [ ] Migration adds `RETAINED_EARNINGS` + `DIVIDEND_PAYABLE`.
  - [ ] Declaring a dividend posts `Dr RETAINED_EARNINGS / Cr DIVIDEND_PAYABLE` through the pipeline; never touches a P&L account (real-DI test).
  - [ ] Settling via the `dividend` disposition draws down `DIVIDEND_PAYABLE` and reconciles the bank line (N:M match).
  - [ ] Null plugin: withholding 0, soft profits-check; a strict test plugin enforces both (test).
  - [ ] Tests pass.

  **Commit**: YES
  - Message: `feat(dividends): equity distribution + plugin withholding/profits-cap`
  - Files: migrations + `src/dividends/`, `src/plugins/`, `src/reconciliation/`
  - Pre-commit: `npm run build && npm test`

- [ ] 39. API token authentication (table + NestJS guard)

  > **Origin:** Wave-6 grilling. The admin API shipped a hardcoded `X-Admin-Key: dev` — a stub, not auth. Replace it with a real, table-backed API token verified by a NestJS guard. RBAC is deferred to v2 (and uncertain — see V2-ROADMAP). NestJS makes this small: one `CanActivate` guard + one table.

  **What to do**:
  - Migration: `api_token` table — id (INTEGER PK), `token_hash` (TEXT NOT NULL UNIQUE — store a **hash** of the token, never plaintext; verify by hashing the presented token + constant-time compare), `label` (TEXT), created_at (INTEGER), revoked_at (INTEGER, nullable). On init, **generate one token**, store its hash, and surface the plaintext **once** (boot log / a seed value for dev so tests have a known token). Plaintext is never persisted.
  - `ApiTokenGuard` (`CanActivate`): read `Authorization: Bearer <token>`, hash it, match a non-revoked `api_token` row (constant-time); `401` on miss/missing/revoked.
  - Apply the guard **globally to `/api` and `/admin`**; leave `/health` (and the open document-ingest webhook, ADR-0016 "ingest open to any sender") **unauthenticated**.
  - Replace Task 31's `X-Admin-Key: dev` with this guard.
  - Tests: valid token → 200; missing/wrong/revoked → 401; health stays open; token stored hashed (no plaintext column).

  **Must NOT do**:
  - Do NOT store the token in plaintext — hash + constant-time compare.
  - Do NOT implement RBAC / roles / per-route permissions — single owner token for v1 (RBAC deferred to v2, uncertain — V2-ROADMAP).
  - Do NOT gate `/health` or open document ingest behind the token (ADR-0016).
  - Do NOT hardcode the token in source — generated/seeded into the table.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Migration + a global guard + init token generation; cross-cutting but small.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (independent).
  - **Blocks**: Task 31 (admin endpoints use the guard).
  - **Blocked By**: Task 1 (migration runner).

  **References**:
  - ADR-0016: ingest open to any sender (do not gate ingest); conversation/commands/approval are the gated tracks.
  - V2-ROADMAP.md: RBAC (deferred, uncertain).

  **Acceptance Criteria**:
  - [ ] Migration creates `api_token` with a UNIQUE `token_hash`; an init token exists (hash stored, plaintext surfaced once).
  - [ ] `ApiTokenGuard` returns 401 without/with a wrong/revoked token; 200 with a valid one — real-DI test.
  - [ ] `/health` stays open; `/api` + `/admin` require the token.
  - [ ] No plaintext token column exists (grep/schema check).
  - [ ] Tests pass.

  **Commit**: YES
  - Message: `feat(auth): table-backed API token + NestJS guard`
  - Files: migration + `src/auth/`
  - Pre-commit: `npm run build && npm test`

---

## Wave Acceptance Criteria
- [ ] All 8 tasks complete
- [ ] `docker compose up` starts and health responds 200
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with new tests
- [ ] Evidence files exist in `.omo/evidence/` for all tasks
- [ ] Git commit records Wave 6 changes

## Commit
- Message: `feat(agents): period lock + VAT report + approvals + agents + admin` — all Wave 6 files + tests
