# Wave 7: AI ingestion — Mastra orchestration, real OCR, agentic classification

## Overview
Replaces the Wave-4 AI **stubs** with the real "AI proposes" layer (CONTEXT.md), built on **Mastra** embedded in-process. A 2-pass intake (Pass 1 OCR→markdown, Pass 2 Mastra agent + tools → schema-validated `TriageResult`) runs as a Mastra **Workflow** with a **durable human-in-the-loop** suspend/resume checkpoint. The deterministic kernel is untouched: AI proposes, Rules validate, Policy decides, the plugin resolves accounting, and only a deterministic voucher reaches the hash-chained ledger. See **ADR-0024** (architecture) and ADR-0018/0016/0002/0009.

> **This `.omo` file is the canonical, authoritative spec — execute from it.** Channels (email/Telegram), the intent router, advisory chat, and SecretaryAgent outreach are **Wave 8**, not here.

## Prerequisites
- **Waves 4-6 complete**: documents/triage, reconciliation, periods/approvals/agents/admin, API token.
- **Runtime prerequisite (verify FIRST):** Mastra needs **Node ≥22 and ESM** (`@mastra/core` is ESM-first). Confirm the app's Node version + module setup; resolve any CJS/ESM interop before building on it (a Task-40 blocker if unmet).
- `npm run build` and `npm test` pass.

## Definition of Done
- Real OCR (Pass 1) transcribes a document to markdown, stored as a Conversation Artifact.
- Pass 2 (Mastra agent + tools) emits a Zod-validated `TriageResult` (amounts, document tax-point date, supplier proposal, category, `document_vat_marking`, confidence) — never an account/VAT code.
- The intake Workflow suspends for human approval on low confidence / uncertain supplier-or-category, persists durably (survives restart), and resumes on the Approval resolving.
- `auto_post_min_confidence` Policy gate is wired (un-stubbed) to the real confidence.
- AI provenance (proposal + model id/version + markdown) persisted for audit, outside the hash chain.
- **Wave gate — ALL green, exactly as CI runs them**: `npm run build && npm run lint && npm run test && npm run test:e2e`.
- **Real-DI integration test** for every cross-module behavior — no all-mock coverage (G2).
- **Schema only in migrations** (G4); stated DB invariants are real DB constraints proven by a test (G5/G6).
- **"Must NOT do" greps clean**; per-wave verification pass (G8).
- Base currency / examples use **EUR** (ADR-0004) — never DKK.

---

## TODOs

- [ ] 40. Mastra runtime + tool layer (embed + invariant)

  **What to do**:
  - Add `@mastra/core` (pin the version — API churn) and a `MastraService` NestJS provider wrapping the `Mastra` instance (agents/workflows/storage). dev-server NOT used — embedded library only.
  - **Storage:** point Mastra's storage at SQLite (LibSQL) — its snapshot/memory tables live **alongside** our domain tables, NOT replacing `Approval`/`Conversation` (ledger/Approval = SoR, VISION §505).
  - **Model profiles:** wire the CONFIG LLM profiles (`ocr`, `processing`, …) to Mastra's model router (provider/model/temperature per task).
  - **Tool layer (the invariant):** define tools as thin wrappers over kernel services. **Read-tools** (`searchSuppliers`, `listCategories`, `getClassificationMemory`, `previewCategoryMapping`) free; the only **write-tool** `proposeDraft` funnels through Rules→Policy→post. **No `post()` tool.** Minimal toolset per agent (ADR-0018). Tool schemas in **Zod**.

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

- [ ] 41. Pass 1 — OCR → markdown (+ audit artifact)

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

- [ ] 42. Pass 2 — Mastra agent + tools → structured TriageResult

  **What to do**:
  - A Mastra **agent** over the Pass-1 markdown with read-tools (`searchSuppliers`/`listCategories`/`getClassificationMemory`), emitting **`structuredOutput`** = Zod `TriageResult`: `gross_amount`, `vat_amount`, **`tax_point_date` (document/invoice date — ADR-0009, not arrival)**, supplier-identity proposal (match by reg-key/IBAN/descriptor or create), `category`, `document_vat_marking`, `confidence`.
  - **Bounded retry** on invalid structured output; if still invalid → hand to the suspend gate (Task 43), never post garbage.
  - `classification memory` fed as an advisory prior (CONTEXT.md — never a gate).

  **Must NOT do**:
  - Do NOT output an account or VAT code — the plugin is the sole resolver (ADR-0002). Pass 2 proposes **category + supplier**, not accounting.
  - Do NOT trust `document_vat_marking` as authority — it is at most a "was VAT charged?" hint.
  - Do NOT let free text cross into the kernel — only the validated `TriageResult`.

  **References**: ADR-0024 (Pass 2 + boundary), ADR-0002, ADR-0009, Wave-5 Tasks 32/33 (marking, Entity).

  **Acceptance**:
  - [ ] Pass 2 returns a Zod-validated `TriageResult` with a confidence and a document-date `tax_point_date`.
  - [ ] Output never contains an account/VAT code; the plugin still resolves them downstream (real-DI test).
  - [ ] Invalid model output retries then suspends — never posts.

  **Commit**: `feat(ai): Pass 2 agentic extract+classify → validated TriageResult`

- [ ] 43. Intake Workflow + durable suspend/resume HITL

  **What to do**:
  - A Mastra **Workflow**: `pass1 (OCR→markdown) → pass2 (agent) → approval gate`. The gate `suspend()`s on low confidence / uncertain supplier or category; the snapshot **persists to storage (survives restart/deploy)**.
  - **Correlate the suspend with a domain `Approval`** (Wave-6) — the Approval is the SoR + the thing a channel shows the user; the Mastra run is keyed by `approval_id`.
  - **Resume on external event:** when the Approval resolves (Wave-8 channel, or the HTTP API in Wave 7), call `run.resume({...resumeData})` with the human decision; the workflow continues → `proposeDraft` → pipeline.
  - Real-DI test: uncertain result → workflow suspends + Approval row pending; **kill/recreate the process**, then resume by `runId` → posts. (Proves durability across restart.)

  **Must NOT do**:
  - Do NOT hold the suspended run in memory / async-wait — it must be a persisted snapshot (durable).
  - Do NOT treat the Mastra run state as SoR — the Approval/ledger are.

  **References**: ADR-0024 (spine + durable HITL), ADR-0015 (Approval), Wave-6 Task 29.

  **Acceptance**:
  - [ ] Uncertain extraction → workflow `suspended` + one pending `Approval`.
  - [ ] After a simulated process restart, `resume(runId, decision)` continues and posts via the pipeline (real-DI, G6).
  - [ ] Confident extraction flows straight through (no suspend).

  **Commit**: `feat(ai): intake workflow + durable human-in-the-loop suspend/resume`

- [ ] 44. Confidence → Policy + AI-provenance audit

  **What to do**:
  - **Un-stub** the Policy `auto_post_min_confidence` gate to consume the real Pass-2 confidence: below threshold → Approval (suspend); at/above → eligible for auto-post (still subject to other Policy/Rules). Confidence is a **Policy** input, never Rules (CONTEXT.md).
  - **Persist AI provenance**: the raw `TriageResult` proposal + **model id/version** + a reference to the `ocr_markdown` Artifact, tied to the business object — so "why did the AI propose this" is reconstructable. Operational record, **outside** the hash chain.
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
  - Update `test/intake.e2e-spec.ts`: upload → real OCR (faux/fixture model) → Pass 2 → (confident) auto-post-eligible / (uncertain) suspend+Approval → resume → posted. Keep deterministic via a fixture model profile (no live LLM in CI).

  **Must NOT do**:
  - Do NOT leave the deterministic odd/even stub in the live path (it stays only as a test fixture / faux model).
  - Do NOT call a live LLM in CI — use the `faux`/fixture model profile.

  **References**: ADR-0024, Wave-4 Task 17/20, Wave-5 Task 38.

  **Acceptance**:
  - [ ] Intake e2e runs the real 2-pass path against a fixture model and posts (confident) / suspends→resumes→posts (uncertain).
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
