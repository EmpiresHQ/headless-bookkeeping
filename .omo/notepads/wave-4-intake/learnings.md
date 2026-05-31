## Task 19 — ReportingPeriod schema + CRUD (2026-05-29)

- Created `src/reporting-periods/` module with migration, types, service, controller, module, unit tests, and integration test.
- Migration `011_create_reporting_period.ts` creates `reporting_period` table and seeds `2024-Q1` as an open period.
- Register migration in `index.ts` as `'011_create_reporting_period'`.
- Added `ReportingPeriodTable` to the `Database` interface in `src/database/types.ts`.
- Service: `list()`, `getById()`, `getCurrent()`, `create()` — all DB-backed via Kysely.
- Controller: `GET /api/reporting-periods`, `GET /api/reporting-periods/current`, `GET /api/reporting-periods/:id`, `POST /api/reporting-periods`. The `/current` route is declared before `/:id`.
- G2 integration test uses direct service construction (avoids nestjs-kysely DI token override issues in minimal test module).
- All 10 reporting-periods tests pass; full suite also green.
- Build shows 2 pre-existing TS errors in `documents.service.ts` (unrelated).
- Lesson: `nestjs-kysely`'s `KYSELY_MODULE_CONNECTION_TOKEN` override in `Test.createTestingModule` doesn't work reliably for minimal modules — better to construct the service directly with `new Service(db)` for integration tests.

## Task 17: OCR triage stub + intake routing

### What was built
- `src/triage/types.ts` — `TriageResult` (OCR output) and `TriageOutcome` discriminated union (`expense` | `invoice` | `unknown`).
- `src/triage/ocr.service.ts` — deterministic stub: odd doc id → receipt (Bolt, transport, 1525 gross, 275 vat, 0.94 confidence); even → invoice (OpenAI, software, 10000 gross, 2500 vat, 0.98 confidence).
- `src/triage/ocr.service.spec.ts` — unit tests proving odd/even determinism.
- `src/triage/triage.service.ts` — `route(documentId)` calls OCR stub, reads base currency from `CurrencyService`, derives tax-point date from `doc.created_at`, creates `Expense` (receipt) or `SalesInvoice` (invoice), sets document status to `triaged`, returns discriminated `TriageOutcome`.
- `src/triage/triage.controller.ts` — `POST /api/documents/:id/triage` and `GET /api/triage/pending`.
- `src/triage/triage.module.ts` — imports `DocumentsModule`, `ExpensesModule`, `SalesInvoicesModule`, `CurrencyModule`.
- `src/triage/triage.integration.spec.ts` — G2 test with real DI (in-memory SQLite + migrations). Uploads two documents, triages each, asserts odd→Expense (transport, 1525, EUR, draft) and even→SalesInvoice (10000, EUR, draft).
- `src/app.module.ts` — wired `TriageModule`.

### Key decisions
- Currency is never hardcoded; always resolved via `currencyService.getBaseCurrency()` (returns EUR for default Irish org).
- Tax-point date derived as `new Date(doc.created_at * 1000).toISOString().slice(0, 10)`.
- Used actual method names from codebase: `createExpense`, `createInvoice`, `getExpenseById`, `getInvoiceById`.
- DocumentsModule was already present from parallel Task 16; fixed two pre-existing TS errors (`DocumentSource`/`Channel` imports and `validateChannel` return type) so the build stays clean.
- Also fixed pre-existing `isolatedModules` + `emitDecoratorMetadata` import issues in `corrections.controller.ts` and `reporting-periods.controller.ts`.

### Verification
- `npm test -- triage` → 6/6 passed (3 OCR unit + 3 integration).
- `npm run build` → clean (0 errors).
- `npm test` (full suite) → all test suites passed.

## Task 16: Document schema + filesystem storage + SHA-256 dedup

### What was built
- `src/database/migrations/010_create_document.ts` — creates `document` and `document_source` tables with `.unique()` on `document.hash`, `.references('document.id')` on `document_source.document_id`, and `CHECK` constraints on `status` and `channel`.
- `src/database/migrations/index.ts` — registered `010_create_document`.
- `src/database/types.ts` — extended `Database` interface with `document: DocumentTable` and `document_source: DocumentSourceTable`.
- `src/documents/types.ts` — `Document`, `DocumentSource`, `DocumentWithSources`, `DocumentStatus`, `Channel`, `UploadDocumentInput`, `UploadDocumentResult`.
- `src/documents/document-storage.service.ts` — filesystem save/read at `{root}/{id}/{filename}`; accepts optional `@Inject(DOCUMENT_STORAGE_ROOT)`.
- `src/documents/documents.service.ts` — `computeSha256` (exported), `upload` (dedup via hash), `list`, `getById`, `setStatus`, `hydrate`.
- `src/documents/documents.controller.ts` — `POST /api/documents` (multipart, memoryStorage), `GET /api/documents`, `GET /api/documents/:id`.
- `src/documents/documents.module.ts` — imports `DatabaseModule`, exports `DocumentsService` + `DocumentStorageService`.
- `src/app.module.ts` — wired `DocumentsModule`.
- `src/documents/documents.service.spec.ts` — unit tests for hashing, upload/dedup, list/getById/setStatus.
- `src/documents/document-intake.integration.spec.ts` — G2 integration test proving (a) dedup collapses to one document with two sources, (b) DB UNIQUE constraint rejects raw duplicate insert.

### Key decisions
- `document.hash` has `.unique()` in migration (G6 integrity).
- On hash collision: append new source to existing document, return `deduplicated: true`.
- On new file: insert document row first (empty `storage_path`), save to filesystem, then update `storage_path`.
- Controller returns `201` for new files, `200` for deduplicated uploads.
- `memoryStorage()` in `FileInterceptor` so `file.buffer` is available for SHA-256.

### Testing quirks discovered
- `expect(...).rejects.toThrow()` is unreliable when jest runs multiple spec files in the same process (even with `--runInBand`). Using `try/catch` + `expect(threw).toBe(true)` is more robust for asserting DB constraint violations.
- This same pattern affects pre-existing tests in the repo (`voucher-line.repository.spec.ts`, `database.module.spec.ts`, `sales-invoices.service.spec.ts`).

### Verification
- `npx jest src/documents/ --runInBand --no-cache` → 10/10 tests pass.
- `npm run build` → clean (0 errors).
- `@types/multer` added as devDependency for `Express.Multer.File` typing.

## Task 20 — Intake integration E2E test + complete endpoint (2026-05-30)

### What was built
- `src/triage/triage.controller.ts` — added `POST /api/documents/:id/complete` (thin: calls `documentsService.setStatus(id, 'processed')`, returns 201).
- `src/app.module.ts` — wired `TriageModule` (was present from Task 17 but not yet imported in AppModule).
- `test/intake.e2e-spec.ts` — full e2e test booting AppModule with overridden `KYSELY_MODULE_CONNECTION_TOKEN` (in-memory SQLite) and `DOCUMENT_STORAGE_ROOT` (temp dir). Three scenarios:
  1. **Full intake flow (odd id → Expense)**: Upload → triage → post (with semantic override) → complete document → verify all status transitions (pending → triaged → processed) and expense.status='posted', expense.voucher_id set, currency='EUR'.
  2. **Dedup flow**: Upload same file twice → verify dedup (same doc id, deduplicated:true, 2 sources) → triage once → verify exactly 1 expense.
  3. **Even id → SalesInvoice**: Upload two docs (first consumes odd id 1, second gets even id 2) → triage even → post invoice → verify invoice.status='posted', invoice.voucher_id set.

### Key decisions
- **Semantic override required**: The OCR stub emits `DK_INPUT_25` VAT code, which the NullCountryPlugin rejects (only validates `NULL_STANDARD`, `IE_INPUT_23`, `IE_OUTPUT_23`). Without an override the pipeline holds for approval (status 'pending'). The e2e test passes `{ ruleType: 'semantic', reason: 'e2e test override' }` in the POST body to bypass semantic validation and auto-post. This is an existing mechanism (not new business logic).
- **Migration boot before AppModule**: Migrations must run before compiling the testing module, since seed data (organization, policy config, accounts) is needed by services at startup.
- **DOCUMENT_STORAGE_ROOT override**: Uses `mkdtempSync` + `rmSync` for temp directory lifecycle; `DocumentStorageService.saveFile` creates subdirectories with `recursive: true`.
- **Type-safe supertest responses**: Used `.then((r) => r.body as T)` pattern to avoid `@typescript-eslint/no-unsafe-member-access` lint errors on supertest's `any`-typed `.body`.
- **Document status transitions**: received → pending (upload) → triaged (triage) → processed (complete endpoint).

### Verification
- `npm run build` → clean (0 errors).
- `npm run lint` → clean (0 errors, 0 warnings).
- `npx jest --config ./test/jest-e2e.json --testPathPatterns='intake' --no-cache` → 3/3 passed.

## W3-1: Atomic override persistence + category cleanup (2026-05-31)

### What was built
- **`src/rules/types.ts`** — Added `category: string` to `SemanticValidationContext` so the business object's real category flows through from the controller without reverse-engineering from account codes.
- **`src/policy/policy.service.ts`** — Added `logOverrideTx(trx, record)` method that inserts an override row using a Kysely transaction handle (not the standalone `this.db`). Extracted shared `insertOverride` private helper to avoid duplication with existing `logOverride`.
- **`src/ledger/pipeline/posting-pipeline.service.ts`** — Three changes:
  1. Replaced `categoryMapper: (accountCode: string) => string` with `category: string` in `PostingPipelineParams`. The pipeline now sets `ResolvedLine.category = params.category` uniformly on all lines. Controllers pass `expense.category` or `'revenue'` directly.
  2. Added `category: params.category` to `SemanticValidationContext` so semantic validation gets the real category.
  3. In `atomicPost()`, called `this.policyService.logOverrideTx(trx, ...)` inside the same transaction as the voucher write and status update — the override row and the post commit or roll back together (ADR-0005 / ADR-0012).
- **`src/expenses/expenses.controller.ts`** — Replaced `categoryMapper: (accountCode) => accountCode.startsWith('EXPENSE_') ? expense.category : ''` with `category: expense.category`.
- **`src/sales-invoices/sales-invoices.controller.ts`** — Replaced `categoryMapper: (_accountCode) => 'revenue'` with `category: 'revenue'`.
- **`src/rules/rules.service.ts`** — In `validateSemantic`, moved the `resolveCategoryMapping` call from per-line iteration to a single call using `context.category`. VAT code validation remains per-line.
- **`test/override-pipeline.e2e-spec.ts`** — Created e2e test with a `StrictTestPlugin` extending `NullCountryPlugin` that rejects `'STRICT_REJECTED'` VAT code. Four scenarios:
  1. Post without override → holds for approval (status 'pending')
  2. Post with override → posts (status 'posted'), voucher exists, exactly one override row in DB with correct fields
  3. Normal category (no override needed) → auto-posts, no override row
  4. Double post → idempotency guard returns 409, still exactly one override row
- **`src/sales-invoices/sales-invoices.controller.spec.ts`** — Updated test expectation from `categoryMapper: expect.any(Function)` to `category: 'revenue'`.
- **`src/rules/rules.service.spec.ts`** — Added `category: 'software'` to `defaultSemanticContext`.

### Key decisions
- **Override guard**: Changed from `if (params.override)` to `if (params.override?.ruleType)` because the controller passes `override ?? {}` (empty object), which was truthy and caused NOT NULL constraint violations on the override table insert.
- **Rule name**: Set `rule_name` to the same value as `rule_type` (`'semantic'`) for now — semantic validation is monolithic; finer rule identification can be added when rules become granular.
- **Category in context, not per-line**: The category mapping check now runs once against `semanticContext.category` instead of per-line. This is correct because a single business object has one category; all its voucher lines share it.
- **StrictTestPlugin in e2e**: Registered via `overrideProvider(NullCountryPlugin).useClass(StrictTestPlugin)` — the PluginLoader's DI-injected `nullPlugin` becomes the strict test plugin, and since the org's country='IE' falls back to the null plugin, the strict rules apply.
- **NullCountryPlugin stays permissive**: The strict behavior lives only in the test plugin; the production plugin is untouched.

### Bugs found and fixed
- **Empty override body trap**: When the controller receives no body, `override` is `undefined` and becomes `{}` via `override ?? {}`. This was truthy but had undefined fields, causing `SQLITE_CONSTRAINT_NOTNULL` on the override insert. Fixed by checking `params.override?.ruleType` instead of `params.override`.

### Verification
- `npm run build` → clean (0 errors).
- `npm run lint` → clean (0 errors, 0 warnings).
- `npx jest --config ./test/jest-e2e.json --testPathPatterns='override-pipeline' --no-cache` → 4/4 passed.
- Full unit test suite: 210/211 passed (1 pre-existing flaky `expect(...).rejects.toThrow()` in `database.module.spec.ts`).
- Full e2e suite: 27/28 passed (1 pre-existing voucher duplicate 500 vs 409 in `voucher.e2e-spec.ts`).

## W3-2: Real FX rate integration in draft voucher generation (2026-05-31)

### What was built
- **`src/plugins/country-plugin.interface.ts`** — Added `getReferenceRate(fromCurrency: string, toCurrency: string, date: string): number` method with full JSDoc. Rate semantics: how many `toCurrency` units does 1 `fromCurrency` unit buy. Must return a positive number. When `fromCurrency === toCurrency`, rate is exactly 1.0.
- **`src/plugins/null-country.plugin.ts`** — Implemented `getReferenceRate`: returns 1.0 when `fromCurrency === toCurrency`, otherwise throws `Error('Cross-currency FX not supported in null plugin: X → Y')`. This matches the v1 constraint of EUR-only deployment.
- **`src/expenses/expenses.service.ts`** — In `generateDraftVoucher`, replaced dead `fxRate = isBaseCurrency ? 1 : 1` and `baseAmount = (amount) => isBaseCurrency ? amount : amount` with real FX: `const fxRate = plugin.getReferenceRate(expense.currency, baseCurrency, expense.tax_point_date)` and `const baseAmount = (amount: number) => Math.round(amount * fxRate)`.
- **`src/sales-invoices/sales-invoices.service.ts`** — Same pattern in `generateDraftVoucher`. Previously the method didn't even compute `base_amount` from `fxRate` — it set `base_amount = invoice.gross_amount` etc. directly. Now uses `baseAmount()` for all three lines (AR, Revenue, VAT_PAYABLE). Removed unused `isBaseCurrency` variable.
- **`src/plugins/plugin-loader.service.spec.ts`** — Added `describe('getReferenceRate')` block with 5 tests:
  1. Same currency (EUR→EUR) → 1.0
  2. Same currency (DKK→DKK) → 1.0
  3. Cross-currency (EUR→DKK) → throws
  4. Cross-currency (USD→EUR) → throws
  5. Date parameter is accepted but ignored (returns 1.0 for any date with same currency)

### Key decisions
- **Rate lives on CountryPlugin, not CurrencyService**: The country plugin is the sole resolver of country-specific rules. An FX rate is country-specific (what source to use, what holiday calendar, what cutoff time). The separate `FXRateService` (with hardcoded rates) is a separate concern for future settlement FX; the draft generation uses the plugin's authoritative rate.
- **`base_amount = Math.round(amount * fxRate)`**: Integer cents per the project convention. The `Math.round` ensures no floating-point surprises at the cent boundary.
- **NullCountryPlugin throws for cross-currency**: In v1 the project is EUR-only, so no cross-currency rates are needed. A real country plugin (e.g., a Danish plugin) would implement actual rate fetching.
- **No test changes needed**: All existing tests use EUR, and `EUR→EUR rate = 1.0`, so `Math.round(amount * 1.0) = amount` — identical behavior to the old stub. The `sales-invoices.service.spec.ts` assertion `expect(line.base_amount).toBe(line.amount)` continues to hold.

### Verification
- `npm run build` → clean (0 errors).
- `npm run lint` → clean (0 errors, 0 warnings).
- Unit tests: all 29 suites passed (plugin-loader: 25 tests — 5 new `getReferenceRate`).
- `npm run test:e2e` → 6 suites, 28/28 passed.

## W3-3: Gapless sequential voucher numbering + atomic idempotency claim + hash chain fix (2026-05-31)

### What was built
- **`src/database/migrations/012_create_voucher_sequence.ts`** — Creates `voucher_sequence(year TEXT PRIMARY KEY, last_number INTEGER NOT NULL DEFAULT 0)`. Per-year sequence counter for gapless V-YYYY-NNNNNN numbering.
- **`src/database/migrations/index.ts`** — Registered migration 012.
- **`src/database/types.ts`** — Added `VoucherSequenceTable` to `Database` interface.
- **`src/ledger/posting/voucher-hash.ts`** — Fixed `computeVoucherHash` per ADR-0013: `previous_hash` is now **prepended** to the canonical JSON string (`prevHash + canonical`), not embedded inside the JSON object. Uses `GENESIS_HASH` as fallback when `previous_hash` is null.
- **`src/ledger/posting/posting.service.ts`** — `postVoucherTx` now mints gapless `V-YYYY-NNNNNN` numbers inside the transaction using the `voucher_sequence` table. Ignores `draft.voucher_number` entirely (never carries DRAFT- prefix or business-object-derived number into posted voucher). Uses `sql` template for atomic `last_number + 1` increment.
- **`src/ledger/pipeline/posting-pipeline.service.ts`** — Replaced external `getStatus` check-then-act with atomic conditional UPDATE: both the auto-post path (`atomicPost`) and hold-for-approval path (`claimForApproval`) use `WHERE status = 'draft'` with `returning('id')`; if no rows updated, throws `ConflictException`. Removed `getStatus`, `updateStatus`, and `isUniqueViolation` methods. Removed `NotFoundException` import (no longer needed).
- **`src/ledger/voucher/types.ts`** — Made `voucher_number` optional in `DraftVoucher` (`voucher_number?: string`).
- **`src/ledger/voucher/voucher.schema.ts`** — Made `voucher_number` optional in Zod schema (`.optional()`).
- **`src/expenses/expenses.service.ts`** — `generateDraftVoucher` now returns `voucher_number: 'PENDING'` instead of `DRAFT-EXP-${id}-${Date.now()}`.
- **`src/sales-invoices/sales-invoices.service.ts`** — `generateDraftVoucher` now returns `voucher_number: 'PENDING'` instead of `invoice.invoice_number`.

### Test updates
- **`src/expenses/expenses.service.spec.ts`** — Changed `expect(draft.voucher_number).toMatch(/^DRAFT-EXP-/)` to `expect(draft.voucher_number).toBe('PENDING')`.
- **`src/sales-invoices/sales-invoices.service.spec.ts`** — Changed `expect(draft.voucher_number).toBe('INV-2026-001')` to `expect(draft.voucher_number).toBe('PENDING')`.
- **`src/sales-invoices/sales-invoices.controller.spec.ts`** — Updated `mockDraft.voucher_number` to `'PENDING'` and corresponding assertion.
- **`src/corrections/corrections.service.spec.ts`** — Removed assertions on `voucher_number` in `postVoucher` call args (reversal `-REV` and corrected `-COR` suffixes), since posting service now ignores draft voucher_number.
- **`src/corrections/corrections.integration.spec.ts`** — Changed reversal/corrected voucher number assertions from exact `-REV`/`-COR` suffix matches to regex `^V-2026-\d{6}$` format check + non-equality with original.
- **`test/voucher.e2e-spec.ts`** — Updated "duplicate" test to verify gapless mints fresh numbers each time. Updated GET test to match `V-2026-NNNNNN` format instead of exact input value.

### Key decisions
- **Sequence inside transaction**: The `voucher_sequence` increment happens in the same transaction as the voucher insert — SQLite's single writer ensures no race conditions, making the sequence truly gapless.
- **Per-year sequence**: One counter per calendar year (`year` is the PK). Reset per year (not continuous) per ADR-0021 — the exact reset cadence is a country-plugin presentation choice.
- **Hash chain fix**: `previous_hash` is no longer inside the JSON object — it's prepended as a string before hashing. This makes the chain cryptographic: each voucher commits to the full prior state hash, not just its own data.
- **Atomic idempotency**: Conditional `UPDATE ... SET status = 'posted' WHERE id = ? AND status = 'draft'` inside the transaction closes the TOCTOU window. The `returning('id')` pattern (returns `undefined` on no match) is the clean way to detect zero-affected-rows in Kysely + better-sqlite3.
- **Draft vouchers have no real number**: `voucher_number` is optional in `DraftVoucher` and set to `'PENDING'` as a placeholder. The real gapless number is minted only at posting time, consistent with ADR-0020 (voucher minted only at posting).

### Verification
- `npm run build` → clean (0 errors).
- `npm run lint` → clean (0 errors, 0 warnings).
- `npm test` → 28 suites, all passed.
- `npm run test:e2e` → 6 suites, 28/28 passed.
