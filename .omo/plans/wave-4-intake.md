# Wave 4: Intake + Triage

## Overview
This wave handles document intake (hash-based deduplication, filesystem storage), OCR triage stub, correction flows (supersession and reversal), ReportingPeriod CRUD, and end-to-end intake integration. Documents enter the system here and flow through to the posting pipeline built in Wave 3.

> **Detailed implementation plan (bite-sized TDD):** [`docs/superpowers/plans/2026-05-29-wave-4-intake.md`](../../docs/superpowers/plans/2026-05-29-wave-4-intake.md) — the step-by-step "how". This file remains the "what / why" spec.

## Prerequisites
- **Wave 3 complete**: Business objects, Rules engine, Policy gate, Pipeline integration
- `docker compose up` starts successfully
- `npm run build` and `npm test` pass

## Definition of Done
- Documents are stored on filesystem with SHA-256 hash deduplication
- OCR triage stub creates Expense/SalesInvoice drafts from uploaded documents
- Correction flow handles draft edits and posted voucher reversals
- ReportingPeriod schema exists with CRUD endpoints
- End-to-end intake flow works: upload → triage → draft → post
- Agent-executed QA scenarios pass with evidence captured
- Git commit records the wave
- **Wave gate — ALL green, exactly as CI runs them** (see `.omo/plans/engineering-guardrails.md`): `npm run build && npm run lint && npm run test && npm run test:e2e`
- **Real-DI integration test** for every cross-module behavior — no all-mock coverage (G2)
- **Schema only in migrations** — grep clean: no `createTable`/`CREATE TABLE` outside `src/database/migrations/` (G4)
- **"Must NOT do" greps clean**; stated DB invariants are real DB constraints proven by a test (G5/G6)
- **Per-wave verification pass** (plan-compliance + code-quality + scope-fidelity) before commit (G8)
- Base currency and example payloads use **EUR** (Ireland default), per ADR-0004 — never DKK

---

## Prologue — carried from the Wave-3 review (do first)

These are remediations from the Wave-3 pipeline code review. They harden the posting path that Wave-4 intake feeds documents into, so knock them out **before Task 20 (intake integration)** — the end-to-end intake flow should run over the corrected pipeline, not the Wave-3 one. Each carries an ADR decision (see references).

- [ ] W3-1. **Persist the Override atomically + prove the override path end-to-end (Findings A, B, E).** In `PostingPipelineService.atomicPost`, call `PolicyService.logOverride(...)` **inside the same transaction** as the voucher write and status update — an overridden post and its `override` row commit or roll back together (ADR-0005 / ADR-0012 amendments). While here: stop reverse-engineering `ResolvedLine.category` from the account-code prefix — carry the business object's real category into `SemanticValidationContext` as a single value, and drop the `accountCode.startsWith('EXPENSE_')` hack.
  - **Must NOT do**: do NOT expose a free-standing override endpoint (AC-6 still holds); do NOT make `NullCountryPlugin` reject things — it stays permissive by design.
  - **Acceptance**: a **full-pipeline e2e test using a strict test plugin** forces a semantic failure, supplies an override, and asserts (a) the object posts, (b) exactly one `override` row exists bound to the business object, and (c) without the override the same post holds for approval. The override row and the voucher are written in one transaction (kill the DB mid-test → neither exists).
  - **References**: ADR-0005 (Wave-3 review amendment), ADR-0012 (Wave-3 review note), ADR-0015.

- [ ] W3-2. **Real FX in draft generation (Finding C).** Add `getReferenceRate(fromCurrency, toCurrency, taxPointDate): number` to the `CountryPlugin` interface. In both draft generators replace the dead `const fxRate = isBaseCurrency ? 1 : 1` ternary: source the rate from the plugin, set `base_amount = round(amount × rate)` via `CurrencyService.convertToBase`, and let the structural tier enforce the account-currency match. `NullCountryPlugin` returns `1.0` same-currency and a documented stub cross-currency.
  - **Must NOT do**: do NOT post realized FX gain/loss (no settlement voucher exists in Wave 3/4 — deferred per ADR-0004); do NOT source the rate in the kernel; do NOT accept a free caller-supplied rate (the VAT-base rate is prescribed, ADR-0004).
  - **Acceptance**: a non-base-currency expense/invoice posts with `fx_rate ≠ 1` and `base_amount = round(amount × rate)`, balanced in base currency; a foreign line targeting a single-currency account that mismatches is rejected by Rules (real-DI test, G2).
  - **References**: ADR-0004 (Wave-3 review amendment).

- [ ] W3-3. **Gapless sequential voucher number + atomic idempotency claim (Findings D, F).** Mint a single per-Organization gapless sequential `voucher_number` (e.g. `V-YYYY-NNNNNN`) inside `PostingService` at post time — kill the `DRAFT-EXP-${id}-${Date.now()}` scheme and the dual numbering. Replace the check-then-act idempotency guard with one conditional `UPDATE … SET status='posting' WHERE id=? AND status='draft'` (0 rows → 409) inside the posting transaction.
  - **Must NOT do**: do NOT derive the number from the business object; do NOT carry a `DRAFT-` prefix or a timestamp into a posted voucher; do NOT leave a gap when a post rolls back (allocate within the transaction).
  - **Acceptance**: posting N vouchers yields a gapless sequence incrementing by exactly 1 (proven by a test); a concurrent/retried `/post` produces no second voucher and returns 409; the sequence advances in lockstep with the ADR-0013 hash chain.
  - **References**: ADR-0021 (new), ADR-0013, ADR-0020.

> **Wave-3 learnings correction:** `.omo/notepads/wave-3-pipeline/learnings.md` (Task 14) claims "Override is logged atomically with posting via `logOverride()`." That is **not** what shipped — `logOverride` was never called from the pipeline. W3-1 makes the claim true.

---

## TODOs

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
  - `OCRService` stub: `extractData(documentId: number): TriageResult` — returns hardcoded mock data based on document id parity. **Use IE/EUR defaults (ADR-0004), and VAT codes that `NullCountryPlugin` actually accepts (`IE_INPUT_23`), or the draft will fail semantic validation:**
    - Odd id → `{ document_type: 'receipt', entity_guess: 'Bolt', currency: 'EUR', gross_amount: 1525, vat_amount: 285, suggested_category: 'transport', suggested_vat_code: 'IE_INPUT_23', confidence: 0.94 }`
    - Even id → `{ document_type: 'invoice', entity_guess: 'Acme Ltd', currency: 'EUR', gross_amount: 12300, vat_amount: 2300, suggested_category: 'revenue', suggested_vat_code: 'IE_OUTPUT_23', confidence: 0.98 }` (a sales invoice carries **output** VAT; the draft generator resolves `'revenue'` → `IE_OUTPUT_23` regardless, ADR-0002)
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

  **Acceptance Criteria**:
  - [ ] `POST /api/documents/1/triage` creates an Expense with category="transport", gross_amount=1525 (EUR)
  - [ ] `POST /api/documents/2/triage` creates a SalesInvoice with gross_amount=12300 (EUR), output VAT
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
    3. **Financial change, original posted, period open** → create reversal Voucher (**mirrored lines: same accounts and amounts, debit/credit flipped — NOT negative amounts**; the Wave-3 hardened ledger enforces `amount > 0` / `base_amount > 0` CHECKs per ADR-0019, so a reversal negates by swapping `is_debit`, never by a negative value), then create corrected Voucher with new lines. Both link to original via `reverses_id` and `corrects_object`
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
  - **Blocks**: Task 27 (period lock needs period schema), Task 28 (VAT report needs periods)
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

---

## Wave Acceptance Criteria
- [ ] All 5 tasks complete
- [ ] `docker compose up` starts and health responds 200
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with new tests
- [ ] Evidence files exist in `.omo/evidence/` for all tasks
- [ ] Git commit records Wave 4 changes

## Commit
- Message: `feat(intake): documents + triage + corrections + periods` — all Wave 4 files + tests
