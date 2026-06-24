# Document Archive & Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the manual triage flow legible. An operator looking at a document must be able to *see what it is* (preview thumbnail), *know when it arrived and where it came from*, *follow it to its supplier / expense / claimant once triaged*, and *act on it* — without the UI re-running OCR/LLM to show what was already computed.

**Architecture:** Two screens with a clean split (no shared mutation). `/intake` is the **work queue** — upload, `pending`, `needs_triage` with the per-reason action forms (unchanged ownership of triage actions). `/documents` is a **read-only archive** of every Document. Both screens show a preview thumbnail. The archive renders entirely from data persisted at intake (ADR-0039): a `preview_path` thumbnail rendered once as an early intake step, and classification facts read off the linked draft `Expense`. The old `Debug` (which re-ran the LLM) becomes a read-only `Details` view.

**Tech Stack:** NestJS, Kysely (better-sqlite3), Jest, React + Vite (`packages/web`), Tailwind, TypeScript.

## Global Constraints

- Schema changes go in **migrations only** (repo rule G4); update `database/types.ts` to match. Migrations are append-only and registered in `database/migrations/index.ts`. **Next free number is 060.**
- Document status enum: `'pending' | 'triaged' | 'needs_triage' | 'processed' | 'error'`. `processing_since` is set while in the pipeline, `NULL` when idle.
- Preview rendering reuses the **existing** `PdfRasterizer` (`triage/pdf-rasterizer.ts`, `pdftoppm`) and `ImageScaler` (`triage/image-scaler.ts`). No new image dependency.
- Thumbnails are written through `DocumentStorageService` (`documents/document-storage.service.ts`), not raw `fs`. Thumbnail bytes live next to source bytes under the same storage root; `preview_path` is the **relative** path.
- Server tests mirror `documents/documents.service.spec.ts`: real migrations against an in-memory `better-sqlite3` via a `TestingModule`. Web tests mirror `DocumentsView.test.tsx` (Vitest + Testing Library).
- The linkage from a Document to its business object is **reverse**: `expense.document_id` → document. One Document → 0..1 draft Expense in v1. `supplier_id` and `claimant_id` on the Expense are both FKs to `entity`. A Document whose outcome is a SalesInvoice / bank import / unresolved is **not** in scope for the Linked column (shows nothing there) — known v1 limitation.

---

### Task 1: Migration 060 — add `preview_path` to `document`, classification fields to `expense`

`preview_path` (nullable) holds the relative path to the rendered thumbnail; `NULL` means "not yet rendered" and triggers the lazy fallback (Task 4). The Expense gains the three classification facts the LLM computes but currently discards, so `Details` can render them without re-invoking the model (ADR-0039): `ai_confidence` (REAL), `ai_document_type` (TEXT), `ai_kind` (TEXT).

**Files:**
- Create: `packages/server/src/database/migrations/060_add_preview_path_and_expense_ai_fields.ts`
- Create: `packages/server/src/database/migrations/060_add_preview_path_and_expense_ai_fields.spec.ts`
- Edit: `packages/server/src/database/migrations/index.ts` (register 060)
- Edit: `packages/server/src/database/types.ts` (`DocumentTable.preview_path: string | null`; `ExpenseTable.ai_confidence: number | null`, `ai_document_type: string | null`, `ai_kind: string | null`)
- Edit: `packages/server/src/documents/types.ts` (`Document.preview_path: string | null`)

**Steps:**
- [ ] Write the spec first (TDD): up adds all four columns, columns are nullable, down drops them; assert against `PRAGMA table_info`.
- [ ] Implement the migration (`addColumn`, SQLite-safe nullable adds).
- [ ] Register in `index.ts`; extend `database/types.ts` and `documents/types.ts`.
- [ ] `npm test` the migration spec — green.

---

### Task 2: `PreviewRenderer` — Document bytes → thumbnail PNG

A small injectable that turns a Document's stored bytes into one thumbnail PNG (first page for PDF, downscale for image/HEIC), writes it via `DocumentStorageService`, and returns the relative path. Never throws — returns `null` on any failure (a non-visual or corrupt file just has no preview). This is the single render path used by both the early intake step (Task 3) and the lazy fallback (Task 4).

**Files:**
- Create: `packages/server/src/documents/preview-renderer.ts`
- Create: `packages/server/src/documents/preview-renderer.spec.ts`
- Edit: `packages/server/src/documents/documents.module.ts` (provide `PreviewRenderer`; ensure `PdfRasterizer` + `ImageScaler` are importable — they live in `triage`, so import their providers or move to a shared provider as the existing module wiring dictates)

**Steps:**
- [ ] Spec first: PDF → non-empty PNG buffer/path; JPEG → downscaled PNG; HEIC → decoded+scaled (reuse `heic-decoder`); unsupported/corrupt → `null`; thumbnail target ~256px longest edge.
- [ ] Implement `render(document): Promise<string | null>` — dispatch on `mime_type`, reuse `PdfRasterizer.toPngPages()[0]` and `ImageScaler`, persist via storage, return relative path.
- [ ] Keep it dependency-light; mirror `pdf-rasterizer.ts` never-throw contract.

---

### Task 3: Early render step at intake (decoupled from OCR)

Render the thumbnail **right after** the source bytes are persisted in `DocumentsService.upload()`, before/independent of the OCR+classification pipeline. This guarantees a preview exists for `pending`, `processing`, and `ocr_failed` documents — exactly the states where the operator most needs to see the file. Failure to render is non-fatal (`preview_path` stays `NULL`, lazy fallback covers it).

**Files:**
- Edit: `packages/server/src/documents/documents.service.ts` (`upload()` — after the new-document insert + `storage.writeFile`, call `PreviewRenderer.render()` and update `preview_path`; dedup path of an existing Document keeps its existing preview)
- Edit: `packages/server/src/documents/documents.service.spec.ts`

**Steps:**
- [ ] Spec: uploading a PDF/image sets `preview_path`; an unsupported file leaves it `NULL` without failing the upload; a dedup hit does not re-render.
- [ ] Wire the render call; ensure it never blocks the upload response on failure.

---

### Task 4: Preview endpoint + lazy fallback

`GET /api/documents/:id/preview` streams the thumbnail PNG. If `preview_path` is `NULL` (pre-existing docs, or a render that failed earlier), render once via `PreviewRenderer`, persist the path, then stream — so old documents self-heal on first view with **no backfill job**. If render still yields nothing (non-visual file), return 404 so the UI shows its fallback icon.

**Files:**
- Edit: `packages/server/src/documents/documents.controller.ts` (`@Get(':id/preview')` → `StreamableFile`, `Content-Type: image/png`)
- Edit: `packages/server/src/documents/documents.service.ts` (`getPreview(id)`: load doc → if `preview_path` render+persist → read bytes; throw `NotFoundException` when unrenderable)
- Edit: `packages/server/src/documents/documents.service.spec.ts`

**Steps:**
- [ ] Spec: doc with `preview_path` streams stored bytes; doc with `NULL` renders+persists+streams; non-visual doc → 404.
- [ ] Implement; set an `ETag` of the document `hash` so the browser caches across reloads.

---

### Task 5: Persist classification facts at triage

At the point the draft Expense is created from the classification (`ai/propose-draft.service.ts`, the `CreateExpenseDto` around the `createExpense` call), also carry `confidence` → `ai_confidence`, `document_type` → `ai_document_type`, `kind` → `ai_kind`. Thread them through `CreateExpenseDto` (`expenses/types.ts`) and the insert in `expenses.service.ts`. This is what makes `Details` (Task 8) fully read-only.

**Files:**
- Edit: `packages/server/src/expenses/types.ts` (`CreateExpenseDto` + zod: optional `ai_confidence`, `ai_document_type`, `ai_kind`)
- Edit: `packages/server/src/expenses/expenses.service.ts` (insert maps the three fields)
- Edit: `packages/server/src/ai/propose-draft.service.ts` (populate from `triageResult`)
- Edit: `packages/server/src/expenses/expenses.service.ts` spec or `ai/propose-draft.service.spec.ts`

**Steps:**
- [ ] Spec: a triaged document's Expense row carries the three AI fields from the classification result.
- [ ] Wire `CreateExpenseDto` → insert → propose-draft.

---

### Task 6: Archive list endpoint — Linked, reason, channel, created_at

Extend `GET /api/documents` to return the rows the archive needs. Per Document: `created_at`, latest source `channel`, and (for `needs_triage`) the AuditFinding `reason` / `reason_type`; plus the **Linked** triad via a LEFT JOIN on `expense.document_id` — `expense_id`, supplier name, claimant name, and whether the expense is `posted`/`reversed` (for the delete guard). Drop nothing from the existing shape that other callers need; add fields.

**Files:**
- Edit: `packages/server/src/documents/documents.service.ts` (`list()` → join expense + entity (supplier, claimant) + latest source + needs_triage finding)
- Edit: `packages/server/src/documents/documents.controller.ts` (response type) and `packages/server/src/documents/types.ts` (a `DocumentArchiveRow` view type)
- Edit: `packages/server/src/documents/documents.service.spec.ts`

**Steps:**
- [ ] Spec: a triaged doc returns `expense_id` + supplier name; a claimant-paid doc also returns claimant name + `expense_linked_status`; a `needs_triage` doc returns `reason_type`; channel + `created_at` present on all.
- [ ] Implement the joins (Kysely). Reason comes from the same source `getNeedsTriageItems` already uses — reuse that query/service rather than duplicating it.

---

### Task 7: `Debug` → read-only `Details` (no LLM)

Replace `triageService.debug()` (which calls `pass2Agent.classify`) with a read of persisted data: OCR markdown from the existing `ocr_markdown` artifact (via `ocrService.transcribe`, which is already idempotent/cache-reading), and classification from the linked draft Expense (`category`, amounts, `document_vat_marking`, `supplier_invoice_number`, and the Task-5 `ai_confidence`/`ai_document_type`/`ai_kind`). Never invoke `pass2Agent`. Keep the endpoint path or rename to `/details`; update `api.ts`.

**Files:**
- Edit: `packages/server/src/triage/triage.service.ts` and `packages/server/src/ai/intake-workflow.service.ts` (`debug()` → read persisted; drop the `pass2Agent.classify` call)
- Edit: `packages/server/src/triage/triage.controller.ts` (route → `details`, or keep `:id/debug` path but read-only)
- Edit: `packages/web/src/api.ts` (`getDocumentDebug` → `getDocumentDetails`; type reads from Expense)
- Edit: the corresponding `.spec.ts`

**Steps:**
- [ ] Spec: `Details` for a triaged doc returns stored OCR + Expense-derived classification and makes **zero** calls to `pass2Agent` (assert via mock).
- [ ] Implement; a doc with no linked Expense (e.g. `needs_triage`) returns OCR only, classification `null`.

---

### Task 8: Archive UI (`DocumentsView`) — preview, columns, actions, delete guard

Rebuild `DocumentsView` to the agreed layout: `thumb · Filename · Added (relative) · Status (+reason badge) · channel icon · Linked · Actions`. Drop the Size and Type columns. **Actions:** View (thumb/Filename → open original `/file` in a new tab), Open in Intake (deep-link, only for `pending`/`needs_triage`), Details (read-only panel from Task 7), Delete. Delete is **disabled with a tooltip** when `expense_linked_status` is `posted`/`reversed`.

**Files:**
- Edit: `packages/web/src/components/DocumentsView.tsx`
- Edit: `packages/web/src/components/DocumentsView.test.tsx`
- Edit: `packages/web/src/api.ts` (archive row type, `getDocumentPreview` URL helper)

**Steps:**
- [ ] Test first: thumbnail `img` points at `/api/documents/:id/preview` with fallback icon on error; Added shows relative time; needs_triage row shows reason badge; triaged row shows Supplier + Expense#N (+ Claimant badge); Delete disabled for a posted-linked doc.
- [ ] Implement; reason badge reuses the `reasonBadge` mapping from `IntakeView` (extract to a shared helper to avoid drift).
- [ ] "Open in Intake" navigates to `/intake?expand=:id`.

---

### Task 9: Backend delete guard for posted-linked documents

Enforce the rule the UI advertises: `deleteDocument` rejects when a linked Expense is `posted` or `reversed` (UI disabling is not a security boundary). Consistent with ADR-0012 (no-break-glass).

**Files:**
- Edit: `packages/server/src/documents/documents.service.ts` (`deleteDocument` → check linked expense status, throw `ConflictException`)
- Edit: `packages/server/src/documents/documents.service.spec.ts`

**Steps:**
- [ ] Spec: deleting a doc linked to a `posted`/`reversed` Expense throws 409; a doc with only a `draft` Expense or no Expense deletes fine (cleaning up the thumbnail too).

---

### Task 10: Preview thumbnail in `/intake` needs_triage rows + deep-link expand

Add the same thumbnail to the `IntakeView` `needs_triage` rows (and `pending` table), so the operator sees the document right where they act on it. Support `?expand=:id` so "Open in Intake" lands with the row expanded.

**Files:**
- Edit: `packages/web/src/components/IntakeView.tsx`
- Edit: `packages/web/src/components/IntakeView.test.tsx`

**Steps:**
- [ ] Test first: needs_triage row renders a thumbnail; `?expand=:id` opens that row's form on mount.
- [ ] Implement; reuse the same preview `img` + fallback component as the archive (shared component).

---

## Verification

- [ ] `npm test` (server + web) green; new specs cover each task.
- [ ] Manual: upload a PDF and a HEIC → both show thumbnails in `/intake` and `/documents`; an `ocr_failed` doc still shows a thumbnail.
- [ ] A triaged doc in `/documents` shows Supplier + Expense#N (+ Claimant badge) and the links navigate.
- [ ] `Details` on a triaged doc renders instantly and makes no model call (check logs / the perf endpoint is not hit).
- [ ] Delete is blocked (UI + API 409) for a doc under a posted Expense; allowed otherwise.
- [ ] An old document (created before this change) renders its preview on first view and persists it (second view served from `preview_path`).
