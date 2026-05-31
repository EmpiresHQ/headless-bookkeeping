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

## Task 31: Admin API endpoints

### What was built
- `AdminModule` (src/admin/): read-only diagnostics API with simple API key auth
  - `AdminKeyGuard` — CanActivate guard checking `x-admin-key === 'dev'`, with `@Public()` decorator for exempt routes
  - `AdminService` — aggregation queries: accounts with balance, vouchers with date filter, voucher with lines, periods, approvals, findings; delegates locking to ReportingPeriodsService
  - `AdminController` — GET routes: accounts, vouchers, vouchers/:id, periods, approvals, approvals/pending, findings, findings/open, health; POST periods/:id/lock
  - `AdminController` spec — 16 real-DI integration tests with in-memory SQLite + supertest

### Key decisions
- Auth is a simple guard: `x-admin-key === 'dev'` (no RBAC, no JWT)
- `@Public()` decorator marks health endpoint as exempt from auth
- Accounts with balances: LEFT JOIN voucher_line, SUM signed base_amount per account
- Voucher date filter: `from`/`to` query params on `tax_point_date`
- All mutations go through existing services (lock → ReportingPeriodsService)
- No new migrations needed — all data sources exist from Tasks 27-30

### Patterns followed
- Real-DI integration tests: in-memory SQLite + full migration run per test suite
- Guard uses Reflector for public route detection
- Direct DB queries for read aggregation, existing service for mutation
- Controller uses @UseGuards at class level, @Public() for exceptions

### Gotchas
- `sql` template tag from Kysely needed for raw SQL in aggregations
- Account codes are named (CASH, AR, AP) not numeric — test seed data uses these
- Migration index had stale reference to non-existent 024_add_dividend_accounts — fixed

## Task 28: VAT report snapshot generation

### What was built
- `vat_report` table (migration 020): id, reporting_period_id (FK), period_name, start_date, end_date, vat_summary (JSON string), total_input_vat, total_output_vat, total_payable, total_receivable, voucher_ids (JSON string), merkle_root (NULL), generated_at
- Immutability triggers: BEFORE UPDATE and BEFORE DELETE that RAISE(ABORT, 'VAT report is immutable')
- `VatReportModule`: service + controller
  - `POST /api/reporting-periods/:id/vat-report` — generate (or retrieve existing) snapshot
  - `GET /api/vat-reports/:id` — fetch report by ID
  - `GET /api/vat-reports/:id/vouchers` — fetch voucher IDs included in report
  - `PUT/PATCH/DELETE /api/vat-reports/:id` — 405 MethodNotAllowed (immutable)
- `VatReportService.generate()`: queries posted vouchers with tax_point_date in period range, joins voucher_line, groups by vat_code (filtering out null VAT codes), splits input (debit) vs output (credit), computes totals, stores snapshot with merkle_root=null
- 15 real-DI integration tests covering aggregation, totals, immutability, idempotency, period boundaries, unposted exclusion, and 405 guards

### Key decisions
- Only lines with explicit VAT codes contribute to the VAT summary (null VAT code lines like CASH, REVENUE are filtered out)
- `is_debit=1` → input_vat (purchases), `is_debit=0` → output_vat (sales)
- `total_payable = total_output_vat - total_input_vat` (positive = net payable to tax authority)
- `total_receivable = total_input_vat - total_output_vat` (positive = net reclaimable)
- `merkle_root` stays NULL (deferred to Task 29)
- Idempotent: re-generating for same period returns existing snapshot
- `voucher_ids` and `vat_summary` stored as JSON strings (Kysely has no native JSON column type for SQLite)

### Patterns followed
- Migration 020 registered in index.ts (both import AND record entry)
- `VatReportTable` added to `Database` interface in `src/database/types.ts`
- Module imports `DatabaseModule`, exports service
- Controller uses `MethodNotAllowedException` for immutability guards (matching voucher.controller.ts pattern)
- Real-DI tests: in-memory SQLite + full migration run, raw `db.updateTable`/`db.deleteFrom` to prove trigger enforcement
- `Math.floor(Date.now() / 1000)` for timestamps

### Gotchas
- Migration index must be updated in BOTH the import statement AND the migrations record — a stale reference to non-existent 023 caused test failures
- Controller 405 methods throw synchronously (not async) — test assertions use `expect(() => ...).toThrow()` not `rejects.toThrow()`
- Test data must be realistic: only VAT-relevant lines (expense lines, VAT payable/receivable) carry VAT codes; CASH/REVENUE/AR lines have `vat_code: null`

## Task 36: Conversation aggregate + deterministic router resolution

### What was built
- `conversation` table (migration 023): id, channel (telegram/email/slack/api), thread_key, status (open/closed), created_at, updated_at, closed_at (nullable), unique(channel, thread_key)
- `message` table: id, conversation_id (FK), direction (inbound/outbound), sender, body, threading_keys (nullable), dkim_spf_pass (nullable), created_at
- `artifact` table: id, conversation_id (FK), kind (inbound_attachment/outbound_output), document_id (FK nullable), storage_path, created_at
- `conversation_document` M:N table: (conversation_id, document_id) composite PK
- `conversation_business_object` M:N table: (conversation_id, object_type, object_id) composite PK
- `ConversationsModule`: service + controller
  - `POST /api/conversations/resolve` — deterministic lookup by (channel, thread_key); reopens closed + logs
  - `POST /api/conversations/messages` — append message to conversation
  - `POST /api/conversations/artifacts` — attach artifact (inbound/outbound)
  - `POST /api/conversations/associate` — M:N link to business object
  - `POST /api/conversations/associate-document` — M:N link to document
  - `POST /api/conversations/:id/close` — close conversation (blocked if non-terminal objects)
  - `GET /api/conversations` — list all
  - `GET /api/conversations/:id` — get by ID with hydrated messages/artifacts
  - `GET /api/conversations/for-object?object_type=&object_id=` — get associated conversations for correction context
- 26 real-DI integration tests

### Key decisions
- Resolution is **deterministic** by (channel, thread_key) — no LLM/probabilistic routing (ADR-0016)
- Reopening a closed conversation logs the transition via `console.log` and resets status to 'open'
- `close()` checks associated business objects: expense terminal = posted/reversed; sales_invoice terminal = posted/reversed
- `getForObject()` returns **all** associated conversations including closed ones — correction context pulls back closed threads
- M:N associations are idempotent (`.ignore()` on insert)
- Conversation is operational/auditable, **NOT** hash-chained (ledger stays system of record)
- `list()` orders by `id DESC` (more reliable than `created_at DESC` for same-second inserts)

### Patterns followed
- Migration 023 registered in index.ts (both import AND record entry)
- Table types added to `Database` interface in `src/database/types.ts`
- Module imports `DatabaseModule`, exports service for cross-module use
- Controller uses `import type` for all DTOs (isolatedModules + emitDecoratorMetadata)
- Real-DI tests: in-memory SQLite + full migration run per test suite
- `Math.floor(Date.now() / 1000)` for timestamps
- `dkim_spf_pass` stored as SQLite integer (0/1/null), mapped to boolean in domain types

### Gotchas
- Migration index had stale reference to non-existent 024_add_dividend_accounts — fixed by rewriting index.ts
- Sales invoice terminal statuses are `posted`/`reversed` (not `sent`/`cancelled`) — CHECK constraint is `('draft', 'pending', 'posted', 'reversed')`
- Same-second inserts have identical `created_at` — ordering by `id` is more deterministic
- `import type` required for all DTOs used in `@Body()`/`@Query()` decorated params (TS1272)

## Task 37: Dividend distribution (declaration + settlement disposition)

### What was built
- `RETAINED_EARNINGS` (equity), `DIVIDEND_PAYABLE` (liability), `DIVIDEND_WITHHOLDING_TAX_PAYABLE` (liability) accounts seeded via migration 024 into the existing `account` table
- `CountryPlugin` interface extended with:
  - `dividendWithholdingRate(orgContext): number` — fraction (0.0–1.0) of gross dividend withheld
  - `assertDistributable(grossAmount, retainedEarnings, orgContext): boolean` — profits-cap check
- `NullCountryPlugin`: withholding 0%, soft profits-check (warn via Logger, never block)
- `DividendsModule`: service + controller
  - `POST /api/dividends` — declare dividend, posts through pipeline (Rules → Policy → post)
    - Dr RETAINED_EARNINGS (gross) / Cr DIVIDEND_PAYABLE (net) [+ Cr DIVIDEND_WITHHOLDING_TAX_PAYABLE if rate > 0]
    - Plugin-driven withholding split and distributable-profits check
  - `POST /api/bank-transactions/:id/dividend` — settle against bank txn with status 'dividend'
    - Posts settlement voucher: Dr DIVIDEND_PAYABLE / Cr BANK_EUR
    - Creates N:M reconciliation_match linking bank txn to declaration voucher
- 8 real-DI integration tests: declaration, settlement, validation, withholding split (mock plugin), profits-check

### Key decisions
- Dividend is an **equity distribution** (ADR-0023), NOT a P&L expense — Dr RETAINED_EARNINGS, never an expense account
- Withholding and profits-cap are **country-plugin rules only** (ADR-0002) — kernel never hardcodes
- Declaration goes through the **full pipeline** (postingService.postVoucher), never writes ledger directly (ADR-0012/0019)
- Settlement uses **reconciliation_match N:M link** (Wave 5 pattern) — bank txn linked to declaration voucher
- `COUNTRY_PLUGIN_TOKEN` injection token allows test overrides (mock plugin with 27% withholding)
- Retained-earnings balance computed from ledger: credits − debits on RETAINED_EARNINGS account
- Bank transaction status 'dividend' was already reserved in Wave 5 disposition enum

### Patterns followed
- Migration 024 in `src/database/migrations/` — seeds accounts into existing table, no new table
- Migration index updated in BOTH import AND record entry
- `import type` for CountryPlugin interface and all DTOs (isolatedModules + emitDecoratorMetadata)
- Module uses `{ provide: COUNTRY_PLUGIN_TOKEN, useClass: NullCountryPlugin }` for injectable plugin
- Real-DI tests: in-memory SQLite + full migration run, mock plugin via `useClass` for withholding test
- `Math.floor(Date.now() / 1000)` for timestamps

### Gotchas
- Migration index had stale reference to non-existent 023_create_conversation (from concurrent work) — fixed by rewriting index.ts with all existing migrations (001-020, 023, 024)
- `CountryPlugin` must be imported with `import type` when used in `@Inject()` decorated constructor param (TS1272)
- Mock plugin test requires `{ provide: COUNTRY_PLUGIN_TOKEN, useClass: MockWithholdingPlugin }` — not just adding the mock as a provider
