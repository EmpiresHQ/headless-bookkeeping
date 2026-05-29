# Wave 6 — Period Lock, VAT Snapshot, Approvals, Agents & Admin Implementation Plan

> **For omo executors:** This is the step-by-step "how" for the omo wave spec [`.omo/plans/wave-6-agents-admin.md`](../../../.omo/plans/wave-6-agents-admin.md), which carries each task's **Recommended Agent Profile** (`quick`/`oracle`/`deep`) and QA scenarios. Execute task-by-task: dispatch one agent per task per its profile, follow the red→green→commit TDD loop below, and pass the wave gate (`npm run build && npm run lint && npm run test && npm run test:e2e`, all green) before each commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the kernel by making filing-driven period locks enforce a non-overridable "no posting into a locked period" rule, freezing immutable VAT report snapshots, running the full Approval lifecycle (pending → approved/rejected/superseded), and shipping five in-process agent stubs plus a read-only API-key-guarded Admin API.

**Architecture:** Period locking is a *hard process rule* (ADR-0009/0012): `PostingService` consults the `reporting_period` table on every post and rejects any voucher whose `tax_point_date` lands in a `locked` period — proven against a real in-memory SQLite DB, not mocks (G2/G6). A filed period produces one immutable `vat_report` row (aggregated VoucherLines grouped by VAT code, EUR base currency), made immutable by a `BEFORE UPDATE` SQL trigger created in a migration (G4/G6) plus a 405 at the controller. The Approval state machine and five NestJS agent services (AuditAgent writes `audit_finding` rows on an `@Cron()` sweep; SecretaryAgent only logs) live in-process, and the Admin API exposes read-only diagnostics behind an `X-Admin-Key: dev` guard.

**Tech Stack:** NestJS, Kysely, better-sqlite3, Jest, TypeScript

---

## Assumptions about prior-wave types (relied on, assumed implemented)

These are produced by Waves 2–5 and are treated as existing. If a referenced file/symbol is absent at implementation time, STOP and reconcile — do not stub it silently.

- **Wave 2** — `src/ledger/account/` (`account` table, `AccountService.getAccountByCode`), `src/ledger/voucher/` (`voucher` + `voucher_line` tables; `voucher.tax_point_date TEXT`, `voucher.posted_at`, `voucher_line.account_id`, `voucher_line.base_amount INTEGER` cents, `voucher_line.vat_code TEXT|null`, `voucher_line.is_debit`), `src/ledger/posting/posting.service.ts` exposing `postVoucher(draft: DraftVoucher): Promise<PostedVoucher>` and the `DraftVoucher` type `{ voucher_number; tax_point_date; reverses_id?; corrects_object_type?; corrects_object_id?; reason?; lines: DraftVoucherLine[] }`.
- **Wave 3** — `src/expenses/` (`expense` table with `status` enum `draft|pending|posted|reversed` and `voucher_id`), `src/sales-invoices/` (`sales_invoice` table). Policy gate holds Rules-valid drafts; Wave 6 Approval is the persistence of that hold.
- **Wave 4** — `src/reporting-periods/` (`reporting_period` table: `id, name, start_date TEXT, end_date TEXT, status TEXT 'open'|'locked', filed_at INTEGER|null, vat_report_snapshot_id INTEGER|null, created_at`; `ReportingPeriodsService` + controller with `GET /api/reporting-periods`, `/:id`, `/current`).
- **Wave 5** — bank/matching tables (only referenced by AuditFinding `finding_type='unmatched_bank'` as a string; no hard dependency).
- **Shared harness** — `src/database/types.ts` `Database` interface, `src/database/migrations/index.ts` registry, `KYSELY_MODULE_CONNECTION_TOKEN()` provider, `migrateToLatest`, base currency **EUR** resolved via ADR-0004 (never hardcode currency; examples use EUR).

---

## File Structure

```
src/
  database/
    types.ts                                    # EXTEND: add vat_report, approval, audit_finding tables
    migrations/
      index.ts                                  # EXTEND: register new migrations
      020_create_vat_report.ts                  # NEW (Task 28) — vat_report table + immutability trigger
      021_create_approval.ts                    # NEW (Task 29) — approval table
      022_create_audit_finding.ts               # NEW (Task 30) — audit_finding table
  reporting-periods/
    reporting-periods.service.ts                # EXTEND (Task 27): lock(), getWarnings(), isLocked()
    reporting-periods.controller.ts             # EXTEND (Task 27): POST /:id/lock, GET /:id/warnings
    reporting-periods-lock.spec.ts              # NEW (Task 27) real-DI integration test
  ledger/posting/
    posting.service.ts                          # EXTEND (Task 27): reject post into locked period
    posting.locked-period.spec.ts               # NEW (Task 27) real-DI integration test
  vat-report/
    vat-report.module.ts                        # NEW (Task 28)
    vat-report.service.ts                        # NEW (Task 28) generate(periodId)
    vat-report.controller.ts                    # NEW (Task 28) POST /api/reporting-periods/:id/vat-report, GET /api/vat-reports/:id(/vouchers)
    types.ts                                     # NEW (Task 28) VatReport, VatSummaryLine
    vat-report.service.spec.ts                  # NEW (Task 28) real-DI integration test
  approvals/
    approvals.module.ts                         # NEW (Task 29)
    approvals.service.ts                         # NEW (Task 29) state machine + idempotent posting
    approvals.controller.ts                     # NEW (Task 29)
    types.ts                                     # NEW (Task 29) Approval, ApprovalStatus
    approvals.service.spec.ts                   # NEW (Task 29) real-DI integration test
    approvals.controller.spec.ts                # NEW (Task 29)
  audit-findings/
    audit-findings.module.ts                    # NEW (Task 30)
    audit-findings.service.ts                    # NEW (Task 30)
    audit-findings.controller.ts                # NEW (Task 30)
    types.ts                                     # NEW (Task 30) AuditFinding, Severity, FindingStatus
    audit-finding.controller.spec.ts            # NEW (Task 30)
  agents/
    agents.module.ts                            # NEW (Task 30)
    accounting.agent.ts                         # NEW (Task 30) stub
    reconciliation.agent.ts                     # NEW (Task 30) stub
    audit.agent.ts                              # NEW (Task 30) sweep() + @Cron()
    secretary.agent.ts                          # NEW (Task 30) notify() logs only
    dev.agent.ts                                # NEW (Task 30) stub, disabled by default
    agents.service.spec.ts                      # NEW (Task 30) real-DI integration test
  admin/
    admin.module.ts                             # NEW (Task 31)
    admin.controller.ts                         # NEW (Task 31) GET-only + lock alias
    admin.service.ts                            # NEW (Task 31) aggregations
    admin-key.guard.ts                          # NEW (Task 31) X-Admin-Key: dev
    admin.controller.spec.ts                    # NEW (Task 31)
  app.module.ts                                 # EXTEND: import VatReport/Approvals/AuditFindings/Agents/Admin + ScheduleModule
```

**Conventions to honor in every task**
- Schema (`createTable`, `ALTER`, triggers) lives ONLY in `src/database/migrations/` and is registered in `index.ts` (G4). Grep gate at wave end: `grep -rn "createTable\|CREATE TABLE\|CREATE TRIGGER" src --include=*.ts | grep -v "src/database/migrations/"` must be empty.
- Every cross-module behavior (locked-period rejection, VAT snapshot immutability, approval → posting) gets a real-DI integration test on in-memory SQLite that runs the real migration (copy `src/currency/currency.resolution.spec.ts`) (G2).
- DB invariants (`locked` period rejection enforced at the kernel; VAT snapshot immutability) are proven by a test that the DB/kernel rejects the violating write, not just app code (G6). No break-glass (ADR-0012).
- Money in cents (INTEGER); examples use **EUR**; never hardcode currency in production code — read base currency via the Wave-1 resolution.
- Controllers follow `src/health/health.controller.ts` style; services inject Kysely via `@InjectKysely()`.
- Use `Math.floor(Date.now() / 1000)` for epoch-second timestamps (matches `001_create_organization.ts`); set non-default values in tests (G3).

---

## Tasks

### 27. ReportingPeriod lock + filing guard

Implements ADR-0009/0015: a period locks on filing (idempotent), and `PostingService` rejects any voucher whose `tax_point_date` falls in a locked period — the non-overridable hard process rule (ADR-0012). A warn-only filing guard surfaces unresolved in-period items but never blocks the lock.

**Files:**
- `src/reporting-periods/reporting-periods.service.ts` (EXTEND)
- `src/reporting-periods/reporting-periods.controller.ts` (EXTEND)
- `src/ledger/posting/posting.service.ts` (EXTEND)
- `src/reporting-periods/reporting-periods-lock.spec.ts` (NEW — real-DI integration)
- `src/ledger/posting/posting.locked-period.spec.ts` (NEW — real-DI integration)

Steps:

- [ ] Write the FULL failing real-DI integration test `src/reporting-periods/reporting-periods-lock.spec.ts`. Copy the harness from `currency.resolution.spec.ts` (in-memory SQLite, `migrateToLatest`, real providers `ReportingPeriodsService` + its deps). Seed an `open` period via the service/CRUD (e.g. `{ name: 'Q1-2026', start_date: '2026-01-01', end_date: '2026-03-31', status: 'open' }`). Assert:
  - `await service.lock(periodId)` returns a period with `status === 'locked'` and `filed_at` non-null (a non-default value: assert it is a number `> 0`, G3).
  - Calling `service.lock(periodId)` a second time resolves (idempotent) and keeps `status === 'locked'` with the SAME `filed_at` (does not re-stamp).
  - `service.isLocked('2026-02-15')` resolves `true` (tax-point inside the locked range) and `service.isLocked('2026-04-15')` resolves `false`.
  - `service.getWarnings(periodId)` resolves an object `{ pendingApprovals: [...], unpostedDrafts: [...] }` (arrays present; may be empty when no expenses/approvals seeded — assert it returns the shape, not a throw).
- [ ] Run `npx jest src/reporting-periods/reporting-periods-lock.spec.ts` → EXPECT FAIL (`lock`, `isLocked`, `getWarnings` undefined).
- [ ] Write the FULL minimal impl in `reporting-periods.service.ts`:
  - `async lock(id: number): Promise<ReportingPeriod>` — read the period; if already `locked`, return it unchanged (idempotent, no error, no re-stamp); else `updateTable('reporting_period').set({ status: 'locked', filed_at: Math.floor(Date.now()/1000) }).where('id','=',id)`. Throw `NotFoundException` if missing.
  - `async isLocked(taxPointDate: string): Promise<boolean>` — `selectFrom('reporting_period').where('status','=','locked').where('start_date','<=',taxPointDate).where('end_date','>=',taxPointDate)` → `executeTakeFirst()` is defined.
  - `async getWarnings(id: number): Promise<{ pendingApprovals: ...; unpostedDrafts: ... }>` — query expenses/approvals (where those tables exist) with `tax_point_date` in `[start_date, end_date]` and status `pending`/`draft`; return both arrays. Guard against absent optional tables by returning `[]`.
- [ ] Add controller routes in `reporting-periods.controller.ts`: `@Post(':id/lock')` → `service.lock(+id)`; `@Get(':id/warnings')` → `service.getWarnings(+id)`.
- [ ] Run `npx jest src/reporting-periods/reporting-periods-lock.spec.ts` → EXPECT PASS.
- [ ] Write the FULL failing real-DI integration test `src/ledger/posting/posting.locked-period.spec.ts`. Boot the real DI graph (Kysely in-memory, migrations, real `PostingService` + `LedgerValidationService` + `ReportingPeriodsService`, accounts seeded by migration). Seed and LOCK a period covering `2026-02`. Assert:
  - Posting a balanced EUR voucher with `tax_point_date: '2026-02-15'` (lines: Dr `EXPENSE_SOFTWARE` 10000 / Cr `CASH` 10000, currency `'EUR'`, base_amount 10000, fx_rate 1) **rejects** with a `BadRequestException` whose message contains `Cannot post into locked period` and the period name.
  - After rejection, `selectFrom('voucher').selectAll().execute()` returns zero rows for that voucher_number (atomic — no partial insert, G6).
  - A control: posting the same shape with `tax_point_date: '2026-04-15'` (an OPEN period) succeeds with `posted_at` non-null (proves the guard discriminates, G3).
- [ ] Run `npx jest src/ledger/posting/posting.locked-period.spec.ts` → EXPECT FAIL (post into locked period currently succeeds).
- [ ] Write the FULL minimal impl in `posting.service.ts`: inject `ReportingPeriodsService`; at the start of `postVoucher`, BEFORE the transaction inserts, `if (await this.reportingPeriods.isLocked(draft.tax_point_date)) throw new BadRequestException(\`Cannot post into locked period \${periodName}\`)` — fetch the locking period's `name` for the message. Wire `ReportingPeriodsModule` into the ledger/posting module imports. This is a hard process rule with NO override path (ADR-0012) — do not add a bypass flag.
- [ ] Run `npx jest src/ledger/posting/posting.locked-period.spec.ts` → EXPECT PASS.
- [ ] **Must NOT do** check (G5): no VAT report computation on lock (Task 28 only); no amended-return logic; lock is never auto-rejected when warnings exist (warn-only). Grep the diff to confirm none introduced.
- [ ] **Commit** (G1): run `npm run build && npm run lint && npm run test && npm run test:e2e` — ALL green — then `git commit -m "feat(periods): reporting period lock + filing guard"`.

---

### 28. VAT report snapshot

Implements ADR-0009/0013: filing freezes an immutable `vat_report` snapshot of the exact included vouchers, grouped by VAT code into input/output sums with net payable/receivable in EUR base currency. Immutability is a real DB constraint (a `BEFORE UPDATE`/`BEFORE DELETE` trigger in a migration) plus a 405 at the API. Merkle root reserved as NULL, logic deferred.

**Files:**
- `src/database/migrations/020_create_vat_report.ts` (NEW — table + immutability trigger)
- `src/database/migrations/index.ts` (EXTEND)
- `src/database/types.ts` (EXTEND — `VatReportTable`)
- `src/vat-report/vat-report.module.ts` (NEW)
- `src/vat-report/vat-report.service.ts` (NEW)
- `src/vat-report/vat-report.controller.ts` (NEW)
- `src/vat-report/types.ts` (NEW)
- `src/vat-report/vat-report.service.spec.ts` (NEW — real-DI integration)
- `src/app.module.ts` (EXTEND)

Steps:

- [ ] Write the migration `020_create_vat_report.ts` FIRST (schema only in migrations, G4). `createTable('vat_report')`: `id` integer PK autoincrement, `period_id` integer NOT NULL FK→`reporting_period(id)`, `generated_at` integer NOT NULL, `voucher_ids` text NOT NULL (JSON array), `vat_summary` text NOT NULL (JSON), `total_payable` integer NOT NULL, `total_receivable` integer NOT NULL, `merkle_root` text (NULL, with a comment `// deferred to v1+`). Then create an immutability trigger via `sql\`CREATE TRIGGER vat_report_immutable_update BEFORE UPDATE ON vat_report BEGIN SELECT RAISE(ABORT, 'VAT report is immutable'); END\`.execute(db)` and an equivalent `BEFORE DELETE` trigger. `down()` drops triggers + table. Register in `index.ts` as `'020_create_vat_report'`.
- [ ] Add `VatReportTable` to `src/database/types.ts` and to the `Database` interface.
- [ ] Define `src/vat-report/types.ts`: `interface VatSummaryLine { vat_code: string; input_base: number; output_base: number; }`, `interface VatReport { id: number; period_id: number; generated_at: number; voucher_ids: number[]; vat_summary: VatSummaryLine[]; total_payable: number; total_receivable: number; merkle_root: string | null; }`.
- [ ] Write the FULL failing real-DI integration test `src/vat-report/vat-report.service.spec.ts`. Boot the real graph (in-memory SQLite, migrations, `VatReportService` + `PostingService` + `ReportingPeriodsService` + accounts). Seed an `open` period `Q1-2026` (`2026-01-01`..`2026-03-31`). POST two real EUR vouchers inside the period using a non-trivial VAT split (G3): e.g. a sales voucher with `vat_code='IE_OUTPUT_23'` output base 2300, and a purchase voucher with `vat_code='IE_INPUT_23'` input base 1150. Lock the period. Then assert:
  - `const report = await service.generate(periodId)` returns a `VatReport` whose `voucher_ids` contains BOTH seeded voucher ids and excludes any voucher outside the period.
  - `vat_summary` groups by VAT code: the `IE_OUTPUT_23` line has `output_base === 2300`, the `IE_INPUT_23` line has `input_base === 1150`.
  - `total_payable === 2300` and `total_receivable === 1150` (output VAT owed vs input VAT reclaimed; non-equal values prove computation, G3).
  - `report.merkle_root === null` (reserved, deferred).
  - **Immutability (G6):** a raw `db.updateTable('vat_report').set({ total_payable: 0 }).where('id','=',report.id).execute()` REJECTS (expect the promise to reject with the trigger's `VAT report is immutable`); then re-read shows `total_payable` still `2300`.
- [ ] Run `npx jest src/vat-report/vat-report.service.spec.ts` → EXPECT FAIL (`VatReportService` does not exist).
- [ ] Write the FULL minimal impl `src/vat-report/vat-report.service.ts`. `async generate(periodId: number): Promise<VatReport>`: load the period (`NotFoundException` if missing); select all vouchers with `tax_point_date` in `[start_date, end_date]`; join `voucher_line`; group lines by `vat_code` summing `base_amount` into input (debit on VAT-receivable side) vs output (credit on VAT-payable side) — base the input/output split on the line's `vat_code` semantics and `is_debit`; compute `total_payable = Σ output_base`, `total_receivable = Σ input_base`; `insertInto('vat_report').values({ period_id, generated_at: now, voucher_ids: JSON.stringify(ids), vat_summary: JSON.stringify(summary), total_payable, total_receivable, merkle_root: null })` and return the parsed snapshot. Do NOT compute a real Merkle root.
- [ ] Write `src/vat-report/vat-report.controller.ts`: `@Post('api/reporting-periods/:id/vat-report')` → 201 with the snapshot; `@Get('api/vat-reports/:id')` → snapshot; `@Get('api/vat-reports/:id/vouchers')` → the included vouchers; explicit `@Put`/`@Patch`/`@Delete` on `api/vat-reports/:id` returning `405 Method Not Allowed` (immutable at the API too). Register `VatReportModule` in `app.module.ts`.
- [ ] Run `npx jest src/vat-report/vat-report.service.spec.ts` → EXPECT PASS.
- [ ] **Must NOT do** check (G5): no real Merkle computation (column stays NULL); no edit path for a generated report (trigger + 405 prove it); no country-specific declaration formats — JSON summary only.
- [ ] **Commit** (G1): `npm run build && npm run lint && npm run test && npm run test:e2e` green → `git commit -m "feat(periods): VAT report snapshot generation"`.

---

### 29. Approval lifecycle

Implements ADR-0015: a Policy-held submission becomes a pending `Approval` with states `pending → approved | rejected | superseded`, never auto-resolving. Approving releases idempotent posting (double-approve never double-posts); rejecting returns the draft to `draft` with a reason; superseding marks it superseded.

**Files:**
- `src/database/migrations/021_create_approval.ts` (NEW)
- `src/database/migrations/index.ts` (EXTEND)
- `src/database/types.ts` (EXTEND — `ApprovalTable`)
- `src/approvals/approvals.module.ts` (NEW)
- `src/approvals/approvals.service.ts` (NEW)
- `src/approvals/approvals.controller.ts` (NEW)
- `src/approvals/types.ts` (NEW)
- `src/approvals/approvals.service.spec.ts` (NEW — real-DI integration)
- `src/approvals/approvals.controller.spec.ts` (NEW)
- `src/app.module.ts` (EXTEND)

Steps:

- [ ] Write the migration `021_create_approval.ts` (G4): `createTable('approval')` — `id` integer PK autoincrement, `object_type` text NOT NULL (`expense`|`sales_invoice`), `object_id` integer NOT NULL, `status` text NOT NULL DEFAULT `'pending'` with a `check(sql\`status IN ('pending','approved','rejected','superseded')\`)` (real DB constraint, G6), `requested_by` text NOT NULL, `approved_by` text (NULL), `rejected_reason` text (NULL), `superseded_by` integer (NULL, FK→`approval(id)`), `created_at` integer NOT NULL, `resolved_at` integer (NULL). `down()` drops the table. Register `'021_create_approval'` in `index.ts`.
- [ ] Add `ApprovalTable` to `types.ts` + `Database`. Define `src/approvals/types.ts`: `type ApprovalStatus = 'pending'|'approved'|'rejected'|'superseded'`, `interface Approval { ... }`, `interface CreateApprovalDto { object_type; object_id; requested_by }`.
- [ ] Write the FULL failing real-DI integration test `src/approvals/approvals.service.spec.ts`. Boot the real graph (in-memory SQLite, migrations, `ApprovalsService` + `PostingService` + the expenses service/repo + accounts). Seed an `expense` in `pending` status with a balanced draft (gross 10000 EUR). Assert:
  - `const a = await service.create({ object_type: 'expense', object_id, requested_by: 'owner@example.com' })` → `a.status === 'pending'`, `resolved_at === null`.
  - `await service.approve(a.id)` → status `approved`, `resolved_at` non-null, AND the linked expense is now `posted` with a non-null `voucher_id`; exactly ONE voucher exists for it.
  - **Idempotency (G6/G3):** `await service.approve(a.id)` a SECOND time resolves without error and the voucher COUNT for that expense is still exactly 1 (no double-post).
  - Reject path: a fresh pending approval `b`; `await service.reject(b.id, 'Missing receipt')` → status `rejected`, `rejected_reason === 'Missing receipt'`, and the underlying expense returns to `status === 'draft'` (never discarded).
  - Supersede path: a fresh pending approval `c`; `await service.supersede(c.id, newApprovalId)` → status `superseded`, `superseded_by === newApprovalId`.
  - Guard: approving an already-`rejected` approval throws (cannot resolve a resolved approval); a timeout does nothing (no auto-resolve helper exists).
- [ ] Run `npx jest src/approvals/approvals.service.spec.ts` → EXPECT FAIL (`ApprovalsService` does not exist).
- [ ] Write the FULL minimal impl `src/approvals/approvals.service.ts`:
  - `create(dto)` — insert with `status: 'pending'`, `created_at: now`, return mapped row.
  - `approve(id)` — load; if `status === 'approved'` return it unchanged (idempotent re-tap); if not `pending` throw `ConflictException`; release posting via `PostingService.postVoucher` (or call the expense's post path) inside a transaction, set expense `status='posted'` + `voucher_id`, set approval `status='approved', approved_by, resolved_at=now`. Guard double-post by checking the expense already has a `voucher_id` before posting.
  - `reject(id, reason)` — load; require `pending`; set approval `status='rejected', rejected_reason=reason, resolved_at=now`; set the underlying draft `status='draft'`.
  - `supersede(id, supersededById)` — load; require `pending`; set `status='superseded', superseded_by, resolved_at=now`.
  - `list(filters)` / `listPending()` queries. NO auto-resolve / timeout method.
- [ ] Write `src/approvals/approvals.controller.ts`: `POST /api/approvals`, `POST /api/approvals/:id/approve`, `POST /api/approvals/:id/reject` (body `{ reason }`), `POST /api/approvals/:id/supersede`, `GET /api/approvals` (filters `status`,`type`), `GET /api/approvals/pending`. Register `ApprovalsModule` in `app.module.ts`.
- [ ] Write `src/approvals/approvals.controller.spec.ts` covering route → service wiring for approve and reject (NestJS TestingModule; service may be a provider with a real in-memory DB or a tightly-asserted double — but the state-transition + idempotency proof lives in the integration spec, G2).
- [ ] Run `npx jest src/approvals` → EXPECT PASS.
- [ ] **Must NOT do** check (G5): no real notification channels (Telegram/email) — state changes only; no approval UI; no auto-reject/auto-approve on timeout (assert no such method exists).
- [ ] **Commit** (G1): `npm run build && npm run lint && npm run test && npm run test:e2e` green → `git commit -m "feat(approvals): approval lifecycle with approve/reject/supersede"`.

---

### 30. AuditFinding + Agent stubs

Implements ADR-0018: the `audit_finding` table is the buffer that decouples detection from outreach. Five in-process NestJS agent services are scaffolded; `AuditAgent.sweep()` (on an `@Cron()` hourly schedule) writes sample findings; `SecretaryAgent.notify()` reads open findings and logs only (no real channels). AuditAgent is structurally read-only on the ledger.

**Files:**
- `src/database/migrations/022_create_audit_finding.ts` (NEW)
- `src/database/migrations/index.ts` (EXTEND)
- `src/database/types.ts` (EXTEND — `AuditFindingTable`)
- `src/audit-findings/audit-findings.module.ts` (NEW)
- `src/audit-findings/audit-findings.service.ts` (NEW)
- `src/audit-findings/audit-findings.controller.ts` (NEW)
- `src/audit-findings/types.ts` (NEW)
- `src/audit-findings/audit-finding.controller.spec.ts` (NEW)
- `src/agents/agents.module.ts` (NEW)
- `src/agents/{accounting,reconciliation,audit,secretary,dev}.agent.ts` (NEW)
- `src/agents/agents.service.spec.ts` (NEW — real-DI integration)
- `src/app.module.ts` (EXTEND — import `ScheduleModule.forRoot()` from `@nestjs/schedule`, AuditFindingsModule, AgentsModule)

Steps:

- [ ] Install scheduler if absent: `npm install @nestjs/schedule` (the `@Cron()` decorator source per the spec). Confirm it appears in `package.json` dependencies.
- [ ] Write the migration `022_create_audit_finding.ts` (G4): `createTable('audit_finding')` — `id` integer PK autoincrement, `finding_type` text NOT NULL (e.g. `missing_receipt`, `pending_approval`, `period_deadline`, `unmatched_bank`), `severity` text NOT NULL with `check(sql\`severity IN ('low','medium','high','critical')\`)` (G6), `description` text NOT NULL, `referenced_object_type` text, `referenced_object_id` integer, `status` text NOT NULL DEFAULT `'open'` with `check(sql\`status IN ('open','resolved','snoozed')\`)`, `created_at` integer NOT NULL, `resolved_at` integer (NULL). `down()` drops it. Register `'022_create_audit_finding'`.
- [ ] Add `AuditFindingTable` to `types.ts` + `Database`. Define `src/audit-findings/types.ts`: `type Severity = 'low'|'medium'|'high'|'critical'`, `type FindingStatus = 'open'|'resolved'|'snoozed'`, `interface AuditFinding { ... }`, `interface CreateAuditFindingDto { ... }`.
- [ ] Write the FULL failing real-DI integration test `src/agents/agents.service.spec.ts`. Boot the real graph (in-memory SQLite, migrations, `AuditAgent`, `SecretaryAgent`, `AuditFindingsService`). Assert:
  - `await auditAgent.sweep()` creates ≥1 `audit_finding` row (query the DB; assert `count >= 1`, severity is one of the enum values — a non-default discriminating check, G3).
  - The `@Cron()` decorator is present on `AuditAgent.sweep` — assert via `Reflect.getMetadata` for the schedule metadata key, OR assert the method is registered (e.g. metadata key `SCHEDULE_CRON_OPTIONS` exists). Keep it a real assertion, not a comment.
  - `SecretaryAgent.notify()` returns/logs the open findings count without making external calls — spy on the Nest `Logger` (or the injected logger) and assert it was called with a message containing `would notify`, and assert NO HTTP/network client is invoked (there is none injected).
  - The three inert stubs (`AccountingAgent`, `ReconciliationAgent`, `DevAgent`) are instantiable `@Injectable()` providers (resolve from the module) and `DevAgent` is disabled by default (e.g. exposes `enabled = false`).
- [ ] Run `npx jest src/agents/agents.service.spec.ts` → EXPECT FAIL (agents do not exist).
- [ ] Write the FULL minimal impl:
  - `src/audit-findings/audit-findings.service.ts` — `create(dto)`, `list({ severity? })`, `resolve(id)` (set `status='resolved', resolved_at=now`), `snooze(id)` (set `status='snoozed'`), `listOpen()`.
  - `src/audit-findings/audit-findings.controller.ts` — `POST /api/audit-findings`, `GET /api/audit-findings` (`?severity=`), `POST /api/audit-findings/:id/resolve`, `POST /api/audit-findings/:id/snooze`.
  - `src/agents/audit.agent.ts` — `@Injectable()`; inject `AuditFindingsService`; `@Cron(CronExpression.EVERY_HOUR) async sweep()` creates sample findings (e.g. one `pending_approval` high, one `missing_receipt` medium) via the service. NO ledger access (read-only by construction — do not inject `PostingService`).
  - `src/agents/secretary.agent.ts` — `@Injectable()`; inject `AuditFindingsService` + `Logger`; `async notify()` reads `listOpen()` and `logger.log('would notify user about N open findings')`. No channels.
  - `src/agents/{accounting,reconciliation,dev}.agent.ts` — `@Injectable()` stubs; `DevAgent` with `readonly enabled = false`.
  - `src/agents/agents.module.ts` + `src/audit-findings/audit-findings.module.ts`; register both in `app.module.ts` and add `ScheduleModule.forRoot()`.
- [ ] Write `src/audit-findings/audit-finding.controller.spec.ts` covering create + list-with-severity-filter route wiring.
- [ ] Run `npx jest src/agents src/audit-findings` → EXPECT PASS.
- [ ] **Must NOT do** check (G5): no real agent logic (AI/OCR/reconciliation algorithms); no external channel integration (log only — grep for telegram/slack/email clients = none); agents are in-process services, not separate processes (no `child_process`/`fork`).
- [ ] **Commit** (G1): `npm run build && npm run lint && npm run test && npm run test:e2e` green → `git commit -m "feat(agents): AuditFinding schema + 5 agent stubs"`.

---

### 31. Admin API endpoints

Read-only diagnostics (plus the lock alias) behind a simple `X-Admin-Key: dev` guard. JSON only, no frontend, no RBAC, no mutation of posted vouchers.

**Files:**
- `src/admin/admin.module.ts` (NEW)
- `src/admin/admin.controller.ts` (NEW)
- `src/admin/admin.service.ts` (NEW)
- `src/admin/admin-key.guard.ts` (NEW)
- `src/admin/admin.controller.spec.ts` (NEW)
- `src/app.module.ts` (EXTEND)

Steps:

- [ ] Write the FULL failing test `src/admin/admin.controller.spec.ts`. Boot the real graph (in-memory SQLite, migrations seed the ≥20 canonical accounts, `AdminService` + `AdminModule` + the guard). Use NestJS `INestApplication` + `supertest`. Assert:
  - `GET /admin/accounts` WITHOUT the header → `401`.
  - `GET /admin/accounts` WITH `X-Admin-Key: dev` → `200` and `body.accounts.length >= 20` (discriminating non-default count, G3); each account carries a computed `balance` (sum of voucher lines, 0 when none posted).
  - `GET /admin/accounts` WITH `X-Admin-Key: wrong` → `401`.
  - `GET /admin/vouchers?from=2026-01-01&to=2026-03-31` with the key → `200` array; the date-range filter excludes a voucher dated `2026-05-01` (seed two vouchers in different periods to prove the filter discriminates).
  - `GET /admin/approvals/pending` with the key → `200`, only `pending` approvals.
  - `GET /admin/findings/open` with the key → `200`, only `open` findings.
- [ ] Run `npx jest src/admin/admin.controller.spec.ts` → EXPECT FAIL (`AdminModule` does not exist).
- [ ] Write `src/admin/admin-key.guard.ts`: a `CanActivate` guard reading `request.headers['x-admin-key']`; if it !== `'dev'` throw `UnauthorizedException` (401). (Hardcoded dev key per spec — no real auth system.)
- [ ] Write `src/admin/admin.service.ts` (aggregations reusing existing services/repos where possible): `listAccountsWithBalances()` (left join voucher_line, sum signed `base_amount`), `listVouchers({ from?, to?, period?, status? })`, `getVoucher(id)` with lines, `listPeriods()`, `listApprovals({ status? })`, `listPendingApprovals()`, `listFindings()`, `listOpenFindings()`, `adminHealth()` (public health shape + a `SELECT 1` DB connectivity probe).
- [ ] Write `src/admin/admin.controller.ts`: `@Controller('admin')` with `@UseGuards(AdminKeyGuard)`; GET routes `accounts`, `vouchers`, `vouchers/:id`, `periods`, `approvals`, `approvals/pending`, `findings`, `findings/open`, `health`; plus `@Post('periods/:id/lock')` delegating to `ReportingPeriodsService.lock` (the only state transition; read-only for the ledger otherwise). Register `AdminModule` in `app.module.ts`.
- [ ] Run `npx jest src/admin/admin.controller.spec.ts` → EXPECT PASS.
- [ ] **Must NOT do** check (G5): no React/Vite frontend (grep clean of `.tsx`/vite); no RBAC beyond the one hardcoded key; no admin route mutates a posted voucher (GET-only on the ledger except the period-lock alias).
- [ ] **Commit** (G1): `npm run build && npm run lint && npm run test && npm run test:e2e` green → `git commit -m "feat(admin): read-only admin API endpoints"`.

---

## Wave-end verification (G8)

Before declaring Wave 6 done, run the per-wave mini compliance pass:

- [ ] **Plan-compliance:** every "Must Have" present — period lock + locked-period posting rejection, immutable VAT snapshot, full approval lifecycle, 5 agent stubs with AuditAgent sweep, read-only Admin API with key auth.
- [ ] **Code-quality (G1):** `npm run build && npm run lint && npm run test && npm run test:e2e` all green, exactly as CI runs them. No `as any` slop, no empty catches, no dead code.
- [ ] **Scope-fidelity (G4/G5/G6):**
  - `grep -rn "createTable\|CREATE TABLE\|CREATE TRIGGER" src --include=*.ts | grep -v "src/database/migrations/"` → empty.
  - Every "Must NOT do" greps clean (no Merkle computation, no notification channels, no frontend, no break-glass / no override of the locked-period rule, no auto-resolve on approvals).
  - DB invariants proven by a test that the DB/kernel rejects the violating write: locked-period posting rejection (Task 27), VAT snapshot immutability trigger (Task 28), approval idempotency (Task 29) — all on real in-memory SQLite (G2/G6).
- [ ] Final wave commit if the spec requires an umbrella commit: `feat(agents): period lock + VAT report + approvals + agents + admin`.
