# Intake Supplier-Unresolved Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator resolve a `needs_triage` document blocked solely by a `supplier-unresolved` triage proposal — create or pick the supplier, then carry the document through `proposeDraft` to a posted/held Expense.

**Architecture:** Persist the blocking `TriageResult` as JSON on the `document` row at triage time (deterministic, no re-run). A new `IntakeWorkflowService.resolveSupplier` reads it, validates the chosen supplier, calls the existing `proposeDraft(triageResult, documentId, supplierId)` seam (explicit supplier id wins), then transitions the document to `triaged`, resolves the `needs_triage` finding, and clears the stored proposal. Two new endpoints (`GET pending-draft`, `POST resolve-supplier`) and an `IntakeView` resolve form expose it; supplier creation reuses the existing `POST /api/entities`.

**Tech Stack:** NestJS, Kysely (better-sqlite3), Zod / nestjs-zod, Jest, React + Vite + Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-11-intake-supplier-resolution-design.md`

---

## File Structure

**Backend — create:**
- `src/database/migrations/039_add_document_pending_triage_result.ts` — adds the nullable JSON column.

**Backend — modify:**
- `src/database/migrations/index.ts` — register migration 039.
- `src/database/types.ts` — add `pending_triage_result` to `DocumentTable`.
- `src/documents/documents.service.ts` — `setPendingTriageResult` / `getPendingTriageResult`.
- `src/ai/intake-workflow.service.ts` — persist on supplier-unresolved; new `resolveSupplier` + `getPendingDraft`; inject `EntitiesService`.
- `src/triage/types.ts` — `PendingDraft` interface, `ResolveSupplierDto`.
- `src/triage/triage.service.ts` — delegate `getPendingDraft` / `resolveSupplier`.
- `src/triage/triage.controller.ts` — two routes; `complete` clears the proposal.

**Frontend — create:**
- `frontend/src/components/ResolveSupplierForm.tsx` — the resolve form.

**Frontend — modify:**
- `frontend/src/api.ts` — `PendingDraft` type, `getPendingDraft`, `resolveSupplier`.
- `frontend/src/components/IntakeView.tsx` — "Resolve" button + form wiring.

---

## Task 1: Persist the blocking proposal on the document

**Files:**
- Create: `src/database/migrations/039_add_document_pending_triage_result.ts`
- Modify: `src/database/migrations/index.ts`
- Modify: `src/database/types.ts` (`DocumentTable`, ~line 167)
- Modify: `src/documents/documents.service.ts`
- Test: `src/documents/documents.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/documents/documents.service.spec.ts`, inside the existing top-level `describe` (reuse its `service` and `db` from `beforeEach`). It seeds a document row directly, then round-trips the proposal:

```ts
  it('persists and clears a pending triage result on the document', async () => {
    const now = Math.floor(Date.now() / 1000);
    const doc = await db
      .insertInto('document')
      .values({
        hash: 'h-pending-1',
        filename: 'f.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1,
        storage_path: null,
        status: 'needs_triage',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(await service.getPendingTriageResult(doc.id)).toBeNull();

    const triage = {
      kind: 'new_expense' as const,
      gross_amount: 1525,
      vat_amount: 285,
      tax_point_date: '2026-03-15',
      category: 'software',
      supplier_proposal: {
        mode: 'create' as const,
        create_name: 'Acme OÜ',
        create_country: 'EE',
      },
      document_type: 'invoice' as const,
      currency: 'EUR',
      document_vat_marking: null,
      supplier_invoice_number: 'INV-7',
      confidence: 0.42,
    };

    await service.setPendingTriageResult(doc.id, triage);
    expect(await service.getPendingTriageResult(doc.id)).toEqual(triage);

    await service.setPendingTriageResult(doc.id, null);
    expect(await service.getPendingTriageResult(doc.id)).toBeNull();
  });
```

> If the suite's `db` handle has a different name, use that name; the assertions are what matter.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/documents/documents.service.spec.ts -t "pending triage result"`
Expected: FAIL — `service.setPendingTriageResult is not a function` (and/or the `pending_triage_result` column does not exist).

- [ ] **Step 3: Create the migration**

`src/database/migrations/039_add_document_pending_triage_result.ts`:

```ts
import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 039: Add document.pending_triage_result.
 *
 * A nullable JSON (TEXT) column that holds the JSON-stringified TriageResult
 * which blocked a document on the `supplier-unresolved` route (Task 43). It is
 * set when the intake workflow parks the document in `needs_triage` for that
 * reason, and cleared (NULL) when the document leaves needs_triage (resolved to
 * `triaged`, or dismissed to `processed`). NULL for every other state/reason.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .addColumn('pending_triage_result', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .dropColumn('pending_triage_result')
    .execute();
}
```

- [ ] **Step 4: Register the migration**

In `src/database/migrations/index.ts`, add the import after the `m038` line:

```ts
import * as m039 from './039_add_document_pending_triage_result';
```

and the entry after the `'038_create_credit_note': m038,` line:

```ts
  '039_add_document_pending_triage_result': m039,
```

- [ ] **Step 5: Add the column to the table type**

In `src/database/types.ts`, in `DocumentTable` (after the `status: string;` field, ~line 176):

```ts
  // Nullable JSON (TEXT): the JSON-stringified TriageResult that blocked this
  // document on the supplier-unresolved route (migration 039). NULL otherwise.
  pending_triage_result: string | null;
```

- [ ] **Step 6: Add the service methods**

In `src/documents/documents.service.ts`, extend the import from `../triage/types` (add a new import line near the other imports — `triage/types` is a pure Zod/type module, no DI cycle):

```ts
import { triageResultSchema, TriageResult } from '../triage/types';
```

Add these methods to `DocumentsService` (e.g. just after `setStatus`):

```ts
  /**
   * Store (or clear) the TriageResult that blocked this document on the
   * supplier-unresolved route. Pass `null` to clear it. Kept off the mapped
   * `Document` type on purpose: it is operational AI scratch data read only by
   * the resolution flow, never shipped in `list()`.
   */
  async setPendingTriageResult(
    id: number,
    result: TriageResult | null,
  ): Promise<void> {
    await this.db
      .updateTable('document')
      .set({ pending_triage_result: result ? JSON.stringify(result) : null })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Read back the stored proposal as a validated TriageResult, or null if the
   * document has none. Re-validates with the Zod schema so a malformed/stale
   * blob fails loudly rather than feeding a half-shaped object into the kernel.
   */
  async getPendingTriageResult(id: number): Promise<TriageResult | null> {
    const row = await this.db
      .selectFrom('document')
      .select('pending_triage_result')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || row.pending_triage_result == null) {
      return null;
    }
    return triageResultSchema.parse(JSON.parse(row.pending_triage_result));
  }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx jest src/documents/documents.service.spec.ts -t "pending triage result"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/database/migrations/039_add_document_pending_triage_result.ts src/database/migrations/index.ts src/database/types.ts src/documents/documents.service.ts src/documents/documents.service.spec.ts
git commit -m "feat(intake): persist blocking TriageResult on document.pending_triage_result"
```

---

## Task 2: Capture the proposal when the workflow parks on supplier-unresolved

**Files:**
- Modify: `src/ai/intake-workflow.service.ts:217-222`
- Test: `src/ai/intake-workflow.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/ai/intake-workflow.service.spec.ts`. Reuse the suite's mocks (the workflow is constructed with mocked `ocrService`, `pass2Agent`, `proposeDraft`, `auditFindings`, `policyService`, `documents`). This test drives a confident `new_expense` whose `proposeDraft` returns `supplier-unresolved`, and asserts the proposal is persisted before routing:

```ts
  it('persists the TriageResult when proposeDraft is supplier-unresolved', async () => {
    const triage = {
      kind: 'new_expense',
      gross_amount: 1000,
      vat_amount: 200,
      tax_point_date: '2026-03-01',
      category: 'software',
      supplier_proposal: { mode: 'create', create_name: 'Acme', create_country: 'EE' },
      document_type: 'invoice',
      currency: 'EUR',
      document_vat_marking: null,
      supplier_invoice_number: null,
      confidence: 0.9,
    };
    documents.getById.mockResolvedValue({ id: 7, status: 'pending' });
    ocrService.transcribe.mockResolvedValue({ ok: true, markdown: 'md' });
    pass2Agent.classify.mockResolvedValue({ ok: true, result: triage });
    policyService.getConfig.mockResolvedValue({ auto_post_min_confidence: 0.7 });
    proposeDraft.proposeDraft.mockResolvedValue({
      outcome: 'supplier-unresolved',
      reason: 'supplier creation not yet implemented (Task 43)',
    });
    auditFindings.findOpenByReference.mockResolvedValue(undefined);
    auditFindings.create.mockResolvedValue({ id: 99, description: 'x' });

    const result = await service.process(7);

    expect(result.status).toBe('needs_triage');
    expect(documents.setPendingTriageResult).toHaveBeenCalledWith(7, triage);
  });
```

> Mock object/method names must match the suite's existing setup. If the suite uses a `documents` mock built from an object literal, add `setPendingTriageResult: jest.fn()` to it. `transitionDocument` reads `documents.getById` again inside `routeNeedsTriage`; the mock above returns a `pending` doc, which permits the `pending -> needs_triage` move.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/ai/intake-workflow.service.spec.ts -t "supplier-unresolved"`
Expected: FAIL — `setPendingTriageResult` was not called (or is not a mock on the `documents` stub).

- [ ] **Step 3: Persist before routing**

In `src/ai/intake-workflow.service.ts`, in the `new_expense` branch, change the supplier-unresolved block (currently lines 217-222) to:

```ts
          if (outcome.outcome === 'supplier-unresolved') {
            this.logger.warn(
              `new_expense for document ${documentId} has an unresolved supplier proposal: ${outcome.reason}`,
            );
            // Keep the exact proposal that blocked us so a human can resolve the
            // supplier and replay it deterministically (no re-run of the agent).
            await this.documents.setPendingTriageResult(documentId, triageResult);
            return this.routeNeedsTriage(documentId, outcome.reason);
          }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/ai/intake-workflow.service.spec.ts -t "supplier-unresolved"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/intake-workflow.service.ts src/ai/intake-workflow.service.spec.ts
git commit -m "feat(intake): persist proposal on supplier-unresolved route"
```

---

## Task 3: `IntakeWorkflowService.resolveSupplier`

**Files:**
- Modify: `src/ai/intake-workflow.service.ts` (imports, constructor, new method)
- Test: `src/ai/intake-workflow.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/ai/intake-workflow.service.spec.ts`. These cover the happy path, the two guards, and idempotent replay. Add `entities: { findById: jest.fn() }` to the suite's mocks and pass it as the new constructor arg (see Step 3).

```ts
  describe('resolveSupplier', () => {
    const triage = {
      kind: 'new_expense',
      gross_amount: 1000,
      vat_amount: 200,
      tax_point_date: '2026-03-01',
      category: 'software',
      supplier_proposal: { mode: 'create', create_name: 'Acme', create_country: 'EE' },
      document_type: 'invoice',
      currency: 'EUR',
      document_vat_marking: null,
      supplier_invoice_number: null,
      confidence: 0.9,
    };

    it('resolves: proposes draft, triages, resolves finding, clears proposal', async () => {
      documents.getById.mockResolvedValue({ id: 7, status: 'needs_triage' });
      documents.getPendingTriageResult.mockResolvedValue(triage);
      entities.findById.mockResolvedValue({ id: 3, role: 'supplier' });
      proposeDraft.proposeDraft.mockResolvedValue({
        outcome: 'draft',
        expenseId: 55,
        pipelineResult: {},
      });
      auditFindings.findOpenByReference.mockResolvedValue({ id: 99 });

      const result = await service.resolveSupplier(7, 3);

      expect(proposeDraft.proposeDraft).toHaveBeenCalledWith(triage, 7, 3);
      expect(documents.setStatus).toHaveBeenCalledWith(7, 'triaged');
      expect(auditFindings.resolve).toHaveBeenCalledWith(99, expect.any(Object));
      expect(documents.setPendingTriageResult).toHaveBeenCalledWith(7, null);
      expect(result).toEqual({
        status: 'draft_proposed',
        draft: { outcome: 'draft', expenseId: 55, pipelineResult: {} },
      });
    });

    it('rejects a document that is not awaiting triage', async () => {
      documents.getById.mockResolvedValue({ id: 7, status: 'pending' });
      await expect(service.resolveSupplier(7, 3)).rejects.toThrow(/not awaiting triage/);
    });

    it('rejects when there is no pending proposal', async () => {
      documents.getById.mockResolvedValue({ id: 7, status: 'needs_triage' });
      documents.getPendingTriageResult.mockResolvedValue(null);
      await expect(service.resolveSupplier(7, 3)).rejects.toThrow(/no pending supplier proposal/);
    });

    it('rejects a non-supplier entity', async () => {
      documents.getById.mockResolvedValue({ id: 7, status: 'needs_triage' });
      documents.getPendingTriageResult.mockResolvedValue(triage);
      entities.findById.mockResolvedValue({ id: 3, role: 'customer' });
      await expect(service.resolveSupplier(7, 3)).rejects.toThrow(/not a supplier/);
    });

    it('is idempotent: replays the existing draft if already triaged', async () => {
      documents.getById.mockResolvedValue({ id: 7, status: 'triaged' });
      proposeDraft.findExistingDraft.mockResolvedValue({
        outcome: 'draft',
        expenseId: 55,
        pipelineResult: { replayed: true },
      });
      const result = await service.resolveSupplier(7, 3);
      expect(result.status).toBe('draft_proposed');
      expect(proposeDraft.proposeDraft).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/ai/intake-workflow.service.spec.ts -t "resolveSupplier"`
Expected: FAIL — `service.resolveSupplier is not a function`.

- [ ] **Step 3: Implement `resolveSupplier` + inject `EntitiesService`**

In `src/ai/intake-workflow.service.ts`:

Extend the NestJS import to add the two exceptions:

```ts
import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
```

Add the entities import near the other service imports:

```ts
import { EntitiesService } from '../entities/entities.service';
```

Add the dependency to the constructor (AiModule already imports EntitiesModule, which exports EntitiesService — no module change needed):

```ts
    private readonly documents: DocumentsService,
    private readonly entities: EntitiesService,
  ) {}
```

Add the method (e.g. after `process`, before the `// ── Private helpers ──` block):

```ts
  /**
   * Resolve a document parked on the supplier-unresolved route. Given the
   * Supplier the operator created or picked, replay the stored TriageResult
   * through proposeDraft (explicit supplier id wins), then move the document to
   * `triaged`, resolve the open needs_triage finding, and clear the stored
   * proposal. Idempotent: a second call on an already-`triaged` document
   * replays its existing draft instead of double-posting.
   */
  async resolveSupplier(
    documentId: number,
    supplierEntityId: number,
  ): Promise<IntakeWorkflowResult> {
    const doc = await this.documents.getById(documentId);

    // Idempotent replay: already resolved into a draft.
    if (doc.status === 'triaged' || doc.status === 'processed') {
      const replay = await this.replayDraftProposed(documentId);
      if (replay) {
        return replay;
      }
    }
    if (doc.status !== 'needs_triage') {
      throw new ConflictException(
        `Document ${documentId} is not awaiting triage (status=${doc.status})`,
      );
    }

    // The exact proposal that blocked us. Absent → the needs_triage reason was
    // not supplier-unresolved, so there is nothing here to resolve.
    const triageResult = await this.documents.getPendingTriageResult(documentId);
    if (!triageResult) {
      throw new BadRequestException(
        `Document ${documentId} has no pending supplier proposal to resolve`,
      );
    }

    // Validate the chosen Supplier (findById throws 404 if it does not exist).
    const entity = await this.entities.findById(supplierEntityId);
    if (entity.role !== 'supplier') {
      throw new BadRequestException(
        `Entity ${supplierEntityId} is not a supplier (role=${entity.role})`,
      );
    }

    // Explicit supplier id wins in resolveSupplier → a draft is produced and the
    // full posting pipeline runs (post/hold per policy), exactly as a confident
    // intake would.
    const outcome = await this.proposeDraft.proposeDraft(
      triageResult,
      documentId,
      supplierEntityId,
    );
    if (outcome.outcome === 'supplier-unresolved') {
      // Defensive: an explicit supplier id must resolve.
      throw new Error(
        `proposeDraft returned supplier-unresolved for document ${documentId} despite explicit supplier ${supplierEntityId}`,
      );
    }

    // Settle the human-wait: triaged + resolve finding + clear the proposal.
    await this.transitionDocument(documentId, 'triaged');
    const finding = await this.auditFindings.findOpenByReference(
      'needs_triage',
      'document',
      documentId,
    );
    if (finding) {
      await this.auditFindings.resolve(finding.id, {
        reason: `supplier resolved to entity ${supplierEntityId}`,
      });
    }
    await this.documents.setPendingTriageResult(documentId, null);

    return { status: 'draft_proposed', draft: outcome };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/ai/intake-workflow.service.spec.ts -t "resolveSupplier"`
Expected: PASS (all five).

- [ ] **Step 5: Commit**

```bash
git add src/ai/intake-workflow.service.ts src/ai/intake-workflow.service.spec.ts
git commit -m "feat(intake): IntakeWorkflowService.resolveSupplier"
```

---

## Task 4: `getPendingDraft` read model on the workflow

**Files:**
- Modify: `src/triage/types.ts` (add `PendingDraft`)
- Modify: `src/ai/intake-workflow.service.ts` (new `getPendingDraft`)
- Test: `src/ai/intake-workflow.service.spec.ts`

- [ ] **Step 1: Add the `PendingDraft` type**

In `src/triage/types.ts`, after the `DocumentDebug` interface, add:

```ts
/**
 * The operator-facing view of a document parked on the supplier-unresolved
 * route: the AI's create-supplier proposal plus the draft figures it extracted,
 * so the resolve form can show what will be booked once a supplier is chosen.
 */
export interface PendingDraft {
  document_id: number;
  reason: string;
  supplier_proposal: { create_name: string; create_country: string };
  draft: {
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    supplier_invoice_number: string | null;
  };
}
```

- [ ] **Step 2: Write the failing test**

Add to `src/ai/intake-workflow.service.spec.ts`:

```ts
  describe('getPendingDraft', () => {
    it('returns the create-proposal and draft figures for a parked document', async () => {
      documents.getPendingTriageResult.mockResolvedValue({
        kind: 'new_expense',
        gross_amount: 1525,
        vat_amount: 285,
        tax_point_date: '2026-03-15',
        category: 'software',
        supplier_proposal: { mode: 'create', create_name: 'Acme OÜ', create_country: 'EE' },
        document_type: 'invoice',
        currency: 'EUR',
        document_vat_marking: null,
        supplier_invoice_number: 'INV-7',
        confidence: 0.42,
      });
      auditFindings.findOpenByReference.mockResolvedValue({
        id: 9,
        description: 'supplier creation not yet implemented (Task 43)',
      });

      const out = await service.getPendingDraft(4);

      expect(out).toEqual({
        document_id: 4,
        reason: 'supplier creation not yet implemented (Task 43)',
        supplier_proposal: { create_name: 'Acme OÜ', create_country: 'EE' },
        draft: {
          category: 'software',
          gross_amount: 1525,
          vat_amount: 285,
          currency: 'EUR',
          tax_point_date: '2026-03-15',
          supplier_invoice_number: 'INV-7',
        },
      });
    });

    it('throws NotFound when no proposal is stored', async () => {
      documents.getPendingTriageResult.mockResolvedValue(null);
      await expect(service.getPendingDraft(4)).rejects.toThrow(/no pending/i);
    });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/ai/intake-workflow.service.spec.ts -t "getPendingDraft"`
Expected: FAIL — `service.getPendingDraft is not a function`.

- [ ] **Step 4: Implement `getPendingDraft`**

In `src/ai/intake-workflow.service.ts`, add `NotFoundException` to the `@nestjs/common` import:

```ts
import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
```

Add `PendingDraft` to the triage types import (the file already imports `DocumentDebug` from `../triage/types`):

```ts
import { DocumentDebug, PendingDraft } from '../triage/types';
```

Add the method (next to `resolveSupplier`):

```ts
  /**
   * Build the operator-facing view of a supplier-unresolved document: the AI's
   * create-supplier proposal plus the draft figures. Throws NotFound if the
   * document has no stored proposal (its needs_triage reason is not a supplier
   * issue, or it is not parked at all).
   */
  async getPendingDraft(documentId: number): Promise<PendingDraft> {
    const tr = await this.documents.getPendingTriageResult(documentId);
    if (!tr || tr.supplier_proposal?.mode !== 'create') {
      throw new NotFoundException(
        `Document ${documentId} has no pending supplier proposal`,
      );
    }
    const finding = await this.auditFindings.findOpenByReference(
      'needs_triage',
      'document',
      documentId,
    );
    return {
      document_id: documentId,
      reason: finding?.description ?? 'supplier creation not yet implemented (Task 43)',
      supplier_proposal: {
        create_name: tr.supplier_proposal.create_name,
        create_country: tr.supplier_proposal.create_country,
      },
      draft: {
        category: tr.category,
        gross_amount: tr.gross_amount,
        vat_amount: tr.vat_amount,
        currency: tr.currency,
        tax_point_date: tr.tax_point_date,
        supplier_invoice_number: tr.supplier_invoice_number,
      },
    };
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/ai/intake-workflow.service.spec.ts -t "getPendingDraft"`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add src/triage/types.ts src/ai/intake-workflow.service.ts src/ai/intake-workflow.service.spec.ts
git commit -m "feat(intake): getPendingDraft read model"
```

---

## Task 5: TriageService delegation + controller endpoints

**Files:**
- Modify: `src/triage/types.ts` (add `ResolveSupplierDto`)
- Modify: `src/triage/triage.service.ts`
- Modify: `src/triage/triage.controller.ts`
- Test: `src/triage/triage.service.spec.ts`

- [ ] **Step 1: Add the request DTO**

In `src/triage/types.ts`, add at the top:

```ts
import { createZodDto } from 'nestjs-zod';
```

and after the `triageResultSchema` block:

```ts
export const resolveSupplierSchema = z.object({
  supplier_entity_id: z.number().int().positive(),
});

export class ResolveSupplierDto extends createZodDto(resolveSupplierSchema) {}
```

- [ ] **Step 2: Write the failing test**

Add to `src/triage/triage.service.spec.ts` (the suite constructs `TriageService` with a mocked `workflow` and `documents`):

```ts
  describe('resolveSupplier', () => {
    it('delegates to the workflow and maps a draft to an expense outcome', async () => {
      documents.getById.mockResolvedValue({ id: 7, status: 'needs_triage' });
      workflow.resolveSupplier.mockResolvedValue({
        status: 'draft_proposed',
        draft: { outcome: 'draft', expenseId: 55, pipelineResult: {} },
      });

      const out = await service.resolveSupplier(7, 3);

      expect(workflow.resolveSupplier).toHaveBeenCalledWith(7, 3);
      expect(out).toEqual({ kind: 'expense', document_id: 7, expense_id: 55 });
    });
  });

  describe('getPendingDraft', () => {
    it('delegates to the workflow', async () => {
      documents.getById.mockResolvedValue({ id: 4, status: 'needs_triage' });
      const pd = { document_id: 4, reason: 'r', supplier_proposal: { create_name: 'A', create_country: 'EE' }, draft: { category: 'c', gross_amount: 1, vat_amount: 0, currency: 'EUR', tax_point_date: '2026-01-01', supplier_invoice_number: null } };
      workflow.getPendingDraft.mockResolvedValue(pd);

      expect(await service.getPendingDraft(4)).toEqual(pd);
      expect(workflow.getPendingDraft).toHaveBeenCalledWith(4);
    });
  });
```

> Add `resolveSupplier: jest.fn()` and `getPendingDraft: jest.fn()` to the suite's `workflow` mock.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/triage/triage.service.spec.ts -t "resolveSupplier|getPendingDraft"`
Expected: FAIL — methods not defined on `TriageService`.

- [ ] **Step 4: Implement the delegations**

In `src/triage/triage.service.ts`, extend the types import:

```ts
import { TriageOutcome, DocumentDebug, PendingDraft } from './types';
```

Add both methods to `TriageService` (after `debug`):

```ts
  /** Operator-facing view of a supplier-unresolved document (404 if none). */
  async getPendingDraft(documentId: number): Promise<PendingDraft> {
    await this.documents.getById(documentId); // 404 if the document is unknown
    return this.workflow.getPendingDraft(documentId);
  }

  /**
   * Resolve the supplier on a parked document and replay it into a draft.
   * Maps the workflow outcome onto the same TriageOutcome shape `route` returns.
   */
  async resolveSupplier(
    documentId: number,
    supplierEntityId: number,
  ): Promise<TriageOutcome> {
    await this.documents.getById(documentId); // 404 if the document is unknown
    const result = await this.workflow.resolveSupplier(
      documentId,
      supplierEntityId,
    );
    if (result.status === 'draft_proposed') {
      return {
        kind: 'expense',
        document_id: documentId,
        expense_id: result.draft.expenseId,
      };
    }
    return { kind: 'unknown', document_id: documentId, reason: result.reason };
  }
```

- [ ] **Step 5: Add the controller routes + clear-on-complete**

In `src/triage/triage.controller.ts`, extend imports:

```ts
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
```

```ts
import { TriageOutcome, DocumentDebug, PendingDraft, ResolveSupplierDto } from './types';
```

Add the two routes (inside the class):

```ts
  @Get('api/documents/:id/pending-draft')
  async pendingDraft(@Param('id') id: string): Promise<PendingDraft> {
    return this.triageService.getPendingDraft(Number(id));
  }

  @Post('api/documents/:id/resolve-supplier')
  async resolveSupplier(
    @Param('id') id: string,
    @Body() dto: ResolveSupplierDto,
  ): Promise<TriageOutcome> {
    return this.triageService.resolveSupplier(Number(id), dto.supplier_entity_id);
  }
```

In the existing `completeDocument`, clear any stored proposal so a dismissed document leaves nothing behind:

```ts
  @Post('api/documents/:id/complete')
  @HttpCode(HttpStatus.CREATED)
  async completeDocument(@Param('id') id: string) {
    await this.documentsService.setStatus(Number(id), 'processed');
    await this.documentsService.setPendingTriageResult(Number(id), null);
    return { id: Number(id), status: 'processed' };
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/triage/triage.service.spec.ts -t "resolveSupplier|getPendingDraft"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/triage/types.ts src/triage/triage.service.ts src/triage/triage.controller.ts src/triage/triage.service.spec.ts
git commit -m "feat(intake): pending-draft + resolve-supplier endpoints"
```

---

## Task 6: Frontend API client

**Files:**
- Modify: `frontend/src/api.ts`
- Test: `frontend/src/api.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/api.test.ts` (mirror the existing fetch-mock style in that file):

```ts
  it('resolveSupplier POSTs the chosen entity id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'expense', document_id: 4, expense_id: 55 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveSupplier(4, 3);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/documents/4/resolve-supplier'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ supplier_entity_id: 3 }),
      }),
    );
    expect(out).toEqual({ kind: 'expense', document_id: 4, expense_id: 55 });
  });
```

Add `resolveSupplier` (and `getPendingDraft` if not already) to the import at the top of `api.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/api.test.ts -t "resolveSupplier"`
Expected: FAIL — `resolveSupplier is not exported`.

- [ ] **Step 3: Add the client functions**

In `frontend/src/api.ts`, after the `uploadDocument` block in the intake section:

```ts
export interface PendingDraft {
  document_id: number;
  reason: string;
  supplier_proposal: { create_name: string; create_country: string };
  draft: {
    category: string;
    gross_amount: number;
    vat_amount: number;
    currency: string;
    tax_point_date: string;
    supplier_invoice_number: string | null;
  };
}

export const getPendingDraft = (id: number) =>
  apiFetch<PendingDraft>(`/api/documents/${id}/pending-draft`);

export const resolveSupplier = (id: number, supplierEntityId: number) =>
  apiFetch<TriageOutcome>(`/api/documents/${id}/resolve-supplier`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ supplier_entity_id: supplierEntityId }),
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/api.test.ts -t "resolveSupplier"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/api.test.ts
git commit -m "feat(spa): pending-draft + resolveSupplier API client"
```

---

## Task 7: Frontend resolve form + IntakeView wiring

**Files:**
- Create: `frontend/src/components/ResolveSupplierForm.tsx`
- Modify: `frontend/src/components/IntakeView.tsx`
- Test: `frontend/src/components/IntakeView.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/IntakeView.test.tsx`:

```ts
  it('resolves a needs_triage document via the create-supplier path', async () => {
    vi.mocked(getTriagePending).mockResolvedValue([]);
    vi.mocked(getDocuments).mockResolvedValue([
      { id: 4, filename: 'inv.pdf', mime_type: 'application/pdf', size_bytes: 1, status: 'needs_triage', created_at: 0 },
    ]);
    vi.mocked(getPendingDraft).mockResolvedValue({
      document_id: 4,
      reason: 'supplier creation not yet implemented (Task 43)',
      supplier_proposal: { create_name: 'Acme OÜ', create_country: 'EE' },
      draft: { category: 'software', gross_amount: 1525, vat_amount: 285, currency: 'EUR', tax_point_date: '2026-03-15', supplier_invoice_number: 'INV-7' },
    });
    vi.mocked(onboardEntity).mockResolvedValue({ id: 3, role: 'supplier', country: 'EE', name: 'Acme OÜ', goods_vs_services: null });
    vi.mocked(resolveSupplier).mockResolvedValue({ kind: 'expense', document_id: 4, expense_id: 55 });

    render(<IntakeView />);
    await screen.findByText('inv.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await screen.findByText('Acme OÜ');

    fireEvent.change(screen.getByLabelText('Registration key'), { target: { value: 'EE123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create supplier & book' }));

    await waitFor(() => {
      expect(onboardEntity).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'supplier', name: 'Acme OÜ', country: 'EE', registrationKey: 'EE123' }),
      );
      expect(resolveSupplier).toHaveBeenCalledWith(4, 3);
    });
  });
```

Ensure the test file mocks the api module (`vi.mock('../api')`) and imports `getPendingDraft`, `resolveSupplier`, `onboardEntity`, `getEntities` alongside the existing mocked imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/IntakeView.test.tsx -t "resolves a needs_triage"`
Expected: FAIL — no "Resolve" button.

- [ ] **Step 3: Create the resolve form**

`frontend/src/components/ResolveSupplierForm.tsx`:

```tsx
import { useEffect, useState } from 'react';
import {
  getPendingDraft,
  resolveSupplier,
  onboardEntity,
  getEntities,
  type PendingDraft,
  type Entity,
} from '../api';

const cents = (n: number) => (n / 100).toFixed(2);

export function ResolveSupplierForm({
  documentId,
  onDone,
  onCancel,
}: {
  documentId: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pd, setPd] = useState<PendingDraft | null>(null);
  const [mode, setMode] = useState<'create' | 'pick'>('create');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [registrationKey, setRegistrationKey] = useState('');
  const [suppliers, setSuppliers] = useState<Entity[]>([]);
  const [pickId, setPickId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPendingDraft(documentId)
      .then((d) => {
        setPd(d);
        setName(d.supplier_proposal.create_name);
        setCountry(d.supplier_proposal.create_country);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    getEntities()
      .then((all) => setSuppliers(all.filter((e) => e.role === 'supplier')))
      .catch(() => undefined);
  }, [documentId]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let entityId: number;
      if (mode === 'create') {
        const created = await onboardEntity({
          role: 'supplier',
          name,
          country,
          registrationKey,
        });
        entityId = created.id;
      } else {
        if (pickId == null) {
          setError('Pick a supplier.');
          setBusy(false);
          return;
        }
        entityId = pickId;
      }
      await resolveSupplier(documentId, entityId);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (error && !pd) {
    return (
      <div className="border rounded p-3 text-sm">
        <p className="text-red-600">{error}</p>
        <button type="button" className="text-gray-600 hover:underline" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }
  if (!pd) return <div className="border rounded p-3 text-sm text-gray-500">Loading…</div>;

  return (
    <div className="border rounded p-3 space-y-3 text-sm bg-gray-50">
      <div className="text-gray-700">
        AI proposes supplier <strong>{pd.supplier_proposal.create_name}</strong> (
        {pd.supplier_proposal.create_country}) — draft {pd.draft.category}{' '}
        {cents(pd.draft.gross_amount)} {pd.draft.currency} (VAT {cents(pd.draft.vat_amount)}),{' '}
        {pd.draft.tax_point_date}
      </div>

      <div className="flex gap-3">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === 'create'} onChange={() => setMode('create')} />
          Create new
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === 'pick'} onChange={() => setMode('pick')} />
          Pick existing
        </label>
      </div>

      {mode === 'create' ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col">Name
            <input className="border rounded px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col">Country
            <input className="border rounded px-2 py-1" value={country} onChange={(e) => setCountry(e.target.value)} />
          </label>
          <label className="flex flex-col">Registration key
            <input aria-label="Registration key" className="border rounded px-2 py-1" value={registrationKey} onChange={(e) => setRegistrationKey(e.target.value)} />
          </label>
        </div>
      ) : (
        <select
          className="border rounded px-2 py-1"
          value={pickId ?? ''}
          onChange={(e) => setPickId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Select a supplier…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.country})</option>
          ))}
        </select>
      )}

      {error && <p className="text-red-600">{error}</p>}

      <div className="space-x-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
        >
          {mode === 'create' ? 'Create supplier & book' : 'Use supplier & book'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="text-gray-600 hover:underline">
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into IntakeView**

In `frontend/src/components/IntakeView.tsx`:

Add the import:

```tsx
import { ResolveSupplierForm } from './ResolveSupplierForm';
```

Add state (next to the other `useState` calls):

```tsx
  const [resolvingId, setResolvingId] = useState<number | null>(null);
```

In the "Needs triage" row's actions cell, add a Resolve button before "Why?":

```tsx
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setResolvingId(d.id)}
                        className="text-green-700 hover:underline disabled:opacity-50"
                      >
                        Resolve
                      </button>
```

Render the form under the row when it is the one being resolved. Replace the single `<tr>` body for needs_triage with a fragment that appends a form row:

```tsx
                {needsTriage.map((d) => (
                  <Fragment key={d.id}>
                    <tr className="border-b align-top">
                      <td className="px-3 py-2">{d.id}</td>
                      <td className="px-3 py-2">{d.filename}</td>
                      <td className="px-3 py-2 text-gray-500">
                        {outcomes[d.id] ?? (
                          <span className="text-gray-400">(click Why? to load)</span>
                        )}
                      </td>
                      <td className="px-3 py-2 space-x-2 whitespace-nowrap">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setResolvingId(d.id)}
                          className="text-green-700 hover:underline disabled:opacity-50"
                        >
                          Resolve
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onTriage(d.id)}
                          className="text-blue-600 hover:underline disabled:opacity-50"
                        >
                          Why?
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onComplete(d.id)}
                          className="text-gray-600 hover:underline disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </td>
                    </tr>
                    {resolvingId === d.id && (
                      <tr>
                        <td colSpan={4} className="px-3 py-2">
                          <ResolveSupplierForm
                            documentId={d.id}
                            onCancel={() => setResolvingId(null)}
                            onDone={() => {
                              setResolvingId(null);
                              void refresh();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
```

Add `Fragment` to the React import at the top:

```tsx
import { Fragment, useEffect, useRef, useState } from 'react';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/IntakeView.test.tsx -t "resolves a needs_triage"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ResolveSupplierForm.tsx frontend/src/components/IntakeView.tsx frontend/src/components/IntakeView.test.tsx
git commit -m "feat(spa): resolve supplier-unresolved documents from Intake"
```

---

## Task 8: Backend end-to-end happy path

**Files:**
- Create: `test/intake-supplier-resolution.e2e-spec.ts`

- [ ] **Step 1: Write the e2e test**

Model the harness on `test/credit-notes.e2e-spec.ts` (Nest `Test.createTestingModule({ imports: [AppModule] })`, in-memory better-sqlite3, all migrations applied, `supertest`). The test seeds a document parked on the supplier-unresolved route by stubbing the OCR + Pass-2 results so triage classifies a confident `new_expense` with a `create` supplier proposal, then drives the resolution endpoints:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { OcrService } from '../src/triage/ocr.service';
import { Pass2AgentService } from '../src/ai/pass2-agent.service';

describe('intake supplier-unresolved resolution (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OcrService)
      .useValue({ transcribe: async () => ({ ok: true, markdown: 'INVOICE Acme OÜ 15.25 EUR' }) })
      .overrideProvider(Pass2AgentService)
      .useValue({
        classify: async () => ({
          ok: true,
          result: {
            kind: 'new_expense',
            gross_amount: 1525,
            vat_amount: 285,
            tax_point_date: '2026-03-15',
            category: 'software',
            supplier_proposal: { mode: 'create', create_name: 'Acme OÜ', create_country: 'EE' },
            document_type: 'invoice',
            currency: 'EUR',
            document_vat_marking: null,
            supplier_invoice_number: 'INV-7',
            confidence: 0.99,
          },
        }),
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('parks on needs_triage, then resolves into a draft expense', async () => {
    const http = request(app.getHttpServer());

    // 1. Upload → pending.
    const up = await http
      .post('/api/documents')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'inv.pdf')
      .expect(201);
    const documentId = up.body.document.id as number;

    // 2. Triage → needs_triage (create-supplier proposal cannot auto-resolve).
    const triaged = await http.post(`/api/documents/${documentId}/triage`).expect(201);
    expect(triaged.body.kind).toBe('unknown');

    // 3. The pending draft is readable.
    const pd = await http.get(`/api/documents/${documentId}/pending-draft`).expect(200);
    expect(pd.body.supplier_proposal).toEqual({ create_name: 'Acme OÜ', create_country: 'EE' });
    expect(pd.body.draft.gross_amount).toBe(1525);

    // 4. Create the supplier.
    const sup = await http
      .post('/api/entities')
      .send({ role: 'supplier', name: 'Acme OÜ', country: 'EE', registrationKey: 'EE100200300' })
      .expect(201);
    const supplierId = sup.body.id as number;

    // 5. Resolve → draft expense.
    const resolved = await http
      .post(`/api/documents/${documentId}/resolve-supplier`)
      .send({ supplier_entity_id: supplierId })
      .expect(201);
    expect(resolved.body.kind).toBe('expense');
    const expenseId = resolved.body.expense_id as number;

    // 6. The expense exists and carries the supplier; the proposal is gone.
    const exp = await http.get(`/api/expenses/${expenseId}`).expect(200);
    expect(exp.body.supplier_id).toBe(supplierId);
    await http.get(`/api/documents/${documentId}/pending-draft`).expect(404);
  });
});
```

> Match the exact HTTP status codes the app's other e2e specs assert (e.g. POST default `201`). If `POST /api/entities` returns `201` vs `200` differs from this, align with the credit-notes/entities e2e precedent. If the app applies a global auth guard in e2e, copy the auth setup (token header) from `test/credit-notes.e2e-spec.ts`.

- [ ] **Step 2: Run the e2e test**

Run: `npx jest --config test/jest-e2e.json test/intake-supplier-resolution.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/intake-supplier-resolution.e2e-spec.ts
git commit -m "test(intake): e2e supplier-unresolved resolution happy path"
```

---

## Task 9: Full verification

- [ ] **Step 1: Backend build + unit + e2e**

Run: `npm run build && npm test && npm run test:e2e`
Expected: TypeScript clean; all suites green.

- [ ] **Step 2: Frontend build + tests + lint**

Run: `cd frontend && npx vitest run && npm run build`
Expected: all tests green; build succeeds.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean (fix any new findings inline).

- [ ] **Step 4: Final commit if lint changed anything**

```bash
git add -A
git commit -m "chore(intake): lint + verification for supplier resolution"
```

---

## Self-Review Notes

- **Spec coverage:** §1 persistence → Task 1; §2 capture → Task 2; §3 resolveSupplier (guards, idempotency, settle) → Task 3; §4 API (`pending-draft`, `resolve-supplier`) → Tasks 4–5; §5 SPA → Tasks 6–7; §6 tests → embedded per task + Task 8 e2e. `complete` cleanup → Task 5 Step 5.
- **Deviation from spec (intentional):** a missing entity yields `404` (from `EntitiesService.findById`) rather than `400`; a wrong-role entity yields `400`. This is stricter-correct and noted here.
- **Type consistency:** `PendingDraft`, `TriageResult`, `resolveSupplier(documentId, supplierEntityId)`, `getPendingDraft(documentId)`, `setPendingTriageResult(id, result|null)`, `getPendingTriageResult(id)` are used identically across backend tasks; `getPendingDraft`/`resolveSupplier` client names match the backend routes.
- **Plan-time check resolved:** `GET /api/entities` exists and the client `getEntities()` (returns `Entity[]`) is already in `frontend/src/api.ts:96`; the picker reuses it.
