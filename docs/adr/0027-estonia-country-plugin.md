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
