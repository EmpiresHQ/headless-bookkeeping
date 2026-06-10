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
preview from live tables. A `final` report without a declarant VAT registration
number is hard-blocked; INF data gaps (missing invoice number on a qualifying
line, etc.) surface as `statutory_report_incomplete` audit findings so they can be
fixed pre-lock (a metadata-only `PATCH /expenses/:id/document-metadata` sets the
opaque `supplier_invoice_number` while the period is open).

## Consequences
- New jurisdictions add a plugin implementing `generateStatutoryReports`; the
  kernel assembly and REST/SPA path are unchanged.
- XML correctness is anchored to the official XSD in CI, so "it imports into
  e-MTA" is a tested property, not a hope. Schema bumps are plugin-only changes.
- The KMD declaration-body box net values are back-derived per rate from output
  VAT (`net = round(vat / rate)`) because the VAT snapshot stores VAT amounts, not
  per-rate taxable bases; INF line amounts come straight from `base_amount`. If a
  future requirement needs exact per-rate taxable bases on the boxes, the
  assembly must carry them in the neutral input.
- The current domain produces one VAT rate per document, so INF emits one line per
  document. Mixed-rate line-item documents would require grouping by `vat_code`
  within a document — explicitly deferred.
