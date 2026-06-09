# Wave 7: AI Orchestration — Learnings

## Task 40: Mastra runtime + tool layer (embed + invariant)

### Date
2026-06-08

### Summary
Implemented the Mastra runtime embedded in-process within the NestJS application, with read-only tool implementations and a deterministic propose-draft service.

### Key Decisions

1. **Dynamic import for ESM compatibility**: `@mastra/core` is an ESM-only package. Since the project uses CJS (`no "type": "module"` in package.json) with `module: nodenext`, we use `await import('@mastra/core')` at runtime to load Mastra. This avoids the ESM/CJS conflict at build time.

2. **Agent import from subpath**: `Agent` is not exported from the main `@mastra/core` entry — it must be imported from `@mastra/core/agent`. The Mastra class is exported from the main entry.

3. **Testability via override pattern**: The `MastraService.initialize()` method accepts optional `overrides` parameter (`MastraClass`, `AgentClass`, `LibSQLStoreClass`) so tests can inject mock classes instead of triggering dynamic ESM imports (which Jest doesn't support without `--experimental-vm-modules`).

4. **Read-only tools only**: The agent has exactly 4 tools, all read-only wrappers over kernel services:
   - `searchSuppliers` → wraps `EntitiesService.list()` with name/country filtering
   - `listCategories` → returns hardcoded canonical categories
   - `getClassificationMemory` → queries expense history for a supplier
   - `previewCategoryMapping` → wraps `CountryPlugin.resolveCategoryMapping()`

5. **No write tools**: Verified via grep that no tool file contains `post`, `createDraft`, or `proposeDraft`. The agent cannot write to the ledger directly.

6. **ProposeDraftService**: A NestJS service (not a tool) that takes a validated `TriageResult` and runs it through the existing posting pipeline: `createExpense` → `generateDraftVoucher` → `Rules` → `Policy` → `post/hold`. Only handles `kind='new_expense'`; other kinds throw `BadRequestException`.

7. **TriageResult schema update**: Converted from plain interface to Zod schema. Added `kind` discriminant, `currency`, `tax_point_date`, `supplier_proposal`, `document_vat_marking` (nullable). Removed `vat_code`, `account`, `entity_guess`.

8. **Mastra storage**: Uses `@mastra/libsql` with `LibSQLStore` pointing to `./data/mastra.sqlite` (alongside the existing `./data/app.sqlite`).

### Versions
- `@mastra/core`: 1.41.0 (latest stable)
- `@mastra/libsql`: 1.12.1 (latest stable)
- `zod`: 4.4.3 (already installed, compatible with Mastra peer dep `^3.25.0 || ^4.0.0`)

### Files Created/Modified
- `package.json` — added `@mastra/core@1.41.0`, `@mastra/libsql@1.12.1`
- `src/triage/types.ts` — updated TriageResult to Zod schema
- `src/triage/ocr.service.ts` — updated to use new TriageResult fields
- `src/triage/ocr.service.spec.ts` — updated tests for new schema
- `src/ai/tools/tool-schemas.ts` — Zod schemas for all tool inputs/outputs
- `src/ai/tools/index.ts` — read-only tool implementations
- `src/ai/mastra.service.ts` — NestJS provider with dynamic import + testable overrides
- `src/ai/propose-draft.service.ts` — deterministic post-agent pipeline runner
- `src/ai/ai.module.ts` — NestJS module registering MastraService + ProposeDraftService
- `src/ai/mastra.service.spec.ts` — tests proving service resolves + agent has correct tools
- `src/ai/propose-draft.service.spec.ts` — tests proving proposeDraft creates expense + runs pipeline
- `src/app.module.ts` — registered AiModule

### Verification
- `npm run build` — passes with zero errors
- `npm test` — 473 tests pass (50 suites)

## Task 42: Pass 2 — Mastra agent + tools → structured TriageResult

### Date
2026-06-08

### Summary
Implemented Pass2AgentService that runs the Pass 2 Mastra agent over Pass-1 markdown and emits a Zod-validated TriageResult with bounded retry.

### Key Decisions

1. **Bounded retry pattern**: The `classify()` method retries up to 3 times on any failure (Zod validation error or agent error). After 3 failures, returns `null` to signal needs_triage (Task 43).

2. **Double validation**: Even though Mastra's `structuredOutput` accepts a Zod schema, we add an explicit `triageResultSchema.parse()` call as a safety net. Model-dependent behavior may return unvalidated data.

3. **Real-DI testing**: Tests use the same mock-class override pattern as MastraService tests. The agent's `structuredOutput` is spied/mocked to return deterministic results or throw errors for retry testing.

4. **Grep-clean output**: Verified that TriageResult has no `vat_code` or `account` fields — the country plugin is the sole resolver (ADR-0002). Tests explicitly assert these properties are absent.

5. **Null on uninitialized**: If Mastra agent is not initialized, `classify()` returns `null` immediately (no retries).

### Files Created/Modified
- `src/ai/pass2-agent.service.ts` — Pass2AgentService with classify() method
- `src/ai/pass2-agent.service.spec.ts` — 10 tests covering valid output, retry, validation, grep-clean
- `src/ai/ai.module.ts` — registered Pass2AgentService in providers and exports

## Task 44: Confidence → Policy + AI-provenance audit

### Date
2026-06-08

### Summary
Wired AI confidence as a Policy gate input and added an operational ai_proposal table for provenance audit. Confidence is a Policy input only — never fed to Rules.

### Key Decisions

1. **PolicyContext interface**: New optional parameter on `PolicyService.decide()`. Backward compatible — existing callers without context still work. Contains `confidence?: number` and `supplierKnown?: boolean`.

2. **Confidence gate un-stubbed**: If `context.confidence` is defined and below `DEFAULT_CONFIG.auto_post_min_confidence` (0.8) → hold-for-approval with reason "AI confidence X below threshold Y". Undefined confidence → skip check.

3. **Unknown-supplier gate un-stubbed**: If `context.supplierKnown === false` and `unknown_supplier_requires_approval` is true → hold-for-approval.

4. **PostingPipelineParams extended**: Added `confidence?: number` and `supplierKnown?: boolean` fields. Threaded through to `policyService.decide()`.

5. **ai_proposal table**: Operational audit table (NOT hash-chained). Stores `business_object_type`, `business_object_id`, `model_id`, `model_version`, `raw_triage_result` (JSON text), `ocr_artifact_id` (FK to artifact), `confidence`, `created_at`.

6. **Provenance written after pipeline**: `ProposeDraftService.writeAiProvenance()` runs after the pipeline completes (whether posted or held). Looks up the ocr_markdown artifact by the expense's document_id.

7. **ProposeDraftService now injects Kysely**: Needed for writing ai_proposal rows. Added `@InjectKysely()` constructor parameter.

8. **Test discipline**: Low-confidence tests verify hold-for-approval; high-confidence + known-supplier tests verify auto-post. Provenance row verified in both paths.

### Files Created/Modified
- `src/policy/types.ts` — added PolicyContext interface
- `src/policy/policy.service.ts` — un-stubbed confidence + supplier gates, added PolicyContext param
- `src/ledger/pipeline/posting-pipeline.service.ts` — added confidence/supplierKnown to PostingPipelineParams, threaded to decide()
- `src/database/migrations/027_add_ai_proposal.ts` — new migration
- `src/database/migrations/index.ts` — registered migration 027
- `src/database/types.ts` — added AiProposalTable interface
- `src/ai/propose-draft.service.ts` — passes confidence/supplierKnown to pipeline, writes ai_proposal row
- `src/policy/policy.service.spec.ts` — 9 new tests for confidence + supplier gates
- `src/ai/propose-draft.service.spec.ts` — 5 new tests for confidence paths + provenance

### Verification
- `npm run build` — passes with zero errors
- `npm test` — 513 tests pass (52 suites)

## Task 41: OCR → markdown (+ audit artifact)

### Date
2026-06-08

### Summary
Implemented Pass 1 OCR: `OcrService.transcribe(documentId)` calls a faux vision model, returns markdown, and stores it as a Conversation Artifact with `kind='ocr_markdown'`.

### Key Decisions

1. **Faux OCR model for v1**: Since no real vision model API is wired, `fauxOcrModel()` returns deterministic markdown based on document filename (receipt/invoice keywords) with id parity as fallback. This enables deterministic tests and pipeline integration.

2. **Idempotent transcription**: `transcribe()` checks for an existing `ocr_markdown` artifact before calling the model. Re-running reads stored markdown without re-calling — critical for cost control when a real model is connected.

3. **Dedicated OCR conversation**: Each document gets its own Conversation via `channel='api', thread_key='ocr:{documentId}'`. This creates a clean audit trail per document's OCR pass, separate from user-facing conversations.

4. **Filesystem storage**: Markdown is written to `./data/artifacts/ocr/{documentId}.md` (not SQLite blobs). The artifact's `storage_path` points to this file. Follows the existing artifact storage convention.

5. **Migration strategy**: SQLite doesn't support ALTER TABLE for CHECK constraints. Migration 026 recreates the `artifact` table with the expanded CHECK (`'inbound_attachment' | 'outbound_output' | 'ocr_markdown'`), copies data, drops old, renames new.

6. **`extract()` preserved**: The existing `extract()` method (returns structured `TriageResult`) is kept alongside `transcribe()` (returns markdown). They serve different pipeline stages — extract() for the structured triage path, transcribe() for Pass 1 OCR.

### Files Created/Modified
- `src/database/migrations/026_add_ocr_markdown_artifact_kind.ts` — new migration
- `src/database/migrations/index.ts` — registered migration 026
- `src/conversations/types.ts` — added `'ocr_markdown'` to `ArtifactKind`
- `src/database/types.ts` — updated `ArtifactTable` kind comment
- `src/triage/ocr.service.ts` — added `transcribe()` with faux model + artifact storage
- `src/triage/ocr.service.spec.ts` — 10 tests (3 extract + 7 transcribe)
- `src/triage/triage.module.ts` — imported `ConversationsModule`
- `src/triage/triage.integration.spec.ts` — added `ConversationsService` to DI

### Verification
- `npm run build` — passes with zero errors
- `npm test` — 490 tests pass (51 suites)

## Task 45: Wire triage to real pipeline + intake e2e

### Date
2026-06-08

### Summary
Replaced the deterministic odd/even `OcrService.extract()` stub in `TriageService.route()` with the real `IntakeWorkflowService.process()` pipeline. Added e2e tests for the full 2-pass intake flow. Fixed pre-existing e2e test infrastructure (Mastra dynamic import + auth guard).

### Key Decisions

1. **OcrModule extraction**: Created `OcrModule` to break the circular dependency between `TriageModule` and `AiModule`. Previously: `AiModule → TriageModule → AiModule`. Now: `AiModule → OcrModule` and `TriageModule → AiModule + OcrModule`.

2. **TriageService simplified**: Removed direct `OcrService.extract()`, `ExpensesService`, `SalesInvoicesService`, and `CurrencyService` dependencies. Now depends only on `IntakeWorkflowService` and `DocumentsService`. The workflow handles OCR → Pass 2 → routing → proposeDraft internally.

3. **TriageOutcome mapping**: `IntakeWorkflowResult` maps to `TriageOutcome`:
   - `DraftProposedOutcome` → `TriageOutcomeExpense` (with expense_id from `draft.expenseId`)
   - `NeedsTriageOutcome` → `TriageOutcomeUnknown` (with reason from workflow)
   - Invoice path deferred (IntakeWorkflowService only handles `new_expense` in v1)

4. **E2E test auth pattern**: The `ApiTokenGuard` (registered as `APP_GUARD` enhancer) cannot be overridden via `.overrideProvider()`. Solution: seed an API token after `app.init()` (when migrations have run), then add `.set('Authorization', ...)` to each request.

5. **E2E test Mastra mock**: `MastraService` dynamic import fails in Jest's VM context. Overrode with `fauxMastraService` that returns null from `getAgent()`.

6. **E2E test Pass 2 mock**: Overrode `Pass2AgentService` with a faux classify() that returns deterministic `TriageResult` based on document filename (`receipt` → confident new_expense, `uncertain` → unknown).

7. **Unknown-supplier gate**: The intake workflow's proposeDraft runs with no supplier ID, so the unknown-supplier policy gate holds for approval (expense status = 'pending'). The e2e test handles this by approving via the approvals endpoint to complete the flow.

### Files Created/Modified
- `src/triage/ocr.module.ts` — new module (breaks circular dependency)
- `src/triage/triage.service.ts` — replaced OcrService.extract() with IntakeWorkflowService.process()
- `src/triage/triage.module.ts` — imports AiModule + OcrModule, removed direct OcrService provider
- `src/ai/ai.module.ts` — imports OcrModule instead of TriageModule
- `test/intake.e2e-spec.ts` — 3 e2e tests (confident new_expense, uncertain, dedup)
- `test/faux-mastra.service.ts` — shared MastraService mock for e2e tests
- `test/app.e2e-spec.ts` — added MastraService override + auth token seeding
- `test/reconciliation.e2e-spec.ts` — added MastraService override + auth token seeding
- `test/override-pipeline.e2e-spec.ts` — added MastraService override + auth token seeding

### Verification
- `npm run build` — passes with zero errors
- `npm test` — 513 tests pass (52 suites)
- `npm run test:e2e` — 31 tests pass (7 suites)
