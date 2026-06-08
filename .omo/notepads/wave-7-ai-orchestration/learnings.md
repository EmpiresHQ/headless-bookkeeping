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
