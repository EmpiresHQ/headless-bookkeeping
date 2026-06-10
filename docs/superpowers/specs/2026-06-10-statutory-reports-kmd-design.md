# Design: Country-plugin statutory reports + EMTA KMD generation

**Date:** 2026-06-10
**Status:** Approved (grilled)
**Branch:** `worktree-statutory-reports-kmd`

## Problem

The system computes VAT (boxes / payable / receivable per `vat_code`) but produces
**no filing artifact**. An Estonian VAT-payer must file the **KMD** (käibedeklaratsioon)
monthly by the 20th of the following month, together with the **KMD INF** appendix
(per-invoice listing of transactions ≥ €1000 net per partner). Today there is no way —
neither for an operator in the SPA nor for an agent over the API — to produce a file that
imports into e-MTA.

The deadline (20th) is **not** a code concern: periods are calendar months for EE (already
enforced by the plugin), and the system files **on demand**, not on deadline (ADR-0009/0015).
This work is about *producing the artifact*, not about deadline tracking.

## Goal

1. Make country plugins capable of generating statutory reports in their **own format**.
2. Implement an **EMTA KMD generator** in the Estonia plugin (KMD boxes + INF A + INF B),
   emitting both the official `vatdeclaration.xsd` XML and the KMD2 CSV.
3. Expose the artifact through **REST** and the **operator SPA**.
4. Introduce **first-class credit notes**, because the Estonian INF requires credit
   transactions to appear as attributed lines and the current correction model does not
   produce them.

## Key principle (ADR-0002)

The country plugin is the **sole resolver** of jurisdiction rules and stays **pure** (no DB
access). The kernel assembles a jurisdiction-neutral input; the plugin renders the format and
applies all jurisdiction-specific business logic (rate→box mapping, eligibility, thresholds,
declarant-ID format validation).

---

## Architecture

### A. Plugin contract (new seam on `CountryPlugin`)

New types in `src/plugins/country-plugin.interface.ts`:

```typescript
interface StatutoryReportInput {
  declarant: { regNumber: string; name: string };          // our org (KMKR + name)
  period: { name: string; startDate: string; endDate: string };
  mode: 'final' | 'draft';                                  // locked vs open
  boxes: VatSummaryLine[];                                  // from VatReportService
  totals: { totalInputVat: number; totalOutputVat: number; totalPayable: number };
  salesLines: StatutoryDocLine[];                           // INF Part A candidates
  purchaseLines: StatutoryDocLine[];                        // INF Part B candidates
}

interface StatutoryDocLine {
  documentKind: 'invoice' | 'credit_note';
  counterpartyName: string;
  counterpartyRegNumber: string | null;                    // null ⇒ non-taxable (B2C)
  invoiceNumber: string | null;                            // null ⇒ flagged by plugin
  creditsInvoiceNumber: string | null;                     // set for credit notes
  date: string;                                            // tax-point (YYYY-MM-DD)
  vatCode: string;                                         // booked code, authoritative
  netAmount: number;                                       // EUR minor units, signed
  vatAmount: number;                                       // EUR minor units, signed
}

interface StatutoryReportArtifact { filename: string; mimeType: string; content: string; }
interface StatutoryWarning { code: string; message: string; counterparty?: string; }

// on CountryPlugin:
generateStatutoryReports(
  input: StatutoryReportInput,
  opts: { formats: ('xml' | 'csv')[] },
): { artifacts: StatutoryReportArtifact[]; warnings: StatutoryWarning[] };
```

- **NullCountryPlugin** → `{ artifacts: [], warnings: [] }` (no statutory format).
- **EstoniaCountryPlugin** → renders `vatdeclaration.xsd` XML (KMD + INF A + B in one file)
  and KMD2 CSV. Owns: reportable-rate filter (24/13/9 only; `EE_ZERO` / `EE_REVERSE_CHARGE`
  excluded from INF), B2C exclusion (no `counterpartyRegNumber` → not on INF), the **€1000
  net per-partner threshold** (group, include all of a partner's lines when ≥ €1000),
  `vatCode → rate% + KMD box` mapping (reuses the private `VAT_RATES` map), and
  declarant `regNumber` format validation (`EE` + 9 digits). Emits `warnings` for
  reportable-but-incomplete documents.

The XML is validated against the official **`vatdeclaration.xsd`** (vendored as a test
fixture). The schema is **version-pinned**; future EMTA form bumps are plugin-only changes.
Machine-to-machine X-tee submission is **out of scope** — we produce a downloadable file the
operator uploads via "Add data from file".

### B. Assembly (kernel) — `StatutoryReportService` (`src/statutory-report/`)

Read-only projection, following the `VatReportService` precedent (injects `@InjectKysely` and
joins tables directly; reporting is inherently cross-cutting and the codebase does not route
it through per-module service methods).

`generate(periodId, { formats })`:

1. **Boxes** — call `VatReportService.generate(periodId)` (idempotent: locked → frozen
   snapshot, open → live compute). Reuse, do not recompute.
2. **Mode** — `locked` period → `final` (deterministic: built from the snapshot's
   `voucher_ids`, which are immutable post-lock); `open` period → `draft` (live tables).
3. **INF lines** — direct Kysely join:
   `sales_invoice` / `expense` / `credit_note` → `voucher` → `voucher_line`
   (`vat_code`, `base_amount` via `LedgerBalanceService.signedBaseAmount`) →
   `entity` + `entity_identifier(kind='registration_key')`.
   - Amounts in **EUR from `base_amount`** (never the document's possibly-foreign
     `gross/vat_amount`).
   - **One line per document** (relies on the one-category → one-`vatCode` invariant; if
     mixed-rate line-items ever appear, revisit by grouping on `vatCode` within a document).
4. **Declarant** — `OrganizationService` (`vat_registration_number` + `name`).
5. Build `StatutoryReportInput`, resolve the active plugin via the
   `OrgContextResolver` / plugin-loader, call `generateStatutoryReports`.
6. Turn returned `warnings` into `statutory_report_incomplete` audit findings.

**Hard block:** generating a `final` report for a jurisdiction that needs a declarant
`regNumber` when the org has none → `400`. (In `draft` mode it is a soft warning.)

### C. First-class credit notes — `CreditNotesService` (`src/credit-notes/`)

A credit note is a **commercial reduction** of a previously-posted, correctly-recorded
invoice (return, retro discount, partial cancellation) — distinct from a *correction* (fixing
a mis-recorded entry). It must appear in INF as its own attributed line.

New table `credit_note`:

| column | notes |
|--------|-------|
| `id` | |
| `kind` | `'sales'` \| `'purchase'` |
| `credits_object_type` | `'sales_invoice'` \| `'expense'` (required) |
| `credits_object_id` | required — the original document |
| `credit_note_number` | supplied string (mirrors `invoice_number`); sales = our number, purchase = supplier's opaque number |
| `gross_amount`, `vat_amount` | credit amounts, EUR-or-doc currency |
| `currency` | must equal the original's currency |
| `tax_point_date` | |
| `status` | `draft` / `posted` / `reversed` |
| `voucher_id` | FK to the reversal-style voucher |
| `created_at`, `updated_at` | |

Rules:
- `vatCode` / rate **inherited** from the original document's `voucher_line` — not
  user-chosen.
- **Partial** allowed; **multiple** credit notes per original allowed (ADR-0006
  "reversed-once" does NOT apply here).
- **Cap guard** at creation: `SUM(posted credit notes for this original) + new ≤ original
  gross/vat`; else `400`.
- **Posting** through `PostingService` (opposite-sign voucher built at the original's
  `vatCode`) + `PeriodLockService`. **Period-lock redirect (ADR-0009) reused**: a credit note
  against an invoice in a *locked* period is dated into the current open period.
- The existing `CorrectionRequest.kind === 'credit_note'` arm (today
  `credit_note_not_implemented` in `corrections.service.ts:134`) **delegates** to
  `CreditNotesService`.

### D. Schema migrations

1. `expense.supplier_invoice_number` — nullable text, opaque (mirrors `document_vat_marking`,
   migration 015). Captured at triage extraction and via manual entry.
2. `organization.vat_registration_number` (nullable text) + `organization.name` (nullable
   text).
3. New `credit_note` table.

### E. REST + SPA

- `GET /api/reporting-periods/:id/statutory-report?format=xml|csv|all` → file, or **zip** when
  more than one artifact. `Content-Disposition` attachment. Works for both agent (API) and
  operator. Controller in `statutory-report` module.
- `PATCH /api/expenses/:id/document-metadata` — sets `supplier_invoice_number` (opaque, no
  ledger impact, no re-post). Guard: allowed only while the expense's period is **not locked**
  (`assertPeriodOpen`). Makes the draft-preview warning actionable.
- `POST /api/credit-notes` (+ `GET` list / `GET :id`).
- SPA: **"Download KMD"** button on the VAT-report / reporting-period view
  (`downloadStatutoryReport(periodId, format)` in `api.ts`); a **Credit Notes** surface to
  issue/list credit notes.

### F. Triage extraction

`triageResultSchema` (`src/triage/types.ts`) + agent prompt (`src/ai/agent-config.ts`) + OCR
faux (`src/triage/ocr.service.ts`) gain `supplier_invoice_number` (nullable). For received
**purchase** credit notes the supplier's credit-note number is captured the same opaque way.
`ProposeDraftService` passes it through to `CreateExpenseDto`; `ExpensesService` persists it.
Low-confidence / missing → existing HITL (`needs_triage`) gate; never blocks.

### G. Validation / HITL

New audit-finding type `statutory_report_incomplete`, emitted (from plugin `warnings` →
kernel) when:
- a document qualifies for INF Part A/B (input/output VAT, partner ≥ €1000 net) but
  `invoiceNumber` is missing, or
- a counterparty with ≥ €1000 turnover has no `registration_key` (excluded from INF — add a
  reg code if it is a business), or
- a reversal/credit voucher in the period cannot be attributed to an INF line.

These are advisory in `draft` mode (fixable pre-lock) and surfaced on the period before
locking.

---

## Decision log (from grilling)

| # | Decision |
|---|----------|
| Q1 | Two modes: `locked` → deterministic final from snapshot; `open` → draft preview from live tables. |
| Q2 | Add metadata-only `PATCH /expenses/:id/document-metadata` for `supplier_invoice_number` (period not locked), so the draft warning is actionable. |
| Q3 | `vatCode → rate% + box` mapping lives in the **plugin**; kernel passes `vatCode`. |
| Q4 | INF amounts from `voucher_line.base_amount` (EUR); one line per document (one-category invariant). |
| Q5 | All INF business logic (reportable-rate filter, B2C exclusion, €1000 threshold) in the **plugin**; plugin returns `warnings`. |
| Q6 | Model **formal credit notes** (chosen over accepting a v1 limitation). |
| Q6a | Credit note is a **first-class `credit_note` object** (not a reversal-only attribution); INF assembly picks it up uniformly. |
| Q6b | **Partial** credit notes with a cumulative **cap**; rate inherited; multiple per original allowed. |
| Q8 | Add `organization.vat_registration_number` **and** `name`; hard-block final without reg number; format validated in plugin. |
| Q9 | Target official **`vatdeclaration.xsd`** XML **and** KMD2 CSV; XSD-validate XML in tests; version-pinned; no X-tee M2M. |
| Q10 | Separate **`CreditNotesService`** reusing posting + period-lock + redirect; correction-kind delegates. |
| Q11 | `StatutoryReportService` uses a **direct Kysely join** (vat-report precedent), not per-module read methods. |
| Q12 | `credit_note_number` supplied (no auto-sequence); vatCode/currency inherited; cap-query guard; original reference mandatory. |

## Out of scope (v1)

- X-tee / X-road machine-to-machine direct submission to e-MTA.
- Deadline (20th) tracking / enforcement — remains advisory.
- Auto-numbering sequence for sales credit notes (numbers are supplied, matching invoices).
- Mixed-rate multi-line documents (current domain produces one rate per document).

## Testing strategy

- **Plugin (pure, isolated):** unit tests over `generateStatutoryReports` — rate→box mapping,
  €1000 threshold grouping, B2C exclusion, reportable-rate filtering, warnings. XML output
  validated against the vendored `vatdeclaration.xsd`; CSV output snapshot-tested.
- **`StatutoryReportService`:** integration tests for assembly (EUR base amounts, locked vs
  open mode, credit-note line inclusion, declarant hard-block).
- **`CreditNotesService`:** cap guard, partial credit, vatCode inheritance, locked-period
  redirect, correction-kind delegation.
- **REST/e2e:** download endpoint (xml/csv/zip), `document-metadata` PATCH lock guard,
  credit-note create/list.
- **Triage:** `supplier_invoice_number` extraction + HITL on missing.

## Suggested follow-up ADR

ADR-0033 — "Country-plugin statutory report generation seam": records that statutory-report
rendering and all jurisdiction filing rules live behind `generateStatutoryReports`, the kernel
only assembles a neutral input, and credit notes are first-class.
