# Work Plan — Headless Bookkeeping Kernel (6 Deployable Waves)

## TL;DR

> **Quick Summary**: Implement the core accounting kernel for a headless, AI-native bookkeeping OS in 6 deployable waves, from database scaffolding through ledger, posting pipeline, intake/triage, reconciliation, and agent/period infrastructure. Each wave is runnable via `docker compose up` and verifiable via agent-executed QA.
>
> **Deliverables**:
> - Wave 1: NestJS + Kysely migration runner, Organization singleton, CountryPlugin interface, health endpoint
> - Wave 2: Canonical Account chart, Voucher + VoucherLine, double-entry validation, posting service, immutability
> - Wave 3: Business objects (Expense, SalesInvoice), Rules engine (structural/hard/semantic), Policy gate, Override logging
> - Wave 4: Document intake + dedup, OCR triage stub, correction flow, ReportingPeriod schema
> - Wave 5: BankStatement + matching engine, prepayments, personal disposition, FX realized auto-posting
> - Wave 6: Period lock + VAT report snapshot, Approval lifecycle, AuditFinding + agent stubs, Admin API endpoints
>
> **Estimated Effort**: Large (6 waves, ~30 tasks, 34 total with final verification)
> **Parallel Execution**: YES — 6 waves, 5 tasks per wave avg, max 5 concurrent per wave
> **Critical Path**: Wave 1 → Wave 2 → Wave 3 → Wave 4/5 → Wave 6 → F1-F4

---

## Context

### Original Request
"Давай попробуем поработать над prds, по первым нескольким adrs, нам нужны deployable waves" — Build work plan PRDs for the first ADRs, organized as deployable waves.

### Interview Summary
**Key Discussions**:
- **Scope**: All ADRs 0001-0018 in 6 deployable waves, from foundation to agents+admin
- **Test strategy**: Tests-after + agent QA (jest exists, build currently passes)
- **Wave structure**: 6 waves (maximized detail/parallelism), not 3 or 4
- **Admin UI**: No React/Vite frontend; Wave 6 includes minimal admin API endpoints only
- **Deferred to v1+**: Depreciation engine (0007), bad debt deep logic (0008), crypto integrity (0013), admin UI frontend

**Research Findings**:
- Current codebase: ~129 lines, 80% NestJS boilerplate, 20% custom (Kysely+better-sqlite3 wired)
- Build passes (`npm run build`, `npm run test` — 1 unit test for placeholder `users` table)
- No domain code exists; only `users` table placeholder
- No migration system exists — schema created ad-hoc in `onModuleInit()`
- Kysely 0.29.2 + better-sqlite3 dialect already configured via `nestjs-kysely`
- Design docs (18 ADRs + CONTEXT.md + VISION.md + CONFIG.md) are mature and comprehensive

### Metis Review
**Identified Gaps (addressed)**:
1. **No migration system** → Wave 1 task 0: Kysely migration runner with `migrateToLatest`
2. **CountryPlugin interface undefined** → Wave 1: Design interface + `NullCountryPlugin` stub
3. **Approval added too late** → Wave 3: Reserve Policy gate with `autoApprove: true` default
4. **Hash chain deferred but schema not reserved** → Wave 2: Add `previous_hash` column to `voucher` (nullable)
5. **FX rate source undefined** → Wave 1: Stub FX rate service
6. **Document storage unspecified** → Wave 4: Filesystem storage (`data/documents/`), SQLite holds metadata+hash only

---

## Work Objectives

### Core Objective
Implement a working accounting kernel with double-entry ledger, posting pipeline, document intake, bank reconciliation, and period/agent infrastructure — in 6 runnable increments, each deployable and testable.

### Concrete Deliverables
- 6 waves of NestJS modules with Kysely SQLite persistence
- Kysely migration system with versioned schema files
- Canonical chart of accounts (kernel-level, country-agnostic)
- Immutable voucher log with double-entry validation
- Business object → draft → Rules → Policy → posted Voucher flow
- Document intake with hash-based deduplication
- Bank statement matching with N:M reconciliation
- Reporting period + VAT report snapshot
- Approval lifecycle with pending/approved/rejected/superseded states
- Agent scaffolding (5 agents as cron stubs)
- Admin API endpoints for diagnostics and reviews

### Definition of Done
Each wave completes when:
- [ ] `docker compose up` starts successfully and health endpoint responds `200 OK`
- [ ] All new code compiles (`npm run build` passes with zero errors)
- [ ] At least one new test file exists and passes (`npm test` includes new tests)
- [ ] Agent-executed QA scenarios pass with evidence captured
- [ ] Git commit records the wave's changes

### Must Have
- Kysely migration runner in Wave 1 (no ad-hoc schema creation)
- CountryPlugin interface + stub implementation in Wave 1
- `previous_hash` column on `voucher` table in Wave 2 (deferred feature, schema-ready)
- Double-entry invariant enforced in Wave 2 (sum of lines = 0)
- Voucher immutability at API layer in Wave 2 (no PUT/DELETE on posted vouchers)
- Structural and hard Rules are inviolable in Wave 3 (no override possible)
- Policy gate structure exists in Wave 3 (even if auto-approves everything)
- Document dedup by SHA-256 hash in Wave 4
- Filesystem document storage in Wave 4 (never SQLite blobs)
- Deterministic N:M matching in Wave 5 (amount + date window + counterparty)
- ReportingPeriod lock prevents posting in Wave 6
- Approval lifecycle states in Wave 6 (pending → approved/rejected/superseded)
- Admin endpoints are read-only or simple state transitions in Wave 6

### Must NOT Have (Guardrails)
- NO React/Vite admin UI in any wave (deferred)
- NO depreciation engine (deferred to v1+)
- NO bad debt write-off deep logic (deferred to v1+)
- NO cryptographic hash chain computation (column reserved, logic deferred)
- NO Merkle root computation in v1 (schema-ready, logic deferred)
- NO actual OCR engine in Wave 4 (stub only)
- NO ML/AI matching in Wave 5 (deterministic only)
- NO real Telegram/Slack/Email integrations in Wave 6 (agent stubs log only)
- NO OAuth/JWT/session auth in Wave 6 (hardcoded API key or none)
- NO document blobs in SQLite (filesystem only)
- NO editing posted vouchers ever (only reversal + counter-voucher)
- NO structural rule overrides ever (only semantic rules via logged Override)
- NO auto-approval on timeout (timeout = reminder only)

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.
> Acceptance criteria requiring "user manually tests/confirms" are FORBIDDEN.

### Test Decision
- **Infrastructure exists**: YES (jest 30.0.0, ts-jest, NestJS testing utils)
- **Automated tests**: Tests-after
- **Framework**: jest (ts-jest transform)
- **If tests-after**: Implementation tasks complete first, then test tasks within same wave verify the implementation

### QA Policy
Every task MUST include agent-executed QA scenarios (see TODO template below).
Evidence saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Frontend/UI**: Use Playwright (not applicable — API-only)
- **API/Backend**: Use Bash (curl) — Send requests, assert status + response fields
- **Library/Module**: Use Bash (bun/node REPL) — Import, call functions, compare output
- **Docker/Deploy**: Use Bash (`docker compose up`, `curl` health endpoint)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation + scaffolding):
├── Task 1: Kysely migration runner + schema init
├── Task 2: Organization singleton module
├── Task 3: CountryPlugin interface + NullCountryPlugin stub
├── Task 4: Base currency + FX rate stub service
└── Task 5: Health endpoint + docker-compose smoke test

Wave 2 (After Wave 1 — ledger primitives, MAX PARALLEL):
├── Task 6: Account chart schema + canonical seed
├── Task 7: Voucher + VoucherLine schema + repository
├── Task 8: Double-entry validation service
├── Task 9: Posting service (atomic voucher creation)
└── Task 10: Immutability enforcement at API layer

Wave 3 (After Wave 2 — posting pipeline, MAX PARALLEL):
├── Task 11: Expense business object + draft generation
├── Task 12: SalesInvoice business object + draft generation
├── Task 13: Rules engine (structural/hard/semantic)
├── Task 14: Policy gate + Override logging
└── Task 15: Pipeline integration (end-to-end flow)

Wave 4 (After Wave 3 — intake + triage):
├── Task 16: Document schema + filesystem storage + dedup
├── Task 17: OCR triage stub + intake routing
├── Task 18: Correction flow (supersession, reversal)
├── Task 19: ReportingPeriod schema + CRUD
└── Task 20: Intake integration (document → draft → pipeline)

Wave 5 (After Wave 3 — reconciliation, parallel with Wave 4):
├── Task 21: BankStatement + BankTransaction schema
├── Task 22: Matching engine (N:M deterministic)
├── Task 23: Prepayment balances (liability/asset vouchers)
├── Task 24: Personal disposition + FX realized auto-posting
└── Task 25: Reconciliation integration

Wave 6 (After Waves 4-5 — agents + periods + admin):
├── Task 26: ReportingPeriod lock + filing guard
├── Task 27: VAT report snapshot
├── Task 28: Approval lifecycle
├── Task 29: AuditFinding + Agent stubs
└── Task 30: Admin API endpoints

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: Task 1 → Task 6 → Task 11 → Task 16/21 → Task 26 → F1-F4 → user okay
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 5 (Waves 1, 2, 3, 5)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1-5 | — | 6-10 |
| 6-10 | 1-5 | 11-15 |
| 11-15 | 6-10 | 16-25 |
| 16-20 | 11-15 | 26-30 |
| 21-25 | 11-15 | 26-30 |
| 26-30 | 16-25 | F1-F4 |
| F1-F4 | 1-30 | — |

### Agent Dispatch Summary

- **Wave 1**: 5 tasks → all `quick` (scaffolding, config, interfaces)
- **Wave 2**: 5 tasks → `quick` (schema, seed), `unspecified-high` (validation, posting, immutability)
- **Wave 3**: 5 tasks → `unspecified-high` (business objects, rules, policy), `deep` (integration)
- **Wave 4**: 5 tasks → `unspecified-high` (document, intake, correction), `deep` (integration)
- **Wave 5**: 5 tasks → `unspecified-high` (bank, matching, prepayments), `deep` (integration)
- **Wave 6**: 5 tasks → `unspecified-high` (period lock, VAT report, approval), `deep` (agents, admin)
- **FINAL**: 4 tasks → F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.
> **A task WITHOUT QA Scenarios is INCOMPLETE. No exceptions.**
> **FORMAT**: Task labels MUST use bare numbers: `1.`, `2.`, `3.` — NOT `T1.`, `Task 1.`, `Phase 1:`.
> Final Verification Wave labels MUST use `F1.`, `F2.`, etc. — NOT `T-F1.`, `F-1.`, `Final 1.`.

- [ ] 1. Kysely migration runner + schema initialization

  **What to do**:
  - Replace ad-hoc schema creation in `AppService.onModuleInit()` with Kysely's built-in migration system
  - Create `src/database/migrations/` directory with migration files
  - Implement migration runner that executes `migrateToLatest()` on `onModuleInit()`
  - First migration: create `organization` table (id, country, base_currency, vat_registered, created_at)
  - Migration files must be timestamped or numbered (e.g., `001_create_organization.ts`)
  - Export migration list from `src/database/migrations/index.ts`
  - Update `DatabaseModule` to configure migration runner
  - Write test: `database.module.spec.ts` proving migrations run and organization table exists

  **Must NOT do**:
  - Do NOT keep ad-hoc `CREATE TABLE` in `AppService.onModuleInit()` — delete it
  - Do NOT create any domain tables (Account, Voucher) — only Organization in this migration
  - Do NOT use a custom migration CLI — Kysely's built-in system is sufficient

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Infrastructure scaffolding, no business logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4, 5)
  - **Blocks**: Tasks 6-10 (all Wave 2 tasks need migrations)
  - **Blocked By**: None

  **References**:
  - `src/database/database.module.ts` — Current KyselyModule config (preserve pattern)
  - `src/database/types.ts` — Current Database interface pattern
  - Kysely docs: `https://kysely.dev/docs/migrations` — Built-in migration system
  - `src/app.service.ts:47` — Delete ad-hoc `users` table creation from `onModuleInit()`

  **Acceptance Criteria**:
  - [ ] `npm run build` passes with zero errors
  - [ ] `npm test` includes new `database.module.spec.ts` and passes
  - [ ] `data/app.sqlite` contains `organization` table after `npm run start:dev`
  - [ ] No `users` table created automatically (old ad-hoc behavior removed)

  **QA Scenarios**:

  ```
  Scenario: Migration runner executes on startup
    Tool: Bash (node REPL)
    Preconditions: Fresh SQLite file (delete `data/app.sqlite`)
    Steps:
      1. Run `npm run build`
      2. Run `node -e "require('./dist/main.js')"` for 3 seconds then kill
      3. Query SQLite: `sqlite3 data/app.sqlite ".tables"`
    Expected Result: Output contains "organization" (and kysely migration meta table)
    Failure Indicators: No organization table; users table still created; build errors
    Evidence: .omo/evidence/task-1-migration-runner.txt

  Scenario: Old ad-hoc table creation is gone
    Tool: Bash
    Preconditions: Fresh SQLite file
    Steps:
      1. Start app, wait 3s, stop
      2. Query: `sqlite3 data/app.sqlite "SELECT name FROM sqlite_master WHERE type='table' AND name='users';"`
    Expected Result: Empty result (no users table)
    Failure Indicators: users table exists (ad-hoc creation not removed)
    Evidence: .omo/evidence/task-1-no-users-table.txt
  ```

  **Evidence to Capture**:
  - [ ] Terminal output of migration runner execution
  - [ ] SQLite schema dump showing organization table

  **Commit**: YES
  - Message: `feat(db): Kysely migration runner + organization table`
  - Files: `src/database/migrations/`, `src/database/database.module.ts`, `src/database/types.ts`, `src/app.service.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 2. Organization singleton module

  **What to do**:
  - Create `src/organization/` module with controller, service, entity types
  - `Organization` table: id (INTEGER PK), country (TEXT NOT NULL), base_currency (TEXT NOT NULL), vat_registered (BOOLEAN), created_at (INTEGER)
  - Single-row constraint: only one Organization record ever (singleton pattern)
  - `GET /api/organization` returns the singleton record
  - `PUT /api/organization` updates the singleton (only country, base_currency, vat_registered are mutable)
  - Seed default Organization on first migration (country='DK', base_currency='DKK', vat_registered=false)
  - Types: `src/organization/types.ts` defining Organization interface
  - Service: `src/organization/organization.service.ts` with `getOrganization()`, `updateOrganization()`
  - Controller: `src/organization/organization.controller.ts` with GET/PUT endpoints
  - Register module in `AppModule`
  - Write tests for GET and PUT endpoints

  **Must NOT do**:
  - Do NOT allow multiple Organization rows (enforce singleton in code + DB unique constraint or check)
  - Do NOT add authentication to endpoints
  - Do NOT create any other domain entities

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple CRUD module, standard NestJS pattern
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4, 5)
  - **Blocks**: Tasks 6-10 (ledger needs Organization context), Task 3 (CountryPlugin needs org country)
  - **Blocked By**: Task 1 (needs migration runner + organization table)

  **References**:
  - `src/app.controller.ts` — Pattern for NestJS controller with GET endpoint
  - `src/app.service.ts` — Pattern for NestJS service with Kysely queries
  - `src/database/types.ts` — Pattern for Kysely Database interface
  - ADR-0003: Single-tenant mono-structure — "Organization is implicit, no org_id"

  **Acceptance Criteria**:
  - [ ] `GET /api/organization` returns `{ country: "DK", base_currency: "DKK", vat_registered: false }` on fresh DB
  - [ ] `PUT /api/organization` with `{ country: "DE", base_currency: "EUR" }` updates and returns updated record
  - [ ] Attempting to create a second organization row is rejected (constraint or code check)
  - [ ] Tests pass: `organization.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Get singleton organization
    Tool: Bash (curl)
    Preconditions: App running with fresh DB
    Steps:
      1. `curl -s http://localhost:3000/api/organization`
    Expected Result: JSON with country="DK", base_currency="DKK", vat_registered=false
    Failure Indicators: 404, empty response, wrong fields
    Evidence: .omo/evidence/task-2-get-organization.json

  Scenario: Update singleton organization
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s -X PUT -H "Content-Type: application/json" -d '{"country":"DE","base_currency":"EUR","vat_registered":true}' http://localhost:3000/api/organization`
    Expected Result: JSON with updated values
    Failure Indicators: 400/500 error, values not persisted
    Evidence: .omo/evidence/task-2-update-organization.json
  ```

  **Evidence to Capture**:
  - [ ] curl output for GET and PUT
  - [ ] Test output showing organization.service tests pass

  **Commit**: YES
  - Message: `feat(organization): singleton module with GET/PUT endpoints`
  - Files: `src/organization/`
  - Pre-commit: `npm run build && npm test`

- [ ] 3. CountryPlugin interface + NullCountryPlugin stub

  **What to do**:
  - Create `src/plugins/` directory for country plugin infrastructure
  - Define `CountryPlugin` interface in `src/plugins/country-plugin.interface.ts`:
    - `getName(): string`
    - `getVATCodes(): VATCode[]`
    - `resolveCategoryMapping(category: string, supplierContext: any): { account: string, vatCode: string }`
    - `getPeriodFrequencyOptions(): string[]`
    - `getDefaultPeriodFrequency(): string`
    - `validateVATCode(vatCode: string, context: any): boolean`
  - Create `NullCountryPlugin` stub in `src/plugins/null-country.plugin.ts` implementing the interface with safe defaults
  - Create `PluginLoader` service in `src/plugins/plugin-loader.service.ts` that resolves plugin by country code from Organization config
  - Register plugin loader as provider in `AppModule`
  - Write tests proving NullCountryPlugin returns safe defaults and PluginLoader resolves correctly

  **Must NOT do**:
  - Do NOT implement a real country plugin (DK, DE, etc.) — only interface + null stub
  - Do NOT load plugins dynamically from npm/packages — simple map-based resolution is fine
  - Do NOT put VAT code logic in the kernel — interface only

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Interface definition + stub, no complex logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4, 5)
  - **Blocks**: Tasks 11-15 (Rules engine needs VAT code resolution), Tasks 13-14 (Policy needs plugin validation)
  - **Blocked By**: Task 2 (needs Organization to know which country/plugin to load)

  **References**:
  - ADR-0002: Country-plugin boundary — "thin canonical kernel, country specifics in plugins"
  - ADR-0002: "The country plugin is the sole resolver of a VAT code"
  - `src/app.module.ts` — Pattern for registering providers

  **Acceptance Criteria**:
  - [ ] `NullCountryPlugin.getName()` returns `"null"`
  - [ ] `NullCountryPlugin.resolveCategoryMapping("software", {})` returns `{ account: "EXPENSE_SOFTWARE", vatCode: "NULL_STANDARD" }`
  - [ ] `PluginLoader.resolve("DK")` returns a CountryPlugin instance
  - [ ] Tests pass: `plugin-loader.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: NullCountryPlugin returns safe defaults
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. `node -e "const { NullCountryPlugin } = require('./dist/plugins/null-country.plugin'); const p = new NullCountryPlugin(); console.log(p.getName(), p.resolveCategoryMapping('software', {}));"`
    Expected Result: Outputs "null" and an object with account + vatCode
    Failure Indicators: undefined, errors, missing methods
    Evidence: .omo/evidence/task-3-null-plugin.txt

  Scenario: PluginLoader resolves by country code
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s http://localhost:3000/api/health` (verify app is up)
      2. Check that `PluginLoader` is injectable and returns plugin for "DK"
    Expected Result: PluginLoader.getPlugin("DK") returns a CountryPlugin instance
    Failure Indicators: Plugin not found, loader not registered
    Evidence: .omo/evidence/task-3-plugin-loader.txt
  ```

  **Evidence to Capture**:
  - [ ] REPL output showing NullCountryPlugin methods work
  - [ ] Test output showing PluginLoader resolves correctly

  **Commit**: YES
  - Message: `feat(plugins): CountryPlugin interface + NullCountryPlugin stub`
  - Files: `src/plugins/`
  - Pre-commit: `npm run build && npm test`

- [ ] 4. Base currency + FX rate stub service

  **What to do**:
  - Create `src/currency/` module
  - `CurrencyService` with methods: `getBaseCurrency(): string`, `convertToBase(amount: number, currency: string, rate: number): number`
  - Base currency is read from Organization singleton config
  - FX rate stub: `FXRateService` with `getRate(fromCurrency: string, toCurrency: string): number` — returns hardcoded rates for testing (DKK→USD: 0.14, USD→DKK: 7.14, DKK→EUR: 0.134, EUR→DKK: 7.46)
  - In production, this would call an external API; for now, hardcoded rates with a TODO comment
  - Write tests for currency conversion and FX rate lookup
  - This service will be used by VoucherLine creation in Wave 2

  **Must NOT do**:
  - Do NOT integrate with external FX APIs (ECB, OpenExchangeRates) — stub only
  - Do NOT persist rates in database — in-memory or hardcoded
  - Do NOT add complex rate caching or history

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple service with arithmetic, no external dependencies
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 5)
  - **Blocks**: Task 7 (VoucherLine needs FX conversion), Task 24 (FX realized auto-posting)
  - **Blocked By**: Task 2 (needs Organization singleton to get base_currency)

  **References**:
  - ADR-0004: Multi-currency transactions — "Every VoucherLine stores original amount + currency, base-currency amount, FX rate"
  - ADR-0004: "Realized FX gain/loss is always computed in the kernel"

  **Acceptance Criteria**:
  - [ ] `CurrencyService.getBaseCurrency()` returns Organization's base_currency (e.g., "DKK")
  - [ ] `CurrencyService.convertToBase(100, "USD", 7.14)` returns `714`
  - [ ] `FXRateService.getRate("USD", "DKK")` returns `7.14`
  - [ ] Tests pass: `currency.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: FX rate stub returns hardcoded rate
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. `node -e "const { FXRateService } = require('./dist/currency/fx-rate.service'); const s = new FXRateService(); console.log(s.getRate('USD','DKK'));"`
    Expected Result: Outputs 7.14
    Failure Indicators: undefined, NaN, wrong value
    Evidence: .omo/evidence/task-4-fx-rate.txt

  Scenario: Currency conversion works correctly
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. `node -e "const { CurrencyService } = require('./dist/currency/currency.service'); const s = new CurrencyService({base_currency:'DKK'}); console.log(s.convertToBase(100,'USD',7.14));"`
    Expected Result: Outputs 714
    Failure Indicators: wrong calculation, null/undefined
    Evidence: .omo/evidence/task-4-conversion.txt
  ```

  **Evidence to Capture**:
  - [ ] REPL output showing rate lookup and conversion
  - [ ] Test output

  **Commit**: YES
  - Message: `feat(currency): base currency service + FX rate stub`
  - Files: `src/currency/`
  - Pre-commit: `npm run build && npm test`

- [ ] 5. Health endpoint + docker-compose smoke test

  **What to do**:
  - Add `GET /health` endpoint to `AppController` (or new `HealthController`) returning `{ status: "ok", timestamp: ISOString }`
  - Ensure `docker-compose.yml` is functional and mounts `./data:/app/data`
  - Add health check to docker-compose service definition
  - Write an integration test that starts the app and asserts `/health` responds with 200
  - This is the "smoke test" for every wave — each wave must keep this passing

  **Must NOT do**:
  - Do NOT add complex health checks (DB connectivity, plugin status) — simple JSON response is enough for Wave 1
  - Do NOT modify Dockerfile significantly — only ensure it works with current setup

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple endpoint + docker verification
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3, 4)
  - **Blocks**: All subsequent waves (every wave's AC1 is "docker compose up + health check")
  - **Blocked By**: None

  **References**:
  - `docker-compose.yml` — Current compose file (verify it works)
  - `Dockerfile` — Current Dockerfile (verify build context)
  - `src/app.controller.ts` — Pattern for adding a new endpoint

  **Acceptance Criteria**:
  - [ ] `curl http://localhost:3000/health` returns `{ status: "ok", timestamp: "..." }`
  - [ ] `docker compose up -d` starts the container successfully
  - [ ] `docker compose ps` shows container as "healthy"
  - [ ] Integration test passes: `health.e2e-spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Health endpoint responds
    Tool: Bash (curl)
    Preconditions: App running (`npm run start:dev` or `docker compose up`)
    Steps:
      1. `curl -s http://localhost:3000/health | jq .`
    Expected Result: JSON with status="ok" and non-null timestamp
    Failure Indicators: 404, connection refused, missing fields
    Evidence: .omo/evidence/task-5-health.json

  Scenario: Docker compose starts successfully
    Tool: Bash
    Preconditions: Docker daemon running
    Steps:
      1. `docker compose up -d --build`
      2. `sleep 5`
      3. `docker compose ps`
      4. `curl -s http://localhost:3000/health`
    Expected Result: Container running, health endpoint responds
    Failure Indicators: Build failure, container exit, connection refused
    Evidence: .omo/evidence/task-5-docker-compose.txt
  ```

  **Evidence to Capture**:
  - [ ] curl output from health endpoint
  - [ ] docker compose ps output
  - [ ] Integration test pass log

  **Commit**: YES
  - Message: `feat(health): health endpoint + docker-compose verification`
  - Files: `src/app.controller.ts` (or new controller), `docker-compose.yml`, `test/health.e2e-spec.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 6. Account chart schema + canonical seed data

  **What to do**:
  - Create migration for `account` table: id (INTEGER PK), code (TEXT NOT NULL UNIQUE), name (TEXT NOT NULL), type (TEXT NOT NULL — enum: asset, liability, equity, revenue, expense), currency (TEXT, nullable — for foreign-currency accounts), parent_id (INTEGER FK to account, nullable), is_system (BOOLEAN DEFAULT false)
  - Seed canonical chart of accounts in migration or seed script:
    - Assets: CASH, BANK_DKK, BANK_USD, AR, SUPPLIER_PREPAYMENTS, RECEIVABLE_FROM_OWNER
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
  - ADR-0002: Country-plugin boundary — "kernel owns a thin canonical chart of Accounts... Cash, Bank (per currency), AR, AP, Revenue, Expense-by-category, VAT-payable, VAT-receivable, Equity, Customer-prepayments, Supplier-prepayments/prepaid-expense, FX-gain/loss, Bad-debt-expense, Suspense"
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
      1. `node -e "const { DatabaseModule } = require('./dist/database/database.module'); ..."` (or use sqlite3 CLI)
      2. `sqlite3 data/app.sqlite "SELECT code FROM account ORDER BY code;"`
    Expected Result: Output includes CASH, BANK_DKK, BANK_USD, AR, AP, EQUITY, REVENUE, EXPENSE_SOFTWARE, VAT_PAYABLE, etc.
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
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"voucher_number":"V-2024-001","tax_point_date":"2024-01-15","lines":[{"account_code":"EXPENSE_SOFTWARE","amount":10000,"currency":"DKK","base_amount":10000,"fx_rate":1,"is_debit":true},{"account_code":"CASH","amount":10000,"currency":"DKK","base_amount":10000,"fx_rate":1,"is_debit":false}]}' http://localhost:3000/api/vouchers`
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
      1. `node -e "const { LedgerValidationService } = require('./dist/ledger/validation/ledger-validation.service'); const v = new LedgerValidationService(); console.log(v.validateVoucherLines([{account_id:1,amount:10000,currency:'DKK',base_amount:10000,fx_rate:1,is_debit:true},{account_id:2,amount:10000,currency:'DKK',base_amount:10000,fx_rate:1,is_debit:false}]));"`
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
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"voucher_number":"V-2024-002","tax_point_date":"2024-01-15","lines":[{"account_code":"EXPENSE_SOFTWARE","amount":10000,"currency":"DKK","base_amount":10000,"fx_rate":1,"is_debit":true},{"account_code":"CASH","amount":10000,"currency":"DKK","base_amount":10000,"fx_rate":1,"is_debit":false}]}' http://localhost:3000/api/vouchers`
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
  - **Blocks**: Task 15 (integration uses Policy), Task 28 (Approval lifecycle depends on Policy decisions)
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
  - **Blocks**: Task 16-20 (intake needs posting pipeline), Task 22-25 (reconciliation needs posted vouchers)
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

- [ ] 16. Document schema + filesystem storage + dedup

  **What to do**:
  - Create `src/documents/` module
  - `document` table: id (INTEGER PK), hash (TEXT NOT NULL UNIQUE), filename (TEXT NOT NULL), content_type (TEXT), size_bytes (INTEGER), storage_path (TEXT NOT NULL), status (TEXT — enum: received, triaged, processed, error), created_at (INTEGER)
  - `document_source` table: id (INTEGER PK), document_id (INTEGER FK), channel (TEXT NOT NULL — telegram, email, api, drive), sender (TEXT), received_at (INTEGER), metadata (TEXT — JSON)
  - Document storage: filesystem at `data/documents/{document_id}/{filename}`
  - `POST /api/documents` accepts multipart upload:
    - Compute SHA-256 hash of file bytes
    - If hash exists in DB: return existing document, append new source
    - If new: save to filesystem, insert document + source rows
  - `GET /api/documents` lists documents with sources
  - `GET /api/documents/:id` returns document metadata
  - Write tests for upload, dedup, and filesystem storage

  **Must NOT do**:
  - Do NOT store file blobs in SQLite — only metadata + hash + filesystem path
  - Do NOT implement real OCR — that's Task 17 (stub)
  - Do NOT implement channel adapters (Telegram bot, email IMAP) — only HTTP upload for now

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: File I/O + DB transactions + hash computation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 17, 18, 19, 20)
  - **Parallel Group**: Wave 4 (with Tasks 17, 18, 19, 20)
  - **Blocks**: Task 17 (triage needs documents), Task 18 (corrections need documents)
  - **Blocked By**: Task 1 (migration runner)

  **References**:
  - ADR-0010: "Document is the deduplication anchor... byte-identical attachments arriving via multiple channels collapse into one Document with multiple sources"
  - ADR-0010: "Hash match" for dedup
  - `docker-compose.yml` — Ensure `data/documents/` is volume-mounted

  **Acceptance Criteria**:
  - [ ] `POST /api/documents` with file → 201, file saved to `data/documents/{id}/filename`
  - [ ] Re-uploading same bytes → 200 with existing document id, new source appended
  - [ ] `GET /api/documents/:id` returns document with sources array
  - [ ] Filesystem contains file at expected path
  - [ ] Tests pass: `documents.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Upload document and store on filesystem
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `echo "test receipt data" > /tmp/test-receipt.txt`
      2. `curl -s -X POST -F "file=@/tmp/test-receipt.txt" http://localhost:3000/api/documents`
    Expected Result: 201 with document JSON, storage_path contains path
    Failure Indicators: 400/500, file not on disk, wrong path
    Evidence: .omo/evidence/task-16-upload.json

  Scenario: Duplicate upload returns existing document
    Tool: Bash (curl)
    Preconditions: App running, same file already uploaded
    Steps:
      1. `curl -s -X POST -F "file=@/tmp/test-receipt.txt" http://localhost:3000/api/documents`
    Expected Result: 200 (or 201 with same id), sources array has 2 entries
    Failure Indicators: New document id created, sources not appended
    Evidence: .omo/evidence/task-16-dedup.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for upload and dedup
  - [ ] Filesystem listing showing `data/documents/`

  **Commit**: YES
  - Message: `feat(documents): document intake + filesystem storage + hash dedup`
  - Files: `src/documents/`, `data/documents/` (ensure .gitignore)
  - Pre-commit: `npm run build && npm test`

- [ ] 17. OCR triage stub + intake routing

  **What to do**:
  - Create `src/triage/` module
  - `OCRService` stub: `extractData(documentId: number): TriageResult` — returns hardcoded mock data based on document id parity:
    - Odd id → `{ document_type: 'receipt', entity_guess: 'Bolt', gross_amount: 1525, vat_amount: 275, suggested_category: 'transport', suggested_vat_code: 'DK_INPUT_25', confidence: 0.94 }`
    - Even id → `{ document_type: 'invoice', entity_guess: 'OpenAI', gross_amount: 10000, vat_amount: 2500, suggested_category: 'software', suggested_vat_code: 'DK_INPUT_25', confidence: 0.98 }`
  - `TriageService.route(documentId: number): TriageOutcome`:
    - Calls OCR stub
    - Determines outcome: `new_expense`, `new_sales_invoice`, `correction`, `duplicate` (already handled in Task 16)
    - For `new_expense`: creates Expense draft from OCR data
    - For `new_sales_invoice`: creates SalesInvoice draft from OCR data
    - For `correction`: links to original (stub — full correction in Task 18)
  - `POST /api/documents/:id/triage` triggers triage and returns outcome
  - `GET /api/triage/pending` lists documents awaiting triage
  - Write tests for triage routing and OCR stub

  **Must NOT do**:
  - Do NOT integrate real OCR (Tesseract, AWS Textract, OpenAI vision) — stub only
  - Do NOT implement complex entity matching — entity_guess is a string, not a Supplier reference
  - Do NOT implement correction logic — just detect and return outcome type

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Stub service with deterministic routing, creates business objects
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 16, 18, 19, 20)
  - **Parallel Group**: Wave 4 (with Tasks 16, 18, 19, 20)
  - **Blocks**: Task 18 (correction flow uses triage outcomes), Task 20 (integration uses triage)
  - **Blocked By**: Task 11-12 (needs Expense and SalesInvoice modules), Task 16 (needs Document module)

  **References**:
  - ADR-0010: "OCR/triage produces a draft (category, supplier guess, amounts, candidate VAT code, confidence)"
  - ADR-0010: "Three outcomes: same document, correction/supersession, new document"
  - ADR-0016: "Intent routing: free natural-language chat" — but triage is not intent routing, it's document classification

  **Acceptance Criteria**:
  - [ ] `POST /api/documents/1/triage` creates an Expense with category="transport", amount=1525
  - [ ] `POST /api/documents/2/triage` creates a SalesInvoice with category="software", amount=10000
  - [ ] `GET /api/triage/pending` lists untriaged documents
  - [ ] Tests pass: `triage.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Triage document to expense
    Tool: Bash (curl)
    Preconditions: App running, document uploaded (id=1)
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/documents/1/triage`
    Expected Result: 200 with outcome type "new_expense", linked expense_id
    Failure Indicators: 404, wrong outcome type, no expense created
    Evidence: .omo/evidence/task-17-triage-expense.json

  Scenario: Triage document to sales invoice
    Tool: Bash (curl)
    Preconditions: App running, document uploaded (id=2)
    Steps:
      1. `curl -s -X POST http://localhost:3000/api/documents/2/triage`
    Expected Result: 200 with outcome type "new_sales_invoice", linked invoice_id
    Failure Indicators: wrong outcome, no invoice created
    Evidence: .omo/evidence/task-17-triage-invoice.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for triage outcomes
  - [ ] Test output

  **Commit**: YES
  - Message: `feat(triage): OCR stub + intake routing`
  - Files: `src/triage/`
  - Pre-commit: `npm run build && npm test`

- [ ] 18. Correction flow (supersession, reversal)

  **What to do**:
  - Implement correction logic per ADR-0010 and ADR-0006:
    1. **Cosmetic only** (address/typo; amounts unchanged) → replace Document attachment, Voucher untouched
    2. **Financial change, original still draft** → edit the draft Expense/Invoice, regenerate draft Voucher
    3. **Financial change, original posted, period open** → create reversal Voucher (mirrored lines, negative amounts), then create corrected Voucher with new lines. Both link to original via `reverses_id` and `corrects_object`
    4. **Financial change, original posted, period locked** → reversal + correction in current open period with `reverses`/`corrects_object` references (period lock not enforced until Wave 6, but structure ready)
    5. **Supplier-issued credit note** → booked as its own Voucher with VAT effect, referencing original
  - `POST /api/expenses/:id/correct` — initiates correction flow
  - `POST /api/sales-invoices/:id/correct` — same for invoices
  - Accept payload: `{ type: 'financial', new_amount: number, new_category: string, reason: string }`
  - For Wave 4, implement cases 1-3; cases 4-5 are stubs (return "not yet implemented" or create structure)
  - Write tests for correction flow

  **Must NOT do**:
  - Do NOT edit posted vouchers directly — always create reversal + new voucher
  - Do NOT implement period lock enforcement here — stub it
  - Do NOT send real credit notes to suppliers — just book the voucher

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Complex business logic with multiple branches, voucher creation, linking
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 16, 17, 19, 20)
  - **Parallel Group**: Wave 4 (with Tasks 16, 17, 19, 20)
  - **Blocks**: Task 20 (integration tests correction flow end-to-end)
  - **Blocked By**: Task 9 (posting service for creating reversal/corrected vouchers), Task 11-12 (needs Expense/SalesInvoice), Task 16 (Document module)

  **References**:
  - ADR-0010: "Correction flow branches on what actually changed: cosmetic only → replace attachment; financial + draft → edit draft; financial + posted + open → reversal + corrected; financial + posted + locked → reversal + correction in current period"
  - ADR-0006: "reversed — editing a posted object reverses the old Voucher and generates a new one"
  - ADR-0009: "Corrections to a locked period land in the current open period"

  **Acceptance Criteria**:
  - [ ] Correcting a draft expense → expense updated, new draft voucher generated
  - [ ] Correcting a posted expense → reversal voucher created, corrected voucher created, both linked to original
  - [ ] Reversal voucher lines are mirror of original (same accounts, opposite debit/credit)
  - [ ] `GET /api/expenses/:id` shows original expense with `reversed_by` or `correction_of` links
  - [ ] Tests pass: `correction.service.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Correct a posted expense
    Tool: Bash (curl)
    Preconditions: App running, expense posted (id=1, amount=10000)
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"type":"financial","new_amount":12000,"new_category":"software","reason":"Original amount was wrong"}' http://localhost:3000/api/expenses/1/correct`
    Expected Result: 200 with correction result, reversal voucher id and corrected voucher id
    Failure Indicators: 400, no vouchers created, original voucher edited
    Evidence: .omo/evidence/task-18-correct-posted.json

  Scenario: Reversal voucher mirrors original
    Tool: Bash (curl)
    Preconditions: Correction completed
    Steps:
      1. `curl -s http://localhost:3000/api/vouchers/{reversal_id}`
    Expected Result: Voucher lines are mirror of original (e.g., if original was Dr EXPENSE 10000 Cr CASH 10000, reversal is Cr EXPENSE 10000 Dr CASH 10000)
    Failure Indicators: Lines don't mirror, amounts wrong
    Evidence: .omo/evidence/task-18-reversal-mirror.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for correction initiation
  - [ ] Voucher details showing reversal and corrected vouchers

  **Commit**: YES
  - Message: `feat(corrections): correction flow with reversal + repost`
  - Files: `src/corrections/` or extensions to `src/expenses/`, `src/sales-invoices/`
  - Pre-commit: `npm run build && npm test`

- [ ] 19. ReportingPeriod schema + CRUD

  **What to do**:
  - Create `src/reporting-periods/` module
  - `reporting_period` table: id (INTEGER PK), name (TEXT NOT NULL), start_date (TEXT NOT NULL), end_date (TEXT NOT NULL), status (TEXT NOT NULL — enum: open, locked), filed_at (INTEGER, nullable), vat_report_snapshot_id (INTEGER, nullable — FK to vat_report, deferred), created_at (INTEGER)
  - `POST /api/reporting-periods` creates a period (admin/config only)
  - `GET /api/reporting-periods` lists all periods
  - `GET /api/reporting-periods/:id` returns period details
  - `GET /api/reporting-periods/current` returns the current open period (latest by start_date)
  - For Wave 4, periods are created manually via API; auto-generation based on frequency deferred to Wave 6
  - Seed one initial open period on startup (e.g., 2024-Q1: 2024-01-01 to 2024-03-31)
  - Write tests for period CRUD

  **Must NOT do**:
  - Do NOT implement period lock enforcement here — just schema + CRUD (lock logic in Wave 6)
  - Do NOT auto-generate periods based on frequency — manual creation for now
  - Do NOT compute VAT reports — schema only

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple CRUD module, schema + REST endpoints
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 16, 17, 18, 20)
  - **Parallel Group**: Wave 4 (with Tasks 16, 17, 18, 20)
  - **Blocks**: Task 26 (period lock needs period schema), Task 27 (VAT report needs periods)
  - **Blocked By**: Task 1 (migration runner)

  **References**:
  - ADR-0009: "Reporting period: open → locked; tax-point date determines membership"
  - ADR-0009: "Period boundaries and frequency set by country plugin + Organization config"
  - ADR-0015: "Interaction with period locking" — deferred to Wave 6

  **Acceptance Criteria**:
  - [ ] Migration creates `reporting_period` table
  - [ ] `GET /api/reporting-periods` returns at least the seeded period
  - [ ] `GET /api/reporting-periods/current` returns the latest open period
  - [ ] `POST /api/reporting-periods` creates a new period
  - [ ] Tests pass: `reporting-periods.controller.spec.ts`

  **QA Scenarios**:

  ```
  Scenario: List reporting periods
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s http://localhost:3000/api/reporting-periods`
    Expected Result: JSON array with at least one period (seeded Q1 2024)
    Failure Indicators: Empty array, 404
    Evidence: .omo/evidence/task-19-list-periods.json

  Scenario: Get current open period
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s http://localhost:3000/api/reporting-periods/current`
    Expected Result: JSON with status="open", valid start/end dates
    Failure Indicators: 404, status="locked", wrong dates
    Evidence: .omo/evidence/task-19-current-period.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for period CRUD
  - [ ] SQLite query showing seeded period

  **Commit**: YES
  - Message: `feat(periods): reporting period schema + CRUD`
  - Files: `src/reporting-periods/`
  - Pre-commit: `npm run build && npm test`

- [ ] 20. Intake integration (document → draft → pipeline)

  **What to do**:
  - Integration test or endpoint that exercises the full intake → posting flow:
    1. Upload document via `POST /api/documents`
    2. Triage document via `POST /api/documents/:id/triage` → creates Expense/SalesInvoice draft
    3. Generate draft voucher via `POST /api/expenses/:id/generate-draft`
    4. Post via pipeline via `POST /api/expenses/:id/post` → Rules → Policy → Voucher
    5. Verify final state: Document.status = "processed", Expense.status = "posted" or "pending"
  - This is wiring test, not new logic
  - Also test the dedup path: upload same file twice, triage both, verify only one Expense created
  - Write end-to-end test: `intake.e2e-spec.ts`

  **Must NOT do**:
  - Do NOT add new business logic — only wire existing modules
  - Do NOT implement real channels (Telegram, email) — HTTP only
  - Do NOT implement correction flow in integration — just the happy path

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: End-to-end integration of document → triage → business object → pipeline → voucher
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (last in Wave 4, depends on all other Wave 4 tasks)
  - **Parallel Group**: Wave 4 (with Tasks 16, 17, 18, 19)
  - **Blocks**: Task 20 itself is the integration capstone
  - **Blocked By**: Tasks 11-19 (all components needed)

  **References**:
  - ADR-0010: Full intake triage flow
  - ADR-0005: Posting pipeline
  - All Wave 3 and Wave 4 service implementations

  **Acceptance Criteria**:
  - [ ] End-to-end test: document upload → triage → draft → post → posted voucher
  - [ ] Dedup test: same file twice → one expense, two document sources
  - [ ] Tests pass: `intake.e2e-spec.ts`

  **QA Scenarios**:

  ```
  Scenario: Full intake to posted voucher
    Tool: Bash (curl + shell script)
    Preconditions: App running, accounts seeded
    Steps:
      1. Upload file: `curl -F "file=@/tmp/receipt.txt" http://localhost:3000/api/documents`
      2. Triage: `curl -X POST http://localhost:3000/api/documents/{id}/triage`
      3. Post: `curl -X POST http://localhost:3000/api/expenses/{expense_id}/post`
      4. Verify: `curl http://localhost:3000/api/expenses/{expense_id}`
    Expected Result: Step 4 returns status="posted", voucher_id set, document.status="processed"
    Failure Indicators: Any step fails, status not posted, no voucher
    Evidence: .omo/evidence/task-20-full-intake.json

  Scenario: Duplicate document dedup
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. Upload file twice
      2. Triage both documents
      3. Count expenses: `curl http://localhost:3000/api/expenses | jq '.expenses | length'`
    Expected Result: Only 1 expense created, document has 2 sources
    Failure Indicators: 2 expenses created, document has 1 source
    Evidence: .omo/evidence/task-20-dedup.txt
  ```

  **Evidence to Capture**:
  - [ ] Shell script output for full end-to-end flow
  - [ ] API responses at each step

  **Commit**: YES
  - Message: `feat(intake): end-to-end document to voucher integration`
  - Files: `test/intake.e2e-spec.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 21. BankStatement + BankTransaction schema

  **What to do**:
  - Create `src/bank/` module
  - `bank_statement` table: id (INTEGER PK), account_id (INTEGER FK to account — must be BANK_*), start_date (TEXT), end_date (TEXT), uploaded_at (INTEGER), file_path (TEXT, nullable)
  - `bank_transaction` table: id (INTEGER PK), statement_id (INTEGER FK), transaction_date (TEXT NOT NULL), description (TEXT), amount (INTEGER NOT NULL — cents, positive for credit/incoming, negative for debit/outgoing), currency (TEXT NOT NULL), reference (TEXT, nullable — invoice number or match key), matched_voucher_id (INTEGER FK to voucher, nullable), status (TEXT — enum: unmatched, matched, personal, bank_fee), created_at (INTEGER)
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
  - **Blocks**: Task 22 (matching needs transactions), Task 25 (integration needs statements)
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
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"account_code":"BANK_DKK","start_date":"2024-01-01","end_date":"2024-01-31","transactions":[{"transaction_date":"2024-01-15","description":"Payment from Customer A","amount":12500,"currency":"DKK","reference":"INV-001"},{"transaction_date":"2024-01-16","description":"Bolt ride","amount":-1525,"currency":"DKK","reference":""}]}' http://localhost:3000/api/bank-statements`
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
  - `ReconciliationService` with `proposeMatches(statementId: number): MatchProposal[]`:
    - For each unmatched incoming transaction (amount > 0):
      - Find unpaid AR vouchers (SalesInvoice vouchers) with matching amount + date within ±7 days
      - Find CustomerPrepayment vouchers with matching amount + date within ±7 days
      - Return proposals sorted by confidence (exact amount match = highest)
    - For each unmatched outgoing transaction (amount < 0):
      - Find unpaid AP vouchers (Expense vouchers with AP line) with matching |amount| + date within ±7 days
      - Return proposals
  - `POST /api/bank-statements/:id/match` executes proposed matches
  - `reconciliation_match` table: id, bank_transaction_id, voucher_id, match_type (enum: exact, partial, prepayment), amount_matched (INTEGER), created_at
  - N:M matching: one transaction can match multiple vouchers, one voucher can match multiple transactions
  - Update voucher and transaction status on match
  - Write tests for matching logic

  **Must NOT do**:
  - Do NOT use ML/AI for matching — deterministic rules only (amount + date + counterparty)
  - Do NOT auto-execute matches without explicit action — only propose, user/agent must confirm
  - Do NOT implement fuzzy matching on descriptions — exact amount + date window only

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: N:M join logic, partial matching, status updates
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 21, 23, 24, 25)
  - **Parallel Group**: Wave 5 (with Tasks 21, 23, 24, 25)
  - **Blocks**: Task 23 (prepayments use matching), Task 25 (integration)
  - **Blocked By**: Task 21 (needs bank transactions), Task 7 (needs vouchers), Task 12 (needs AR/AP vouchers)

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
  - **Blocks**: Task 25 (integration tests prepayment flow)
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

- [ ] 24. Personal disposition + FX realized auto-posting

  **What to do**:
  - **Personal disposition** (ADR-0017):
    - `POST /api/bank-transactions/:id/personal` — marks transaction as personal, creates voucher: Dr OWNERS_DRAWINGS / Cr BANK
    - For sole proprietors: Owner's-drawings (equity contra)
    - For companies (ApS): Receivable-from-owner (asset) — but for v1, use Owner's-drawings as default
    - `GET /api/bank-transactions/:id` shows disposition status
  - **FX realized auto-posting** (ADR-0004):
    - When settling a foreign-currency invoice from a foreign-currency bank account at a different rate than booked:
    - Auto-compute realized FX gain/loss: (invoice FX rate - settlement FX rate) * amount
    - Create system-generated voucher: Dr/Cr FX_GAIN or FX_LOSS + adjust Bank account
    - `FXRealizedService.computeAndPost(...)` — called by matching engine when FX rates differ
    - Stub for Wave 5: hardcoded rate comparison, real rate service deferred
  - Write tests for both personal disposition and FX posting

  **Must NOT do**:
  - Do NOT implement company-type-specific logic (ApS vs sole proprietor) — default to Owner's-drawings
  - Do NOT implement unrealized FX revaluation — deferred to v1+
  - Do NOT integrate with external FX rate APIs — use stub rates from Task 4

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Two distinct features (personal disposition + FX), both involve voucher creation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 21, 22, 23, 25)
  - **Parallel Group**: Wave 5 (with Tasks 21, 22, 23, 25)
  - **Blocks**: Task 25 (integration tests personal + FX flows)
  - **Blocked By**: Task 9 (posting service), Task 6 (needs OWNERS_DRAWINGS, FX_GAIN, FX_LOSS accounts), Task 4 (FX rate stub), Task 21 (bank transactions)

  **References**:
  - ADR-0017: "The ledger books it by org type: Dr Owner's-drawings / Cr Bank for a sole proprietor"
  - ADR-0017: "Approval-required (a judgment with tax consequences)" — but for Wave 5, just post directly (Policy in Wave 3 gates it)
  - ADR-0004: "Realized FX gain/loss is always computed in the kernel — posted automatically"
  - ADR-0004: "The base-currency VAT amount is converted at the prescribed reference rate"

  **Acceptance Criteria**:
  - [ ] `POST /api/bank-transactions/1/personal` creates voucher: Dr OWNERS_DRAWINGS, Cr BANK
  - [ ] FX realized computed when settling USD invoice from USD account at different rate
  - [ ] FX voucher lines balance to zero (e.g., Dr FX_LOSS 100, Cr BANK 100)
  - [ ] Tests pass: `personal-disposition.service.spec.ts`, `fx-realized.service.spec.ts`

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

  Scenario: FX realized auto-posted on settlement
    Tool: Bash (curl)
    Preconditions: USD invoice posted at rate 7.0, bank transaction at rate 7.14
    Steps:
      1. Match transaction to invoice
      2. Check for auto-created FX voucher
    Expected Result: FX voucher exists, lines: Dr FX_GAIN (or Cr FX_LOSS), amount = difference * base_amount
    Failure Indicators: No FX voucher, wrong calculation
    Evidence: .omo/evidence/task-24-fx-realized.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for personal disposition
  - [ ] FX voucher details showing correct computation

  **Commit**: YES
  - Message: `feat(reconciliation): personal disposition + FX realized auto-posting`
  - Files: `src/reconciliation/personal-disposition.service.ts`, `src/reconciliation/fx-realized.service.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 25. Reconciliation integration

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
  - Also verify that `GET /api/accounts/BANK_DKK` shows correct balance after all transactions
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
  - **Parallel Group**: Wave 5 (with Tasks 21, 22, 23, 24)
  - **Blocks**: Task 25 itself is the integration capstone
  - **Blocked By**: Tasks 21-24 (all reconciliation components)

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
    Evidence: .omo/evidence/task-25-full-reconciliation.txt
  ```

  **Evidence to Capture**:
  - [ ] Shell script output for full flow
  - [ ] SQLite query verifying all transactions are matched/personal/prepayment

  **Commit**: YES
  - Message: `feat(reconciliation): end-to-end reconciliation integration`
  - Files: `test/reconciliation.e2e-spec.ts`
  - Pre-commit: `npm run build && npm test`

- [ ] 26. ReportingPeriod lock + filing guard

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
  - Do NOT implement VAT report computation on lock — that's Task 27
  - Do NOT implement amended return logic — deferred
  - Do NOT auto-reject lock if warnings exist — only warn, user decides

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Hard process rule enforcement, idempotent state transitions, warning queries
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 27, 28, 29, 30)
  - **Parallel Group**: Wave 6 (with Tasks 27, 28, 29, 30)
  - **Blocks**: Task 27 (VAT report needs locked period), Task 28 (approvals interact with lock)
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
    Evidence: .omo/evidence/task-26-lock-period.json

  Scenario: Posting into locked period is rejected
    Tool: Bash (curl)
    Preconditions: Period locked
    Steps:
      1. Try to post voucher with tax_point_date in locked period
    Expected Result: 400 with error message about locked period
    Failure Indicators: 200 OK (voucher posted), wrong error message
    Evidence: .omo/evidence/task-26-post-rejected.txt
  ```

  **Evidence to Capture**:
  - [ ] API responses for lock and posting rejection
  - [ ] SQLite query showing period status

  **Commit**: YES
  - Message: `feat(periods): reporting period lock + filing guard`
  - Files: `src/reporting-periods/reporting-periods.controller.ts`, `src/ledger/posting/posting.service.ts` (add lock check)
  - Pre-commit: `npm run build && npm test`

- [ ] 27. VAT report snapshot

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
  - **Can Run In Parallel**: YES (with Tasks 26, 28, 29, 30)
  - **Parallel Group**: Wave 6 (with Tasks 26, 28, 29, 30)
  - **Blocks**: None (last feature task)
  - **Blocked By**: Task 26 (period must be lockable), Task 7 (vouchers), Task 19 (periods)

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
    Evidence: .omo/evidence/task-27-vat-report.json

  Scenario: VAT report is immutable
    Tool: Bash (curl)
    Preconditions: Report exists
    Steps:
      1. `curl -s -X PUT http://localhost:3000/api/vat-reports/1` (any payload)
    Expected Result: 405 Method Not Allowed
    Failure Indicators: 200 OK, report modified
    Evidence: .omo/evidence/task-27-immutable.txt
  ```

  **Evidence to Capture**:
  - [ ] API response for VAT report generation
  - [ ] SQLite query showing vat_report table contents

  **Commit**: YES
  - Message: `feat(periods): VAT report snapshot generation`
  - Files: `src/vat-report/`
  - Pre-commit: `npm run build && npm test`

- [ ] 28. Approval lifecycle

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
  - **Can Run In Parallel**: YES (with Tasks 26, 27, 29, 30)
  - **Parallel Group**: Wave 6 (with Tasks 26, 27, 29, 30)
  - **Blocks**: Task 29 (AuditFinding may reference approvals)
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
    Evidence: .omo/evidence/task-28-approve.json

  Scenario: Reject a pending expense
    Tool: Bash (curl)
    Preconditions: App running, pending expense exists
    Steps:
      1. `curl -s -X POST -H "Content-Type: application/json" -d '{"reason":"Missing receipt"}' http://localhost:3000/api/approvals/2/reject`
    Expected Result: 200 with approval JSON, status="rejected", expense.status="draft", reason set
    Failure Indicators: status not changed, expense deleted
    Evidence: .omo/evidence/task-28-reject.json
  ```

  **Evidence to Capture**:
  - [ ] API responses for approve and reject
  - [ ] SQLite query showing approval states

  **Commit**: YES
  - Message: `feat(approvals): approval lifecycle with approve/reject/supersede`
  - Files: `src/approvals/`
  - Pre-commit: `npm run build && npm test`

- [ ] 29. AuditFinding + Agent stubs

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
  - **Can Run In Parallel**: YES (with Tasks 26, 27, 28, 30)
  - **Parallel Group**: Wave 6 (with Tasks 26, 27, 28, 30)
  - **Blocks**: Task 30 (admin endpoints may list findings)
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
    Evidence: .omo/evidence/task-29-findings.json

  Scenario: Agent sweep creates findings
    Tool: Bash (node REPL)
    Preconditions: Build passes
    Steps:
      1. `node -e "const { AuditAgent } = require('./dist/agents/audit.agent'); const a = new AuditAgent(); a.sweep(); console.log('sweep done');"`
      2. Query DB for new findings
    Expected Result: New audit_finding rows created
    Failure Indicators: No findings created, errors
    Evidence: .omo/evidence/task-29-agent-sweep.txt
  ```

  **Evidence to Capture**:
  - [ ] API responses for finding creation
  - [ ] Agent sweep output

  **Commit**: YES
  - Message: `feat(agents): AuditFinding schema + 5 agent stubs`
  - Files: `src/agents/`, `src/audit-findings/`
  - Pre-commit: `npm run build && npm test`

- [ ] 30. Admin API endpoints

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
  - **Can Run In Parallel**: YES (with Tasks 26, 27, 28, 29)
  - **Parallel Group**: Wave 6 (with Tasks 26, 27, 28, 29)
  - **Blocks**: None
  - **Blocked By**: Tasks 26-29 (all admin data sources)

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
    Evidence: .omo/evidence/task-30-admin-accounts.json

  Scenario: Admin endpoints reject without key
    Tool: Bash (curl)
    Preconditions: App running
    Steps:
      1. `curl -s -w "%{http_code}" -o /dev/null http://localhost:3000/admin/accounts`
    Expected Result: HTTP code 401
    Failure Indicators: 200 OK (no auth enforced)
    Evidence: .omo/evidence/task-30-admin-auth.txt
  ```

  **Evidence to Capture**:
  - [ ] API responses for admin endpoints
  - [ ] Auth rejection output

  **Commit**: YES
  - Message: `feat(admin): read-only admin API endpoints`
  - Files: `src/admin/`
  - Pre-commit: `npm run build && npm test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .omo/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill if UI)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (features working together, not isolation). Test edge cases: empty state, invalid input, rapid actions. Save to `.omo/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Wave 1**: `feat(db): migration runner + organization` — all Wave 1 files + tests
- **Wave 2**: `feat(ledger): account chart + voucher + posting + immutability` — all Wave 2 files + tests
- **Wave 3**: `feat(pipeline): business objects + rules + policy + integration` — all Wave 3 files + tests
- **Wave 4**: `feat(intake): documents + triage + corrections + periods` — all Wave 4 files + tests
- **Wave 5**: `feat(reconciliation): bank + matching + prepayments + FX` — all Wave 5 files + tests
- **Wave 6**: `feat(agents): period lock + VAT report + approvals + agents + admin` — all Wave 6 files + tests
- **Final**: `chore(review): final verification and fixes` — any fixes from F1-F4

---

## Success Criteria

### Verification Commands
```bash
# Build passes
npm run build

# All tests pass (unit + integration)
npm test

# Docker compose starts and health endpoint responds
docker compose up -d && sleep 5 && curl -s http://localhost:3000/health

# Admin endpoints accessible with key
curl -s -H "X-Admin-Key: dev" http://localhost:3000/admin/accounts

# Ledger immutability enforced
curl -s -X PUT -w "%{http_code}" http://localhost:3000/api/vouchers/1
# Expected: 405

# Period lock prevents posting
# (After locking a period in Wave 6)
curl -s -X POST -H "Content-Type: application/json" -d '{"voucher_number":"TEST","tax_point_date":"2024-01-15","lines":[...]}' http://localhost:3000/api/vouchers
# Expected: 400 with "locked period" error
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with all new tests
- [ ] `docker compose up` starts successfully
- [ ] All 6 waves have evidence in `.omo/evidence/`
- [ ] All Final Verification tasks (F1-F4) approved
- [ ] User gave explicit "okay" to complete
