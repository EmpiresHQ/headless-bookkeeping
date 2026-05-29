# Wave 1: Foundation + Scaffolding

## Overview
This wave establishes the database infrastructure, organizational context, plugin architecture, currency services, and deployment health checks. Nothing in this wave is domain-specific — it's pure scaffolding that all subsequent waves depend on.

> **Implementation deviations (post-review, reconciled with ADRs).** During review the following decisions were taken and are now authoritative (see ADR-0002, ADR-0004):
> - **Base currency is sourced from the country plugin, not the Organization.** `CountryPlugin.getDefaultBaseCurrency()` is the origin; `Organization.base_currency` is a **nullable override** (`NULL` = inherit). Resolution: `org.base_currency ?? pluginLoader.resolve(org.country).getDefaultBaseCurrency()`.
> - **Default organization is Ireland**, no override: `country='IE'`, `base_currency=NULL` → resolves to `EUR`. (Replaces the original DK/DKK default.)
> - **The default country plugin returns `EUR`**; `PluginLoader` fails loud if no default plugin is available.
> - **Singleton enforced at the DB**: `organization.id` is `INTEGER PRIMARY KEY CHECK (id = 1)`, seeded with `id=1`.
> - **Schema lives only in the migration.** `OrganizationService` does NOT create tables on init (the original implementation had reintroduced an ad-hoc `CREATE TABLE`; removed).
> - **Health lives in a dedicated `HealthController`**; the demo `AppController`/`AppService` (`/`, `/users`) were deleted.

## Prerequisites
- None (starts immediately)

## Definition of Done
- `docker compose up` starts and health endpoint returns 200
- `npm run build` passes with zero errors
- `npm test` includes new tests and passes
- SQLite `organization` table exists; old ad-hoc `users` table creation is removed
- Agent-executed QA scenarios pass with evidence captured
- Git commit records the wave

---

## TODOs

> **FORMAT**: Task labels MUST use bare numbers: `1.`, `2.`, `3.` — NOT `T1.`, `Task 1.`, `Phase 1:`.
> Every task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.
> **A task WITHOUT QA Scenarios is INCOMPLETE. No exceptions.**

- [x] 1. Kysely migration runner + schema initialization

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
  - `src/app.service.ts` — Delete ad-hoc `users` table creation from `onModuleInit()`

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

- [x] 2. Organization singleton module

  **What to do**:
  - Create `src/organization/` module with controller, service, entity types
  - `Organization` table: id (INTEGER PK), country (TEXT NOT NULL), base_currency (TEXT NOT NULL), vat_registered (BOOLEAN), created_at (INTEGER)
  - Single-row constraint: only one Organization record ever (singleton pattern)
  - `GET /api/organization` returns the singleton record
  - `PUT /api/organization` updates the singleton (only country, base_currency, vat_registered are mutable)
  - Seed default Organization on first migration (country='IE', base_currency=NULL → resolves to EUR via the country plugin, vat_registered=false). `base_currency` is a nullable override.
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
  - [ ] `GET /api/organization` returns `{ id: 1, country: "IE", base_currency: null, vat_registered: false }` on fresh DB
  - [ ] `PUT /api/organization` with `{ country: "DE", base_currency: "EUR" }` updates and returns updated record; `{ base_currency: null }` clears the override
  - [ ] Attempting to create a second organization row is rejected at the DB (PK `CHECK (id = 1)`)
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

- [x] 3. CountryPlugin interface + NullCountryPlugin stub

  **What to do**:
  - Create `src/plugins/` directory for country plugin infrastructure
  - Define `CountryPlugin` interface in `src/plugins/country-plugin.interface.ts`:
    - `getName(): string`
    - `getVATCodes(): VATCode[]`
    - `resolveCategoryMapping(category: string, supplierContext: any): { account: string, vatCode: string }`
    - `getPeriodFrequencyOptions(): string[]`
    - `getDefaultPeriodFrequency(): string`
    - `getDefaultBaseCurrency(): string` — the jurisdiction's default base currency (ADR-0004)
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
  - [ ] `NullCountryPlugin.getDefaultBaseCurrency()` returns `"EUR"`
  - [ ] `PluginLoader.resolve("DK")` returns a CountryPlugin instance; with no default plugin available it throws (fail-loud)
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

- [x] 4. Base currency + FX rate stub service

  **What to do**:
  - Create `src/currency/` module
  - `CurrencyService` with methods: `getBaseCurrency(): Promise<string>`, `convertToBase(amount: number, currency: string, rate: number): number`
  - Base currency is resolved as `org.base_currency ?? pluginLoader.resolve(org.country).getDefaultBaseCurrency()` (ADR-0004) — the plugin is the source, the Organization an optional override
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
  - **Blocks**: Task 7 (VoucherLine needs FX conversion), Task 25 (FX realized auto-posting)
  - **Blocked By**: Task 2 (needs Organization singleton to get base_currency)

  **References**:
  - ADR-0004: Multi-currency transactions — "Every VoucherLine stores original amount + currency, base-currency amount, FX rate"
  - ADR-0004: "Realized FX gain/loss is always computed in the kernel"

  **Acceptance Criteria**:
  - [ ] `CurrencyService.getBaseCurrency()` resolves the IE seed (no override) to `"EUR"` via the plugin; an explicit `base_currency` override takes precedence
  - [ ] `CurrencyService.convertToBase(100, "USD", 7.14)` returns `714`
  - [ ] `FXRateService.getRate("USD", "DKK")` returns `7.14`
  - [ ] Tests pass: `currency.service.spec.ts` + integration `currency.resolution.spec.ts`

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

- [x] 5. Health endpoint + docker-compose smoke test

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

---

## Wave Acceptance Criteria
- [x] All 5 tasks complete
- [x] `docker compose up` starts and health responds 200
- [x] `npm run build` passes with zero errors
- [x] `npm test` passes with new tests
- [x] Evidence files exist in `.omo/evidence/` for all tasks
- [ ] Git commit records Wave 1 changes

## Commit
- Message: `feat(db): migration runner + organization` — all Wave 1 files + tests
