# Order-vs-Invoice Classification + Duplicate-Posting Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the intake pipeline from auto-posting an order confirmation / proforma as a real expense, and add a two-tier structured duplicate gate so the same purchase can never be booked twice.

**Architecture:** Three independent defenses layered on the existing Pass-2 → deterministic-routing → auto-post pipeline: (1) a jurisdiction-aware document-type classification that recognizes non-tax documents (order confirmation, proforma) via country-plugin-supplied vocabulary and parks them instead of posting; (2) a two-tier structured duplicate gate (exact supplier+invoice-number, fuzzy supplier+gross+date-window) placed post-classification, right before the auto-post in `routeExpense`; (3) evals + unit tests that lock the behavior against regression. The country-specific classification vocabulary lives in the `CountryPlugin` seam, not the shared prompt.

**Tech Stack:** NestJS, Kysely (better-sqlite3), Zod, Mastra (LLM agents), Jest.

## Global Constraints

- Amounts are INTEGER MINOR UNITS (cents). `gross_amount` 5200 = €52.00.
- `tax_point_date` is an ISO `YYYY-MM-DD` string; ISO dates sort lexically = chronologically.
- Never hard-*reject* a document: the `document` + `document_source` rows are audit evidence and must always persist. The only two outcomes for a blocked auto-post are (a) park to `needs_triage`, (b) post. No silent drop.
- The `ProcessingGate` (`this.gate.run(...)`) serializes the whole OCR→classify→route pipeline process-wide — so inside `routeExpense`, any earlier document's committed `expense` row is visible. Do not add locking.
- BASE BRANCH IS `main` (this worktree = `fix/order-vs-invoice-duplicate-gate` off main, NOT the stale `opencode/crisp-tiger`). On main, PR #185 already landed: `reason_type` IS persisted (`audit_finding.reason_type`, migration 065) and read back via `resolveReasonType(persisted, description)` — persisted write-time value wins, falling back to `classifyReasonType(description)` for legacy rows (`triage/types.ts`). `TriageReasonType` is an EXPLICIT union PLUS a parallel `TRIAGE_REASON_TYPES` array (both hand-maintained; `classification_failed` already exists) — match that style, do NOT refactor into a derived union. Adding a new `TriageReasonType` needs: (1) add the literal to BOTH the union AND the `TRIAGE_REASON_TYPES` array; (2) add a `classifyReasonType` branch matching a STABLE distinctive marker substring, ordered so no earlier generic check shadows it; (3) make every `routeNeedsTriage` reason string for that case contain that exact marker AND ensure the write path persists the right `reason_type` (whatever mechanism main's `routeNeedsTriage` uses — verify per task). Markers: `not a primary tax document` → `non_postable_document`; `possible duplicate of` → `possible_duplicate`. The two values are TEXT in the existing column — no new migration.
- Follow the existing sales-side precedent: `routeSalesInvoice` already parks a duplicate invoice number (`propose-draft.service.ts` `DuplicateNumberResult`, wired at `intake-workflow.service.ts:685-696`). The expense-side gate is its mirror.

---

## File Structure

**Modify:**
- `packages/server/src/triage/types.ts` — add `document_type` enum values; add two `TriageReasonType`s + array entries; add a `classifyReasonType` branch each.
- `packages/server/src/intake/document-class.ts` — add `DocumentType` values; add `non_postable` route; classify order_confirmation/proforma to it.
- `packages/server/src/plugins/country-plugin.interface.ts` — add `getDocumentClassificationHints(): string`.
- `packages/server/src/plugins/null-country.plugin.ts` — neutral English hints.
- `packages/server/src/plugins/estonia-country.plugin.ts` — Estonian-lexicon hints.
- `packages/server/src/ai/triage-instructions.ts` — add `withDocumentHints(instructions, hints)`.
- `packages/server/src/ai/mastra.service.ts` — append hints in both triage builders.
- `packages/server/src/ai/intake-workflow.service.ts` — handle `non_postable` route; call the duplicate gate in `routeExpense` and `resolveSupplier` before `proposeDraft`.

**Create:**
- `packages/server/src/ai/duplicate-guard.service.ts` — the two-tier gate + its NestJS provider.
- `packages/server/src/ai/duplicate-guard.service.spec.ts` — gate unit tests.
- `packages/server/src/ai/__fixtures__/ee-classification-evals.ts` — golden OCR markdowns + expected labels (EE set, incl. the real Tellimus/Arve pair).
- `packages/server/src/ai/pass2-classification.eval.spec.ts` — env-gated LLM eval runner over the fixtures.

**Test (extend existing):**
- `packages/server/src/triage/types.spec.ts` (create if absent) — reason-type guards.
- `packages/server/src/intake/document-class.spec.ts` (create if absent) — routing.
- `packages/server/src/plugins/estonia-country.plugin.spec.ts` — hints content.
- `packages/server/src/ai/triage-instructions.spec.ts` — `withDocumentHints`.
- `packages/server/src/ai/mastra.service.spec.ts` — hint reaches assembled prompt.
- `packages/server/src/ai/intake-workflow.service.spec.ts` — non_postable park + gate e2e.

---

## Task 1: Schema — new document types + reason types

**Files:**
- Modify: `packages/server/src/triage/types.ts` — `:112` (`document_type` enum), `:221-230` (`TriageReasonType` union), `:240-250` (`TRIAGE_REASON_TYPES` array), `:280-311` (`classifyReasonType`)
- Modify: `packages/server/src/intake/document-class.ts:1-7` (`DocumentType`)
- Test: EXTEND the two existing specs — `packages/server/src/triage/types.spec.ts` (schema parsing) and `packages/server/src/triage/triage.types.spec.ts` (`classifyReasonType` branches). Do NOT create a new spec file.

**Interfaces:**
- Produces: `TriageReasonType` now includes `'non_postable_document' | 'possible_duplicate'`; `document_type` enum includes `'order_confirmation' | 'proforma'`; `DocumentType` (intake) includes `'order_confirmation' | 'proforma'`.

- [ ] **Step 1: Write the failing tests (extend the two EXISTING specs — do NOT create a new file)**

Add to `packages/server/src/triage/types.spec.ts` (it already has a `triageResultSchema … document_type` describe; reuse its existing `triageResultSchema` import):
```typescript
describe('document_type — order_confirmation / proforma', () => {
  it('parses the two new non-postable document types', () => {
    for (const document_type of ['order_confirmation', 'proforma'] as const) {
      const r = triageResultSchema.parse({
        kind: 'new_expense',
        gross_amount: 5200,
        vat_amount: 1006,
        tax_point_date: '2026-07-15',
        category: 'it_equipment',
        document_type,
      });
      expect(r.document_type).toBe(document_type);
    }
  });
});
```

Add to `packages/server/src/triage/triage.types.spec.ts` (it already covers every `classifyReasonType` branch). Widen its import line from `import { classifyReasonType } from './types';` to also import `isTriageReasonType, TRIAGE_REASON_TYPES`, then add:
```typescript
describe('new reason types (order/proforma park + duplicate gate)', () => {
  it('registers both new reason types on the type guard and array', () => {
    expect(isTriageReasonType('non_postable_document')).toBe(true);
    expect(isTriageReasonType('possible_duplicate')).toBe(true);
    expect(TRIAGE_REASON_TYPES).toEqual(
      expect.arrayContaining(['non_postable_document', 'possible_duplicate']),
    );
  });
  it('maps a non-postable (order confirmation / proforma) park reason', () => {
    expect(
      classifyReasonType(
        'Order confirmation — not a primary tax document; awaiting the final invoice',
      ),
    ).toBe('non_postable_document');
  });
  it('maps a duplicate-gate reason, winning over the generic supplier check', () => {
    // Contains the word "supplier" — must still resolve to possible_duplicate
    // because the duplicate branch is ordered before the supplier branch.
    expect(
      classifyReasonType(
        'possible duplicate of expense #84 (same supplier, 52.00 gross, 2026-07-15)',
      ),
    ).toBe('possible_duplicate');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx jest src/triage/types.spec.ts src/triage/triage.types.spec.ts`
Expected: FAIL — `isTriageReasonType('non_postable_document')` is false; the enum parse throws on `order_confirmation`; the two `classifyReasonType` cases return `'unknown'`/`'supplier_unresolved'` instead of the new types.

- [ ] **Step 3: Implement**

In `triage/types.ts`, the `document_type` enum (currently line 112):
```typescript
  document_type: z
    .enum([
      'receipt',
      'invoice',
      'bank_statement',
      'credit_note',
      'order_confirmation',
      'proforma',
      'other',
    ])
    .default('other'),
```

The `TriageReasonType` union (line 221) — add two members before `'unknown'`:
```typescript
  | 'not_a_document'
  | 'non_postable_document'
  | 'possible_duplicate'
  | 'unknown';
```

The `TRIAGE_REASON_TYPES` array (line 240) — add the same two before `'unknown'`:
```typescript
  'not_a_document',
  'non_postable_document',
  'possible_duplicate',
  'unknown',
] as const;
```

In `classifyReasonType` (line 280), add two branches. Put them AFTER the `not_a_document` check and BEFORE the `supplier` check, so their distinct marker text wins:
```typescript
  if (description.toLowerCase().includes('not a primary tax document'))
    return 'non_postable_document';
  if (description.toLowerCase().includes('possible duplicate of'))
    return 'possible_duplicate';
```

In `intake/document-class.ts`, the `DocumentType` alias (line 1):
```typescript
export type DocumentType =
  | 'invoice'
  | 'receipt'
  | 'bank_statement'
  | 'credit_note'
  | 'order_confirmation'
  | 'proforma'
  | 'other';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx jest src/triage/types.spec.ts src/triage/triage.types.spec.ts`
Expected: PASS (both new describes green, all pre-existing cases still green). Then `cd packages/server && npx tsc --noEmit` — clean (the widened `document_type`/`DocumentType` must not break any consumer; `classifyDocumentClass` has no exhaustive switch so the new values fall through to its documented default until Task 2).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/triage/types.ts packages/server/src/intake/document-class.ts packages/server/src/triage/types.spec.ts packages/server/src/triage/triage.types.spec.ts
git commit -m "feat(triage): add order_confirmation/proforma document types and non_postable/possible_duplicate reason types"
```

---

## Task 2: Routing — park order_confirmation / proforma as non-postable

**Files:**
- Modify: `packages/server/src/intake/document-class.ts:8-66` (`IntakeRoute`, `classifyDocumentClass`)
- Modify: `packages/server/src/ai/intake-workflow.service.ts:64-66` (add `nonPostableReason`), `:488-513` (route switch)
- Test: `packages/server/src/intake/document-class.spec.ts`, extend `intake-workflow.service.spec.ts`

**Interfaces:**
- Consumes: `DocumentType` (Task 1).
- Produces: `IntakeRoute` now includes `'non_postable'`; `classifyDocumentClass` returns it for order_confirmation/proforma; exported `nonPostableReason(): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/intake/document-class.spec.ts`:
```typescript
import { classifyDocumentClass } from './document-class';

describe('classifyDocumentClass — non-postable documents', () => {
  it('routes an order_confirmation to non_postable (no IBAN)', () => {
    expect(
      classifyDocumentClass({ documentType: 'order_confirmation', ibanMatched: false }),
    ).toEqual({ route: 'non_postable', direction: 'incoming', docType: 'order_confirmation' });
  });

  it('routes a proforma to non_postable even when IBAN matches', () => {
    expect(
      classifyDocumentClass({ documentType: 'proforma', ibanMatched: true }),
    ).toEqual({ route: 'non_postable', direction: 'incoming', docType: 'proforma' });
  });

  it('still routes a plain invoice to expense', () => {
    expect(
      classifyDocumentClass({ documentType: 'invoice', ibanMatched: false }),
    ).toEqual({ route: 'expense', direction: 'incoming', docType: 'invoice' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest src/intake/document-class.spec.ts`
Expected: FAIL — `route` is `'expense'`, not `'non_postable'`.

- [ ] **Step 3: Implement**

In `document-class.ts`, extend `IntakeRoute` (line 8):
```typescript
export type IntakeRoute =
  | 'expense'
  | 'sales_invoice'
  | 'bank_statement'
  | 'non_postable'
  | 'unsupported';
```

At the TOP of `classifyDocumentClass` body (after destructuring, before the bank_statement check), add:
```typescript
  // Order confirmations and proformas are NOT primary tax documents in any
  // direction — they precede or estimate a real invoice. Park them; never post.
  if (documentType === 'order_confirmation' || documentType === 'proforma') {
    return { route: 'non_postable', direction: 'incoming', docType: documentType };
  }
```

In `intake-workflow.service.ts`, add an exported reason builder next to `notADocumentReason` (line 64):
```typescript
export function nonPostableReason(docType: string): string {
  return `This is not a primary tax document (classified as ${docType} — e.g. an order confirmation, proforma, or quote). Intake did not book it; the real invoice will be booked when it arrives. Held for human review.`;
}
```

In the `switch (documentClass.route)` block (line 488), add a case before `unsupported`:
```typescript
        case 'non_postable':
          return this.routeNeedsTriage(
            documentId,
            nonPostableReason(documentClass.docType),
          );
```

- [ ] **Step 4: Write the workflow-level failing test, then run all**

In `intake-workflow.service.spec.ts`, add a case in the existing describe that mocks Pass-2 to return `document_type: 'order_confirmation'`, `kind: 'new_expense'`, `confidence: 0.95`, and asserts the document ends `needs_triage` with a `non_postable_document` reason_type and that `proposeDraft.proposeDraft` was NOT called. (Follow the existing mock-setup pattern in that spec for OCR + pass2Agent + documents + auditFindings.)

Run: `cd packages/server && npx jest src/intake/document-class.spec.ts src/ai/intake-workflow.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/intake/document-class.ts packages/server/src/ai/intake-workflow.service.ts packages/server/src/intake/document-class.spec.ts packages/server/src/ai/intake-workflow.service.spec.ts
git commit -m "feat(intake): route order_confirmation/proforma to non-postable needs_triage instead of auto-posting"
```

---

## Task 3: CountryPlugin.getDocumentClassificationHints()

**Files:**
- Modify: `packages/server/src/plugins/country-plugin.interface.ts:160` (add method after `getCategories()`)
- Modify: `packages/server/src/plugins/null-country.plugin.ts:107-113` (add after `getCategories()`)
- Modify: `packages/server/src/plugins/estonia-country.plugin.ts:194` (add near identity/category section)
- Test: `packages/server/src/plugins/estonia-country.plugin.spec.ts`

**Interfaces:**
- Produces: `CountryPlugin.getDocumentClassificationHints(): string` — a prose block of jurisdiction-specific vocabulary telling the model which local document titles map to `order_confirmation` / `proforma` / `credit_note` vs a real `invoice`.

- [ ] **Step 1: Write the failing test**

In `estonia-country.plugin.spec.ts`, add:
```typescript
describe('getDocumentClassificationHints', () => {
  it('names the Estonian order/proforma vocabulary and the invoice marker', () => {
    const hints = plugin.getDocumentClassificationHints();
    expect(hints).toMatch(/Tellimus/i);        // order
    expect(hints).toMatch(/ettemaksuarve/i);   // prepayment/proforma
    expect(hints).toMatch(/Arve/);             // invoice
    expect(hints).toMatch(/order_confirmation/);
    expect(hints).toMatch(/proforma/);
  });
});
```
(Reuse the existing `plugin` instance the spec sets up; if none, `const plugin = new EstoniaCountryPlugin();`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest src/plugins/estonia-country.plugin.spec.ts`
Expected: FAIL — `getDocumentClassificationHints` is not a function.

- [ ] **Step 3: Implement**

In `country-plugin.interface.ts`, after `getCategories(): CategoryDef[]` (line 160), add:
```typescript
  /**
   * Jurisdiction-specific document-classification vocabulary appended to the
   * Pass-2 prompt. Tells the model which LOCAL document titles are NOT primary
   * tax documents (order confirmations, proformas, quotes, delivery notes →
   * document_type "order_confirmation"/"proforma"/"other") versus a real
   * invoice, so a paid order confirmation is not misread as an invoice.
   * Return '' to add nothing.
   */
  getDocumentClassificationHints(): string;
```

In `null-country.plugin.ts`, after `getCategories()` (line 113):
```typescript
  getDocumentClassificationHints(): string {
    return (
      'DOCUMENT-TYPE GUIDANCE:\n' +
      '- An "order confirmation", "order", "sales order", "purchase order", ' +
      'or "order receipt" — even if it shows a total or is marked paid — is ' +
      'NOT a tax invoice. Set document_type="order_confirmation".\n' +
      '- A "pro forma invoice" / "proforma" / "quote" / "quotation" / ' +
      '"estimate" is NOT a real invoice. Set document_type="proforma".\n' +
      '- A "delivery note" / "packing slip" with no payable amount is not an ' +
      'accounting document. Set kind="not_a_document".\n' +
      '- A real invoice states "Invoice", carries an invoice number, a due ' +
      'date, and an explicit VAT breakdown. Set document_type="invoice".\n' +
      'When an order confirmation and a separate invoice describe the same ' +
      'purchase, ONLY the invoice is the postable primary document.'
    );
  }
```

In `estonia-country.plugin.ts`, near the identity/category section (after `getCategories()` ~line 194), under a new banner:
```typescript
  // ── Document classification vocabulary (EE) ───────────────────────────────

  getDocumentClassificationHints(): string {
    return (
      'DOCUMENT-TYPE GUIDANCE (Estonian documents):\n' +
      '- "Tellimus", "Tellimuse kinnitus", "Tellimuse number" = an ORDER / ' +
      'order confirmation. Even if it shows "Kokku tasuda" or "Makstud" ' +
      '(paid), it is NOT a tax invoice. Set document_type="order_confirmation".\n' +
      '- "Ettemaksuarve" = prepayment/pro-forma invoice; "Pakkumine" / ' +
      '"Hinnapakkumine" = quote; "Saateleht" = delivery note. None are a final ' +
      'invoice. Set document_type="proforma" (or "other" for a saateleht).\n' +
      '- "Arve" (an invoice) with "Arve nr", "Maksetähtpäev" (due date) and a ' +
      '"Käibemaks 24%" VAT breakdown IS the primary tax document. Set ' +
      'document_type="invoice".\n' +
      '- A document titled "Arve nr X / Tellimus nr Y" is the INVOICE for order ' +
      'Y — classify it as invoice, not as an order.\n' +
      'When both a Tellimus and an Arve describe the same purchase, ONLY the ' +
      'Arve is postable.'
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx jest src/plugins/estonia-country.plugin.spec.ts`
Expected: PASS. Then `cd packages/server && npx tsc --noEmit` to confirm every `CountryPlugin` implementer (incl. `strict-test.plugin.ts` via `NullCountryPlugin` inheritance) still satisfies the interface.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/plugins/country-plugin.interface.ts packages/server/src/plugins/null-country.plugin.ts packages/server/src/plugins/estonia-country.plugin.ts packages/server/src/plugins/estonia-country.plugin.spec.ts
git commit -m "feat(plugins): add getDocumentClassificationHints() with EE order-vs-invoice vocabulary"
```

---

## Task 4: Inject plugin hints into the Pass-2 prompt

**Files:**
- Modify: `packages/server/src/ai/triage-instructions.ts:20` (add `withDocumentHints`)
- Modify: `packages/server/src/ai/mastra.service.ts:104-144` (both triage builders)
- Test: `packages/server/src/ai/triage-instructions.spec.ts`, `packages/server/src/ai/mastra.service.spec.ts`

**Interfaces:**
- Consumes: `plugin.getDocumentClassificationHints()` (Task 3).
- Produces: `withDocumentHints(instructions: string, hints: string): string`.

- [ ] **Step 1: Write the failing test**

In `triage-instructions.spec.ts`, add:
```typescript
import { withDocumentHints } from './triage-instructions';

describe('withDocumentHints', () => {
  it('appends non-empty hints', () => {
    const out = withDocumentHints('BASE', 'HINTBLOCK');
    expect(out).toContain('BASE');
    expect(out).toContain('HINTBLOCK');
  });
  it('returns the base unchanged for empty hints', () => {
    expect(withDocumentHints('BASE', '')).toBe('BASE');
    expect(withDocumentHints('BASE', '   ')).toBe('BASE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest src/ai/triage-instructions.spec.ts`
Expected: FAIL — `withDocumentHints` is not exported.

- [ ] **Step 3: Implement**

In `triage-instructions.ts`, add after `withCategoryList` (line 20):
```typescript
/**
 * Append the active country plugin's document-classification vocabulary to the
 * base triage prompt, so the model distinguishes local order-confirmation /
 * proforma titles from a real invoice at generation time. Jurisdiction-specific
 * wording lives in the plugin, not here. Empty/blank hints leave the base
 * prompt unchanged.
 */
export function withDocumentHints(
  baseInstructions: string,
  hints: string,
): string {
  if (hints.trim().length === 0) return baseInstructions;
  return `${baseInstructions}\n\n${hints}`;
}
```

In `mastra.service.ts`, in BOTH `buildTriageEnrichmentAgent` and `buildTriageClassificationAgent`, resolve the active plugin and thread the hints through. The builders already read `orgContext` and call `this.categoryService.list()`; `PluginLoader` is already injected as `this.pluginLoader` and `OrganizationService` as `this.organizationService`. Insert after `withCategoryList` and before/around `withOrgIdentity`:
```typescript
    const org = await this.organizationService.getOrganization();
    const plugin = this.pluginLoader.resolve(org.country);
    const withHints = withDocumentHints(
      withCategoryList(instructions, categories),
      plugin.getDocumentClassificationHints(),
    );
    const finalInstructions = orgContext
      ? withOrgIdentity(withHints, orgContext)
      : withHints;
```
Add `withDocumentHints` to the existing import from `./triage-instructions`. (If a builder already resolves `org`/`plugin` for another reason, reuse it — do not resolve twice.)

- [ ] **Step 4: Write the end-to-end prompt test, then run**

In `mastra.service.spec.ts`, following the existing `expect(await agent.getInstructions()).toContain(...)` pattern (lines ~145/182), assert the classification agent's instructions contain a hint marker. With the EE plugin active this is `'order_confirmation'`; if the spec's test org uses the null plugin, assert `'order confirmation'`. Match the spec's existing org/plugin setup.

Run: `cd packages/server && npx jest src/ai/triage-instructions.spec.ts src/ai/mastra.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ai/triage-instructions.ts packages/server/src/ai/mastra.service.ts packages/server/src/ai/triage-instructions.spec.ts packages/server/src/ai/mastra.service.spec.ts
git commit -m "feat(ai): inject country-plugin document-classification hints into the Pass-2 prompt"
```

---

## Task 5: DuplicateGuardService — two-tier structured gate

**Files:**
- Create: `packages/server/src/ai/duplicate-guard.service.ts`, `packages/server/src/ai/duplicate-guard.service.spec.ts`
- Modify: the module that provides the AI services (add `DuplicateGuardService` to providers — the same NestJS module that declares `ProposeDraftService`/`IntakeWorkflowService`).

**Interfaces:**
- Produces:
```typescript
export interface DuplicateMatch {
  tier: 1 | 2;
  existingExpenseId: number;
  reason: string;
}
export class DuplicateGuardService {
  // Returns the strongest match blocking an auto-post, or null if clear.
  check(candidate: {
    supplierId: number;
    supplierInvoiceNumber: string | null;
    grossAmount: number;
    taxPointDate: string; // YYYY-MM-DD
  }): Promise<DuplicateMatch | null>;
}
```
- Tier 1 (exact): an existing `expense` row (any non-reversed status) with the same `supplier_id` AND the same non-null `supplier_invoice_number`.
- Tier 2 (fuzzy): same `supplier_id` AND same `gross_amount` AND `tax_point_date` within ±7 days, when Tier 1 did not match. Match on GROSS, never VAT (VAT wobbles: the incident's order said 10.00, the invoice 10.06).
- Window bounds are computed in JS as ISO strings and compared lexically.

- [ ] **Step 1: Write the failing test**

Create `duplicate-guard.service.spec.ts`. Use the repo's in-memory Kysely test harness (copy the DB-setup import used by `propose-draft.service.spec.ts`). Seed `entity` (a supplier) and `expense` rows directly via `db.insertInto`.
```typescript
// Pseudocode structure — mirror the DB harness of propose-draft.service.spec.ts.
describe('DuplicateGuardService', () => {
  // helper seedExpense({ supplierId, invoiceNo, gross, date, status })

  it('Tier 1: same supplier + same invoice number blocks', async () => {
    await seedExpense({ supplierId: 44, invoiceNo: '2599', gross: 5200, date: '2026-07-15', status: 'posted' });
    const m = await guard.check({ supplierId: 44, supplierInvoiceNumber: '2599', grossAmount: 5200, taxPointDate: '2026-07-15' });
    expect(m?.tier).toBe(1);
  });

  it('Tier 2: same supplier + gross + date within 7 days blocks (no/other numbers)', async () => {
    await seedExpense({ supplierId: 44, invoiceNo: null, gross: 5200, date: '2026-07-15', status: 'posted' });
    const m = await guard.check({ supplierId: 44, supplierInvoiceNumber: '28965', grossAmount: 5200, taxPointDate: '2026-07-15' });
    expect(m?.tier).toBe(2);
    expect(m?.reason).toContain('possible duplicate of');
  });

  it('does NOT block two real invoices: same supplier+gross+date but different numbers', async () => {
    // This is only distinguishable when BOTH have printed numbers. Tier 1 needs
    // an EXACT number match; different numbers skip Tier 1. Tier 2 would catch
    // same-gross+date — so a genuine same-day, same-amount second invoice DOES
    // park (safe: one operator click). Assert Tier 2 fires and is labelled,
    // NOT silently dropped.
    await seedExpense({ supplierId: 44, invoiceNo: '1000', gross: 5200, date: '2026-07-15', status: 'posted' });
    const m = await guard.check({ supplierId: 44, supplierInvoiceNumber: '1001', grossAmount: 5200, taxPointDate: '2026-07-15' });
    expect(m?.tier).toBe(2);
  });

  it('does NOT block a monthly recurring invoice 30 days apart', async () => {
    await seedExpense({ supplierId: 44, invoiceNo: null, gross: 5200, date: '2026-06-15', status: 'posted' });
    const m = await guard.check({ supplierId: 44, supplierInvoiceNumber: null, grossAmount: 5200, taxPointDate: '2026-07-15' });
    expect(m).toBeNull();
  });

  it('ignores reversed expenses', async () => {
    await seedExpense({ supplierId: 44, invoiceNo: '2599', gross: 5200, date: '2026-07-15', status: 'reversed' });
    const m = await guard.check({ supplierId: 44, supplierInvoiceNumber: '2599', grossAmount: 5200, taxPointDate: '2026-07-15' });
    expect(m).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest src/ai/duplicate-guard.service.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `duplicate-guard.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import type { Database } from '../database/types'; // match the import path used by propose-draft.service.ts

export interface DuplicateMatch {
  tier: 1 | 2;
  existingExpenseId: number;
  reason: string;
}

const WINDOW_DAYS = 7;

/** ISO YYYY-MM-DD shifted by ±days (UTC, no time component). */
function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

@Injectable()
export class DuplicateGuardService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async check(candidate: {
    supplierId: number;
    supplierInvoiceNumber: string | null;
    grossAmount: number;
    taxPointDate: string;
  }): Promise<DuplicateMatch | null> {
    // A reversed expense is void — it must not block a re-post.
    const notReversed = (q: any) => q.where('status', '!=', 'reversed');

    // Tier 1 — exact supplier + invoice number (only when a number is printed).
    if (candidate.supplierInvoiceNumber) {
      const exact = await notReversed(
        this.db
          .selectFrom('expense')
          .select(['id'])
          .where('supplier_id', '=', candidate.supplierId)
          .where('supplier_invoice_number', '=', candidate.supplierInvoiceNumber),
      )
        .orderBy('id', 'desc')
        .executeTakeFirst();
      if (exact) {
        return {
          tier: 1,
          existingExpenseId: exact.id,
          reason: `Possible duplicate of expense #${exact.id}: same supplier and invoice number ${candidate.supplierInvoiceNumber}.`,
        };
      }
    }

    // Tier 2 — supplier + gross + tax_point_date within ±WINDOW_DAYS.
    const lo = shiftIsoDate(candidate.taxPointDate, -WINDOW_DAYS);
    const hi = shiftIsoDate(candidate.taxPointDate, WINDOW_DAYS);
    const fuzzy = await notReversed(
      this.db
        .selectFrom('expense')
        .select(['id', 'tax_point_date'])
        .where('supplier_id', '=', candidate.supplierId)
        .where('gross_amount', '=', candidate.grossAmount)
        .where('tax_point_date', '>=', lo)
        .where('tax_point_date', '<=', hi),
    )
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (fuzzy) {
      return {
        tier: 2,
        existingExpenseId: fuzzy.id,
        reason: `Possible duplicate of expense #${fuzzy.id}: same supplier, ${(candidate.grossAmount / 100).toFixed(2)} gross, tax point ${candidate.taxPointDate} (existing ${fuzzy.tax_point_date}).`,
      };
    }

    return null;
  }
}
```
Add `DuplicateGuardService` to the providers of the AI module (the one declaring `ProposeDraftService`). Verify the `Database` type import path and `InjectKysely`/`nestjs-kysely` usage against `propose-draft.service.ts` and adjust if they differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx jest src/ai/duplicate-guard.service.spec.ts`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ai/duplicate-guard.service.ts packages/server/src/ai/duplicate-guard.service.spec.ts packages/server/src/ai/<ai-module>.ts
git commit -m "feat(ai): add two-tier structured DuplicateGuardService (exact number + fuzzy supplier/gross/date)"
```

---

## Task 6: Wire the gate into routeExpense (and the resolveSupplier bypass)

**Files:**
- Modify: `packages/server/src/ai/intake-workflow.service.ts` — constructor (inject `DuplicateGuardService`), `routeExpense` (`:544-590`, the `new_expense` confident branch, BEFORE `proposeDraft`), and `resolveSupplier` (`:743+`, before its `proposeDraft` call).
- Test: extend `intake-workflow.service.spec.ts`.

**Interfaces:**
- Consumes: `DuplicateGuardService.check(...)` (Task 5), `TriageReasonType` `'possible_duplicate'` (Task 1, reached because the reason text contains `'possible duplicate of'`).

- [ ] **Step 1: Write the failing test**

In `intake-workflow.service.spec.ts` add an e2e-style case (mocking OCR + pass2Agent, real-ish documents/auditFindings, `DuplicateGuardService` mocked to return a Tier-2 match): a confident `new_expense` whose supplier+gross+date collides ends `needs_triage` with `possible_duplicate` reason_type, and `proposeDraft.proposeDraft` is NOT called. Add a second case: guard returns `null` → posts as before (existing happy-path assertion still holds).

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && npx jest src/ai/intake-workflow.service.spec.ts`
Expected: FAIL — document posts instead of parking (gate not wired).

- [ ] **Step 3: Implement**

Inject the guard in the constructor (line 186 block):
```typescript
    private readonly duplicateGuard: DuplicateGuardService,
```

In `routeExpense`, inside `case 'new_expense':` after the `confidence >= threshold` check and BEFORE `proposeDraft` (around line 555), add the gate. The `supplier_proposal` match id is the resolved supplier; use it when present (a `create` proposal has no id yet and falls through to the existing supplier-unresolved path, so only gate when we have a supplier id):
```typescript
        if (triageResult.confidence >= threshold) {
          const supplierId =
            triageResult.supplier_proposal?.mode === 'match'
              ? triageResult.supplier_proposal.match_entity_id
              : null;
          if (supplierId != null) {
            const dup = await this.duplicateGuard.check({
              supplierId,
              supplierInvoiceNumber: triageResult.supplier_invoice_number,
              grossAmount: triageResult.gross_amount,
              taxPointDate: triageResult.tax_point_date,
            });
            if (dup) {
              this.logger.warn(
                `Duplicate gate (tier ${dup.tier}) blocked auto-post for document ${documentId}: ${dup.reason}`,
              );
              return this.routeNeedsTriage(documentId, dup.reason);
            }
          }
          // ... existing proposeDraft call unchanged ...
```

In `resolveSupplier`, after the operator's `supplierEntityId` is known and before its `proposeDraft` call, run the same check with `supplierId: supplierEntityId` (the operator just chose the supplier) using the stored pending triage figures. Park to `needs_triage` with `dup.reason` if it matches. (The idempotent already-`triaged` replay branch at line 749 must stay ABOVE this — never gate a replay.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/server && npx jest src/ai/intake-workflow.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ai/intake-workflow.service.ts packages/server/src/ai/intake-workflow.service.spec.ts
git commit -m "feat(ai): gate expense auto-post through DuplicateGuard in routeExpense and resolveSupplier"
```

---

## Task 7: EE classification evals (env-gated LLM runner)

**Files:**
- Create: `packages/server/src/ai/__fixtures__/ee-classification-evals.ts`, `packages/server/src/ai/pass2-classification.eval.spec.ts`

**Interfaces:**
- Consumes: `Pass2AgentService.classify` and the assembled prompt (Tasks 1-4).

**Note on honesty:** true classification behavior needs a real model, which is non-deterministic and costs tokens. This runner is therefore ENV-GATED (`RUN_LLM_EVALS=1`) so it never runs in the default unit suite or CI without opt-in. The deterministic protection lives in Tasks 1-6; this task locks the *model's* behavior and is run manually/periodically. Do NOT assert these in the default `jest` run.

- [x] **Step 1: Create the fixture set** — DONE

`__fixtures__/ee-classification-evals.ts` is created, exporting `EE_CLASSIFICATION_EVALS: ClassificationEvalCase[]` with `{ name, markdown, expect: { document_type, kind?, postable }, note? }`. It contains the VERBATIM prod OCR of both incident documents plus the guard cases:
- **incident order (Tellimus)** — real `139.md` verbatim → `{ document_type: 'order_confirmation', postable: false }`.
- **incident invoice (Arve)** — real `141.md` verbatim → `{ document_type: 'invoice', kind: 'new_expense', postable: true }`.
- **over-hardening guard** — an `Arve` that names its order number in the header → stays `{ document_type: 'invoice', postable: true }` (recall-collapse guard).
- **ettemaksuarve** → `proforma`, non-postable; **pakkumine/hinnapakkumine** → `proforma`, non-postable; **saateleht** → `{ document_type: 'other', kind: 'not_a_document', postable: false }`.

The fixture uses a local `EvalDocumentType` union so it compiles independently of Task 1's schema change.

- [ ] **Step 2: Create the gated runner**

Create `pass2-classification.eval.spec.ts`:
```typescript
import { EE_CLASSIFICATION_EVALS } from './__fixtures__/ee-classification-evals';

const run = process.env.RUN_LLM_EVALS === '1' ? describe : describe.skip;

run('Pass-2 classification evals (EE)', () => {
  // Boot the real Pass2AgentService with the EE plugin active (mirror the
  // integration wiring the app uses). For each fixture, call classify(markdown)
  // and assert result.document_type === expect.document_type (and kind when set).
  for (const c of EE_CLASSIFICATION_EVALS) {
    it(c.name, async () => {
      const out = await pass2.classify(c.markdown, {
        orgContext: { name: 'override OÜ', vatNumber: 'EE102983355', iban: null },
        directionHint: 'incoming',
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.result.document_type).toBe(c.expect.document_type);
        if (c.expect.kind) expect(out.result.kind).toBe(c.expect.kind);
      }
    });
  }
});
```

- [ ] **Step 3: Run gated (opt-in) to sanity-check**

Run: `cd packages/server && RUN_LLM_EVALS=1 npx jest src/ai/pass2-classification.eval.spec.ts`
Expected: the incident-order case classifies `order_confirmation` (non-postable), incident-invoice classifies `invoice`, and the over-hardening guards STAY `invoice`. Iterate the plugin hints (Task 3) until green. Without the env var, the suite is skipped.

- [ ] **Step 4: Confirm default suite skips it**

Run: `cd packages/server && npx jest src/ai/pass2-classification.eval.spec.ts`
Expected: 0 tests run (skipped) — proves CI stays deterministic.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ai/__fixtures__/ee-classification-evals.ts packages/server/src/ai/pass2-classification.eval.spec.ts
git commit -m "test(ai): add env-gated EE Pass-2 classification evals (Tellimus/Arve incident + over-hardening guards)"
```

---

## Final verification

- [ ] `cd packages/server && npx tsc --noEmit` — clean.
- [ ] `cd packages/server && npm test` — all deterministic tests pass; the LLM eval spec is skipped.
- [ ] `cd packages/server && npm run lint` — clean.
- [ ] Manual trace: re-feed the two incident markdowns through the pipeline (mocked LLM returning the real labels) and assert exactly ONE auto-post (the Arve) and ONE needs_triage (the Tellimus, `non_postable_document`) — even when the order arrives first.

## Self-review notes

- **Spec coverage:** Gap 1 (byte-hash-only dedup) → Tasks 5-6 add structured dedup. Gap 2 (order-vs-invoice) → Tasks 1-4 + 7. Gap 3 (no auto-post gate) → Task 6. Sequential-order failure (order posts first, blocks invoice) → resolved by Task 2 making the order non-postable, so the invoice always posts regardless of arrival order; Task 6 is the backstop for classification misses, parked per the user's "park + human" decision.
- **VAT-wobble** (10.00 vs 10.06) handled: gate matches on `gross_amount` only (Task 5).
- **Type consistency:** `document_type` values, `IntakeRoute` `'non_postable'`, `TriageReasonType` `'non_postable_document'`/`'possible_duplicate'`, and `DuplicateMatch` are defined in Tasks 1/2/5 and consumed by name in Tasks 2/4/6.
- **No auto-supersede** (user chose park+human) — the gate never reverses; it only parks.
