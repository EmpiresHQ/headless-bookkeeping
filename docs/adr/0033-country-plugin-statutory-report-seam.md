# Statutory report generation lives behind a country-plugin seam; credit notes are first-class

## Status
Accepted (2026-06-11).

## Context
The kernel computed VAT (boxes / payable / receivable per `vat_code`) but produced
**no filing artifact**. An Estonian VAT payer must file the **KMD**
(käibedeklaratsioon) monthly together with the **KMD INF** appendix (per-invoice
listing of transactions ≥ €1000 net per partner). Each jurisdiction has its own
filing format, so the rendering and all the jurisdiction rules around it (which
rates are reportable, the per-partner threshold, B2C exclusion, `vat_code` → box
mapping, declarant-id format) must not leak into the kernel.

A second gap surfaced: the Estonian INF requires **credit notes** to appear as
attributed lines, but the system modelled only internal corrections
(reverse + re-dated repost, ADR-0009), never a formal credit document.

## Decision

**1. A country-plugin renders the statutory report from a neutral input.**
`CountryPlugin.generateStatutoryReports(input, { formats }) → { artifacts, warnings }`
is the sole seam (ADR-0002). The kernel's `StatutoryReportService` assembles a
jurisdiction-neutral `StatutoryReportInput` — VAT boxes (reusing
`VatReportService.generate`, idempotent: locked→snapshot, open→live), declarant
identity (`OrganizationService`), and per-document INF lines via a direct Kysely
join (`sales_invoice`/`expense`/`credit_note` → `voucher` → `voucher_line` →
`entity` + `entity_identifier`), amounts in EUR from `base_amount` — and hands it
to the active plugin. The plugin stays **pure** (no DB) and owns every
jurisdiction rule. `NullCountryPlugin` returns empty artifacts.

**2. The Estonia plugin emits the real EMTA format.** It renders a single
`vatDeclaration` XML validated in tests against the official, version-pinned
`vatdeclaration.xsd` (KMD6, valid from 2025-07-01) **and** the official KMD CSV.
INF eligibility (standard rates 24/13/9 only; B2C excluded; €1000-net-per-partner
threshold) lives in the plugin and is unit-tested in isolation. X-tee
machine-to-machine submission is **out of scope** — we produce a downloadable
file the operator uploads via "Add data from file".

**3. Credit notes are a first-class object.** A `credit_note` row (a "negative
invoice" referencing a posted `sales_invoice`/`expense`) is posted by
`CreditNotesService` as a **sign-flipped, proportionally-scaled mirror** of the
original's voucher, with the rounding residual absorbed on the counterparty
(AR/AP) line so it balances exactly in both transaction and base currency. Rules:
partial allowed, multiple per original allowed (ADR-0006 "reversed-once" does NOT
apply), cumulative gross capped at the original, vatCode/currency inherited, and
the ADR-0009 locked-period redirect reused. The `credit_note` correction kind
delegates here. Credit notes flow into INF assembly as ordinary (negative) lines.

**4. Reporting modes.** A `locked` period yields a deterministic `final` report
(built from the snapshot's immutable vouchers); an `open` period yields a `draft`
preview from live tables. A `final` report without a valid declarant commercial
registry code is hard-blocked; INF data gaps (missing invoice number on a qualifying
line, etc.) surface as `statutory_report_incomplete` audit findings so they can be
fixed pre-lock (a metadata-only `PATCH /expenses/:id/document-metadata` sets the
opaque `supplier_invoice_number` while the period is open).

## Consequences
- New jurisdictions add a plugin implementing `generateStatutoryReports`; the
  kernel assembly and REST/SPA path are unchanged.
- XML correctness is anchored to the official XSD in CI, so "it imports into
  e-MTA" is a tested property, not a hope. Schema bumps are plugin-only changes.
- As corrected for #196, the input carries the declaration built from signed
  ledger bases. XML and CSV use these exact amounts, including zero-rated
  supplies and reverse-charge acquisitions; reduced 9% and 13% bases stay
  separate. Supply bases are credit-positive and acquisition bases debit-positive,
  so reversals subtract. VAT amounts are never divided by rates to infer bases.
- Declarant identity uses `organization.registry_code` (8 digits for an Estonian
  company), separately from `vat_registration_number`. Migration 066 leaves it
  null for existing organizations; the operator must enter it before final export.
- The current domain produces one VAT rate per document, so INF emits one line per
  document. Mixed-rate line-item documents would require grouping by `vat_code`
  within a document — explicitly deferred.

## Amendment (issue #200, 2026-09-20): draft reads live, final replays frozen

Decision 4 said a `locked` period yields a deterministic `final` "built from the
snapshot's immutable vouchers" and an `open` period a `draft` preview. The
implementation reached both through `VatReportService.generate`, which **freezes**
— so downloading a draft froze the filing state, and a later lock filed that
premature snapshot while the XML was assembled from live data.

Corrected:

- A **draft** is assembled entirely from `VatReportService.preview` and the live
  tables. It stores nothing.
- Closing a period freezes, atomically, a complete `vat_report` **and** a
  `statutory_filing_snapshot` holding the whole `StatutoryReportInput`. A
  snapshot that drifted (frozen early) is superseded by a fresh one rather than
  reused; the stale row is retained, immutable, and flagged as an audit finding.
- A **final** replays that frozen payload verbatim — including the declarant
  identity and the **rendering jurisdiction**. Resolving the plugin from
  `organization.country` at export time would let a later country change alter,
  or (via `NullCountryPlugin`) silently empty, an already-filed artifact.
- A locked period with no frozen payload has no reproducible final: the export
  **refuses (409)** and points at the reconciliation endpoint. It offers no
  "reconstructed" variant on purpose — neither the KMD XML nor the CSV has a
  field that marks an artifact as a rebuild, so any file produced there would be
  indistinguishable from a real filing to a caller reading only the bytes. The
  live figures remain available through the read-only VAT-report preview.
