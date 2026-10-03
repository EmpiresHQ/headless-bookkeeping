# Estonia country plugin: first real jurisdiction, CountryPluginRetrieval, and distribution-tax model

`NullCountryPlugin` (IE/EUR defaults) was the only concrete `CountryPlugin` in production — every real-jurisdiction path (cross-currency FX, EU reverse-charge, semantic-Rule overrides, and the distributable-profits cap) was reachable only via test doubles. Estonia is the first real jurisdiction: a well-documented, EUR-base, monthly-VAT country with a distinctive company-level distribution tax (CIT-on-distribution), making it the ideal first non-null plugin.

## Decision

### 1. `EstoniaCountryPlugin` as the first real jurisdiction

`EstoniaCountryPlugin implements CountryPlugin`, registered in `PluginLoader` under `'EE'`. All Estonian VAT and distribution facts are encoded as of 2026-06, sourced from:

- **EY** — "Significant tax changes in Estonia 2025–2026"
- **Estonian Tax & Customs Board (EMTA)** — emta.ee
- **VATupdate.com** — Estonia 2025 rate change summaries

Verified facts:

| Dimension | Value |
|---|---|
| Standard VAT rate | **24%** (raised from 22%, effective 2025-07-01) |
| Accommodation VAT rate | **13%** (raised from 9%, effective 2025-01-01) |
| Reduced rate (books, press/periodicals, medicines, medical devices) | **9%** |
| Zero rate | Export outside EU; intra-Community supply |
| Intra-EU B2B acquisition | Reverse-charge — buyer self-accounts at 24% |
| VAT period | **Monthly** |
| VAT registration threshold | **€40,000** (turnover) |
| Base currency | **EUR** |

VAT codes introduced: `EE_OUTPUT_24`, `EE_INPUT_24`, `EE_OUTPUT_13`, `EE_INPUT_13`, `EE_OUTPUT_9`, `EE_INPUT_9`, `EE_ZERO`, `EE_REVERSE_CHARGE`. The kernel sentinel `NULL_STANDARD` (ADR-0002) is also recognized by the plugin as a no-VAT marker; it remains kernel-owned.

### 2. `CountryPluginRetrieval` — compute-only sub-interface for the advisory agent

`CountryPlugin` now `extends CountryPluginRetrieval` (new file `country-plugin-retrieval.interface.ts`). `CountryPluginRetrieval` is a **compute-only, side-effect-free** surface with four methods:

| Method | Purpose |
|---|---|
| `getVatRate(vatCode)` | Numeric rate (0.0–1.0) for a VAT code; 0 for zero/exempt/sentinel |
| `computeVat(netMinorUnits, vatCode)` | Pure VAT arithmetic → `VatComputation { net, vat, gross, rate }` |
| `previewExpenseTreatment(category, supplierFacts, orgContext)` | "What would this expense book as" — composes category mapping + cross-border, posts nothing |
| `getVatRegistrationThreshold(orgContext)` | Jurisdiction registration threshold in base-currency minor units, or null |

The advisory ("consultant") agent's tools type against `CountryPluginRetrieval` exclusively — they **read and calculate, register nothing**. This is not a new class or module: every `CountryPlugin` already satisfies it (the full plugin is a superset). The narrow typing prevents advisory tools from accidentally reaching the resolution/posting methods of the full interface.

`NullCountryPlugin` implements the four methods with IE-appropriate defaults (rates for `IE_INPUT_23`/`IE_OUTPUT_23`; threshold null). `StrictTestPlugin` inherits from Null. Every `CountryPlugin` implementor must implement the four methods — a missing method is a compile error.

### 3. `resolveDistributionTax` — company-level on-top model

The `CountryPlugin` interface gains one new method:

```typescript
resolveDistributionTax(
  netToOwner: number,
  orgContext: OrgContext,
): { accountCode: string; amount: number } | null;
```

This models a **company-level tax paid on top of a dividend** — distinct in two ways from `dividendWithholdingRate`:

- **Withholding** is deducted *from* the shareholder's gross → the shareholder receives net.
- **Distribution tax** is paid *by the company on top* of the net distribution → the shareholder receives the full declared amount; the company pays additional tax.

Estonia uses the distribution-tax model: **CIT = 22/78 of the net distribution** (= 22% of the grossed-up amount). The 14%/7% reduced-rate regime for regularly-distributed profits was **abolished from 2025**; only the 22/78 rate applies. `resolveDistributionTax` returns `{ accountCode: 'DISTRIBUTION_TAX_PAYABLE', amount: Math.round(netToOwner × 22 / 78) }` for EE, and `null` for jurisdictions with no such tax (IE, Null, and any plugin that does not override it).

### 4. `DISTRIBUTION_TAX_PAYABLE` account (migration 034) + `DividendsService` 4-line booking

A new kernel-canonical liability account `DISTRIBUTION_TAX_PAYABLE` is added in migration 034. `DividendsService.declare` books four lines when a country plugin returns a non-null distribution tax:

```
Dr  RETAINED_EARNINGS           (gross_amount + distTaxAmount)   ← total equity hit
Cr  DIVIDEND_PAYABLE            (net to owner)
Cr  DIVIDEND_WITHHOLDING_TAX_PAYABLE  (withholding, if > 0)
Cr  DISTRIBUTION_TAX_PAYABLE    (distribution tax, if > 0)
```

Balance invariant: `retainedDebit = netPayable + withholdingAmount + distTaxAmount`. For Estonia (no withholding, 22/78 distribution tax), a €1,000 net distribution books as:

```
Dr  RETAINED_EARNINGS       128,205 cents   (100,000 + 28,205)
Cr  DIVIDEND_PAYABLE        100,000 cents
Cr  DISTRIBUTION_TAX_PAYABLE  28,205 cents
```

The three-line schema (Dr RE / Cr DIVIDEND_PAYABLE / Cr DWT) for jurisdictions without distribution tax is unchanged — the fourth line is added only when `resolveDistributionTax` returns non-null.

`assertDistributable` for EE checks that `gross + distributionTax(gross) ≤ retainedEarnings`, because the total equity hit includes the on-top tax. `dividendWithholdingRate` for EE returns `0.0` (Estonia has no shareholder withholding tax).

## Why

Estonia over IE (the Null default) as the first real plugin: EUR base currency avoids a new FX requirement for the first real jurisdiction; the CIT-on-distribution model is a genuine interface extension (`resolveDistributionTax`) with accounting substance; the EU reverse-charge path is exercisable. Estonia is one of the closest real jurisdictions to the existing neutral-plugin architecture, while still exercising every new path.

`CountryPluginRetrieval` as a sub-interface rather than a separate service: every `CountryPlugin` is already a superset of the compute-only surface. Introducing a separate advisory-VAT service would duplicate the rate tables and create a two-way sync problem. Narrowing the type at the call site (advisory tool receives `CountryPluginRetrieval`, not `CountryPlugin`) is sufficient — the same object, a narrower contract at the boundary.

`resolveDistributionTax` on `CountryPlugin` (not a separate interface): it is a country-jurisdiction rule (ADR-0002), and the method returns `null` for most jurisdictions (zero implementation cost). Splitting it into an opt-in interface (e.g. `HasDistributionTax`) would be correct but premature — with only one real jurisdiction today, the null-return default is simpler.

## Consequences

- `src/plugins/country-plugin-retrieval.interface.ts` — new; exports `CountryPluginRetrieval`, `VatComputation`, `ExpenseTreatmentPreview`.
- `src/plugins/country-plugin.interface.ts` — extends `CountryPluginRetrieval`; gains `resolveDistributionTax`.
- `src/plugins/estonia-country.plugin.ts` — new; `EstoniaCountryPlugin @Injectable()`.
- `src/plugins/null-country.plugin.ts` — implements the 4 retrieval methods + `resolveDistributionTax → null`.
- `src/plugins/plugin-loader.service.ts` — registers `'EE' → EstoniaCountryPlugin`.
- `src/database/migrations/034_add_distribution_tax_account.ts` — `DISTRIBUTION_TAX_PAYABLE` liability account.
- `src/dividends/dividends.service.ts` — 4-line booking in `declare()`.
- New domain terms (CONTEXT.md): `CountryPluginRetrieval`, `resolveDistributionTax`, `DISTRIBUTION_TAX_PAYABLE`, `distribution tax`.

## Documented limitations

1. **EU set by political country code.** `EstoniaCountryPlugin.EU` is keyed on ISO-3166-1 alpha-2 codes. This does not model VAT-territory sub-region exceptions (Canary Islands excluded from EU VAT territory, Monaco included, etc. — per ADR-0002 and CONTEXT.md "VAT territory"). These exceptions require a separate territory-membership map per plugin and are deferred; they affect a small fraction of transactions for the target persona.

2. **Reverse-charge is a classification marker only.** `resolveCrossBorderTreatment` returns `EE_REVERSE_CHARGE` as the VAT code on intra-EU acquisitions. The full two-sided posting (output VAT box + input VAT box, netting to zero) required for the EE VAT return is a **VAT-report layer concern**, not a classification concern. The plugin marks the code; the VAT-report layer (deferred) interprets it. This is consistent with ADR-0002: the plugin is the sole resolver of the VAT code; report generation is separate.

3. **FX rates are v1 hardcoded placeholders.** `getReferenceRate` uses a static table (`USD→EUR: 0.92`, `GBP→EUR: 1.16`). Live ECB rate fetching is a tracked debt: `getReferenceRate` is a pure synchronous function and cannot perform I/O; making it async requires an interface change (deferred). The hardcoded rates unblock the realized-FX and cross-currency test paths.

## Amendment (issue #209): service sales are decided by facts, or refused

The revenue mapping originally read one condition — "another EU country AND the
counterparty deals in services" — and answered 24% for everything else. That
charged Estonian VAT on a general-rule service sold to a US business, and
zero-rated a service sold to a Finnish CONSUMER purely because Finland is in the
EU. Neither follows from KMS §10: the place of a general-rule service turns on
whether the recipient is a **taxable person acting as such**, which is a fact
about the customer, not an inference from its country.

Two facts were added rather than a cleverer inference:

- `entity.tax_status` — `taxable_business | non_taxable | unknown`. The
  counterparty's status (never our own registration, which is #211's subject).
  Existing rows are NOT backfilled: they stay unknown.
- `sales_invoice.supply_type` + `sales_invoice.service_place_rule` — what this
  invoice supplies and under which place-of-supply rule. `service_place_rule`
  defaults to `general` because the general rule IS the residual one; an
  exception exists only when a caller declares it.

The plugin then maps the EMTA general-rule table (see the guide for the matrix),
distinguishing the two zero-rates with separate VAT codes — `EE_OUTPUT_0_EU`
(KMD rows 3 **and 3.1**, VD tähis 3S) and `EE_OUTPUT_0_3RD_COUNTRY` (row 3 only,
no VD), because row 3.1 and the VD are both reports on supplies to other member
states. `KmdBaseClassification.outputSubRow` carries that breakdown, so the
jurisdiction-agnostic VAT report never learns what "3.1" means.

**Refusal is part of the contract.** When a fact that decides the treatment is
missing or contradictory, `resolveCategoryMapping` throws
`UnresolvedVatTreatmentError` (HTTP 422) carrying the missing fact and the call
that supplies it, and nothing is posted. The kernel's usual escapes do not fit
here: holding for approval and "booking conservatively" both still put a number
on a return that the facts do not support, and a semantic override relaxes a
RULE, whereas this is an absent FACT. An unknown status is treated as unknown,
never as a consumer. The one place an unknown is allowed through is a DOMESTIC
supply, where it cannot change the answer (24% either way).

Rates are read at the invoice's tax point (`getVatRate(code, onDate?)`), so a
back-dated invoice is measured against the rate that governed it (EE: 20% →
22% from 2024-01-01 → 24% from 2025-07-01) rather than today's.

### Documented limitations (as amended)

4. **Only the general rule is implemented.** Every named place-of-supply
   exception is refused with an actionable message. Implementing one means
   adding the facts its rule actually needs (e.g. where the property is), not
   widening the default.

5. **Goods sales are untouched.** Their place of supply follows the movement of
   the goods, which this issue does not model; a goods sale keeps the standard
   domestic mapping.

6. **The tax-amount check is scoped to service sales.** A service sale's
   `vat_amount` must equal the resolved rate on the net, because the treatment
   was derived from facts and is therefore checkable. Goods sales and purchases
   keep the tax their document states — the kernel has never recomputed those.

### Two consequences of adding a declaration row and a refusal

**A frozen filing payload is never rewritten.**
`statutory_filing_snapshot.payload` is the artifact a filing was made from, so a
payload frozen before field 3.1 had its own declaration row keeps its exact
bytes. It is normalized on READ
(`normalizeFrozenStatutoryInput`): a missing `row3_1_intra_eu_supply` is read as
`vd_intra_eu_services`, which is what the XML/CSV box was rendered from at the
time. An old payload therefore still renders byte-identically and XSD-valid
instead of emitting `NaN`.

**A refusal needs a remedy on the refused object.**
`PATCH /api/sales-invoices/:id` corrects a DRAFT (or pending) invoice's
`supply_type`, `service_place_rule` and amounts, because the invoice number is
unique and re-creating the invoice returns 409. A POSTED invoice is refused with
409 — its voucher is immutable and is corrected by reversal (ADR-0006).
Customer-side facts stay on `PATCH /api/entities/:id`.
