# Wave 7: AI ingestion — Mastra orchestration, real OCR, agentic classification

## Overview
Replaces the Wave-4 AI **stubs** with the real "AI proposes" layer (CONTEXT.md), built on **Mastra** embedded in-process. A 2-pass intake (Pass 1 OCR→markdown, Pass 2 **read-only** Mastra agent + tools → schema-validated `TriageResult`) runs as a Mastra **Workflow** that **routes draft-or-triage**: a confident `new_expense` becomes a draft (deterministic step) through the pipeline; an uncertain result creates no draft and raises an `AuditFinding(needs_triage)`. The deterministic kernel is untouched: AI proposes, Rules validate, Policy decides, the plugin resolves accounting, and only a deterministic voucher reaches the hash-chained ledger. Human-in-the-loop is durable on our own Approval/AuditFinding (no Mastra `suspend()` in v1). See **ADR-0024** (architecture) and ADR-0018/0016/0002/0009.

> **This `.omo` file is the canonical, authoritative spec — execute from it.** Channels (email/Telegram), the intent router, advisory chat, and SecretaryAgent outreach are **Wave 8**, not here.

## Prerequisites
- **Waves 4-6 complete** — Wave 7 hard-depends on aggregates that those waves build:
  - **Wave-5 Task 33** `entity` (supplier identity) — Pass 2's supplier-proposal tool.
  - **Wave-5 Task 32** `document_vat_marking` (the OCR field renamed from `vat_code`) — Pass 2 emits it, never a VAT code.
  - **Wave-5 Task 38** purchase-side triage outcomes (`new_expense|correction|duplicate|unknown`, no `sales_invoice`) — the live triage path the AI feeds.
  - **Wave-6 Task 29** `approval` — the HITL for a held draft (resolve → approve→post). (`workflow_run_id` is forward-compat only; v1 does not suspend a Mastra run.)
  - **Wave-6 Task 30** `audit_finding` (+ `needs_triage` finding_type) — the no-draft uncertain path.
  - **Wave-6 Task 36** `conversation`/`artifact` (incl. `ocr_markdown` kind) — Pass-1 markdown audit home.
- ⚠️ **RE-REVIEW GATE (Codex W7 review):** Wave 5 is already in implementation — its tasks **cannot be re-tightened from here**. So **re-review this Wave-7 plan AFTER Wave 5 ships**, verifying the prerequisites actually landed as specified (purchase-side outcomes, `document_vat_marking`, `entity`). Do not dispatch Wave-7 agents until that re-review passes. (Wave-6 prerequisites we *can* still tighten — and have: `approval.workflow_run_id`, `artifact.kind += ocr_markdown`.)
- **Runtime prerequisite (verify FIRST):** Mastra needs **Node ≥22 and ESM** (`@mastra/core` is ESM-first). Node is fine (22.x), but `package.json` has **no `"type": "module"`** and tsconfig is `nodenext` — Task 40 must explicitly resolve the ESM/CJS module strategy before building on Mastra.
- `npm run build` and `npm test` pass.

## Definition of Done
- Real OCR (Pass 1) transcribes a document to markdown, stored as a Conversation Artifact.
- Pass 2 (Mastra agent + tools) emits a Zod-validated `TriageResult` (amounts, document tax-point date, supplier proposal, category, `document_vat_marking`, confidence) — never an account/VAT code.
- The intake Workflow routes draft-or-triage: confident `new_expense` → draft → pipeline (auto-post or hold→Approval); uncertain/unknown → no draft → `AuditFinding(needs_triage)`. Both human waits are durable on our aggregates (survive restart); no Mastra `suspend()` in v1.
- `auto_post_min_confidence` Policy gate is wired (un-stubbed) to the real confidence.
- AI provenance (proposal + model id/version + markdown) persisted for audit, outside the hash chain.
- **Wave gate — ALL green, exactly as CI runs them**: `npm run build && npm run lint && npm run test && npm run test:e2e`.
- **Real-DI integration test** for every cross-module behavior — no all-mock coverage (G2).
- **Schema only in migrations** (G4); stated DB invariants are real DB constraints proven by a test (G5/G6).
- **"Must NOT do" greps clean**; per-wave verification pass (G8).
- Base currency / examples use **EUR** (ADR-0004) — never DKK.

---

## TODOs

- [x] 40. Mastra runtime + tool layer (embed + invariant)

  **What to do**:
  - **ESM strategy (researched — Codex W7 P2):** keep Nest **CommonJS** (do NOT add `"type":"module"`); keep tsconfig **`module: nodenext`** (Node 22.22 — and nodenext *preserves* dynamic `import()` in emitted CJS, whereas `module:commonjs` downlevels it to `require()` and throws `ERR_REQUIRE_ESM`). **Do NOT use SWC** (it emits ESM under nodenext — breaks; Nest's SWC recipe needs `commonjs`); use `tsc`/`nest build`. Full ESM migration is deferred to Nest v12 — not now.
  - Add `@mastra/core` (pin the version — API churn; `engines: node>=22.13`, dual ESM+CJS build) and a `MastraService` NestJS provider. **Load Mastra via an async factory provider using dynamic `import()`** (`useFactory: async () => await import('@mastra/core')`) — the safe default that survives `ERR_REQUIRE_ASYNC_MODULE` if a transitive dep uses top-level await. (Smoke-test a plain `require('@mastra/core')` first; if it works synchronously, a normal import is fine.) dev-server NOT used — embedded library only.
  - **Storage:** point Mastra's storage at SQLite (LibSQL) — its snapshot/memory tables live **alongside** our domain tables, NOT replacing `Approval`/`Conversation` (ledger/Approval = SoR, VISION §505).
  - **Model profiles:** wire the CONFIG LLM profiles (`ocr`, `processing`, …) to Mastra's model router (provider/model/temperature per task).
  - **Tool layer (the invariant):** the agent gets **read-tools ONLY** — thin read-wrappers over kernel services (`searchSuppliers`, `listCategories`, `getClassificationMemory`, `previewCategoryMapping`). The agent has **no write tool** (no `proposeDraft`, no `post`) — so it cannot create half-baked drafts (see Task 43). `proposeDraft` is a **deterministic post-agent step**, not an agent tool. Minimal toolset per agent (ADR-0018). Tool schemas in **Zod**.
  - **`proposeDraft` contract (Codex W7 P1):** the pipeline does NOT accept a raw AI proposal — it operates on an existing business object (`expense`/`sales_invoice`) and updates that table. So `proposeDraft(TriageResult)` = **create the `Expense` business object** (via the existing `ExpensesService.createExpense`, purchase-side per Wave-5 Task 38) from the validated `TriageResult`, then run the **existing** `generateDraftVoucher → posting pipeline (Rules→Policy→post)`. No new pipeline entry-point, no ad-hoc posting — it reuses the Wave-3/4 path. The agent never sees the voucher/post; it only proposes the business object.
  - **Route by `kind` (NF-2):** `proposeDraft` handles only `kind='new_expense'`. `correction`/`duplicate` route to the Wave-4 correction / dedup paths (link to original — stub if not yet built); `unknown` → hold for human triage. Never silently create a new expense for a non-`new_expense` kind.

  **Must NOT do**:
  - Do NOT give any agent a tool that writes the ledger directly / bypasses the pipeline (ADR-0012/0019). No `post` tool.
  - Do NOT let Mastra own domain truth — its tables are operational; `Approval`/`Conversation`/ledger remain SoR.
  - Do NOT run the Mastra dev server / separate process — embed in-process.

  **References**: ADR-0024, ADR-0018, ADR-0012/0019, CONFIG §4 (LLM profiles).

  **Acceptance**:
  - [ ] `MastraService` resolves in DI; a trivial agent runs end-to-end against a `faux`/test model.
  - [ ] A write attempted by an agent goes through the pipeline; there is no `post` tool (grep clean).
  - [ ] Node/ESM prerequisite confirmed (build + test green).

  **Commit**: `feat(ai): embed Mastra runtime + tool layer (pipeline-gated, no post tool)`

- [x] 41. Pass 1 — OCR → markdown (+ audit artifact)

  **What to do**:
  - `OcrService.transcribe(documentId): string` — vision/OCR model (per the `ocr` profile) → **markdown** of the document. Transcribe, do NOT structure.
  - Persist the markdown as a **Conversation `Artifact`** (`kind='ocr_markdown'`) — audit ("what we read") + reproducibility anchor for Pass 2.
  - Real-DI test with a `faux`/fixture model (deterministic) proving markdown is produced + stored.

  **Must NOT do**:
  - Do NOT emit structured fields here — markdown only (structure is Pass 2).
  - Do NOT hardcode a provider — read the `ocr` profile.

  **References**: ADR-0024 (Pass 1), CONTEXT.md (Document, Artifact).

  **Acceptance**:
  - [ ] Transcribing a document yields markdown stored as an `ocr_markdown` Artifact on its Conversation.
  - [ ] Re-running Pass 2 reads the stored markdown without re-calling vision.

  **Commit**: `feat(ai): Pass 1 OCR→markdown + audit artifact`

- [x] 42. Pass 2 — Mastra agent + tools → structured TriageResult

  **What to do**:
  - **Replace the Wave-4 TS-interface `TriageResult` with a Zod schema (Codex W7 P0)** — the validated AI-output contract. The current `src/triage/types.ts` interface still has a `vat_code` field; **remove it**. Fields: **`kind`** (discriminant — `new_expense | correction | duplicate | unknown`, the Wave-5 Task-38 outcome union; NF-2), `gross_amount`, `vat_amount`, **`currency`** (`z.string().length(3)`; if the document omits it, fall back to the org base currency — NF-4, `createExpense` requires it), **`tax_point_date` (document/invoice date — ADR-0009, not arrival)**, supplier-identity proposal (match by reg-key/IBAN/descriptor or create), `category`, `document_vat_marking`, `confidence`. **No `vat_code`, no account** — the plugin resolves account+VAT (ADR-0002); the marking is evidence, never authority.
  - A Mastra **agent** over the Pass-1 markdown with read-tools (`searchSuppliers`/`listCategories`/`getClassificationMemory`) emits **`structuredOutput`** = that Zod `TriageResult`.
  - **Bounded retry** on invalid structured output; if still invalid → route to `needs_triage` (no draft, Task 43), never post garbage.
  - `classification memory` fed as an advisory prior (CONTEXT.md — never a gate).

  **Must NOT do**:
  - Do NOT output an account or VAT code — the plugin is the sole resolver (ADR-0002). Pass 2 proposes **category + supplier**, not accounting.
  - Do NOT trust `document_vat_marking` as authority — it is at most a "was VAT charged?" hint.
  - Do NOT let free text cross into the kernel — only the validated `TriageResult`.

  **References**: ADR-0024 (Pass 2 + boundary), ADR-0002, ADR-0009, Wave-5 Tasks 32/33 (marking, Entity).

  **Acceptance**:
  - [ ] Pass 2 returns a Zod-validated `TriageResult` with a confidence and a document-date `tax_point_date`.
  - [ ] Output never contains an account/VAT code; the plugin still resolves them downstream (real-DI test).
  - [ ] Invalid model output retries (bounded) then routes to `needs_triage` (no draft) — never posts.

  **Commit**: `feat(ai): Pass 2 agentic extract+classify → validated TriageResult`

- [x] 43. Intake Workflow — draft-or-triage routing (no garbage drafts; no mid-extraction suspend)

  > **Design (Codex W7 NF-1/NF-3 + grilling):** the agent is **read-only** and produces ONE complete validated `TriageResult` (no "create draft" tool → no half-baked/abandoned drafts). A draft is created **once, deterministically, only when the result is confident and `kind='new_expense'`**. There is **no Mastra `suspend()` in v1** — durable human-in-the-loop is carried by our own Wave-6 aggregates (Approval for a held draft; AuditFinding for an uncertain no-draft case), both on-disk and reboot-safe. (Mastra's suspend/resume stays available for future flows; v1 doesn't need it.)

  **What to do**:
  - Mastra **Workflow**: `pass1 (OCR→markdown) → pass2 (read-only agent → complete TriageResult) → route by confidence + kind`:
    - **confident + `kind='new_expense'`** → the deterministic `proposeDraft` step creates the draft `Expense` (one shot) → existing `generateDraftVoucher → Rules → Policy` (Task 44). Policy decides **auto-post** or **hold → Approval(object=the draft Expense)** (Wave-6) — the existing HITL; resume = Wave-6 `approve → post`.
    - **uncertain / `kind='unknown'` / supplier unresolved** → **NO draft.** Emit an `AuditFinding(finding_type='needs_triage')` (Wave-6) referencing the Document/Conversation → human triages (Wave-8 surfaces it) → **re-run** the workflow. No partial Expense is ever created.
    - `correction`/`duplicate` → Wave-4 correction/dedup path (link to original; stub if unbuilt). **NF-9 (deferred to post-Wave-5 re-review):** the exact handoff — which `TriageResult` fields these kinds carry and which service/endpoint they call (`POST /api/expenses/:id/correct` payload, or the dedup lookup) — is specified once Wave-5's correction/dedup stubs land; v1 may simply route these to `needs_triage` until then.
  - The workflow **ends** after routing (no long-lived suspended run). Durability is the Approval / AuditFinding row, not Mastra state.

  **Must NOT do**:
  - Do NOT give the agent a write/`create-draft`/`proposeDraft` tool — drafts are created by the deterministic post-agent step, only from a complete confident result (no garbage drafts).
  - Do NOT create an Expense for an uncertain/unknown result — route to `needs_triage`, not a junk draft.
  - Do NOT use Mastra `suspend()` for the human wait in v1 — the Approval/AuditFinding is the durable wait (Mastra state is not SoR).

  **References**: ADR-0024, ADR-0015 (Approval), ADR-0018 (AuditFinding), Wave-6 Task 29/30.

  **Acceptance**:
  - [ ] Confident `new_expense` → exactly one draft Expense created → pipeline (auto-post or Approval) — real-DI test.
  - [ ] Uncertain/unknown → **no** Expense row; one `needs_triage` AuditFinding — real-DI test (G6: assert zero expense rows).
  - [ ] The agent has no write tool (grep clean); drafts only originate from the deterministic step.
  - [ ] A held draft survives a process restart (the Approval row is on disk) and posts on approval.

  **Commit**: `feat(ai): intake workflow — draft-or-triage routing, read-only agent`

- [x] 44. Confidence → Policy + AI-provenance audit

  **What to do**:
  - **Confidence input contract (Codex W7 P1):** `PolicyService.decide()` today takes only `(DraftVoucher, RuleResult[])` — there is no confidence channel. Add a **`PolicyContext { confidence?, supplierKnown?, … }`** parameter threaded from the pipeline, and **un-stub** the `auto_post_min_confidence` gate to read `context.confidence`: below threshold → **hold → Approval** (on the existing draft Expense, Wave-6); at/above → auto-post-eligible (still subject to other Policy/Rules). Confidence is a **Policy** input, never Rules / never a voucher field (CONTEXT.md, ADR-0024).
  - **AI provenance table (Codex W7 P1):** new `ai_proposal` table — `id`, `business_object_type`, `business_object_id`, `model_id`, `model_version`, `raw_triage_result` (JSON), `ocr_artifact_id` (FK → artifact), `confidence`, `created_at`. Written when an AI-originated draft is created; lets "why did the AI propose this" be reconstructed. **Operational record, outside the hash chain** — the voucher schema gets NO provenance field. **Migration spec (NF-5):** a numbered Kysely migration (next free number at impl time) registered in `migrations/index.ts`; add an `AiProposalTable` typing to the `Database` interface; FK `ocr_artifact_id → artifact.id`; `raw_triage_result` stored as **TEXT (serialized JSON)** per the repo's SQLite convention (cf. `document_source.metadata`).
  - Real-DI tests for both branches (below/above threshold) + provenance row exists for a posted AI-originated voucher.

  **Must NOT do**:
  - Do NOT feed confidence into Rules (it's a Policy input).
  - Do NOT put the AI proposal into the hash-chained ledger — provenance is operational audit only.

  **References**: ADR-0024 (boundary), CONFIG §3 (`auto_post_min_confidence`), ADR-0013 (chain).

  **Acceptance**:
  - [ ] Low-confidence AI draft holds for Approval; high-confidence is auto-post-eligible — proven by test.
  - [ ] A posted AI-originated voucher has a provenance record (proposal + model id/version + markdown ref); the ledger row itself is unchanged/deterministic.

  **Commit**: `feat(ai): confidence→Policy gate + AI provenance audit`

- [ ] 45. Wire triage to the real pipeline + intake e2e

  **What to do**:
  - Replace the Wave-4 `OcrService.extract()` stub usage in `TriageService` with the real Workflow (Tasks 41-43); triage now produces real drafts with real confidence + document tax-point date.
  - Update `test/intake.e2e-spec.ts`: upload → real OCR (faux/fixture model) → Pass 2 → **(confident `new_expense`)** draft → pipeline → auto-post/Approval; **(uncertain)** no draft → `AuditFinding(needs_triage)`. Keep deterministic via a fixture model profile (no live LLM in CI).

  **Must NOT do**:
  - Do NOT leave the deterministic odd/even stub in the live path (it stays only as a test fixture / faux model).
  - Do NOT call a live LLM in CI — use the `faux`/fixture model profile.

  **References**: ADR-0024, Wave-4 Task 17/20, Wave-5 Task 38.

  **Acceptance**:
  - [ ] Intake e2e runs the real 2-pass path against a fixture model: confident `new_expense` → posts (or holds→Approval); uncertain → no expense row + a `needs_triage` AuditFinding.
  - [ ] No live LLM call in CI; tests deterministic.

  **Commit**: `feat(ai): wire real 2-pass intake + e2e`

---

## Wave Acceptance Criteria
- [ ] All 6 tasks complete
- [ ] `docker compose up` starts and health responds 200
- [ ] `npm run build` / `lint` / `test` / `test:e2e` all green
- [ ] Evidence files in `.omo/evidence/` for each task
- [ ] Git commit records Wave 7

## Commit
- Message: `feat(ai): Mastra 2-pass intake — real OCR + agentic classify + durable HITL`
