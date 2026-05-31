# AI ingestion: Mastra-orchestrated 2-pass OCR, durable human-in-the-loop, AI proposes / kernel posts

The "AI proposes" layer (real OCR + agentic classification) — replacing the Wave-4 OCR stub — is built on **Mastra**, embedded **in-process** (the ledger remains the source of truth; VISION §505 "Mastra NOT source of truth"). This ADR fixes how non-deterministic AI meets the deterministic, hash-chained kernel.

## 2-pass extraction

- **Pass 1 — OCR → markdown.** The document is transcribed to markdown by a vision/OCR model (per the `ocr` LLM profile, CONFIG); the model is told to *transcribe, not structure*. The markdown is stored as a **Conversation Artifact** — an audit record ("what we read") and a reproducibility anchor (Pass 2 can be re-run on the stored markdown without re-calling vision).
- **Pass 2 — extract + classify.** A Mastra **agent** reasons over the markdown with read-tools (`searchSuppliers`, `listCategories`, `getClassificationMemory`) and emits a **schema-validated (Zod) structured `TriageResult`**: amounts, the document/invoice **tax-point date** (ADR-0009 — not the arrival timestamp), a supplier-identity proposal (match or create), category, `document_vat_marking`, and confidence.
- Rationale: vision models transcribe far better than they emit strict structure; a text LLM reasons better over text. 2-pass is both simpler and more accurate than forcing structured output straight from the vision call.

## Workflow spine + human-in-the-loop (draft-or-triage; no garbage drafts)

The pipeline is a Mastra **Workflow** (pass1 → pass2 → route) — deterministic control flow with one free-reasoning step (pass 2). The **agent is read-only**: it has no "create draft" tool, so it cannot produce half-baked or abandoned drafts; its sole output is **one complete, schema-validated `TriageResult`**. A draft is then created by a **deterministic post-agent step**, exactly once, **only when the result is confident and `kind='new_expense'`** — and that draft goes through the normal kernel (`generateDraftVoucher → Rules → Policy`), no AI bypass.

**The human-in-the-loop is carried by the kernel's own durable aggregates, not by a Mastra `suspend()` (v1):**
- A draft Policy holds → a domain **`Approval`** on that draft (Wave-6); resolved later (Wave-8 channel) → `approve → post`.
- An **uncertain** result (low confidence / `kind='unknown'` / supplier unresolved) → **no draft is created** → an **`AuditFinding(needs_triage)`** (Wave-6) referencing the Document; a human triages → the workflow re-runs.

Both waits are durable on-disk (Approval / AuditFinding rows) and reboot-safe; the workflow simply ends after routing. Mastra's own `suspend()/resume()` is **not used in v1** (it remains available, with `approval.workflow_run_id` reserved, for future flows that must pause a run mid-execution). Channels (email/Telegram) that deliver the approval/triage to the user are Wave 8.

## The AI↔kernel boundary (invariant)

- **Only schema-validated structured output crosses into the kernel** — free text never does. Invalid output → bounded retry → then route to `needs_triage` (no draft); never post garbage. The agent is read-only (no write tool) — drafts are created only by the deterministic post-agent step, from a complete confident result.
- **Confidence is a Policy input, not a Rules input** (CONTEXT.md) — it drives `auto_post_min_confidence` (un-stub the gate). Below threshold → Approval.
- **Classification proposes meaning, the plugin resolves accounting.** Pass 2 outputs **category + supplier identity**, *never* the account or VAT code — the country plugin is the sole resolver (ADR-0002). `classification memory` is an advisory prior, never a gate.
- **Tools are thin wrappers over kernel services.** Read-tools are free; the only write-tool (`proposeDraft`) funnels through Rules → Policy → post; **there is no `post()` tool**; minimal toolset per agent (ADR-0018, ADR-0012, ADR-0019).
- **Non-determinism lives outside the chain.** The raw AI proposal + model id/version + the markdown are persisted for audit (operational provenance), but the hash-chained ledger only ever sees the deterministic *posted* voucher.

## Considered options

**`@earendil-works/pi-agent-core`** (lean, MIT) was evaluated and **rejected**: it has no first-class structured output (only a forced-tool workaround) and no durable suspend/resume (you build it on your own state) — both central to a human-approval product. **Mastra** provides both out of the box and is Zod-native (matching the kernel's W3 schemas), with a workflow engine that fits the 2-pass + suspend spine.

**Consequences / costs accepted:** heavier dependency surface; **Node ≥22 / ESM-first** (verify the app's build/runtime); Mastra owns its own snapshot/memory tables, running **alongside** (not replacing) our `Approval`/`Conversation` (ledger/Approval stay SoR); and API churn (0.x→1.x) — pin the Mastra version.
