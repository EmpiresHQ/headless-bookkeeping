# Intake supplier-unresolved resolution — design

**Date:** 2026-06-11
**Status:** Approved (brainstorming)
**Scope:** Narrow vertical slice — resolve a `needs_triage` document whose only
blocker is a `supplier-unresolved` triage proposal (Task 43), and carry it
through to a posted/held Expense.

## Problem

When intake triage classifies a confident `new_expense` but the AI proposes
*creating* a new supplier (`supplier_proposal.mode === 'create'`),
`ProposeDraftService.proposeDraft` returns `supplier-unresolved` and the
workflow routes the document to `needs_triage` (`intake-workflow.service.ts`
lines 217-222). In that branch **no Expense and no `ai_proposal` row is
created** — the only durable artifact is a `needs_triage` `AuditFinding` whose
`description` is a human-readable reason string. The AI's proposed
`create_name` / `create_country` are lost.

Today a `needs_triage` document is a dead end:

- **SPA** (`IntakeView.tsx`): the "Needs triage" row exposes only **"Why?"**
  (`GET /documents/:id/debug`, read-only) and **"Dismiss"**
  (`POST /documents/:id/complete` → `processed`, no posting).
- **API**: there is no endpoint that takes a parked proposal and turns it into
  an Expense.

The seam to fix it already exists: `proposeDraft(triageResult, documentId,
supplierId?)` takes an explicit `supplierId` and `resolveSupplier` gives it
priority ("explicit override wins"). And supplier creation already exists:
`POST /api/entities` (`role`/`country`/`name`/`registrationKey`). We only need
to (a) keep the proposal that blocked the document, and (b) wire
create-or-pick-supplier → `proposeDraft` → resolve the finding.

## Approach (chosen)

**Persist the blocking `TriageResult` at triage time** so the human resolves
exactly the figures the AI saw (deterministic, no re-run, no extra LLM call,
keeps the "never create a null-supplier draft" invariant — ADR-0014/0024).

Storage decision: a nullable JSON column on **`document`**, not a new table and
not on `audit_finding`. Rationale:

- Lifecycle of the JSON exactly matches the document status machine: set on
  route → `needs_triage` (supplier-unresolved), cleared on → `triaged` /
  `processed`.
- A finding can be snoozed/resolved and re-created out of band
  (`replayNeedsTriage` allows this); hanging the proposal on the finding risks
  losing it. The document row is the stable anchor, and the resolution endpoint
  is already keyed on `/documents/:id`.

SQLite note: better-sqlite3 → the column is `TEXT` holding `JSON.stringify(...)`
(kysely does not emit SQLite's native JSONB format). Semantically a JSON field.

Rejected alternatives:

- **Re-run triage at resolution time** — non-deterministic (regenerated
  classification may differ from what blocked the doc), costs an LLM call per
  open, weak audit.
- **Create a null-supplier draft Expense at triage** — breaks the
  no-null-supplier-draft invariant, pollutes the Expenses tab with un-postable
  drafts, larger blast radius.

## Design

### 1. Persistence — JSON column on `document`

Migration `039_add_document_pending_triage_result.ts`:

```
ALTER TABLE document ADD COLUMN pending_triage_result TEXT  -- nullable JSON
```

- Holds `JSON.stringify(TriageResult)` for a document parked by
  `supplier-unresolved`. `NULL` otherwise.
- No new service. `DocumentsService` gains:
  - `setPendingTriageResult(id: number, result: TriageResult | null): Promise<void>`
    — writes the JSON (or `NULL` to clear), bumps `updated_at`.
  - The value is read off the document row; parsed + validated on read with the
    existing `triageResultSchema`.

### 2. Capture point — workflow change

`intake-workflow.service.ts`, the `supplier-unresolved` branch (lines 217-222):

```ts
if (outcome.outcome === 'supplier-unresolved') {
  await this.documents.setPendingTriageResult(documentId, triageResult); // NEW
  return this.routeNeedsTriage(documentId, outcome.reason);
}
```

`routeNeedsTriage` stays generic — the other five `needs_triage` reasons persist
nothing (there is no proposal to resolve). Re-running `process()` on an already
`needs_triage` document hits `replayNeedsTriage` and does not overwrite the
stored proposal.

### 3. Resolution — new method on `IntakeWorkflowService`

`IntakeWorkflowService` is "the single DEEP owner of Document → outcome" and
already owns the `needs_triage → triaged` transition (state machine, lines
78-80). Resolution lives here to keep all status transitions in one owner.

`resolveSupplier(documentId: number, supplierEntityId: number): Promise<IntakeWorkflowResult>`:

1. **Idempotency / guard.** Load the document.
   - If `triaged` and a draft already exists for it → replay the existing draft
     (`replayDraftProposed`) and return — second call is a safe no-op.
   - If status is not `needs_triage` → `409` ("document is not awaiting triage").
2. **Load proposal.** Read `document.pending_triage_result`. If `NULL` → `400`
   ("no pending supplier proposal to resolve" — the `needs_triage` reason is not
   supplier-unresolved). Parse + validate with `triageResultSchema`.
3. **Validate supplier.** `supplierEntityId` must reference an existing
   `entity` with `role='supplier'`; else `400`.
4. **Propose draft.** `proposeDraft(triageResult, documentId, supplierEntityId)`
   — explicit `supplierId` wins, so a draft Expense is created and the full
   posting pipeline runs (draft → rules → policy → post/hold), identical to a
   confident intake (per chosen behavior). A returned `supplier-unresolved` here
   would be a bug (explicit id supplied) → defensive `500`.
5. **Settle, atomically in intent.** On `draft` outcome:
   - `transitionDocument(documentId, 'triaged')`.
   - Resolve the open `needs_triage` `AuditFinding`
     (`AuditFindingsService.resolve` via `findOpenByReference('needs_triage',
     'document', documentId)`).
   - `documents.setPendingTriageResult(documentId, null)`.
6. Return `{ status: 'draft_proposed', draft }`.

`complete(documentId)` (Dismiss) also clears `pending_triage_result` (→ `NULL`)
as cleanup when an operator dismisses instead of resolving.

### 4. API — `triage.controller.ts`

- `GET /api/documents/:id/pending-draft` → `200`:
  ```json
  {
    "document_id": 4,
    "reason": "supplier creation not yet implemented (Task 43)",
    "supplier_proposal": { "create_name": "...", "create_country": "EE" },
    "draft": {
      "category": "...",
      "gross_amount": 1525,
      "vat_amount": 285,
      "currency": "EUR",
      "tax_point_date": "2026-03-15",
      "supplier_invoice_number": "..."
    }
  }
  ```
  `404` if the document has no `pending_triage_result` (different needs_triage
  reason, or not parked). `reason` is read from the open finding's description.
- `POST /api/documents/:id/resolve-supplier` body `{ supplier_entity_id: number }`
  → `IntakeWorkflowResult` (`draft_proposed`).

Supplier creation **reuses** the existing `POST /api/entities`
(`role`/`country`/`name`/`registrationKey`/`goodsVsServices?`). The resolution
endpoint is supplier-agnostic: it takes an already-resolved entity id, whether
freshly created or picked.

> Plan-time check: confirm a supplier-list endpoint exists for the picker
> (expected `GET /api/entities?role=supplier`, used by `EntitiesView`).

### 5. SPA — `IntakeView.tsx`

In the "Needs triage" table, add a **"Resolve"** button alongside
"Why?"/"Dismiss". Click opens a form that `GET /documents/:id/pending-draft`
and shows the proposed supplier (name + country) and the draft summary
(category, gross, VAT, currency, date). Two modes:

- **Create new supplier** (default; name + country prefilled): inputs `name`,
  `country`, **`registrationKey`** (required, empty — the AI proposal does not
  carry it), optional `goodsVsServices` → `POST /api/entities` → entity id.
- **Pick existing supplier**: dropdown from `GET /api/entities?role=supplier` →
  entity id.

Submit → `POST /documents/:id/resolve-supplier { supplier_entity_id }`. On
success the row leaves "Needs triage"; the draft Expense appears in the Expenses
tab (or Approvals if policy held it). If `GET pending-draft` returns `404`, the
form disables Resolve with a note that this needs_triage is not a supplier
issue.

`api.ts` additions: `getPendingDraft(id)`, `resolveSupplier(id, entityId)`;
reuse `onboardEntity` and the entities-list call.

### 6. Tests

- **Unit — `DocumentsService.setPendingTriageResult`**: write JSON, read back,
  clear to `NULL`.
- **Unit — workflow capture**: `supplier-unresolved` persists the
  `TriageResult` on the document before routing; other reasons do not.
- **Unit — `resolveSupplier`**: happy path (draft created, document `triaged`,
  finding resolved, `pending_triage_result` cleared); guards (not
  `needs_triage` → 409; no pending proposal → 400; non-supplier entity → 400);
  idempotency (second call replays the existing draft).
- **E2E**: upload a doc that classifies `new_expense` with a create-supplier
  proposal → `needs_triage`; `GET pending-draft`; create entity via
  `POST /api/entities`; `POST resolve-supplier` → document `triaged` + Expense
  exists.
- **Frontend**: `IntakeView` resolve-form test (create path + pick path).

## Out of scope (YAGNI)

- Editing amount/category/date during resolution (supplier only; corrections go
  through the normal Expense flow).
- Resolution for other `needs_triage` reasons (low-confidence, unknown,
  correction, duplicate).
- Persisting proposals for any reason other than supplier-unresolved.
