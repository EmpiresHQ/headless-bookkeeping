# Wave 3 Pipeline — Learnings

## Task P5: CountryPlugin category mapping (seam #5)

- `resolveCategoryMapping` now takes three parameters: `category`, `supplierFacts`, and `orgContext`.
- `SupplierFacts` captures intrinsic supplier data (country, goods-vs-services, classification memory); `OrgContext` captures organization context (country, VAT registration, base currency override).
- `CategoryMappingResult` field renamed from `account` to `accountCode` to align with the seeded chart's `code` column and avoid ambiguity.
- NullCountryPlugin uses IE/EUR defaults: `IE_INPUT_23` for expenses, `IE_OUTPUT_23` for revenue, matching the default Irish deployment (ADR-0004).
- Expense categories map to seeded chart accounts (`EXPENSE_SOFTWARE`, `EXPENSE_TRANSPORT`, `EXPENSE_RENT`, etc.); unknown categories fall back to `EXPENSE_OTHER`.
- Real-DI integration test spins up an in-memory SQLite database, runs migrations, and queries the `account` table to prove resolved `accountCode` values exist in the seeded chart.
- All 14 test suites pass (100 tests total); build is clean.

## 2026-05-29: P3 — Cosmetics (is_system comment + toBool dedup)

- `src/database/types.ts`: `is_system` comment was wrong — said "1 = debit, 0 = credit" (copy-pasted from `is_debit`). Fixed to "1 = system-managed, 0 = user-managed".
- Created `src/database/helpers.ts` with `toBool(value: number): boolean` encapsulating the `=== 1` SQLite boolean coercion.
- Replaced 5 duplicated `=== 1` coercions across 4 files with `toBool()`:
  - `voucher-line.repository.ts` — `is_debit`
  - `account.service.ts` — `is_system`
  - `organization.service.ts` — `vat_registered`
  - `posting.service.ts` — `is_debit` (2 occurrences)
- All 14 unit test suites pass (104 tests). E2E: 1 pre-existing failure (NestJS validation pipe response shape).

## Task 12: SalesInvoice business object + draft voucher generation

- Migration numbering collision: `006_create_expenses` already existed; sales-invoice migration was renumbered to `007_create_sales_invoices` to avoid conflict.
- `Database` type in `src/database/types.ts` was missing `expense: ExpenseTable`, which caused build failures in `expenses.service.ts` after adding `sales_invoice`. Always verify all referenced tables are declared in the central `Database` interface.
- `isolatedModules` + `emitDecoratorMetadata` build error when using an interface in `@Body() dto: CreateSalesInvoiceDto`: interfaces are erased at compile time, so decorated signatures need `import type` for the interface (or a class DTO). Fixed by splitting the import: `import { SalesInvoice } from './types'; import type { CreateSalesInvoiceDto } from './types';`.
- SalesInvoice `status` enum: `draft | pending | posted | reversed` — distinct from `sent_at` (AC-11). `send` only sets `sent_at`; it never mutates `status`.
- `generate-draft` returns a **transient** `DraftVoucher` (not persisted — ADR-0020). Lines: Dr AR (gross), Cr REVENUE (net), Cr VAT_PAYABLE (vat). Uses `CountryPlugin.resolveCategoryMapping('revenue', …)` for both revenue account and output VAT code.
- EUR lines use `fx_rate=1, base_amount=amount` (AC-7). For non-EUR, the structure defers to future FX-rate resolution.
- Real-DI integration test spins up in-memory SQLite, runs all migrations (including 007), seeds the chart, and exercises the full service graph: `SalesInvoicesService → OrganizationService → PluginLoader → NullCountryPlugin → CurrencyService`.
- All 19 test suites pass (build clean, zero errors).

## Task P1: Error contract + Zod validation

- Installed `zod` (no `nestjs-zod` needed); a thin custom `ZodValidationPipe` (~20 lines) is sufficient and keeps dependencies minimal.
- Global pipe pattern: `app.useGlobalPipes(new ZodValidationPipe())` in `src/main.ts`; e2e tests must also register the pipe manually on `createNestApplication()` because `main.ts` is not executed in the test harness.
- The pipe checks `metadata.metatype?.schema` — DTO classes carry a static `schema` property (e.g. `DraftVoucherDto`). This mirrors how `nestjs-zod` works but without the extra package.
- `DraftVoucherSchema` validates `voucher_number` (non-empty), `tax_point_date` (YYYY-MM-DD regex), and `lines` (array of at least 2 `DraftVoucherLineSchema` objects with positive integer amounts, positive fx_rate, boolean `is_debit`, etc.).
- NestJS `BadRequestException` with an object argument returns that object as the JSON response body (no `statusCode` wrapper). The e2e test must assert on the field-error keys directly, not on a top-level `message` property.
- SQLite UNIQUE constraint violation from better-sqlite3 throws a standard `Error` with `message.includes('UNIQUE constraint failed')`. Catching this in the controller and re-throwing `ConflictException` maps it cleanly to HTTP 409.
- The `isUniqueViolation` helper checks both `'UNIQUE constraint failed'` and `'voucher_number'` in the message to avoid catching unrelated unique violations.
- Build passes (`nest build` exit 0). All 12 e2e tests pass (3 suites). All unit tests pass (14 suites, 104+ tests).

## Task 11: Expense business object + draft voucher generation

- Created `src/expenses/` module (controller, service, types, module) with real-DI integration tests.
- Migration `006_create_expenses.ts` (005 was already taken by voucher line indexes). Table: id, document_id, supplier_id, category, gross_amount, vat_amount, currency, tax_point_date, status (draft/pending/posted/reversed), voucher_id, created_at, updated_at.
- `POST /api/expenses` creates an Expense in `draft` status.
- `POST /api/expenses/:id/generate-draft` returns a **transient** `DraftVoucher` (in-memory, no DB write). Lines: `Dr Expense (net)` + `Dr VAT_RECEIVABLE (vat)` / `Cr AP (gross)` — accrual basis, never `Cr Cash`.
- Uses `CountryPlugin.resolveCategoryMapping(category, supplierFacts, orgContext)` to resolve the expense account code + input VAT code. NullCountryPlugin maps categories to `EXPENSE_*` accounts and `IE_INPUT_23`.
- EUR lines use `fx_rate=1, base_amount=amount` as required by the hardened CHECK constraints.
- The draft voucher is **not persisted** — `expense.voucher_id` stays NULL until actual posting (ADR-0020).
- Real-DI integration tests spin up in-memory SQLite, run migrations (which already seed the singleton organization), and test CRUD + draft generation including balance verification.
- All 19 test suites pass (152 tests total). Build is clean.

## Task 13: Rules engine (structural, hard, semantic)

- Created `src/rules/` module: `types.ts`, `rules.guards.ts`, `rules.service.ts`, `rules.module.ts`, `rules.service.spec.ts`.
- Also created `src/ledger/validation/ledger-validation.module.ts` to properly export `LedgerValidationService` so `RulesModule` and `PostingModule` can both import it without duplication.
- **Structural tier** delegates entirely to `LedgerValidationService.validateVoucherLines(...)` — no reimplementation of balance/positivity/currency checks. `RuleResult.overrideable: false`.
- **Hard process tier** is a stub that always passes until Wave 6 (period locking). `RuleResult.overrideable: false`.
- **Semantic tier** validates VAT codes via `CountryPlugin.validateVATCode()` and category mapping existence via `resolveCategoryMapping()`. `RuleResult.overrideable: true`.
- Override behavior: passing an `Override` object with `ruleType === 'semantic'` and a reason converts a semantic failure into `passed: true`. Structural/hard overrides are ignored — `passed` stays `false`.
- `canOverride(result)` and `mustReject(result)` guard helpers in `rules.guards.ts` encapsulate the decision logic.
- Real-DI integration test spins up in-memory SQLite, runs migrations, queries seeded chart for real `account.id` values, and validates structural + semantic tiers end-to-end against `NullCountryPlugin`.
- All 16 rules tests pass. 15 test suites pass total (2 pre-existing failures in `src/expenses/` — unrelated).

## Task 14: Policy gate + Override logging

- Created `src/policy/` module: `types.ts`, `policy.service.ts`, `override.controller.ts`, `policy.module.ts`, plus `policy.service.spec.ts` and `override.controller.spec.ts`.
- Migrations: `008_create_overrides.ts` (override audit table) and `009_create_policy_config.ts` (key-value config table seeded with v1 defaults).
- `PolicyDecision.action` is strictly `'auto-post' | 'hold-for-approval'` — no `'reject'` (AC-5). Structural/hard failures are rejected by Rules before Policy is consulted; Policy guards defensively anyway.
- `PolicyService.decide()` checks in order: (1) structural/hard failure → hold, (2) semantic failure (no override applied) → hold, (3) amount > ceiling (100000 cents = 1000 EUR) → hold, (4) default → auto-post.
- AI confidence (`auto_post_min_confidence`) and `unknown_supplier_requires_approval` are stubbed for v1 — not wired into `decide()` yet, but config exists.
- `always_approve_operations` is a stub list (`['correction', 'reversal', 'vat_lock']`) — not wired because `DraftVoucher` does not yet carry an `operation_type` field.
- Override is logged atomically with posting via `logOverride()` (AC-6) — there is no free-standing `POST /api/overrides` endpoint. `GET /api/overrides` is read-only for audit.
- `getOverrides()` orders by `created_at desc, id desc` to handle SQLite second-level timestamp granularity.
- Real-DI integration tests use `KYSELY_MODULE_CONNECTION_TOKEN()` to inject an in-memory Kysely instance, following the pattern established in `expenses.service.spec.ts`.
- All 21 test suites pass (168 tests total). Build is clean.

## Task 15: Pipeline integration (end-to-end flow)

### Architecture
- Two new endpoints: `POST /api/expenses/:id/post` and `POST /api/sales-invoices/:id/post`
- Full pipeline: draft → code resolution (AC-4) → Rules (structural + hard + semantic) → Policy gate → post or hold
- `voucher_id` stays NULL for held items (ADR-0020); voucher only minted on auto-post
- Idempotent posting: guard on `status !== 'draft'` returns 409 with descriptive message (AC-9)

### ResolvedLine construction
- Account codes resolved via `AccountService.getAccountsByCodes(codes)` into `{account_id, account_currency}`
- `ResolvedLine.vat_code`: coerced from `null` to `'NULL_STANDARD'` for structural/hard tiers (not used by those tiers)
- `ResolvedLine.category`: expense/revenue line gets the business object's category; system lines (AP, AR, VAT_RECEIVABLE, VAT_PAYABLE) get empty string `''`
- Semantic validation filters to only lines with real VAT codes (`!== 'NULL_STANDARD'`) — avoids false failures from AP/AR lines with null vat_code

### Module wiring
- `ExpensesModule` and `SalesInvoicesModule` now import: `AccountModule`, `PostingModule`, `RulesModule`, `PolicyModule`
- `ExpensesModule` added to `AppModule` (was missing before)
- `ExpensesController` constructor grew from 1 to 7 dependencies; `SalesInvoicesController` from 1 to 6

### Service additions
- `ExpensesService.updateExpenseStatus(id, status, voucherId)` — updates status + voucher_id atomically
- `SalesInvoicesService.updateInvoiceStatus(id, status, voucherId)` — same for invoices

### Existing test fixes
- `expenses.controller.spec.ts` and `sales-invoices.controller.spec.ts` needed new providers (AccountService, RulesService, PolicyService, PostingService, LedgerValidationService) added to their `Test.createTestingModule`
- Sales invoice controller spec uses mock providers for all new dependencies

### E2E tests (test/pipeline.e2e-spec.ts)
- 8 tests total, real-DI with in-memory SQLite + supertest
- Expense happy path: create (123 EUR) → post → auto-post, voucher minted with posted_at and previous_hash
- Expense policy hold: create (2500 EUR > 1000 ceiling) → post → held, status=pending, voucher_id=null, no voucher rows in DB
- Expense idempotency: double-post → 409 "already posted"; post pending → 409 "already pending"
- Invoice happy path: create → post → posted with voucher, verifies debit/credit line counts (1 Dr AR, 2 Cr)
- Invoice policy hold: large invoice → held → pending, no voucher
- Invoice idempotency: double-post → 409
- Invoice not found: POST non-existent → 404

### Verification
- Build: `nest build` exit 0, clean
- Unit tests: all 21 test suites pass (168+ tests)
- E2E tests: pipeline 8/8 pass; 1 pre-existing failure in voucher.e2e-spec.ts (duplicate voucher_number → 500 instead of 409, pre-dates this task)

## Wave-3 review corrections (2026-05-30)

A post-wave code review found that several claims above do not match what shipped. Recorded here so the notepad is not misleading; remediations are tracked as the Wave-4 prologue (`.omo/plans/wave-4-intake.md`, tasks W3-1…W3-3).

- **Task 14 claim "Override is logged atomically with posting via `logOverride()`" is FALSE.** `PostingPipelineService.atomicPost` never calls `logOverride`; the override only flips an in-memory semantic result and no `override` row is ever written. This breaks the ADR-0012 "only escape valve is a *logged* Override" invariant. → W3-1.
- **The semantic tier cannot fail through the real pipeline.** `NullCountryPlugin` accepts every VAT code it emits and falls back to `EXPENSE_OTHER` for any category, so the override path is unreachable end-to-end with the only plugin that exists. Intentional (real plugins carry failing codes), but the override path was therefore only unit-tested, never integration-tested. → W3-1 adds a strict-test-plugin e2e.
- **`fx_rate = isBaseCurrency ? 1 : 1` is a dead ternary (both branches return 1).** Foreign-currency documents post at an implicit 1:1 with no conversion; because most chart accounts have `currency = NULL` the account-currency guard does not catch it. Silent integrity hole. → W3-2 (real `getReferenceRate`).
- **Expense posted `voucher_number = DRAFT-EXP-${id}-${Date.now()}`** — non-deterministic, `DRAFT-` prefix on an immutable voucher, and divergent from the invoice scheme; defeats UNIQUE-based idempotency and is not gapless/sequential (statutorily required). → W3-3 + new ADR-0021.
- **Idempotency is check-then-act (TOCTOU)**; with the gapless sequence the UNIQUE backstop disappears, so the status claim must become an atomic conditional UPDATE. → W3-3.
- **`ResolvedLine.category` is reverse-engineered from the account-code prefix** rather than carried from the source business object. → W3-1.
