# Outgoing Invoices via Intake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the intake pipeline recognise a document that is the organization's OWN outgoing (sales) invoice and book it as a `SalesInvoice` draft (revenue, direction=sale) instead of an Expense — plus route bank-statement CSVs to bank-ingestion and park everything else.

**Architecture:** Intake becomes an extensible document router. After OCR, code deterministically matches the organization's own IBAN against IBANs printed on the document (the direction gate: our IBAN present → outgoing). The Pass-2 agent emits the document *type* (`invoice|receipt|bank_statement|credit_note|other`) plus structured "issuer" signals; code composes a confidence from those signals + the IBAN match. A new `classifyDocumentClass()` seam maps `(document_type, ibanMatched)` to one of four routes — `expense` (existing), `sales_invoice` (this feature), `bank_statement` (CSV → bank-ingestion), `unsupported` (→ needs_triage). The sales-invoice route mirrors the existing expense path: a `proposeSalesInvoiceDraft` step creates the invoice and runs the same `PostingPipelineService`, with a full customer-resolution mirror of the supplier flow.

**Tech Stack:** NestJS, Kysely (SQLite), Zod (`nestjs-zod`), Mastra (LLM agent), Vitest (server), React + Vitest/Testing-Library (web SPA). Monorepo: `packages/server`, `packages/web`.

**Test commands (run from worktree root):**
- Single server test file: `npm test --workspace=packages/server -- <path> -t "<name>"` (project uses Vitest; confirm with `cat packages/server/package.json | grep '"test"'`).
- Whole server suite: `npm test --workspace=packages/server`.
- Web: `npm test --workspace=packages/web -- <path>`.

> If a `--workspace` invocation is wrong for this repo, fall back to `cd packages/server && npx vitest run <path>`. Confirm the runner from `package.json` before Task 1.

---

## Resolved design decisions (from grilling — do not relitigate)

1. **Goal:** full booking path — outgoing invoices become `SalesInvoice` drafts via intake.
2. **Direction gate = IBAN, in code.** Our IBAN on the doc → outgoing. No IBAN match → incoming (existing expense path, unchanged). Name/VAT are NOT direction deciders — they are confidence signals only.
3. **Type vs direction split:** the agent emits `document_type`; code decides direction via the IBAN match. A bank statement also carries our IBAN, so `document_type` is the top discriminator, IBAN is the sub-discriminator within invoice/receipt.
4. **Confidence composed in code** from the agent's structured signals + the deterministic IBAN match; gated by the existing `auto_post_min_confidence` policy threshold.
5. **Routing seam + routes:** `DocumentClass {direction, doc_type}` + `classifyDocumentClass()` → dispatch to `expense | sales_invoice | bank_statement | unsupported`. Extensible, but only these routes in v1.
6. **Org IBAN storage:** single `organization.iban TEXT` column + a SettingsView field.
7. **New `kind: 'new_sales_invoice'`** on `TriageResult` (the agent's structured opinion; the *route* is decided by `classifyDocumentClass`, and kind-agrees-with-route is one confidence signal).
8. **Lifecycle after draft:** run the posting pipeline (post-or-hold per policy), mirror of expense. `sent_at` stays `null` (sending is orthogonal to booking).
9. **Customer resolution:** full mirror of supplier — `match` (existing) → auto-proceed; `create` (new) → park to needs_triage + manual resolve. No auto-create in v1.
10. **Idempotency/dedup:** new `sales_invoice.document_id` column; replay by it. `UNIQUE(invoice_number)` conflict (same number, different doc) → needs_triage as `duplicate`.
11. **Manual override:** extend the manual-classify flow so an operator can classify a `needs_triage` document as a sales invoice (covers low-confidence and IBAN-mismatch parks). Reclassifying an already-auto-booked expense is OUT of scope.
12. **Bank route:** `bank_statement` + CSV/text → `BankIngestionService.startImport(text, organization.iban)`. Non-CSV (PDF/image) → park to needs_triage (OCR-of-statements deferred).
13. **UI:** IBAN field in SettingsView; IntakeView shows the `Sales invoice #X` outcome (with link) and offers manual-classify-as-invoice in the triage form.

**Known accepted gap:** an outgoing invoice WITHOUT our IBAN on it is treated as an expense (no auto-detection). Operator recourse is manual reclassification only for parked (needs_triage) docs, not for already-booked expenses.

---

## File Structure

**Server — new files**
- `packages/server/src/database/migrations/0XX_add_organization_iban.ts` — add `organization.iban`.
- `packages/server/src/database/migrations/0YY_add_sales_invoice_document_id.ts` — add `sales_invoice.document_id`.
- `packages/server/src/intake/document-class.ts` — `DocumentClass` type + `classifyDocumentClass()` pure router.
- `packages/server/src/intake/document-class.spec.ts` — router unit tests.
- `packages/server/src/intake/iban-match.ts` — `extractIbans()` + `matchesOrgIban()` (reuses the reconciliation IBAN regex pattern).
- `packages/server/src/intake/iban-match.spec.ts` — IBAN matcher unit tests.
- `packages/server/src/intake/outgoing-confidence.ts` — `composeOutgoingConfidence()` pure function.
- `packages/server/src/intake/outgoing-confidence.spec.ts` — confidence-composition unit tests.

**Server — modified files**
- `packages/server/src/database/types.ts` — add `iban` to `organization`, `document_id` to `sales_invoice`.
- `packages/server/src/organization/types.ts` — `Organization.iban`, `UpdateOrganizationDto.iban`.
- `packages/server/src/organization/organization.service.ts` — persist/return `iban`.
- `packages/server/src/triage/types.ts` — extend `document_type` enum, add `kind: 'new_sales_invoice'`, `outgoing_signals`, `customer_proposal`; add `TriageOutcomeBankStatement`; wire `TriageOutcomeInvoice` into `route()`.
- `packages/server/src/ai/pass2-agent.service.ts` — accept `orgContext` + `directionHint`, thread into the agent prompt.
- `packages/server/src/ai/mastra.service.ts` — extend triage instructions with org identity + direction hint + type/signal guidance.
- `packages/server/src/ai/propose-draft.service.ts` — add `proposeSalesInvoiceDraft()`, `resolveCustomer()`, `findExistingInvoiceDraft()`, `manualClassifyInvoiceDraft()`.
- `packages/server/src/ai/intake-workflow.service.ts` — new routing via `classifyDocumentClass`; sales-invoice + bank-statement branches; invoice replay; manual-classify-as-invoice.
- `packages/server/src/triage/triage.service.ts` — map new outcomes; extend `manualClassify`.
- `packages/server/src/sales-invoices/sales-invoices.service.ts` — `customer_id`/`document_id` on create; `findByDocumentId()`.
- `packages/server/src/ai/ai.module.ts` / `intake`/`triage` modules — wire `OrganizationService`, `BankIngestionService`, `SalesInvoicesService` deps.

**Web — modified files**
- `packages/web/src/components/SettingsView.tsx` (+ test) — IBAN input.
- `packages/web/src/components/IntakeView.tsx` (+ test) — sales-invoice outcome + manual-classify-as-invoice.
- `packages/web/src/api.ts` — types for the new outcome + manual-classify-invoice payload.

---

## Phase 1 — Organization IBAN setting

*Outcome: the operator can store the org's own IBAN. Pure prerequisite for detection; independently shippable.*

### Task 1: Migration — add `organization.iban`

**Files:**
- Create: `packages/server/src/database/migrations/0XX_add_organization_iban.ts` (use the next free numeric prefix — run `ls packages/server/src/database/migrations | tail -5` to find it)
- Modify: `packages/server/src/database/types.ts` (the `organization` table interface)

- [ ] **Step 1: Find the next migration number**

Run: `ls packages/server/src/database/migrations | sort | tail -3`
Expected: highest existing prefix (e.g. `045_...`, `046_...`). Use the next integer, zero-padded to 3 digits, for `0XX`.

- [ ] **Step 2: Write the migration**

```typescript
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('organization')
    .addColumn('iban', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('organization').dropColumn('iban').execute();
}
```

- [ ] **Step 3: Add the column to the typed schema**

In `packages/server/src/database/types.ts`, find the `organization` table interface (search `organization`) and add, next to `vat_registration_number`:

```typescript
  iban: string | null;
```

- [ ] **Step 4: Run the migration test suite**

Run: `npm test --workspace=packages/server -- src/database`
Expected: PASS (migrations apply cleanly; the runner applies up/down).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/database/migrations packages/server/src/database/types.ts
git commit -m "feat(org): add organization.iban column"
```

### Task 2: OrganizationService persists/returns `iban`

**Files:**
- Modify: `packages/server/src/organization/types.ts`
- Modify: `packages/server/src/organization/organization.service.ts`
- Test: `packages/server/src/organization/organization.service.spec.ts` (create if absent; otherwise add a case)

- [ ] **Step 1: Write the failing test**

Add to the organization service spec (mirror the existing harness in that file; if none exists, create it copying the DB-setup pattern from `packages/server/src/sales-invoices/sales-invoices.service.spec.ts`):

```typescript
it('persists and returns the organization IBAN', async () => {
  const updated = await service.updateOrganization({ iban: 'EE382200221020145685' });
  expect(updated.iban).toBe('EE382200221020145685');

  const fetched = await service.getOrganization();
  expect(fetched.iban).toBe('EE382200221020145685');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=packages/server -- src/organization/organization.service.spec.ts -t "IBAN"`
Expected: FAIL — `iban` is `undefined` (not yet mapped/persisted).

- [ ] **Step 3: Add `iban` to the types**

In `packages/server/src/organization/types.ts`:

```typescript
export interface Organization {
  // ...existing fields...
  vat_registration_number: string | null;
  name: string | null;
  iban: string | null;
}

export interface UpdateOrganizationDto {
  // ...existing fields...
  vat_registration_number?: string | null;
  name?: string | null;
  iban?: string | null;
}
```

- [ ] **Step 4: Persist + map `iban` in the service**

In `packages/server/src/organization/organization.service.ts`:
- In `updateOrganization`, after the `name` line, add:

```typescript
    if (dto.iban !== undefined) updates.iban = dto.iban;
```

- In `mapRow`, add `iban` to the destructured params, its type (`iban: string | null;`), and the returned object:

```typescript
      iban,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/organization/organization.service.spec.ts -t "IBAN"`
Expected: PASS.

- [ ] **Step 6: Verify the DTO accepts `iban` (controller)**

Confirm the update DTO used by `organization.controller.ts` is derived from `UpdateOrganizationDto`/its Zod schema. Open `packages/server/src/organization/organization.controller.ts`; if it uses a `createZodDto(...)` schema, add `iban: z.string().nullable().optional()` to that schema. Run the controller spec:

Run: `npm test --workspace=packages/server -- src/organization/organization.controller`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/organization
git commit -m "feat(org): persist organization IBAN via settings"
```

### Task 3: SettingsView IBAN input (web)

**Files:**
- Modify: `packages/web/src/components/SettingsView.tsx`
- Modify: `packages/web/src/api.ts` (Organization type + update payload)
- Test: `packages/web/src/components/SettingsView.test.tsx`

- [ ] **Step 1: Read the current SettingsView + its test**

Run: `sed -n '1,120p' packages/web/src/components/SettingsView.tsx` and `sed -n '1,80p' packages/web/src/components/SettingsView.test.tsx` to learn the field pattern (how `vat_registration_number`/`name` inputs are rendered and saved).

- [ ] **Step 2: Write the failing test**

Mirror an existing field test. Add to `SettingsView.test.tsx`:

```typescript
it('renders the IBAN field and saves it', async () => {
  renderSettings({ iban: null }); // use the existing render helper / mock shape
  const input = screen.getByLabelText(/IBAN/i);
  fireEvent.change(input, { target: { value: 'EE382200221020145685' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() =>
    expect(mockUpdateOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ iban: 'EE382200221020145685' }),
    ),
  );
});
```

Adjust `renderSettings`/`mockUpdateOrganization` names to match the file's existing helpers.

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test --workspace=packages/web -- src/components/SettingsView.test.tsx -t "IBAN"`
Expected: FAIL — no `IBAN` label.

- [ ] **Step 4: Add the field**

In `packages/web/src/api.ts`, add `iban: string | null;` to the `Organization` type and to the update payload type. In `SettingsView.tsx`, add a labelled text input bound to the same form-state/save handler the other fields use (copy the `vat_registration_number` input block, rename to `iban`, label `IBAN`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --workspace=packages/web -- src/components/SettingsView.test.tsx -t "IBAN"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/SettingsView.tsx packages/web/src/components/SettingsView.test.tsx packages/web/src/api.ts
git commit -m "feat(web): add organization IBAN field to Settings"
```

---

## Phase 2 — Routing seam (detection + classification, no new booking yet)

*Outcome: deterministic IBAN matching, the agent emits document type + issuer signals, and a pure `classifyDocumentClass` router decides the route. Until Phase 3 the `sales_invoice` and `bank_statement` routes resolve to `needs_triage` (explicit reasons), so this phase is safe to ship: incoming expenses are unchanged.*

### Task 4: IBAN matcher (pure)

**Files:**
- Create: `packages/server/src/intake/iban-match.ts`
- Test: `packages/server/src/intake/iban-match.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { extractIbans, matchesOrgIban } from './iban-match';

describe('iban-match', () => {
  it('extracts and normalises IBANs from OCR markdown (spaces removed, upper-cased)', () => {
    const md = 'Pay to: ee38 2200 2210 2014 5685\nRef 123';
    expect(extractIbans(md)).toContain('EE382200221020145685');
  });

  it('matches the org IBAN ignoring spacing and case', () => {
    const md = 'Bank: EE38 2200 2210 2014 5685';
    expect(matchesOrgIban(md, 'ee382200221020145685')).toBe(true);
  });

  it('returns false when the org has no IBAN configured', () => {
    expect(matchesOrgIban('EE382200221020145685', null)).toBe(false);
  });

  it('returns false when no doc IBAN matches the org IBAN', () => {
    expect(matchesOrgIban('LV80BANK0000435195001', 'EE382200221020145685')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=packages/server -- src/intake/iban-match.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * IBAN matching for intake direction detection. Reuses the same IBAN shape the
 * reconciliation module recognises (see reconciliation.service.ts IBAN_PATTERN):
 * 2-letter country + 2 check digits + up to 30 alphanumerics. We normalise by
 * stripping spaces and upper-casing so OCR spacing/case never defeats a match.
 */
const IBAN_PATTERN = /[A-Z]{2}\d{2}[A-Z0-9]{4,30}/gi;

export function normaliseIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** All IBAN-shaped tokens found in free text, normalised and de-duplicated. */
export function extractIbans(text: string): string[] {
  // Strip spaces first so a spaced-out IBAN (OCR) is matched as one token.
  const compact = text.replace(/\s+/g, '');
  const found = compact.match(IBAN_PATTERN) ?? [];
  return Array.from(new Set(found.map((m) => m.toUpperCase())));
}

/**
 * True iff the organization's own IBAN appears anywhere in `text`. A null/empty
 * org IBAN never matches (feature inert until configured).
 */
export function matchesOrgIban(text: string, orgIban: string | null): boolean {
  if (!orgIban) return false;
  const target = normaliseIban(orgIban);
  if (!target) return false;
  return extractIbans(text).includes(target);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/intake/iban-match.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/intake/iban-match.ts packages/server/src/intake/iban-match.spec.ts
git commit -m "feat(intake): add deterministic org-IBAN matcher"
```

### Task 5: Extend the TriageResult schema (type, signals, customer proposal, new kind)

**Files:**
- Modify: `packages/server/src/triage/types.ts`
- Test: `packages/server/src/triage/types.spec.ts` (exists — add cases)

- [ ] **Step 1: Write the failing test**

Add to `packages/server/src/triage/types.spec.ts`:

```typescript
it('accepts kind new_sales_invoice with a customer_proposal and outgoing_signals', () => {
  const parsed = triageResultSchema.parse({
    kind: 'new_sales_invoice',
    gross_amount: 12200,
    vat_amount: 2200,
    tax_point_date: '2026-06-01',
    category: 'revenue',
    document_type: 'invoice',
    customer_proposal: { mode: 'match', match_entity_id: 7 },
    outgoing_signals: { org_name_is_issuer: true, org_vat_is_issuer: true },
  });
  expect(parsed.kind).toBe('new_sales_invoice');
  expect(parsed.customer_proposal).toEqual({ mode: 'match', match_entity_id: 7 });
  expect(parsed.outgoing_signals.has_buyer_block).toBe(false); // defaulted
});

it('defaults document_type to "other" and outgoing_signals to all-false', () => {
  const parsed = triageResultSchema.parse({
    kind: 'new_expense',
    gross_amount: 100,
    vat_amount: 0,
    tax_point_date: '2026-06-01',
    category: 'EXPENSE_OTHER',
  });
  expect(parsed.document_type).toBe('other');
  expect(parsed.outgoing_signals).toEqual({
    org_name_is_issuer: false,
    org_vat_is_issuer: false,
    has_buyer_block: false,
    self_identifies_as_invoice: false,
  });
});
```

> NOTE: this CHANGES the `document_type` default from `'unknown'` to `'other'` and widens the enum. Search the repo for `document_type` and `'unknown'` usages in tests and fix any that assert the old default in this same task (`grep -rn "document_type" packages/server/src`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=packages/server -- src/triage/types.spec.ts -t "new_sales_invoice"`
Expected: FAIL — `new_sales_invoice` not in the enum; `customer_proposal`/`outgoing_signals` unknown.

- [ ] **Step 3: Extend the schema**

In `packages/server/src/triage/types.ts`:

```typescript
// Reuse the supplier discriminated union shape for the customer counterparty —
// same match/create semantics (ADR-0014). A 'create' proposal parks to
// needs_triage in v1 exactly like supplier 'create'.
export const customerProposalSchema = supplierProposalSchema; // identical shape
export type CustomerProposal = SupplierProposal;

// Structured "is this OUR outgoing invoice?" signals the agent emits. They are
// confidence inputs ONLY — direction is decided in code from the IBAN match.
export const outgoingSignalsSchema = z.object({
  org_name_is_issuer: z.boolean().default(false),
  org_vat_is_issuer: z.boolean().default(false),
  has_buyer_block: z.boolean().default(false),
  self_identifies_as_invoice: z.boolean().default(false),
});
export type OutgoingSignals = z.infer<typeof outgoingSignalsSchema>;
```

Then change `triageResultSchema`:
- `kind`: add `'new_sales_invoice'` → `z.enum(['new_expense', 'new_sales_invoice', 'correction', 'duplicate', 'unknown'])`.
- Replace `document_type`: `z.enum(['receipt', 'invoice', 'bank_statement', 'credit_note', 'other']).default('other')`.
- Add `customer_proposal: customerProposalSchema.optional(),`.
- Add `outgoing_signals: outgoingSignalsSchema.default({}),` (Zod fills each boolean default from the empty object).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/triage/types.spec.ts`
Expected: PASS (and the `document_type` migration cases you fixed in Step 1).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/triage/types.ts packages/server/src/triage/types.spec.ts
git commit -m "feat(triage): extend TriageResult with sales-invoice kind, doc types and outgoing signals"
```

### Task 6: `composeOutgoingConfidence` (pure)

**Files:**
- Create: `packages/server/src/intake/outgoing-confidence.ts`
- Test: `packages/server/src/intake/outgoing-confidence.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { composeOutgoingConfidence } from './outgoing-confidence';

const NONE = {
  org_name_is_issuer: false,
  org_vat_is_issuer: false,
  has_buyer_block: false,
  self_identifies_as_invoice: false,
};

describe('composeOutgoingConfidence', () => {
  it('is 0 when the org IBAN did not match (not an outgoing candidate)', () => {
    expect(composeOutgoingConfidence(false, { ...NONE, org_name_is_issuer: true })).toBe(0);
  });

  it('gives the IBAN-match base even with no corroborating signals', () => {
    expect(composeOutgoingConfidence(true, NONE)).toBeCloseTo(0.5);
  });

  it('reaches 1.0 when IBAN matched and every signal is true', () => {
    expect(
      composeOutgoingConfidence(true, {
        org_name_is_issuer: true,
        org_vat_is_issuer: true,
        has_buyer_block: true,
        self_identifies_as_invoice: true,
      }),
    ).toBeCloseTo(1.0);
  });

  it('adds issuer identity weight (name + VAT) above the base', () => {
    expect(composeOutgoingConfidence(true, { ...NONE, org_name_is_issuer: true, org_vat_is_issuer: true }))
      .toBeCloseTo(0.9);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=packages/server -- src/intake/outgoing-confidence.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { OutgoingSignals } from '../triage/types';

/**
 * Compose a 0..1 confidence that a document is OUR outgoing invoice.
 *
 * The IBAN match is the gate AND the dominant signal: if our IBAN is not on the
 * document this is not an outgoing candidate at all (returns 0). When it is, we
 * start at a 0.5 base and add corroborating weight from the agent's structured
 * issuer signals. Weights sum to 1.0 when everything agrees.
 */
const WEIGHTS = {
  base: 0.5, // org IBAN present on the document
  org_name_is_issuer: 0.2,
  org_vat_is_issuer: 0.2,
  has_buyer_block: 0.05,
  self_identifies_as_invoice: 0.05,
} as const;

export function composeOutgoingConfidence(
  ibanMatched: boolean,
  signals: OutgoingSignals,
): number {
  if (!ibanMatched) return 0;
  let score = WEIGHTS.base;
  if (signals.org_name_is_issuer) score += WEIGHTS.org_name_is_issuer;
  if (signals.org_vat_is_issuer) score += WEIGHTS.org_vat_is_issuer;
  if (signals.has_buyer_block) score += WEIGHTS.has_buyer_block;
  if (signals.self_identifies_as_invoice) score += WEIGHTS.self_identifies_as_invoice;
  return Math.min(1, score);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/intake/outgoing-confidence.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/intake/outgoing-confidence.ts packages/server/src/intake/outgoing-confidence.spec.ts
git commit -m "feat(intake): add outgoing-invoice confidence composition"
```

### Task 7: `classifyDocumentClass` router (pure)

**Files:**
- Create: `packages/server/src/intake/document-class.ts`
- Test: `packages/server/src/intake/document-class.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { classifyDocumentClass } from './document-class';

describe('classifyDocumentClass', () => {
  it('routes an invoice/receipt to sales_invoice when our IBAN matched', () => {
    expect(classifyDocumentClass({ documentType: 'invoice', ibanMatched: true }))
      .toEqual({ route: 'sales_invoice', direction: 'outgoing', docType: 'invoice' });
    expect(classifyDocumentClass({ documentType: 'receipt', ibanMatched: true }).route)
      .toBe('sales_invoice');
  });

  it('routes an invoice/receipt to expense when our IBAN did NOT match', () => {
    expect(classifyDocumentClass({ documentType: 'invoice', ibanMatched: false }))
      .toEqual({ route: 'expense', direction: 'incoming', docType: 'invoice' });
  });

  it('routes a bank statement to bank_statement regardless of IBAN', () => {
    expect(classifyDocumentClass({ documentType: 'bank_statement', ibanMatched: true }).route)
      .toBe('bank_statement');
    expect(classifyDocumentClass({ documentType: 'bank_statement', ibanMatched: false }).route)
      .toBe('bank_statement');
  });

  it('routes credit_note and other to unsupported in v1', () => {
    expect(classifyDocumentClass({ documentType: 'credit_note', ibanMatched: true }).route)
      .toBe('unsupported');
    expect(classifyDocumentClass({ documentType: 'other', ibanMatched: false }).route)
      .toBe('unsupported');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=packages/server -- src/intake/document-class.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
export type DocumentType =
  | 'invoice'
  | 'receipt'
  | 'bank_statement'
  | 'credit_note'
  | 'other';

export type IntakeRoute = 'expense' | 'sales_invoice' | 'bank_statement' | 'unsupported';

export interface DocumentClass {
  route: IntakeRoute;
  direction: 'incoming' | 'outgoing' | 'none';
  docType: DocumentType;
}

/**
 * Pure intake router. The document TYPE (from the agent) is the top
 * discriminator; the org-IBAN match (decided in code) is the direction
 * sub-discriminator within invoice/receipt. A bank statement also carries our
 * IBAN, so it is matched on type BEFORE the IBAN gate is consulted. Unknown /
 * not-yet-supported classes route to 'unsupported' (the workflow parks them).
 */
export function classifyDocumentClass(input: {
  documentType: DocumentType;
  ibanMatched: boolean;
}): DocumentClass {
  const { documentType, ibanMatched } = input;

  if (documentType === 'bank_statement') {
    return { route: 'bank_statement', direction: 'none', docType: documentType };
  }

  if (documentType === 'invoice' || documentType === 'receipt') {
    return ibanMatched
      ? { route: 'sales_invoice', direction: 'outgoing', docType: documentType }
      : { route: 'expense', direction: 'incoming', docType: documentType };
  }

  // credit_note + other → not booked automatically in v1.
  return { route: 'unsupported', direction: 'none', docType: documentType };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/intake/document-class.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/intake/document-class.ts packages/server/src/intake/document-class.spec.ts
git commit -m "feat(intake): add classifyDocumentClass router seam"
```

### Task 8: Thread org context + direction hint into Pass 2

**Files:**
- Modify: `packages/server/src/ai/pass2-agent.service.ts`
- Modify: `packages/server/src/ai/mastra.service.ts` (prompt building) and `packages/server/src/ai/triage-instructions.ts`
- Test: `packages/server/src/ai/pass2-agent.service.spec.ts`

- [ ] **Step 1: Read the current agent build + instructions**

Run: `sed -n '1,200p' packages/server/src/ai/mastra.service.ts` — locate `buildTriageAgent()` and how the base instructions string is assembled (it composes `withCategoryList(...)`). The org context must be appended to that instructions string.

- [ ] **Step 2: Write the failing test**

In `pass2-agent.service.spec.ts`, add a case asserting the org context reaches the prompt. Mirror the existing mock of `mastraService.buildTriageAgent`. Assert that when `classify(markdown, { orgContext, directionHint })` is called, the built agent's instructions include the org IBAN/name and the direction hint:

```typescript
it('passes org identity and direction hint into the agent build', async () => {
  const generate = vi.fn().mockResolvedValue({ object: validTriageResult });
  const buildTriageAgent = vi.fn().mockResolvedValue({ generate });
  (service as unknown as { mastraService: { buildTriageAgent: typeof buildTriageAgent } })
    .mastraService.buildTriageAgent = buildTriageAgent;

  await service.classify('md', {
    orgContext: { iban: 'EE38...', name: 'Acme OÜ', vatNumber: 'EE100200300' },
    directionHint: 'outgoing',
  });

  expect(buildTriageAgent).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Acme OÜ', directionHint: 'outgoing' }),
  );
});
```

Adjust to the real test harness in that file (it may construct the service via the Nest testing module). The key assertion: org context + hint flow to `buildTriageAgent`.

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test --workspace=packages/server -- src/ai/pass2-agent.service.spec.ts -t "org identity"`
Expected: FAIL — `classify` ignores the second argument.

- [ ] **Step 4: Extend `classify` signature + thread through**

In `pass2-agent.service.ts`, change the signature to:

```typescript
export interface Pass2Context {
  orgContext: { iban: string | null; name: string | null; vatNumber: string | null };
  directionHint: 'incoming' | 'outgoing';
}

async classify(markdown: string, ctx: Pass2Context): Promise<Pass2Outcome> {
  // ...
  agent = await this.mastraService.buildTriageAgent({
    name: ctx.orgContext.name,
    vatNumber: ctx.orgContext.vatNumber,
    iban: ctx.orgContext.iban,
    directionHint: ctx.directionHint,
  });
  // ...rest unchanged...
}
```

In `mastra.service.ts`, change `buildTriageAgent()` to accept the optional org context and append a block to the instructions (extend `triage-instructions.ts` with a helper):

```typescript
// triage-instructions.ts
export function withOrgIdentity(
  instructions: string,
  org: { name: string | null; vatNumber: string | null; iban: string | null; directionHint: 'incoming' | 'outgoing' },
): string {
  return (
    instructions +
    `\n\nYOUR ORGANIZATION: name="${org.name ?? 'unknown'}", VAT="${org.vatNumber ?? 'unknown'}", IBAN="${org.iban ?? 'unknown'}".` +
    `\nThis document has been pre-classified as direction="${org.directionHint}" (decided by matching your IBAN against the document — trust it).` +
    `\nReport \`document_type\` accurately (invoice | receipt | bank_statement | credit_note | other).` +
    `\nWhen direction is "outgoing", set kind="new_sales_invoice", extract the CUSTOMER (buyer) into \`customer_proposal\` and the document's invoice number into \`supplier_invoice_number\`, and set the \`outgoing_signals\` booleans truthfully (does YOUR org name / VAT appear as the issuer/seller? is there a distinct buyer block? does the document call itself an invoice?).` +
    `\nWhen direction is "incoming", behave as before: kind="new_expense" with a \`supplier_proposal\`.`
  );
}
```

Then in `buildTriageAgent`, compose `withOrgIdentity(withCategoryList(base, categories), org)` when org context is provided.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/ai/pass2-agent.service.spec.ts`
Expected: PASS (fix any other callers of `classify` to pass the new context — the only production caller is `IntakeWorkflowService`, updated in Task 9; the `debug()` path also calls `classify` — give it `directionHint: 'incoming'` and the real org context).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ai/pass2-agent.service.ts packages/server/src/ai/mastra.service.ts packages/server/src/ai/triage-instructions.ts packages/server/src/ai/pass2-agent.service.spec.ts
git commit -m "feat(ai): thread org identity + direction hint into Pass 2"
```

### Task 9: Workflow routing via `classifyDocumentClass` (sales/bank routes still park)

**Files:**
- Modify: `packages/server/src/ai/intake-workflow.service.ts`
- Modify: `packages/server/src/ai/ai.module.ts` (inject `OrganizationService`)
- Test: `packages/server/src/ai/intake-workflow.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

Add cases (mirror the existing mock setup in the spec — it mocks `ocrService`, `pass2Agent`, `proposeDraft`, `documents`, etc.; add an `organizationService` mock returning `{ iban: 'EE38...' }`):

```typescript
it('routes an incoming invoice (no IBAN match) to the existing expense path', async () => {
  organizationService.getOrganization.mockResolvedValue({ iban: 'EE382200221020145685' });
  ocrService.transcribe.mockResolvedValue({ ok: true, markdown: 'supplier doc, pay to DE89...' });
  pass2Agent.classify.mockResolvedValue({ ok: true, result: { ...expenseResult, document_type: 'invoice' } });
  const res = await service.process(1);
  expect(res.status).toBe('draft_proposed');
  expect(proposeDraft.proposeDraft).toHaveBeenCalled(); // expense path unchanged
});

it('parks an outgoing invoice in Phase 2 (sales route not yet wired)', async () => {
  organizationService.getOrganization.mockResolvedValue({ iban: 'EE382200221020145685' });
  ocrService.transcribe.mockResolvedValue({ ok: true, markdown: 'Pay to EE38 2200 2210 2014 5685' });
  pass2Agent.classify.mockResolvedValue({ ok: true, result: { ...salesResult, document_type: 'invoice' } });
  const res = await service.process(2);
  expect(res.status).toBe('needs_triage');
  expect(res.reason).toMatch(/sales invoice/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=packages/server -- src/ai/intake-workflow.service.spec.ts -t "outgoing invoice"`
Expected: FAIL — current `process` switches on `kind` only, no IBAN/route logic.

- [ ] **Step 3: Refactor `process()` routing**

Inject `OrganizationService` into the constructor. Replace the body between "Pass 2 complete" and the `switch (triageResult.kind)` with route computation, and replace the switch with a route switch:

```typescript
const org = await this.organizationService.getOrganization();
const ibanMatched = matchesOrgIban(markdown, org.iban);
const documentClass = classifyDocumentClass({
  documentType: triageResult.document_type,
  ibanMatched,
});

switch (documentClass.route) {
  case 'expense':
    return this.routeExpense(documentId, triageResult); // existing new_expense logic, extracted verbatim
  case 'sales_invoice':
    // Phase 2: not yet wired — park with an explicit reason (replaced in Task 11).
    return this.routeNeedsTriage(
      documentId,
      'Detected an outgoing sales invoice (our IBAN on the document); sales-invoice intake not yet enabled',
    );
  case 'bank_statement':
    // Phase 2: not yet wired — park (replaced in Task 12).
    return this.routeNeedsTriage(documentId, 'Detected a bank statement; bank-statement intake not yet enabled');
  case 'unsupported':
    return this.routeNeedsTriage(
      documentId,
      `Document type '${documentClass.docType}' is not supported by intake yet`,
    );
}
```

Extract the existing `new_expense`/`unknown`/`correction`/`duplicate` switch into a private `routeExpense(documentId, triageResult)` that preserves the current behaviour EXACTLY (confidence gate, supplier-unresolved, category-unresolved). The non-`new_expense` kinds keep their current `needs_triage` reasons. Import `matchesOrgIban` and `classifyDocumentClass` from `../intake/...`. Update the `pass2Agent.classify(markdown, ...)` call to pass the new `Pass2Context` (orgContext from `org`, directionHint from `ibanMatched ? 'outgoing' : 'incoming'`) — compute `ibanMatched` BEFORE the classify call so the hint is available.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/ai/intake-workflow.service.spec.ts`
Expected: PASS (all existing expense cases still green + the two new cases).

- [ ] **Step 5: Wire the module dependency**

In `ai.module.ts`, ensure `OrganizationModule` is imported (so `OrganizationService` is injectable). Run the whole server suite to catch DI wiring:

Run: `npm test --workspace=packages/server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ai/intake-workflow.service.ts packages/server/src/ai/ai.module.ts packages/server/src/ai/intake-workflow.service.spec.ts
git commit -m "feat(intake): route documents via classifyDocumentClass (sales/bank park for now)"
```

---

## Phase 3 — Sales-invoice intake path

*Outcome: an outgoing invoice is booked as a SalesInvoice draft and run through the posting pipeline, with full customer resolution and idempotent replay.*

### Task 10: Migration + service support for `sales_invoice.document_id` and customer linkage

**Files:**
- Create: `packages/server/src/database/migrations/0YY_add_sales_invoice_document_id.ts`
- Modify: `packages/server/src/database/types.ts` (`sales_invoice` interface)
- Modify: `packages/server/src/sales-invoices/sales-invoices.service.ts` + `types.ts`
- Test: `packages/server/src/sales-invoices/sales-invoices.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('stores document_id on create and finds the invoice by document_id', async () => {
  const inv = await service.createInvoice({
    invoice_number: 'INV-1', gross_amount: 12200, vat_amount: 2200,
    currency: 'EUR', tax_point_date: '2026-06-01', customer_id: null,
    document_id: 42,
  } as any);
  expect(inv.document_id).toBe(42);

  const found = await service.findByDocumentId(42);
  expect(found?.id).toBe(inv.id);
  expect(await service.findByDocumentId(999)).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=packages/server -- src/sales-invoices/sales-invoices.service.spec.ts -t "document_id"`
Expected: FAIL — column/field/method missing.

- [ ] **Step 3: Write the migration**

```typescript
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('sales_invoice')
    .addColumn('document_id', 'integer', (col) => col.references('document.id'))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('sales_invoice').dropColumn('document_id').execute();
}
```

Add `document_id: number | null;` to the `sales_invoice` interface in `database/types.ts`.

- [ ] **Step 4: Add `document_id` to the DTO/type + service**

In `sales-invoices/types.ts`: add `document_id: number | null;` to `SalesInvoice`, and `document_id: z.number().int().nullable().optional(),` to `createSalesInvoiceSchema`.

In `sales-invoices.service.ts`:
- In `createInvoice`, add `document_id: dto.document_id ?? null,` to the inserted values.
- In `mapRow`, add `document_id` to the param type and returned object.
- Add the finder:

```typescript
async findByDocumentId(documentId: number): Promise<SalesInvoice | undefined> {
  const row = await this.db
    .selectFrom('sales_invoice')
    .selectAll()
    .where('document_id', '=', documentId)
    .orderBy('id', 'asc')
    .executeTakeFirst();
  return row ? this.mapRow(row) : undefined;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/sales-invoices/sales-invoices.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/database packages/server/src/sales-invoices
git commit -m "feat(sales-invoices): link invoices to source document + find by document_id"
```

### Task 11: `proposeSalesInvoiceDraft` + `resolveCustomer` + invoice replay

**Files:**
- Modify: `packages/server/src/ai/propose-draft.service.ts`
- Modify: `packages/server/src/ai/intake-workflow.service.ts` (replace the Phase-2 park with the real route)
- Modify: `packages/server/src/ai/ai.module.ts` (inject `SalesInvoicesService`, `OrganizationService` already there)
- Test: `packages/server/src/ai/propose-draft.service.spec.ts`, `packages/server/src/ai/intake-workflow.service.spec.ts`

- [ ] **Step 1: Write the failing test (propose-draft)**

```typescript
it('creates a sales invoice draft and runs the posting pipeline (match customer)', async () => {
  entitiesService.findById.mockResolvedValue({ id: 7, role: 'customer', country: 'EE' });
  salesInvoicesService.createInvoice.mockResolvedValue({ id: 55, customer_id: 7 });
  const out = await service.proposeSalesInvoiceDraft(
    { ...salesTriageResult, customer_proposal: { mode: 'match', match_entity_id: 7 } },
    /* documentId */ 42,
  );
  expect(out.outcome).toBe('draft');
  expect(out.invoiceId).toBe(55);
  expect(salesInvoicesService.createInvoice).toHaveBeenCalledWith(
    expect.objectContaining({ document_id: 42, customer_id: 7, invoice_number: salesTriageResult.supplier_invoice_number }),
  );
  expect(postingPipelineService.runPipeline).toHaveBeenCalledWith(
    expect.objectContaining({ businessObjectType: 'sales_invoice', category: 'revenue' }),
  );
});

it('returns customer-unresolved for a create proposal (parks, no draft)', async () => {
  const out = await service.proposeSalesInvoiceDraft(
    { ...salesTriageResult, customer_proposal: { mode: 'create', create_name: 'X', create_country: 'EE', create_registration_key: null, create_email: null, create_phone: null, create_address: null } },
    42,
  );
  expect(out.outcome).toBe('customer-unresolved');
  expect(salesInvoicesService.createInvoice).not.toHaveBeenCalled();
});

it('returns invoice-number-missing when supplier_invoice_number is null', async () => {
  const out = await service.proposeSalesInvoiceDraft(
    { ...salesTriageResult, supplier_invoice_number: null, customer_proposal: { mode: 'match', match_entity_id: 7 } },
    42,
  );
  expect(out.outcome).toBe('invoice-number-missing');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=packages/server -- src/ai/propose-draft.service.spec.ts -t "sales invoice"`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement `proposeSalesInvoiceDraft` + helpers**

Add result types near the other outcome interfaces in `propose-draft.service.ts`:

```typescript
export interface ProposeSalesInvoiceResult {
  outcome: 'draft';
  invoiceId: number;
  pipelineResult: PipelineRunResult;
}
export interface CustomerUnresolvedResult { outcome: 'customer-unresolved'; reason: string; }
export interface InvoiceNumberMissingResult { outcome: 'invoice-number-missing'; reason: string; }
export type ProposeSalesInvoiceOutcome =
  | ProposeSalesInvoiceResult
  | CustomerUnresolvedResult
  | InvoiceNumberMissingResult;

export interface InvoiceDraftReplayResult {
  outcome: 'draft';
  invoiceId: number;
  pipelineResult: PipelineRunResult | ReplayedPipelineResult;
}
```

Inject `SalesInvoicesService` into the constructor. Add:

```typescript
async proposeSalesInvoiceDraft(
  triageResult: TriageResult,
  documentId: number,
  customerId?: number | null,
): Promise<ProposeSalesInvoiceOutcome> {
  // The document's printed invoice number IS our number for an outgoing invoice.
  const invoiceNumber = triageResult.supplier_invoice_number;
  if (!invoiceNumber) {
    return { outcome: 'invoice-number-missing', reason: 'no invoice number found on the document' };
  }

  // Customer resolution mirrors the supplier flow: match → id; create → park.
  const resolved = await this.resolveCustomer(triageResult.customer_proposal, customerId);
  if (resolved.outcome === 'customer-unresolved') return resolved;

  const invoice = await this.salesInvoicesService.createInvoice({
    document_id: documentId,
    customer_id: resolved.customerId,
    invoice_number: invoiceNumber,
    gross_amount: triageResult.gross_amount,
    vat_amount: triageResult.vat_amount,
    currency: triageResult.currency,
    tax_point_date: triageResult.tax_point_date,
    document_vat_marking: triageResult.document_vat_marking,
  });

  const pipelineResult = await this.postingPipelineService.runPipeline({
    businessObjectId: invoice.id,
    businessObjectType: 'sales_invoice',
    draftGenerator: () => this.salesInvoicesService.generateDraftVoucher(invoice.id),
    category: 'revenue',
    refetch: () => this.salesInvoicesService.getInvoiceById(invoice.id),
  });

  return { outcome: 'draft', invoiceId: invoice.id, pipelineResult };
}

private async resolveCustomer(
  proposal: CustomerProposal | undefined,
  explicitCustomerId?: number | null,
): Promise<{ outcome: 'resolved'; customerId: number | null } | CustomerUnresolvedResult> {
  if (explicitCustomerId != null) return { outcome: 'resolved', customerId: explicitCustomerId };
  if (!proposal) return { outcome: 'resolved', customerId: null };
  if (proposal.mode === 'match') return { outcome: 'resolved', customerId: proposal.match_entity_id };
  // mode 'create' → park (no auto-create in v1, mirror of supplier).
  return {
    outcome: 'customer-unresolved',
    reason: 'customer must be created/selected by an operator before this outgoing invoice can be booked',
  };
}

async findExistingInvoiceDraft(documentId: number): Promise<InvoiceDraftReplayResult | undefined> {
  const invoice = await this.salesInvoicesService.findByDocumentId(documentId);
  if (!invoice) return undefined;
  return { outcome: 'draft', invoiceId: invoice.id, pipelineResult: { replayed: true } };
}
```

> If `createInvoice` throws a UNIQUE-violation on `invoice_number` (same number, different document), `proposeSalesInvoiceDraft` must surface it as a distinct outcome so the workflow parks it as a duplicate. Wrap the `createInvoice` call in try/catch reusing the controller's `isUniqueViolation` check (extract that helper to `sales-invoices.service.ts` and import it), returning `{ outcome: 'duplicate-number', reason: ... }`. Add `DuplicateNumberResult` to the union and a test asserting it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/ai/propose-draft.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire the real sales route in the workflow (replace Phase-2 park)**

In `intake-workflow.service.ts`, replace the `case 'sales_invoice'` park (from Task 9) with a real `routeSalesInvoice(documentId, triageResult, ibanMatched)` private method:

```typescript
private async routeSalesInvoice(documentId: number, triageResult: TriageResult, ibanMatched: boolean): Promise<IntakeWorkflowResult> {
  const threshold = (await this.policyService.getConfig()).auto_post_min_confidence;
  const confidence = composeOutgoingConfidence(ibanMatched, triageResult.outgoing_signals);
  if (confidence < threshold) {
    return this.routeNeedsTriage(documentId, `Outgoing-invoice confidence ${confidence} below threshold ${threshold}`);
  }
  const outcome = await this.proposeDraft.proposeSalesInvoiceDraft(triageResult, documentId);
  if (outcome.outcome === 'customer-unresolved') {
    await this.documents.setPendingTriageResult(documentId, triageResult);
    return this.routeNeedsTriage(documentId, outcome.reason);
  }
  if (outcome.outcome === 'invoice-number-missing' || outcome.outcome === 'duplicate-number') {
    return this.routeNeedsTriage(documentId, outcome.reason);
  }
  await this.documents.setStatus(documentId, 'triaged');
  return { status: 'draft_proposed', salesInvoice: { invoiceId: outcome.invoiceId } } as IntakeWorkflowResult;
}
```

Extend the `DraftProposedOutcome`/`IntakeWorkflowResult` union to carry an optional sales-invoice draft (add a `DraftProposedInvoiceOutcome { status: 'draft_proposed_invoice'; invoiceId: number; pipelineResult }`), and add an invoice branch to the idempotency replay at the top of `process()` (when `status === 'triaged'|'processed'`, also try `proposeDraft.findExistingInvoiceDraft(documentId)`).

- [ ] **Step 6: Add workflow tests for the real sales route**

```typescript
it('books an outgoing invoice as a sales invoice draft above threshold', async () => {
  organizationService.getOrganization.mockResolvedValue({ iban: 'EE382200221020145685' });
  policyService.getConfig.mockResolvedValue({ auto_post_min_confidence: 0.8 });
  ocrService.transcribe.mockResolvedValue({ ok: true, markdown: 'Pay to EE38 2200 2210 2014 5685' });
  pass2Agent.classify.mockResolvedValue({ ok: true, result: {
    ...salesResult, document_type: 'invoice', supplier_invoice_number: 'INV-9',
    customer_proposal: { mode: 'match', match_entity_id: 7 },
    outgoing_signals: { org_name_is_issuer: true, org_vat_is_issuer: true, has_buyer_block: true, self_identifies_as_invoice: true },
  }});
  proposeDraft.proposeSalesInvoiceDraft.mockResolvedValue({ outcome: 'draft', invoiceId: 55, pipelineResult: {} });
  const res = await service.process(3);
  expect(res.status).toBe('draft_proposed_invoice');
  expect(res.invoiceId).toBe(55);
});

it('parks an outgoing invoice with a create-customer proposal', async () => {
  // ...same setup but proposeSalesInvoiceDraft resolves customer-unresolved...
  proposeDraft.proposeSalesInvoiceDraft.mockResolvedValue({ outcome: 'customer-unresolved', reason: 'create customer' });
  const res = await service.process(4);
  expect(res.status).toBe('needs_triage');
  expect(documents.setPendingTriageResult).toHaveBeenCalled();
});
```

- [ ] **Step 7: Run workflow + module wiring**

Run: `npm test --workspace=packages/server -- src/ai`
Then: `npm test --workspace=packages/server` (catches DI: `SalesInvoicesService` must be importable in `ai.module.ts` — import `SalesInvoicesModule` and ensure it exports the service, which it already does).
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/ai packages/server/src/sales-invoices
git commit -m "feat(intake): book outgoing invoices as sales-invoice drafts via the posting pipeline"
```

### Task 12: Map the outcome to the HTTP layer (`TriageOutcomeInvoice`)

**Files:**
- Modify: `packages/server/src/triage/triage.service.ts`
- Test: `packages/server/src/triage/triage.integration.spec.ts` (or `triage.service` unit spec)

- [ ] **Step 1: Write the failing test**

In the triage spec, assert `route()` returns the invoice outcome shape when the workflow returns a `draft_proposed_invoice`:

```typescript
it('maps a sales-invoice workflow outcome to a TriageOutcomeInvoice', async () => {
  workflow.process.mockResolvedValue({ status: 'draft_proposed_invoice', invoiceId: 55 });
  const out = await service.route(1);
  expect(out).toEqual({ kind: 'invoice', document_id: 1, invoice_id: 55 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=packages/server -- src/triage -t "TriageOutcomeInvoice"`
Expected: FAIL — `route()` only maps `draft_proposed` (expense) and `needs_triage`.

- [ ] **Step 3: Map the new status in `route()`**

In `triage.service.ts` `route()`, before the expense `draft_proposed` mapping, add:

```typescript
if (result.status === 'draft_proposed_invoice') {
  return { kind: 'invoice', document_id: documentId, invoice_id: result.invoiceId };
}
```

(`TriageOutcomeInvoice` already exists in `triage/types.ts` — no type change needed.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace=packages/server -- src/triage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/triage
git commit -m "feat(triage): surface sales-invoice outcome from route()"
```

---

## Phase 4 — Bank-statement CSV route

*Outcome: a CSV bank statement dropped into intake is handed to bank-ingestion; a non-CSV statement parks.*

### Task 13: Bank-statement route in the workflow

**Files:**
- Modify: `packages/server/src/ai/intake-workflow.service.ts` (replace the Phase-2 bank park)
- Modify: `packages/server/src/ai/ai.module.ts` (inject `BankIngestionService`, `DocumentsService` already injected)
- Test: `packages/server/src/ai/intake-workflow.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
it('hands a CSV bank statement to bank-ingestion', async () => {
  organizationService.getOrganization.mockResolvedValue({ iban: 'EE382200221020145685' });
  ocrService.transcribe.mockResolvedValue({ ok: true, markdown: 'date,amount,desc\n2026-06-01,100,x' });
  documents.getById.mockResolvedValue({ id: 9, mime_type: 'text/csv', filename: 'stmt.csv', status: 'pending' });
  documents.getFile.mockResolvedValue({ buffer: Buffer.from('date,amount,desc\n2026-06-01,100,x'), filename: 'stmt.csv', mimeType: 'text/csv' });
  pass2Agent.classify.mockResolvedValue({ ok: true, result: { ...expenseResult, document_type: 'bank_statement' } });
  bankIngestion.startImport.mockResolvedValue({ jobId: 3 });
  const res = await service.process(9);
  expect(bankIngestion.startImport).toHaveBeenCalledWith(expect.any(String), 'EE382200221020145685');
  expect(res.status).toBe('bank_import_started');
});

it('parks a non-CSV (PDF) bank statement', async () => {
  organizationService.getOrganization.mockResolvedValue({ iban: 'EE382200221020145685' });
  documents.getById.mockResolvedValue({ id: 10, mime_type: 'application/pdf', filename: 's.pdf', status: 'pending' });
  ocrService.transcribe.mockResolvedValue({ ok: true, markdown: 'Statement ...' });
  pass2Agent.classify.mockResolvedValue({ ok: true, result: { ...expenseResult, document_type: 'bank_statement' } });
  const res = await service.process(10);
  expect(res.status).toBe('needs_triage');
  expect(res.reason).toMatch(/CSV/i);
  expect(bankIngestion.startImport).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=packages/server -- src/ai/intake-workflow.service.spec.ts -t "bank"`
Expected: FAIL — bank route still parks (Phase 2).

- [ ] **Step 3: Implement `routeBankStatement`**

Inject `BankIngestionService`. Add a `bank_import_started` outcome to `IntakeWorkflowResult`. Replace the bank park:

```typescript
private async routeBankStatement(documentId: number): Promise<IntakeWorkflowResult> {
  const doc = await this.documents.getById(documentId);
  const isCsv = doc.mime_type === 'text/csv' || doc.filename.toLowerCase().endsWith('.csv');
  if (!isCsv) {
    return this.routeNeedsTriage(documentId, 'Bank statement is not a CSV; PDF/image statements are not yet supported by intake — import it via the bank screen');
  }
  const file = await this.documents.getFile(documentId);
  const org = await this.organizationService.getOrganization();
  const { jobId } = await this.bankIngestion.startImport(file.buffer.toString('utf-8'), org.iban ?? '');
  await this.documents.setStatus(documentId, 'processed');
  return { status: 'bank_import_started', jobId } as IntakeWorkflowResult;
}
```

> Confirm `DocumentsService.getFile` returns `{ buffer, filename, mimeType }` (it does — see documents.service.ts:134). `startImport(csvText, accountHint)` is `bank-ingestion.service.ts:39`.

- [ ] **Step 4: Map the bank outcome in `triage.service.ts route()`**

Add a `TriageOutcomeBankStatement { kind: 'bank_statement'; document_id: number; job_id: number }` to `triage/types.ts`'s `TriageOutcome` union, and map `bank_import_started` in `route()`:

```typescript
if (result.status === 'bank_import_started') {
  return { kind: 'bank_statement', document_id: documentId, job_id: result.jobId };
}
```

- [ ] **Step 5: Run tests + DI**

Run: `npm test --workspace=packages/server -- src/ai src/triage`
Then: `npm test --workspace=packages/server` (DI: import `BankModule`/`BankIngestionService` into `ai.module.ts`; watch for a module cycle — if Nest reports one, use `forwardRef` as `bank-ingestion.service.ts` already does for reconciliation).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ai packages/server/src/triage
git commit -m "feat(intake): route CSV bank statements to bank-ingestion, park non-CSV"
```

---

## Phase 5 — Manual classify-as-sales-invoice + SPA surface

*Outcome: an operator can reclassify a parked document as a sales invoice, and IntakeView shows the new outcomes.*

### Task 14: Manual classify a `needs_triage` document as a sales invoice

**Files:**
- Modify: `packages/server/src/triage/types.ts` (`ManualClassifyDto` — make it a tagged union or add a `target` discriminator)
- Modify: `packages/server/src/ai/propose-draft.service.ts` (`manualClassifyInvoiceDraft`)
- Modify: `packages/server/src/ai/intake-workflow.service.ts` (`manualClassify` dispatches by target)
- Modify: `packages/server/src/triage/triage.service.ts` + `triage.controller.ts`
- Test: relevant specs in `src/ai` and `src/triage`

- [ ] **Step 1: Read the current ManualClassify shape**

Run: `sed -n '120,220p' packages/server/src/triage/types.ts` and find `ManualClassifyDto`; read `manualClassify` in `intake-workflow.service.ts` (already in this repo) and the controller endpoint in `triage.controller.ts`.

- [ ] **Step 2: Write the failing test**

```typescript
it('manually classifies a parked document as a sales invoice', async () => {
  documents.getById.mockResolvedValue({ id: 5, status: 'needs_triage' });
  proposeDraft.manualClassifyInvoiceDraft.mockResolvedValue({ outcome: 'draft', invoiceId: 77, pipelineResult: {} });
  const res = await service.manualClassify(5, {
    target: 'sales_invoice',
    customer_id: 7, invoice_number: 'INV-77', gross_amount: 12200, vat_amount: 2200,
    currency: 'EUR', tax_point_date: '2026-06-01', document_vat_marking: null,
  } as any);
  expect(res.status).toBe('draft_proposed_invoice');
  expect(res.invoiceId).toBe(77);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test --workspace=packages/server -- src/ai/intake-workflow.service.spec.ts -t "manually classifies a parked document as a sales invoice"`
Expected: FAIL.

- [ ] **Step 4: Implement**

- Make `ManualClassifyDto` a discriminated union on `target: 'expense' | 'sales_invoice'` (default `'expense'` for backward compatibility). The `expense` arm keeps today's fields (`supplier_id`, `category`, ...). The `sales_invoice` arm carries `customer_id?`, `invoice_number`, `gross_amount`, `vat_amount`, `currency`, `tax_point_date`, `document_vat_marking?`.
- Add `manualClassifyInvoiceDraft(documentId, dto)` to `propose-draft.service.ts` mirroring `manualClassifyDraft` but calling `salesInvoicesService.createInvoice(...)` + `runPipeline({ businessObjectType: 'sales_invoice', category: 'revenue', requestedBy: 'operator' })`. Returns `ProposeSalesInvoiceResult`.
- In `intake-workflow.service.ts` `manualClassify`, branch on `dto.target`: `sales_invoice` → `manualClassifyInvoiceDraft`, settle the document to `triaged`, resolve the finding, clear the pending proposal, and return `{ status: 'draft_proposed_invoice', invoiceId }`. `expense` → existing path unchanged.
- Map in `triage.service.ts manualClassify` the same way `route()` maps `draft_proposed_invoice`.

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=packages/server -- src/ai src/triage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ai packages/server/src/triage
git commit -m "feat(intake): allow manual classify of a parked document as a sales invoice"
```

### Task 15: IntakeView shows the sales-invoice outcome + manual-classify-as-invoice

**Files:**
- Modify: `packages/web/src/components/IntakeView.tsx` (+ test)
- Modify: `packages/web/src/api.ts` (outcome union + manual-classify payload)

- [ ] **Step 1: Read the current IntakeView + its test**

Run: `sed -n '1,200p' packages/web/src/components/IntakeView.tsx` and its test to learn how the existing expense/`needs_triage` outcomes render and how the manual-classify form posts.

- [ ] **Step 2: Write the failing test**

```typescript
it('renders a Sales invoice outcome with a link to the invoice', async () => {
  renderIntake({ outcome: { kind: 'invoice', document_id: 1, invoice_id: 55 } });
  expect(await screen.findByText(/Sales invoice #55/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test --workspace=packages/web -- src/components/IntakeView.test.tsx -t "Sales invoice"`
Expected: FAIL.

- [ ] **Step 4: Implement**

- In `api.ts`, extend the triage outcome type with `{ kind: 'invoice'; document_id: number; invoice_id: number }` and `{ kind: 'bank_statement'; document_id: number; job_id: number }`, and add a `manualClassifyInvoice(documentId, payload)` call hitting the existing manual-classify endpoint with `target: 'sales_invoice'`.
- In `IntakeView.tsx`, render the `invoice` outcome as `Sales invoice #{invoice_id}` (link to the invoices screen) and the `bank_statement` outcome as `Bank import started (job #{job_id})`. In the triage form for a parked document, add a "Classify as sales invoice" option that posts the sales-invoice manual-classify payload.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --workspace=packages/web -- src/components/IntakeView.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/IntakeView.tsx packages/web/src/components/IntakeView.test.tsx packages/web/src/api.ts
git commit -m "feat(web): show sales-invoice/bank outcomes and manual classify-as-invoice in Intake"
```

---

## Final verification

- [ ] **Whole server suite:** `npm test --workspace=packages/server` → all green.
- [ ] **Whole web suite:** `npm test --workspace=packages/web` → all green.
- [ ] **Lint + typecheck:** `npm run lint` and the repo's typecheck command (`tsc --noEmit` / `tsconfig.typecheck.json`, per recent CI commits) → clean.
- [ ] **Manual smoke (optional, via /run or the headless API):** set the org IBAN in Settings; upload a PDF invoice that prints that IBAN as payee → expect a `Sales invoice #N` outcome; upload a supplier invoice (their IBAN) → expect an expense; upload a CSV bank statement → expect a bank import job.

---

## Self-review notes (author checklist — completed)

- **Spec coverage:** IBAN storage (T1–T3), detection (T4), schema (T5), confidence (T6), router (T7), Pass-2 org context (T8), routing (T9), document link/idempotency (T10), sales-invoice booking + customer mirror (T11), HTTP outcome (T12), bank route (T13), manual override (T14), UI (T3 + T15). All 13 resolved decisions map to a task.
- **Type consistency:** `proposeSalesInvoiceDraft` returns `{ outcome, invoiceId }`; workflow returns `draft_proposed_invoice` with `invoiceId`; `triage.route()` maps to `{ kind: 'invoice', invoice_id }` (matches the pre-existing `TriageOutcomeInvoice`). `composeOutgoingConfidence(ibanMatched, signals)` signature is identical across T6/T9. `classifyDocumentClass({ documentType, ibanMatched })` identical across T7/T9.
- **Open confirmations for the implementer (read-before-write, not placeholders):** the exact `ManualClassifyDto` shape (T14 Step 1), the SettingsView/IntakeView field patterns (T3/T15 Step 1), and the Vitest invocation style (header). These are existing-code reads, not unspecified logic.
