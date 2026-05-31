# Wave 6: Agents & Admin — Learnings

## Task 30: AuditFinding + Agent stubs

### What was built
- `audit_finding` table (migration 018): id, finding_type, severity (low/medium/high/critical), description, referenced_object_type, referenced_object_id, status (open/resolved/snoozed), created_at, resolved_at
- `AuditFindingsModule`: service + controller with CRUD endpoints
  - `POST /api/audit-findings` — creates a finding
  - `GET /api/audit-findings?severity=high` — lists findings with optional severity filter
  - `POST /api/audit-findings/:id/resolve` — marks as resolved
  - `POST /api/audit-findings/:id/snooze` — marks as snoozed
- `AgentsModule` with 5 in-process NestJS service stubs:
  - `AccountingAgent` — empty stub, `@Injectable()`
  - `ReconciliationAgent` — empty stub
  - `AuditAgent` — `sweep()` method creates sample AuditFinding, `@Cron('0 * * * *')` (hourly)
  - `SecretaryAgent` — `notify()` logs open findings to console (no external calls)
  - `DevAgent` — empty stub, `isEnabled()` checks `DEV_AGENT_ENABLED` env var (default: false)

### Key decisions
- All agents are in-process NestJS services (not separate processes) — ADR-0018
- `@nestjs/schedule` was already installed; `ScheduleModule.forRoot()` imported in AgentsModule
- AuditFinding is the buffer decoupling detection (AuditAgent) from outreach (SecretaryAgent)
- Severity drives nag cadence: low → ~daily, high → ~hourly (deferred to later wave)
- SecretaryAgent.notify() is console-only in v1 — no Telegram/Slack/email integration
- Real-DI integration tests: in-memory SQLite + full migration run per test suite

### Patterns followed
- Migration in `src/database/migrations/` with `up`/`down` functions
- Table type added to `Database` interface in `src/database/types.ts`
- Module imports `DatabaseModule`, exports service for cross-module use
- Controller uses `@Body()`, `@Query()`, `@Param()` with `ParseIntPipe`
- Types imported with `import type` for decorated signatures (isolatedModules + emitDecoratorMetadata)
- Tests use real Kysely + SQLite in-memory, run all migrations via Migrator

### Gotchas
- `import type` required for DTOs used in `@Body()`/`@Query()` decorated params (TS1272)
- Migration index must be updated both in imports AND in the `migrations` record
- `@nestjs/schedule` needs `ScheduleModule.forRoot()` in the importing module (not just providers)

## Task 29: Approval lifecycle

### What was built
- `approval` table (migration 019): id, object_type (expense/sales_invoice), object_id, status (pending/approved/rejected/superseded), requested_by, approved_by (nullable), rejected_reason (nullable), superseded_by (FK to approval, nullable), created_at, resolved_at (nullable)
- `ApprovalsModule`: service + controller with full lifecycle endpoints
  - `POST /api/approvals` — creates a pending approval, transitions business object from draft → pending
  - `POST /api/approvals/:id/approve` — approves and posts voucher, idempotent (second call returns same voucher)
  - `POST /api/approvals/:id/reject` — rejects, returns business object to draft
  - `POST /api/approvals/:id/supersede` — supersedes a pending approval
  - `GET /api/approvals?status=pending&object_type=expense` — lists with filters
  - `GET /api/approvals/pending` — lists only pending approvals
- 29 real-DI integration tests (15 service + 14 controller)

### Key decisions
- `createApproval` atomically transitions business object from `draft` → `pending` (matches posting pipeline's `claimForApproval`)
- `approveApproval` generates draft voucher BEFORE the transaction to avoid deadlock (generateDraftVoucher uses `this.db`, not transaction handle; better-sqlite3 has single connection)
- Idempotent posting: if approval is already `approved`, returns existing voucher without double-posting
- Reject returns business object to `draft` status (can be re-submitted)
- Supersede requires the superseding approval to exist (NotFoundException if not)
- ApprovalsService injects ExpensesService + SalesInvoicesService to regenerate draft vouchers at approve time

### Patterns followed
- Migration 019 (018 was already taken by audit_finding)
- Table type added to `Database` interface in `src/database/types.ts`
- Module imports DatabaseModule, AccountModule, PostingModule, ExpensesModule, SalesInvoicesModule
- Controller uses `import type` for all DTOs and return types
- Real-DI tests: in-memory SQLite + full migration run, real service instances via DI
- Transaction discipline: all DB writes inside `db.transaction().execute()`, reads outside when they use `this.db`

### Gotchas
- **Deadlock inside transactions**: calling methods that use `this.db` (main Kysely instance) inside a `db.transaction().execute()` callback causes a hang with better-sqlite3. Generate drafts and resolve accounts BEFORE the transaction, then only do writes inside.
- Migration number collision: 018 was already used by `create_audit_finding`, so approval became 019
- `ApprovalTable` interface must be added to both the `Database` interface AND as a standalone interface in `src/database/types.ts`
