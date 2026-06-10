# Statutory Reports + EMTA KMD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let country plugins render statutory reports in their own format, implement the Estonia EMTA KMD generator (boxes + INF A/B as `vatdeclaration.xsd` XML and KMD2 CSV), introduce first-class credit notes, and expose the artifact over REST + the operator SPA.

**Architecture:** The kernel assembles a jurisdiction-neutral `StatutoryReportInput` (boxes from `VatReportService`, per-document INF lines via a direct Kysely join, declarant identity from `OrganizationService`) and hands it to the active `CountryPlugin`, which stays pure (ADR-0002) and owns all jurisdiction rules + rendering. Credit notes become a first-class object so the Estonian INF can list credit transactions as attributed lines.

**Tech Stack:** NestJS, Kysely (better-sqlite3), Zod DTOs, Jest. XML via a small string builder validated against the official `vatdeclaration.xsd` with `libxmljs2` (XSD validation). SPA: React + Vite.

---

## File Structure

**Created**
- `src/database/migrations/036_add_supplier_invoice_number.ts` — `expense.supplier_invoice_number`.
- `src/database/migrations/037_add_org_declarant_identity.ts` — `organization.vat_registration_number` + `name`.
- `src/database/migrations/038_create_credit_note.ts` — `credit_note` table.
- `src/credit-notes/types.ts`, `credit-notes.service.ts`, `credit-notes.controller.ts`, `credit-notes.module.ts` (+ specs).
- `src/statutory-report/types.ts`, `statutory-report.service.ts`, `statutory-report.controller.ts`, `statutory-report.module.ts` (+ specs).
- `src/plugins/statutory-report.types.ts` — shared statutory-report contract types.
- `src/plugins/estonia-kmd/kmd-xml.ts`, `kmd-csv.ts`, `kmd-inf.ts` — Estonia renderers.
- `test/fixtures/vatdeclaration.xsd` — vendored official schema (pinned version).
- `frontend/src/components/CreditNotesView.tsx` (+ test).

**Modified**
- `src/plugins/country-plugin.interface.ts` — add `generateStatutoryReports` to `CountryPlugin`.
- `src/plugins/null-country.plugin.ts`, `estonia-country.plugin.ts` — implement it.
- `src/audit-findings/types.ts` — add `statutory_report_incomplete` finding type.
- `src/organization/types.ts`, `organization.service.ts` — declarant fields.
- `src/expenses/types.ts`, `expenses.service.ts`, `expenses.controller.ts` — `supplier_invoice_number` + metadata PATCH.
- `src/triage/types.ts`, `src/ai/agent-config.ts`, `src/triage/ocr.service.ts`, `src/ai/propose-draft.service.ts` — extraction.
- `src/corrections/corrections.service.ts` — delegate `credit_note` kind.
- `src/database/types.ts`, `src/database/migrations/index.ts` — register table + migrations.
- `frontend/src/api.ts`, `frontend/src/components/tabs.tsx` — download helper + tab.

---

## Phase 1 — Schema & declarant identity

### Task 1: Migration — `expense.supplier_invoice_number`

**Files:**
- Create: `src/database/migrations/036_add_supplier_invoice_number.ts`
- Modify: `src/database/migrations/index.ts`, `src/database/types.ts`

- [ ] **Step 1: Write the migration**

```typescript
// src/database/migrations/036_add_supplier_invoice_number.ts
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('expense')
    .addColumn('supplier_invoice_number', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('expense')
    .dropColumn('supplier_invoice_number')
    .execute();
}
```

- [ ] **Step 2: Register it** in `src/database/migrations/index.ts`

Add the import alongside the others (`import * as m036 from './036_add_supplier_invoice_number';`) and the keyed entry `'036_add_supplier_invoice_number': m036,` in the migrations object (keep ascending order).

- [ ] **Step 3: Add the column to the table type** in `src/database/types.ts`

In `ExpenseTable`, after `document_vat_marking`, add:

```typescript
  supplier_invoice_number: string | null;
```

- [ ] **Step 4: Run the migration test suite**

Run: `npx jest src/database`
Expected: PASS (migrations apply cleanly).

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations/036_add_supplier_invoice_number.ts src/database/migrations/index.ts src/database/types.ts
git commit -m "feat(db): add expense.supplier_invoice_number (opaque, nullable)"
```

### Task 2: Migration — org declarant identity

**Files:**
- Create: `src/database/migrations/037_add_org_declarant_identity.ts`
- Modify: `src/database/migrations/index.ts`, `src/database/types.ts`, `src/organization/types.ts`

- [ ] **Step 1: Write the migration**

```typescript
// src/database/migrations/037_add_org_declarant_identity.ts
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('organization')
    .addColumn('vat_registration_number', 'text')
    .execute();
  await db.schema.alterTable('organization').addColumn('name', 'text').execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('organization')
    .dropColumn('vat_registration_number')
    .execute();
  await db.schema.alterTable('organization').dropColumn('name').execute();
}
```

- [ ] **Step 2: Register** in `index.ts` (`m037` import + `'037_add_org_declarant_identity': m037,`).

- [ ] **Step 3: Extend table + domain types**

`src/database/types.ts` → `OrganizationTable`: add `vat_registration_number: string | null;` and `name: string | null;`.
`src/organization/types.ts` → `Organization` interface: add the same two fields; `UpdateOrganizationDto`: add `vat_registration_number?: string | null;` and `name?: string | null;`.

- [ ] **Step 4: Update `organization.service.ts`** to read/write the new fields.

In the row→domain mapper add `vat_registration_number: row.vat_registration_number, name: row.name,`. In the update method include the two columns when present in the DTO (follow the existing `base_currency` conditional-set pattern).

- [ ] **Step 5: Run** `npx jest src/organization src/database` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(org): declarant identity — vat_registration_number + name"
```

### Task 3: Migration — `credit_note` table

**Files:**
- Create: `src/database/migrations/038_create_credit_note.ts`
- Modify: `src/database/migrations/index.ts`, `src/database/types.ts`

- [ ] **Step 1: Write the migration**

```typescript
// src/database/migrations/038_create_credit_note.ts
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('credit_note')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('kind', 'text', (c) => c.notNull()) // 'sales' | 'purchase'
    .addColumn('credits_object_type', 'text', (c) => c.notNull())
    .addColumn('credits_object_id', 'integer', (c) => c.notNull())
    .addColumn('credit_note_number', 'text', (c) => c.notNull())
    .addColumn('gross_amount', 'integer', (c) => c.notNull())
    .addColumn('vat_amount', 'integer', (c) => c.notNull())
    .addColumn('currency', 'text', (c) => c.notNull())
    .addColumn('tax_point_date', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft'))
    .addColumn('voucher_id', 'integer')
    .addColumn('created_at', 'integer', (c) => c.notNull())
    .addColumn('updated_at', 'integer', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('credit_note').execute();
}
```

- [ ] **Step 2: Register** in `index.ts` (`m038` + keyed entry).

- [ ] **Step 3: Add table type** in `src/database/types.ts`

Add to the `Database` interface: `credit_note: CreditNoteTable;`. Define:

```typescript
export interface CreditNoteTable {
  id: Generated<number>;
  kind: string;
  credits_object_type: string;
  credits_object_id: number;
  credit_note_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: string;
  voucher_id: number | null;
  created_at: number;
  updated_at: number;
}
```

(Use the same `Generated`/import convention already present in the file.)

- [ ] **Step 4: Run** `npx jest src/database` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): create credit_note table"
```

---

## Phase 2 — Plugin contract seam

### Task 4: Statutory-report contract types

**Files:**
- Create: `src/plugins/statutory-report.types.ts`
- Modify: `src/plugins/country-plugin.interface.ts`

- [ ] **Step 1: Write the contract types**

```typescript
// src/plugins/statutory-report.types.ts
import type { VatSummaryLine } from '../vat-report/types';

export type StatutoryFormat = 'xml' | 'csv';

export interface StatutoryDocLine {
  documentKind: 'invoice' | 'credit_note';
  counterpartyName: string;
  counterpartyRegNumber: string | null; // null ⇒ non-taxable (B2C)
  invoiceNumber: string | null; // null ⇒ flagged by the plugin
  creditsInvoiceNumber: string | null; // set for credit notes
  date: string; // tax-point YYYY-MM-DD
  vatCode: string; // booked code, authoritative
  netAmount: number; // EUR minor units, signed
  vatAmount: number; // EUR minor units, signed
}

export interface StatutoryReportInput {
  declarant: { regNumber: string | null; name: string | null };
  period: { name: string; startDate: string; endDate: string };
  mode: 'final' | 'draft';
  boxes: VatSummaryLine[];
  totals: { totalInputVat: number; totalOutputVat: number; totalPayable: number };
  salesLines: StatutoryDocLine[];
  purchaseLines: StatutoryDocLine[];
}

export interface StatutoryReportArtifact {
  filename: string;
  mimeType: string;
  content: string;
}

export interface StatutoryWarning {
  code: string;
  message: string;
  counterparty?: string;
}

export interface StatutoryReportResult {
  artifacts: StatutoryReportArtifact[];
  warnings: StatutoryWarning[];
}
```

- [ ] **Step 2: Add the method to the `CountryPlugin` interface** in `src/plugins/country-plugin.interface.ts`

Add the import `import type { StatutoryReportInput, StatutoryReportResult, StatutoryFormat } from './statutory-report.types';` and re-export them in the existing `export type { ... }` block. Add to the interface:

```typescript
  /**
   * Render the jurisdiction's statutory VAT filing artifact(s) from a
   * neutral, pre-assembled input. The plugin owns ALL jurisdiction rules
   * (reportable-rate filter, B2C exclusion, thresholds, rate→box mapping,
   * declarant-id format) and stays pure — no DB access. Unsupported
   * jurisdictions return empty artifacts.
   */
  generateStatutoryReports(
    input: StatutoryReportInput,
    opts: { formats: StatutoryFormat[] },
  ): StatutoryReportResult;
```

- [ ] **Step 3: Run** `npx jest src/plugins` — Expected: FAIL (NullCountryPlugin + EstoniaCountryPlugin no longer satisfy the interface — TS compile error in tests).

- [ ] **Step 4: Commit (red checkpoint)**

```bash
git add src/plugins/statutory-report.types.ts src/plugins/country-plugin.interface.ts
git commit -m "feat(plugins): add generateStatutoryReports to CountryPlugin contract"
```

### Task 5: NullCountryPlugin returns empty

**Files:**
- Modify: `src/plugins/null-country.plugin.ts`
- Test: `src/plugins/null-country.plugin.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// in null-country.plugin.spec.ts
it('returns no statutory artifacts (jurisdiction has no filing format)', () => {
  const result = plugin.generateStatutoryReports(
    {
      declarant: { regNumber: null, name: null },
      period: { name: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31' },
      mode: 'final',
      boxes: [],
      totals: { totalInputVat: 0, totalOutputVat: 0, totalPayable: 0 },
      salesLines: [],
      purchaseLines: [],
    },
    { formats: ['xml'] },
  );
  expect(result).toEqual({ artifacts: [], warnings: [] });
});
```

- [ ] **Step 2: Run** `npx jest src/plugins/null-country.plugin.spec.ts -t "no statutory"` — Expected: FAIL (method missing).

- [ ] **Step 3: Implement** in `null-country.plugin.ts`

```typescript
generateStatutoryReports(): StatutoryReportResult {
  return { artifacts: [], warnings: [] };
}
```

(Import `StatutoryReportResult` from `./statutory-report.types`.)

- [ ] **Step 4: Run** the same test — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(plugins): NullCountryPlugin statutory report = empty"
```

---

## Phase 3 — Estonia EMTA KMD generator

### Task 6: INF eligibility, threshold & line classification (pure helper)

This is the jurisdiction core. Build it as a pure module first, fully unit-tested, then wire it into the plugin.

**Files:**
- Create: `src/plugins/estonia-kmd/kmd-inf.ts`
- Test: `src/plugins/estonia-kmd/kmd-inf.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// kmd-inf.spec.ts
import { buildInfPart, EE_RATE_BY_CODE } from './kmd-inf';
import { StatutoryDocLine } from '../statutory-report.types';

const line = (over: Partial<StatutoryDocLine>): StatutoryDocLine => ({
  documentKind: 'invoice',
  counterpartyName: 'Acme OÜ',
  counterpartyRegNumber: 'EE100000001',
  invoiceNumber: 'INV-1',
  creditsInvoiceNumber: null,
  date: '2026-05-10',
  vatCode: 'EE_OUTPUT_24',
  netAmount: 200000,
  vatAmount: 48000,
  ...over,
});

describe('buildInfPart', () => {
  it('excludes B2C (no registration number)', () => {
    const { rows } = buildInfPart([line({ counterpartyRegNumber: null, netAmount: 500000 })]);
    expect(rows).toHaveLength(0);
  });

  it('excludes partners under the €1000 net threshold', () => {
    const { rows } = buildInfPart([line({ netAmount: 99999 })]);
    expect(rows).toHaveLength(0);
  });

  it('includes ALL lines of a partner once their net total ≥ €1000', () => {
    const { rows } = buildInfPart([
      line({ invoiceNumber: 'A', netAmount: 60000 }),
      line({ invoiceNumber: 'B', netAmount: 60000 }),
    ]);
    expect(rows.map((r) => r.invoiceNumber).sort()).toEqual(['A', 'B']);
  });

  it('excludes zero-rated and reverse-charge codes from INF', () => {
    const { rows } = buildInfPart([
      line({ vatCode: 'EE_ZERO', netAmount: 500000 }),
      line({ vatCode: 'EE_REVERSE_CHARGE', netAmount: 500000 }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('maps vat code to numeric rate', () => {
    expect(EE_RATE_BY_CODE['EE_OUTPUT_24']).toBe(24);
    expect(EE_RATE_BY_CODE['EE_INPUT_13']).toBe(13);
  });

  it('warns when a qualifying line has no invoice number', () => {
    const { warnings } = buildInfPart([line({ invoiceNumber: null, netAmount: 500000 })]);
    expect(warnings[0].code).toBe('inf_missing_invoice_number');
    expect(warnings[0].counterparty).toBe('Acme OÜ');
  });
});
```

- [ ] **Step 2: Run** `npx jest src/plugins/estonia-kmd/kmd-inf.spec.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// src/plugins/estonia-kmd/kmd-inf.ts
import { StatutoryDocLine, StatutoryWarning } from '../statutory-report.types';

/** Rates that appear on INF; others (zero, reverse-charge) are excluded. */
export const EE_RATE_BY_CODE: Record<string, number> = {
  EE_OUTPUT_24: 24,
  EE_INPUT_24: 24,
  EE_OUTPUT_13: 13,
  EE_INPUT_13: 13,
  EE_OUTPUT_9: 9,
  EE_INPUT_9: 9,
};

const THRESHOLD_NET = 100000; // €1000 in cents

export interface InfRow {
  counterpartyRegNumber: string;
  counterpartyName: string;
  invoiceNumber: string | null;
  creditsInvoiceNumber: string | null;
  date: string;
  ratePercent: number;
  netAmount: number;
  vatAmount: number;
}

export function buildInfPart(lines: StatutoryDocLine[]): {
  rows: InfRow[];
  warnings: StatutoryWarning[];
} {
  const warnings: StatutoryWarning[] = [];

  // 1. Keep only INF-reportable rates with a taxable (B2B) counterparty.
  const reportable = lines.filter(
    (l) => EE_RATE_BY_CODE[l.vatCode] !== undefined && l.counterpartyRegNumber,
  );

  // 2. Group by partner; the €1000 net threshold is per partner, signed net.
  const netByPartner = new Map<string, number>();
  for (const l of reportable) {
    const key = l.counterpartyRegNumber as string;
    netByPartner.set(key, (netByPartner.get(key) ?? 0) + Math.abs(l.netAmount));
  }

  const rows: InfRow[] = [];
  for (const l of reportable) {
    const key = l.counterpartyRegNumber as string;
    if ((netByPartner.get(key) ?? 0) < THRESHOLD_NET) continue;
    if (!l.invoiceNumber) {
      warnings.push({
        code: 'inf_missing_invoice_number',
        message: `INF row for ${l.counterpartyName} has no invoice number`,
        counterparty: l.counterpartyName,
      });
    }
    rows.push({
      counterpartyRegNumber: key,
      counterpartyName: l.counterpartyName,
      invoiceNumber: l.invoiceNumber,
      creditsInvoiceNumber: l.creditsInvoiceNumber,
      date: l.date,
      ratePercent: EE_RATE_BY_CODE[l.vatCode],
      netAmount: l.netAmount,
      vatAmount: l.vatAmount,
    });
  }
  return { rows, warnings };
}
```

- [ ] **Step 4: Run** the spec — Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/estonia-kmd/kmd-inf.ts src/plugins/estonia-kmd/kmd-inf.spec.ts
git commit -m "feat(estonia): KMD INF eligibility + €1000 threshold + rate map"
```

### Task 7: Vendor the official XSD + XML validator helper

**Files:**
- Create: `test/fixtures/vatdeclaration.xsd` (download the pinned schema from EMTA tech-info), `src/plugins/estonia-kmd/xsd-validate.ts`
- Test: `src/plugins/estonia-kmd/xsd-validate.spec.ts`
- Modify: `package.json` (add `libxmljs2` dev dependency)

- [ ] **Step 1: Install the XSD validator**

Run: `npm install --save-dev libxmljs2`

- [ ] **Step 2: Vendor the schema**

Download the current `vatdeclaration.xsd` referenced from the EMTA technical-information page (https://www.emta.ee/en/business-client/e-services-training-courses/how-use-e-services/technical-information-services) into `test/fixtures/vatdeclaration.xsd`. Record the schema version in a top-of-file comment in `xsd-validate.ts`.

> If the schema cannot be fetched in this environment, stop and ask the user to supply `vatdeclaration.xsd`. Do NOT invent element names — the XSD is the spec source for Task 8.

- [ ] **Step 3: Write the validator helper + failing test**

```typescript
// xsd-validate.spec.ts
import { validateAgainstKmdXsd } from './xsd-validate';
import { readFileSync } from 'fs';
import { join } from 'path';

it('accepts a schema-valid document and rejects a malformed one', () => {
  const xsd = readFileSync(join(__dirname, '../../../test/fixtures/vatdeclaration.xsd'), 'utf8');
  const bad = '<vatDeclaration><wrong/></vatDeclaration>';
  const res = validateAgainstKmdXsd(bad, xsd);
  expect(res.valid).toBe(false);
});
```

```typescript
// src/plugins/estonia-kmd/xsd-validate.ts
// Pinned EMTA schema version: <fill from the downloaded file header>.
import * as libxml from 'libxmljs2';

export function validateAgainstKmdXsd(
  xml: string,
  xsd: string,
): { valid: boolean; errors: string[] } {
  const xsdDoc = libxml.parseXml(xsd);
  const xmlDoc = libxml.parseXml(xml);
  const valid = xmlDoc.validate(xsdDoc);
  return { valid, errors: (xmlDoc.validationErrors ?? []).map((e) => String(e)) };
}
```

- [ ] **Step 4: Run** `npx jest src/plugins/estonia-kmd/xsd-validate.spec.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(estonia): vendor pinned vatdeclaration.xsd + XSD validator"
```

### Task 8: Estonia KMD XML renderer (boxes + INF A/B), XSD-validated

**Files:**
- Create: `src/plugins/estonia-kmd/kmd-xml.ts`
- Test: `src/plugins/estonia-kmd/kmd-xml.spec.ts`

> Element names, namespace, and structure MUST match the vendored `vatdeclaration.xsd` and the "KMD2 XML formaadi kirjeldus". The skeleton below shows the shape; replace element names with the exact schema names while implementing.

- [ ] **Step 1: Write the failing test (XSD validation is the acceptance gate)**

```typescript
// kmd-xml.spec.ts
import { renderKmdXml } from './kmd-xml';
import { validateAgainstKmdXsd } from './xsd-validate';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StatutoryReportInput } from '../statutory-report.types';

const xsd = readFileSync(join(__dirname, '../../../test/fixtures/vatdeclaration.xsd'), 'utf8');

const input: StatutoryReportInput = {
  declarant: { regNumber: 'EE100000001', name: 'Test OÜ' },
  period: { name: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31' },
  mode: 'final',
  boxes: [{ vat_code: 'EE_OUTPUT_24', input_vat: 0, output_vat: 48000, line_count: 1 }],
  totals: { totalInputVat: 0, totalOutputVat: 48000, totalPayable: 48000 },
  salesLines: [
    {
      documentKind: 'invoice',
      counterpartyName: 'Acme OÜ',
      counterpartyRegNumber: 'EE100000002',
      invoiceNumber: 'INV-1',
      creditsInvoiceNumber: null,
      date: '2026-05-10',
      vatCode: 'EE_OUTPUT_24',
      netAmount: 200000,
      vatAmount: 48000,
    },
  ],
  purchaseLines: [],
};

it('produces XSD-valid KMD XML with the declarant and period', () => {
  const xml = renderKmdXml(input);
  const res = validateAgainstKmdXsd(xml, xsd);
  expect(res.errors).toEqual([]);
  expect(res.valid).toBe(true);
  expect(xml).toContain('EE100000001');
});

it('includes the INF Part A row for a ≥€1000 partner', () => {
  const xml = renderKmdXml(input);
  expect(xml).toContain('INV-1');
  expect(xml).toContain('EE100000002');
});
```

- [ ] **Step 2: Run** `npx jest src/plugins/estonia-kmd/kmd-xml.spec.ts` — Expected: FAIL (renderer missing).

- [ ] **Step 3: Implement `renderKmdXml`**

Build the document from `input` using the exact schema element names. Use `buildInfPart(input.salesLines)` and `buildInfPart(input.purchaseLines)` for the INF A/B rows. Escape text with a local `esc()` (`& < > " '`). Compute KMD box amounts from `input.boxes`/`input.totals`. Keep this file responsible only for XML string construction.

```typescript
// src/plugins/estonia-kmd/kmd-xml.ts  (skeleton — use exact XSD element names)
import { StatutoryReportInput } from '../statutory-report.types';
import { buildInfPart } from './kmd-inf';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const eur = (cents: number): string => (cents / 100).toFixed(2);

export function renderKmdXml(input: StatutoryReportInput): string {
  const a = buildInfPart(input.salesLines);
  const b = buildInfPart(input.purchaseLines);
  const infA = a.rows.map((r) => /* <saleLine> … </saleLine> using r */ '').join('');
  const infB = b.rows.map((r) => /* <purchaseLine> … </purchaseLine> using r */ '').join('');
  // Assemble <vatDeclaration> per the XSD: declarant id, taxPeriod,
  // declaration boxes from input.totals/boxes, then <INF><partA>…</partA>
  // <partB>…</partB></INF>. Replace placeholders with exact element names.
  return `<?xml version="1.0" encoding="UTF-8"?>` + `…`;
}
```

- [ ] **Step 4: Iterate against the XSD** until `npx jest src/plugins/estonia-kmd/kmd-xml.spec.ts` passes (the validator drives correctness — adjust element names until `errors` is empty).

- [ ] **Step 5: Commit**

```bash
git add src/plugins/estonia-kmd/kmd-xml.ts src/plugins/estonia-kmd/kmd-xml.spec.ts
git commit -m "feat(estonia): KMD XML renderer (boxes + INF A/B), XSD-validated"
```

### Task 9: Estonia KMD2 CSV renderer

**Files:**
- Create: `src/plugins/estonia-kmd/kmd-csv.ts`
- Test: `src/plugins/estonia-kmd/kmd-csv.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// kmd-csv.spec.ts
import { renderKmdCsv } from './kmd-csv';
// reuse the `input` fixture shape from kmd-xml.spec.ts
it('emits a CSV with a header and one INF Part A row', () => {
  const csv = renderKmdCsv(input); // import/inline the same input object
  const lines = csv.trim().split('\n');
  expect(lines[0]).toContain('invoice_number');
  expect(lines.some((l) => l.includes('INV-1') && l.includes('EE100000002'))).toBe(true);
});
```

- [ ] **Step 2: Run** `npx jest src/plugins/estonia-kmd/kmd-csv.spec.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `renderKmdCsv`** per the "KMD2 CSV formaadi kirjeldus": one header row, then INF A then INF B rows (reuse `buildInfPart`). Quote fields containing commas; join with `\n`.

- [ ] **Step 4: Run** the spec — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(estonia): KMD2 CSV renderer"
```

### Task 10: Wire renderers into `EstoniaCountryPlugin.generateStatutoryReports`

**Files:**
- Modify: `src/plugins/estonia-country.plugin.ts`
- Test: `src/plugins/estonia-country.plugin.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// in estonia-country.plugin.spec.ts (reuse the `input` fixture)
it('returns xml + csv artifacts when both formats requested', () => {
  const { artifacts } = plugin.generateStatutoryReports(input, { formats: ['xml', 'csv'] });
  expect(artifacts.map((a) => a.mimeType).sort()).toEqual(['application/xml', 'text/csv']);
  expect(artifacts.find((a) => a.filename.endsWith('.xml'))).toBeDefined();
});

it('hard-flags a missing declarant reg number in final mode', () => {
  const bad = { ...input, declarant: { regNumber: null, name: 'X' } };
  const { warnings } = plugin.generateStatutoryReports(bad, { formats: ['xml'] });
  expect(warnings.some((w) => w.code === 'missing_declarant_reg_number')).toBe(true);
});

it('validates declarant reg number format (EE + 9 digits)', () => {
  const bad = { ...input, declarant: { regNumber: 'XX1', name: 'X' } };
  const { warnings } = plugin.generateStatutoryReports(bad, { formats: ['xml'] });
  expect(warnings.some((w) => w.code === 'invalid_declarant_reg_number')).toBe(true);
});
```

- [ ] **Step 2: Run** `npx jest src/plugins/estonia-country.plugin.spec.ts -t "artifacts"` — Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// estonia-country.plugin.ts
import { renderKmdXml } from './estonia-kmd/kmd-xml';
import { renderKmdCsv } from './estonia-kmd/kmd-csv';
import {
  StatutoryReportInput, StatutoryReportResult, StatutoryFormat,
} from './statutory-report.types';

private static readonly REG_RE = /^EE\d{9}$/;

generateStatutoryReports(
  input: StatutoryReportInput,
  opts: { formats: StatutoryFormat[] },
): StatutoryReportResult {
  const warnings = [];
  const reg = input.declarant.regNumber;
  if (!reg) {
    warnings.push({
      code: 'missing_declarant_reg_number',
      message: 'KMD declarant has no VAT registration number',
    });
  } else if (!EstoniaCountryPlugin.REG_RE.test(reg)) {
    warnings.push({
      code: 'invalid_declarant_reg_number',
      message: `Declarant reg number ${reg} is not EE + 9 digits`,
    });
  }
  const base = input.period.name.replace(/[^\w-]/g, '_');
  const artifacts = [];
  for (const fmt of opts.formats) {
    if (fmt === 'xml') {
      artifacts.push({ filename: `kmd-${base}.xml`, mimeType: 'application/xml', content: renderKmdXml(input) });
    } else {
      artifacts.push({ filename: `kmd-${base}.csv`, mimeType: 'text/csv', content: renderKmdCsv(input) });
    }
  }
  // Surface INF row warnings (missing invoice numbers) too.
  warnings.push(
    ...renderInfWarnings(input), // small helper that runs buildInfPart on both parts and collects warnings
  );
  return { artifacts, warnings };
}
```

Add a private `renderInfWarnings(input)` that calls `buildInfPart(input.salesLines)` and `buildInfPart(input.purchaseLines)` and returns the concatenated `warnings`.

- [ ] **Step 4: Run** `npx jest src/plugins/estonia-country.plugin.spec.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(estonia): generateStatutoryReports — xml/csv + declarant validation"
```

---

## Phase 4 — Credit notes

### Task 11: Credit-note types + DTO

**Files:**
- Create: `src/credit-notes/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// src/credit-notes/types.ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export type CreditNoteKind = 'sales' | 'purchase';
export type CreditNoteStatus = 'draft' | 'posted' | 'reversed';

export interface CreditNote {
  id: number;
  kind: CreditNoteKind;
  credits_object_type: 'sales_invoice' | 'expense';
  credits_object_id: number;
  credit_note_number: string;
  gross_amount: number;
  vat_amount: number;
  currency: string;
  tax_point_date: string;
  status: CreditNoteStatus;
  voucher_id: number | null;
  created_at: number;
  updated_at: number;
}

export const createCreditNoteSchema = z.object({
  credits_object_type: z.enum(['sales_invoice', 'expense']),
  credits_object_id: z.number().int(),
  credit_note_number: z.string(),
  gross_amount: z.number().int(),
  vat_amount: z.number().int(),
  tax_point_date: z.string(),
});

export class CreateCreditNoteDto extends createZodDto(createCreditNoteSchema) {}
```

- [ ] **Step 2: Run** `npx tsc --noEmit` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/credit-notes/types.ts && git commit -m "feat(credit-notes): types + create DTO"
```

### Task 12: `CreditNotesService.create` — cap guard + vatCode/currency inheritance

**Files:**
- Create: `src/credit-notes/credit-notes.service.ts`, `src/credit-notes/credit-notes.module.ts`
- Test: `src/credit-notes/credit-notes.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// credit-notes.service.spec.ts — integration style (real Kysely test db, post a sales invoice first)
it('rejects a credit note that exceeds the original gross (cap guard)', async () => {
  const inv = await seedPostedSalesInvoice({ gross: 100000, vat: 24000 }); // helper
  await expect(
    service.create({
      credits_object_type: 'sales_invoice',
      credits_object_id: inv.id,
      credit_note_number: 'CN-1',
      gross_amount: 120000,
      vat_amount: 28800,
      tax_point_date: '2026-05-20',
    }),
  ).rejects.toThrow(/exceeds/i);
});

it('allows multiple partial credit notes up to the cap', async () => {
  const inv = await seedPostedSalesInvoice({ gross: 100000, vat: 24000 });
  await service.create({ credits_object_type: 'sales_invoice', credits_object_id: inv.id, credit_note_number: 'CN-1', gross_amount: 60000, vat_amount: 14400, tax_point_date: '2026-05-20' });
  const second = await service.create({ credits_object_type: 'sales_invoice', credits_object_id: inv.id, credit_note_number: 'CN-2', gross_amount: 40000, vat_amount: 9600, tax_point_date: '2026-05-20' });
  expect(second.status).toBe('posted');
  expect(second.currency).toBe(inv.currency); // inherited
});
```

(Provide a `seedPostedSalesInvoice` helper in the spec that creates + posts an invoice via `SalesInvoicesService`.)

- [ ] **Step 2: Run** `npx jest src/credit-notes/credit-notes.service.spec.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the service**

```typescript
// credit-notes.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { CreateCreditNoteDto, CreditNote } from './types';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { AccountService } from '../ledger/account/account.service';

@Injectable()
export class CreditNotesService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly posting: PostingService,
    private readonly periodLock: PeriodLockService,
    private readonly voucherLines: VoucherLineRepository,
    private readonly accounts: AccountService,
  ) {}

  async create(dto: CreateCreditNoteDto): Promise<CreditNote> {
    const table = dto.credits_object_type; // 'sales_invoice' | 'expense'
    const original = await this.db
      .selectFrom(table)
      .selectAll()
      .where('id', '=', dto.credits_object_id)
      .executeTakeFirst();
    if (!original) throw new NotFoundException(`${table} ${dto.credits_object_id} not found`);
    if (original.status !== 'posted')
      throw new BadRequestException(`Cannot credit a ${original.status} ${table}`);

    // Cap: cumulative posted credit notes + new ≤ original.
    const credited = await this.db
      .selectFrom('credit_note')
      .select(({ fn }) => [
        fn.sum<number>('gross_amount').as('gross'),
        fn.sum<number>('vat_amount').as('vat'),
      ])
      .where('credits_object_type', '=', table)
      .where('credits_object_id', '=', dto.credits_object_id)
      .where('status', '=', 'posted')
      .executeTakeFirst();
    const priorGross = credited?.gross ?? 0;
    if (priorGross + dto.gross_amount > original.gross_amount)
      throw new BadRequestException(
        `Credit note exceeds remaining creditable amount on ${table} ${dto.credits_object_id}`,
      );

    // Inherit vatCode from the original's voucher VAT-control line.
    const origLines = await this.voucherLines.getLinesByVoucherId(original.voucher_id!);
    const vatLine = await this.findVatControlLine(origLines);

    // Redirect into the open period if the original's date is locked (ADR-0009).
    const taxPointDate = await this.resolveDate(dto.tax_point_date);
    const kind = table === 'sales_invoice' ? 'sales' : 'purchase';

    return this.db.transaction().execute(async (trx) => {
      const draft = this.buildCreditVoucher(dto, vatLine, taxPointDate, kind);
      const posted = await this.posting.postVoucher(draft, trx);
      const now = Date.now();
      const row = await trx
        .insertInto('credit_note')
        .values({
          kind,
          credits_object_type: table,
          credits_object_id: dto.credits_object_id,
          credit_note_number: dto.credit_note_number,
          gross_amount: dto.gross_amount,
          vat_amount: dto.vat_amount,
          currency: original.currency,
          tax_point_date: taxPointDate,
          status: 'posted',
          voucher_id: posted.id,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.mapRow(row);
    });
  }

  // findVatControlLine / buildCreditVoucher / resolveDate / mapRow:
  // - resolveDate: if periodLock.findLockedPeriod(date) → use getCurrentOpenPeriod().start_date.
  // - buildCreditVoucher: mirror the original's lines with opposite is_debit, scaled to
  //   dto.gross/vat (opposite sign of the original invoice voucher), at the inherited vat_code.
}
```

Implement the four private helpers concretely (mirror `CorrectionsService.buildReversalDraft` for line-flipping; `findVatControlLine` selects the line whose account code is `VAT_PAYABLE`/`VAT_RECEIVABLE`). `credit-notes.module.ts` provides `CreditNotesService` and imports `PostingModule`, `ReportingPeriodsModule`, ledger modules, exports the service.

- [ ] **Step 4: Run** the spec — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(credit-notes): create with cap guard + vatCode/currency inheritance + lock redirect"
```

### Task 13: Credit-notes controller

**Files:**
- Create: `src/credit-notes/credit-notes.controller.ts`
- Modify: `src/credit-notes/credit-notes.module.ts`, `src/app.module.ts`
- Test: `test/credit-notes.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e test**

```typescript
// test/credit-notes.e2e-spec.ts
it('POST /api/credit-notes creates a credit note for a posted invoice', async () => {
  const inv = await seedPostedSalesInvoice(app, { gross: 100000, vat: 24000 });
  const res = await request(app.getHttpServer())
    .post('/api/credit-notes')
    .set('Authorization', `Bearer ${token}`)
    .send({ credits_object_type: 'sales_invoice', credits_object_id: inv.id, credit_note_number: 'CN-1', gross_amount: 50000, vat_amount: 12000, tax_point_date: '2026-05-20' })
    .expect(201);
  expect(res.body.status).toBe('posted');
});
```

(Follow the auth-token + seed setup pattern from existing e2e specs, e.g. the bank import smoke test.)

- [ ] **Step 2: Run** `npx jest --config ./test/jest-e2e.json test/credit-notes.e2e-spec.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the controller**

```typescript
// credit-notes.controller.ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreditNotesService } from './credit-notes.service';
import { CreateCreditNoteDto } from './types';

@Controller('api/credit-notes')
export class CreditNotesController {
  constructor(private readonly service: CreditNotesService) {}

  @Post()
  create(@Body() dto: CreateCreditNoteDto) {
    return this.service.create(dto);
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getById(Number(id));
  }
}
```

Add `list()` and `getById()` to the service (simple selects). Register `CreditNotesController` in the module and import `CreditNotesModule` in `app.module.ts`.

- [ ] **Step 4: Run** the e2e — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(credit-notes): REST controller (create/list/get)"
```

### Task 14: Delegate the `credit_note` correction kind

**Files:**
- Modify: `src/corrections/corrections.service.ts`, `src/corrections/corrections.module.ts`
- Test: `src/corrections/corrections.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('delegates a credit_note correction request to CreditNotesService', async () => {
  const spy = jest.spyOn(creditNotes, 'create').mockResolvedValue({ id: 7 } as any);
  const res = await service.correctSalesInvoice(invoiceId, {
    kind: 'credit_note',
    creditNote: { credit_note_number: 'CN-9', gross_amount: 10000, vat_amount: 2400, tax_point_date: '2026-05-20' },
    reason: 'return',
  } as any);
  expect(spy).toHaveBeenCalled();
  expect(res.outcome).toBe('credit_note_created');
});
```

- [ ] **Step 2: Run** the test — Expected: FAIL (still returns `credit_note_not_implemented`).

- [ ] **Step 3: Implement**

Inject `CreditNotesService` into `CorrectionsService`. Replace the arm at `corrections.service.ts:134`:

```typescript
if (request.kind === 'credit_note') {
  const cn = await this.creditNotes.create({
    credits_object_type: params.objectType as 'sales_invoice' | 'expense',
    credits_object_id: params.objectId,
    ...request.creditNote,
  });
  return { outcome: 'credit_note_created', creditNoteId: cn.id };
}
```

Add `credit_note_created` + `creditNoteId` to `CorrectionResult` and the `creditNote` payload to `CorrectionRequest` in `src/corrections/types.ts`. Import `CreditNotesModule` in `corrections.module.ts`.

- [ ] **Step 4: Run** `npx jest src/corrections` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(corrections): credit_note kind delegates to CreditNotesService"
```

---

## Phase 5 — supplier_invoice_number plumbing

### Task 15: Carry `supplier_invoice_number` through expense create

**Files:**
- Modify: `src/expenses/types.ts`, `src/expenses/expenses.service.ts`
- Test: `src/expenses/expenses.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('persists supplier_invoice_number on create', async () => {
  const e = await service.createExpense({
    category: 'software', gross_amount: 12000, vat_amount: 2000, currency: 'EUR',
    tax_point_date: '2026-05-10', supplier_invoice_number: 'SUP-77',
  });
  const fetched = await service.getExpenseById(e.id);
  expect(fetched.supplier_invoice_number).toBe('SUP-77');
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/expenses/types.ts`: add `supplier_invoice_number: string | null;` to `Expense`; add `supplier_invoice_number: z.string().nullable().optional(),` to `createExpenseSchema`.
`expenses.service.ts`: in `createExpense` insert `supplier_invoice_number: dto.supplier_invoice_number ?? null,`; in the row mapper add `supplier_invoice_number: row.supplier_invoice_number,`.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(expenses): persist supplier_invoice_number on create"
```

### Task 16: `PATCH /api/expenses/:id/document-metadata` (lock-guarded)

**Files:**
- Modify: `src/expenses/expenses.controller.ts`, `src/expenses/expenses.service.ts`
- Test: `test/expenses-metadata.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e test**

```typescript
it('sets supplier_invoice_number on a posted expense while period is open', async () => {
  const e = await seedPostedExpense(app, { gross: 12000, vat: 2000, date: '2026-05-10' });
  await request(app.getHttpServer())
    .patch(`/api/expenses/${e.id}/document-metadata`)
    .set('Authorization', `Bearer ${token}`)
    .send({ supplier_invoice_number: 'SUP-9' })
    .expect(200);
});

it('rejects the patch when the expense period is locked', async () => {
  const e = await seedPostedExpense(app, { gross: 12000, vat: 2000, date: '2026-05-10' });
  await lockPeriodCovering(app, '2026-05-10'); // helper
  await request(app.getHttpServer())
    .patch(`/api/expenses/${e.id}/document-metadata`)
    .set('Authorization', `Bearer ${token}`)
    .send({ supplier_invoice_number: 'SUP-9' })
    .expect(400);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

Service method:

```typescript
async setDocumentMetadata(id: number, patch: { supplier_invoice_number?: string | null }): Promise<Expense> {
  const expense = await this.getExpenseById(id);
  await this.periodLock.assertPeriodOpen(expense.tax_point_date); // throws if locked
  await this.db.updateTable('expense')
    .set({ supplier_invoice_number: patch.supplier_invoice_number ?? null, updated_at: Date.now() })
    .where('id', '=', id).execute();
  return this.getExpenseById(id);
}
```

(Inject `PeriodLockService` into `ExpensesService`; import `ReportingPeriodsModule` in `expenses.module.ts` if not already.) Controller:

```typescript
@Patch(':id/document-metadata')
setDocumentMetadata(@Param('id') id: string, @Body() body: { supplier_invoice_number?: string | null }) {
  return this.expensesService.setDocumentMetadata(Number(id), body);
}
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(expenses): document-metadata PATCH for supplier_invoice_number (lock-guarded)"
```

### Task 17: Triage extraction of `supplier_invoice_number`

**Files:**
- Modify: `src/triage/types.ts`, `src/ai/agent-config.ts`, `src/triage/ocr.service.ts`, `src/ai/propose-draft.service.ts`
- Test: `src/ai/propose-draft.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('passes supplier_invoice_number from triage into the created expense', async () => {
  const draft = await service.proposeDraft(
    { ...validTriageResult, supplier_invoice_number: 'SUP-55' },
    documentId,
  );
  // assert the CreateExpenseDto handed to ExpensesService carried it
  expect(createExpenseSpy).toHaveBeenCalledWith(
    expect.objectContaining({ supplier_invoice_number: 'SUP-55' }),
  );
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

`triage/types.ts`: add `supplier_invoice_number: z.string().nullable()` to `triageResultSchema`.
`ai/agent-config.ts`: extend the prompt to instruct extracting the supplier's invoice/receipt number (null if absent).
`triage/ocr.service.ts`: include an `**Invoice Number:**` line in the faux markdown so tests are deterministic.
`ai/propose-draft.service.ts`: add `supplier_invoice_number: triageResult.supplier_invoice_number,` to the `CreateExpenseDto`.

- [ ] **Step 4: Run** `npx jest src/ai src/triage` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(triage): extract supplier_invoice_number into expense draft"
```

---

## Phase 6 — Assembly service, audit finding, REST

### Task 18: Add `statutory_report_incomplete` finding type

**Files:**
- Modify: `src/audit-findings/types.ts`
- Test: `src/audit-findings/audit-findings.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('accepts the statutory_report_incomplete finding type', async () => {
  const f = await service.create({
    finding_type: 'statutory_report_incomplete',
    severity: 'medium',
  });
  expect(f.finding_type).toBe('statutory_report_incomplete');
});
```

- [ ] **Step 2: Run** — Expected: FAIL (`assertFindingType` rejects unknown type).

- [ ] **Step 3: Implement**

In `src/audit-findings/types.ts`: add `| 'statutory_report_incomplete' // a statutory report (KMD/INF) is missing required data` to the `FindingType` union AND `'statutory_report_incomplete',` to the `FINDING_TYPES` array.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(audit-findings): add statutory_report_incomplete type"
```

### Task 19: `StatutoryReportService.generate` — assembly

**Files:**
- Create: `src/statutory-report/statutory-report.service.ts`, `src/statutory-report/statutory-report.module.ts`
- Test: `src/statutory-report/statutory-report.service.spec.ts`

- [ ] **Step 1: Write failing integration tests**

```typescript
// statutory-report.service.spec.ts
it('assembles INF lines in EUR base amounts from posted documents in the period', async () => {
  await seedPostedSalesInvoice({ customerReg: 'EE100000002', gross: 248000, vat: 48000, date: '2026-05-10', invoiceNumber: 'INV-1' });
  const result = await service.generate(periodId, { formats: ['xml'] });
  expect(result.artifacts.find((a) => a.filename.endsWith('.xml'))).toBeDefined();
});

it('includes credit notes as credit_note doc lines', async () => {
  const inv = await seedPostedSalesInvoice({ customerReg: 'EE100000002', gross: 248000, vat: 48000, date: '2026-05-10', invoiceNumber: 'INV-1' });
  await creditNotes.create({ credits_object_type: 'sales_invoice', credits_object_id: inv.id, credit_note_number: 'CN-1', gross_amount: 24800, vat_amount: 4800, tax_point_date: '2026-05-12' });
  const result = await service.generate(periodId, { formats: ['xml'] });
  expect(result.artifacts[0].content).toContain('CN-1');
});

it('hard-blocks final generation without a declarant reg number', async () => {
  await lockPeriod(periodId);
  await setOrgRegNumber(null);
  await expect(service.generate(periodId, { formats: ['xml'] })).rejects.toThrow(/registration number/i);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// statutory-report.service.ts (shape)
@Injectable()
export class StatutoryReportService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
    private readonly vatReport: VatReportService,
    private readonly orgResolver: OrgContextResolver,
    private readonly auditFindings: AuditFindingsService,
  ) {}

  async generate(periodId: number, opts: { formats: StatutoryFormat[] }): Promise<StatutoryReportResult> {
    const period = await this.getPeriod(periodId); // start/end/name/status
    const mode = period.status === 'locked' ? 'final' : 'draft';
    const report = await this.vatReport.generate(periodId); // boxes + totals
    const { organization, plugin } = await this.orgResolver.resolve();

    if (mode === 'final' && !organization.vat_registration_number) {
      throw new BadRequestException('Cannot generate a final KMD without a declarant VAT registration number');
    }

    const salesLines = await this.assembleLines('sales_invoice', period); // see below
    const purchaseLines = await this.assembleLines('expense', period);

    const input: StatutoryReportInput = {
      declarant: { regNumber: organization.vat_registration_number, name: organization.name },
      period: { name: period.name, startDate: period.start_date, endDate: period.end_date },
      mode,
      boxes: report.vat_summary,
      totals: {
        totalInputVat: report.total_input_vat,
        totalOutputVat: report.total_output_vat,
        totalPayable: report.total_payable,
      },
      salesLines,
      purchaseLines,
    };

    const result = plugin.generateStatutoryReports(input, opts);
    for (const w of result.warnings) {
      await this.auditFindings.create({ finding_type: 'statutory_report_incomplete', severity: 'medium' });
    }
    return result;
  }
}
```

`assembleLines(table, period)` runs ONE Kysely query: join the business object (and `credit_note` for the credit lines) → `voucher` (filter `tax_point_date` within `[start,end]`, `posted_at is not null`) → `voucher_line` → `account` (pick the taxable-base line for `netAmount` and the VAT-control line for `vatAmount`, both via `ledgerBalance.signedBaseAmount`) → `entity` + `entity_identifier(kind='registration_key')`. Produce `StatutoryDocLine[]` (one per document, `documentKind` `'invoice'` for sales_invoice/expense rows and `'credit_note'` for credit_note rows; `creditsInvoiceNumber` resolved from the credited object's number for credit notes; `invoiceNumber` = `invoice_number` for sales, `supplier_invoice_number` for purchases). Register everything in `statutory-report.module.ts`.

- [ ] **Step 4: Run** `npx jest src/statutory-report` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(statutory-report): assemble neutral input + delegate to plugin"
```

### Task 20: REST endpoint — download

**Files:**
- Create: `src/statutory-report/statutory-report.controller.ts`
- Modify: `src/statutory-report/statutory-report.module.ts`, `src/app.module.ts`, `package.json` (add `jszip`)
- Test: `test/statutory-report.e2e-spec.ts`

- [ ] **Step 1: Install zip dep**

Run: `npm install jszip`

- [ ] **Step 2: Write failing e2e tests**

```typescript
it('GET …/statutory-report?format=xml returns an XML attachment', async () => {
  const periodId = await seedLockedPeriodWithInvoice(app); // helper
  const res = await request(app.getHttpServer())
    .get(`/api/reporting-periods/${periodId}/statutory-report?format=xml`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  expect(res.headers['content-type']).toContain('application/xml');
  expect(res.headers['content-disposition']).toContain('.xml');
});

it('format=all returns a zip', async () => {
  const periodId = await seedLockedPeriodWithInvoice(app);
  const res = await request(app.getHttpServer())
    .get(`/api/reporting-periods/${periodId}/statutory-report?format=all`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  expect(res.headers['content-type']).toContain('application/zip');
});
```

- [ ] **Step 3: Run** — Expected: FAIL.

- [ ] **Step 4: Implement the controller**

```typescript
@Controller('api/reporting-periods')
export class StatutoryReportController {
  constructor(private readonly service: StatutoryReportService) {}

  @Get(':id/statutory-report')
  async download(@Param('id') id: string, @Query('format') format = 'xml', @Res() res: Response) {
    const formats = format === 'all' ? ['xml', 'csv'] : [format as StatutoryFormat];
    const { artifacts } = await this.service.generate(Number(id), { formats });
    if (artifacts.length === 1) {
      res.setHeader('Content-Type', artifacts[0].mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${artifacts[0].filename}"`);
      return res.send(artifacts[0].content);
    }
    const zip = new JSZip();
    artifacts.forEach((a) => zip.file(a.filename, a.content));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="kmd.zip"');
    return res.send(buf);
  }
}
```

Register the controller; import `StatutoryReportModule` in `app.module.ts`.

- [ ] **Step 5: Run** — Expected: PASS. Then commit.

```bash
git add -A && git commit -m "feat(statutory-report): download endpoint (xml/csv/zip)"
```

---

## Phase 7 — Operator SPA

### Task 21: `api.ts` helpers + Download KMD button

**Files:**
- Modify: `frontend/src/api.ts`, the VAT-report / reporting-period view component
- Test: `frontend/src/api.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('downloadStatutoryReport hits the period endpoint with the format', async () => {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['<xml/>']), { status: 200, headers: { 'content-type': 'application/xml' } }));
  await downloadStatutoryReport(5, 'xml');
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('/api/reporting-periods/5/statutory-report?format=xml'), expect.any(Object));
});
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/api.test.ts -t downloadStatutoryReport` — Expected: FAIL.

- [ ] **Step 3: Implement** in `frontend/src/api.ts`

```typescript
export async function downloadStatutoryReport(periodId: number, format: 'xml' | 'csv' | 'all') {
  const res = await apiFetch(`/api/reporting-periods/${periodId}/statutory-report?format=${format}`, { method: 'GET' });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'kmd';
  a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5:** Add a "Download KMD" button to the reporting-period / VAT-report view calling `downloadStatutoryReport(period.id, 'all')`. Run `cd frontend && npx vitest run` — Expected: PASS. Commit.

```bash
git add -A && git commit -m "feat(spa): downloadStatutoryReport helper + Download KMD button"
```

### Task 22: Credit Notes SPA surface

**Files:**
- Create: `frontend/src/components/CreditNotesView.tsx` (+ `CreditNotesView.test.tsx`)
- Modify: `frontend/src/components/tabs.tsx`, `frontend/src/api.ts`

- [ ] **Step 1: Write the failing component test**

```typescript
// CreditNotesView.test.tsx (vi.mock the api module, mirror BankView.test.tsx convention)
it('submits a credit note and shows it in the list', async () => {
  vi.mocked(api.createCreditNote).mockResolvedValue({ id: 1, credit_note_number: 'CN-1', status: 'posted' } as any);
  vi.mocked(api.listCreditNotes).mockResolvedValue([{ id: 1, credit_note_number: 'CN-1', status: 'posted' }] as any);
  render(<CreditNotesView />);
  fireEvent.change(screen.getByLabelText(/credit note number/i), { target: { value: 'CN-1' } });
  fireEvent.click(screen.getByRole('button', { name: /issue credit note/i }));
  expect(await screen.findByText('CN-1')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/components/CreditNotesView.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement** `createCreditNote` / `listCreditNotes` in `api.ts`, the `CreditNotesView` component (form + list, following `BankView.tsx`), and register it as a tab in `tabs.tsx` (TabDef with custom component).

- [ ] **Step 4: Run** `cd frontend && npx vitest run` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(spa): Credit Notes tab (issue + list)"
```

---

## Phase 8 — Integration & docs

### Task 23: Full-suite regression + ADR

**Files:**
- Create: `docs/adr/0033-country-plugin-statutory-report-seam.md`

- [ ] **Step 1: Run the full backend suite**

Run: `npm test`
Expected: PASS (≥ 813 prior tests + the new ones; 0 failures).

- [ ] **Step 2: Run the frontend suite + build**

Run: `cd frontend && npx vitest run && npx vite build`
Expected: PASS, clean build.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors in touched files.

- [ ] **Step 4: Write ADR-0033** recording the seam: statutory rendering + all jurisdiction filing rules live behind `CountryPlugin.generateStatutoryReports`; the kernel only assembles a neutral input; credit notes are first-class; XML is XSD-validated and version-pinned; X-tee M2M is out of scope.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs(adr-0033): country-plugin statutory report generation seam"
```

---

## Self-Review Notes

- **Spec coverage:** Plugin contract (T4–5), Estonia XML+CSV+threshold+warnings (T6–10), assembly + modes + declarant hard-block (T19), credit notes first-class + cap + inheritance + redirect + delegation (T11–14), supplier_invoice_number field + triage + metadata PATCH (T1,15–17), org declarant identity (T2), audit finding (T18), REST download (T20), SPA (T21–22), migrations (T1–3). All spec sections map to a task.
- **External dependency:** Task 7 requires the real `vatdeclaration.xsd`; if unfetchable, execution must pause and ask the user (flagged in-task) rather than invent element names.
- **Type consistency:** `StatutoryReportInput` / `StatutoryDocLine` / `StatutoryReportResult` / `generateStatutoryReports` used identically across T4, T5, T8, T10, T19. `credit_note` columns match across T3 (migration), T11 (types), T12 (service).
