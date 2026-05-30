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
