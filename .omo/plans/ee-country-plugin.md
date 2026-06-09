# Estonia (EE) Country Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a real **Estonia (EE)** country plugin — the first non-null jurisdiction — which (a) implements full Estonian VAT (24% standard, 13% accommodation, 9% reduced, 0% export/IC, reverse-charge), monthly periods, EUR, and **real cross-currency FX** (unblocking the realized-FX + semantic-Rules-override paths that `NullCountryPlugin` can't exercise); (b) adds a compute-only **`CountryPluginRetrieval`** sub-interface for the advisory agent; and (c) models Estonia's **CIT-on-distribution** (22/78 tax *on top* of dividends, distinct from withholding).

**Architecture:** `EstoniaCountryPlugin implements CountryPlugin` (in `src/plugins/`), registered in `PluginLoader` under `'EE'`. The `CountryPlugin` interface is extended along two axes: it now `extends CountryPluginRetrieval` (new compute-only methods: `getVatRate`, `computeVat`, `previewExpenseTreatment`, `getVatRegistrationThreshold` — for the advisory agent's read-only tools, register nothing), and it gains `resolveDistributionTax(netToOwner, orgContext): { accountCode; amount } | null` (Estonia's company-level distribution tax, booked *on top*). `NullCountryPlugin` and `StrictTestPlugin` implement the new methods (Null: zero/null defaults). A new `DISTRIBUTION_TAX_PAYABLE` account (migration 034) + a `DividendsService.declare` change book the on-top tax line. See ADR-0002 (plugin boundary), ADR-0004 (FX), ADR-0023 (dividends), and new **ADR-0027** (this plugin + the two interface extensions).

**Tech Stack:** NestJS 11, Kysely 0.29 over better-sqlite3, Jest 30, TypeScript strict. **Node 24** (`.nvmrc`=24; gate fails under Node 22 — better-sqlite3 NODE_MODULE_VERSION mismatch).

**Branch:** `ee-country-plugin` (off `wave-8-interaction`, so ADR/migration numbers don't collide with the unmerged wave-8 work: next ADR = 0027, next migration = 034).

---

## Guardrails (apply to every task)

- **G1 — gate under Node 24.** Prefix every shell: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null;`. Final commit of every task preceded by `npm run build && npm run lint && npm test` green (+ `test:e2e` for the last task). Never commit on red.
- **G2 — real-DI integration tests** for DB-touching behavior (in-memory `Kysely<Database>` + `Migrator.migrateToLatest()` + `Test.createTestingModule`). Plugin methods are pure → most plugin tests are plain unit tests (no DB), except the DividendsService change (real-DI).
- **G3 — discriminating assertions.** Assert EE-specific values that differ from Null/IE (e.g. `EE_INPUT_24`, rate `0.24`, distribution tax `282` on `1000`) — never just truthiness.
- **G4 — schema only in migrations.** The one new table/account migration is `034_add_distribution_tax_account.ts`. Grep gate empty: `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"`.
- **G5 — no `any`, no `as`.** Strict TS; `npm run lint` enforces.
- **The new interface methods must be implemented by EVERY `CountryPlugin`** — `NullCountryPlugin`, `StrictTestPlugin` (extends Null → inherits), and the `MockWithholdingPlugin`/any test plugins in specs. A missing method is a compile error; Task 1 updates Null so the build stays green before EE exists.

## Assumed current contracts (verified)

- `CountryPlugin` interface (`src/plugins/country-plugin.interface.ts`): 13 methods incl. `getName`, `getVATCodes(): VATCode[]`, `resolveCategoryMapping(category, supplierFacts: SupplierFacts, orgContext: OrgContext): CategoryMappingResult`, `getPeriodFrequencyOptions(): string[]`, `getDefaultPeriodFrequency(): string`, `getDefaultBaseCurrency(): string`, `getReferenceRate(from, to, date): number`, `roundToBaseMinorUnits(amount): number`, `validateVATCode(vatCode, {supplier, org}): boolean`, `resolvePersonalDispositionAccount(orgType): string`, `resolveCrossBorderTreatment(supplierFacts, orgContext, {vatCharged}): CrossBorderResolution`, `dividendWithholdingRate(orgContext): number`, `assertDistributable(grossAmount, retainedEarnings, orgContext): boolean`.
- Types: `SupplierFacts = { country: string; goodsVsServices: 'goods'|'services'|'unknown'; classificationMemory: string[] }`; `OrgContext = { country: string; vatRegistered: boolean; baseCurrency: string | null }`; `CategoryMappingResult = { accountCode: string; vatCode: VATCode }`; `CrossBorderTreatment = 'domestic'|'reverse_charge'|'import'|'foreign_cost'|'unresolvable'`; `CrossBorderResolution = { treatment: CrossBorderTreatment; vatCode: VATCode | null }`; `VATCode = string`.
- `NullCountryPlugin` (`src/plugins/null-country.plugin.ts`): IE/EUR neutral; `getVATCodes()`→`['NULL_STANDARD','IE_INPUT_23','IE_OUTPUT_23']`; same-currency FX only (throws on cross-currency); `roundToBaseMinorUnits`→`Math.round`; `resolvePersonalDispositionAccount`: sole_proprietor→`OWNERS_DRAWINGS`, else→`SHAREHOLDER_LOAN`; `dividendWithholdingRate`→0; `assertDistributable`→soft (logs, returns true).
- `StrictTestPlugin extends NullCountryPlugin` (`src/plugins/strict-test.plugin.ts`): test-only, overrides validate to reject `STRICT_REJECTED`.
- `PluginLoader` (`src/plugins/plugin-loader.service.ts`): `constructor(nullPlugin)`, `plugins: Map<string,CountryPlugin>` seeded `{'null': nullPlugin}`, `resolve(code)` → `plugins.get(code) ?? nullPlugin` (warns once). `PluginsModule` providers/exports `[NullCountryPlugin, PluginLoader]`.
- `NULL_VAT_CODE = 'NULL_STANDARD'` (`src/ledger/posting/vat-constants.ts`) — kernel sentinel; plugins reference but don't own it.
- Canonical accounts incl. `REVENUE`, `EXPENSE_SOFTWARE/_TRANSPORT/_TRAVEL/_MARKETING/_SALARY/_CONTRACTOR/_RENT/_TAX/_BANK_FEE/_MEALS/_INSURANCE/_EDUCATION/_OTHER`, `AR`, `AP`, `VAT_PAYABLE`, `VAT_RECEIVABLE`, `RETAINED_EARNINGS`, `DIVIDEND_PAYABLE`, `DIVIDEND_WITHHOLDING_TAX_PAYABLE`, `OWNERS_DRAWINGS`, `SHAREHOLDER_LOAN`.
- `DividendsService.declare` (`src/dividends/dividends.service.ts:62`): builds `Dr RETAINED_EARNINGS (gross) / Cr DIVIDEND_PAYABLE (net=gross−withholding) / Cr DIVIDEND_WITHHOLDING_TAX_PAYABLE (withholding, if >0)`; `withholding = round(gross × dividendWithholdingRate)`; calls `assertDistributable(gross, getDistributableProfits(), org)` (throws BadRequest if false). Account-code constants at top of the service file.

---

## Estonian facts (verified 2026-06, sources in ADR-0027)

- Standard VAT **24%** (since 2025-07-01). Accommodation **13%** (since 2025-01-01). Reduced **9%** (books, press/periodicals, medicines, medical devices). Export-outside-EU & intra-Community supply **0%**. Reverse-charge for intra-EU B2B acquisitions (buyer self-accounts at the standard rate).
- VAT period **monthly**. Registration threshold **€40,000**. Base currency **EUR**.
- Owner withdrawal: a company distribution is taxed at the **company** level — CIT **22/78 of the net distribution** (= 22% of the grossed-up amount), paid by the company **on top** of the dividend; the shareholder receives the full declared amount (no withholding). The 14%/7% reduced-rate regime was abolished from 2025.

---

## File Structure

```
src/plugins/
  country-plugin-retrieval.interface.ts   # NEW: CountryPluginRetrieval (compute-only, advisory)
  country-plugin.interface.ts             # MODIFY: extends CountryPluginRetrieval; + resolveDistributionTax
  null-country.plugin.ts                  # MODIFY: implement the new methods (zero/null defaults)
  estonia-country.plugin.ts               # NEW: EstoniaCountryPlugin
  estonia-country.plugin.spec.ts          # NEW: unit tests (pure)
  plugin-loader.service.ts                # MODIFY: register 'EE'
  plugins.module.ts                       # MODIFY: provide/export EstoniaCountryPlugin
src/database/migrations/
  034_add_distribution_tax_account.ts     # NEW: DISTRIBUTION_TAX_PAYABLE account
  index.ts                                # MODIFY: register 034
src/dividends/
  dividends.service.ts                    # MODIFY: book on-top distribution tax line
  dividends.service.spec.ts               # MODIFY: EE distribution-tax test
docs/adr/0027-estonia-country-plugin.md   # NEW
```

---

## Task 1: `CountryPluginRetrieval` sub-interface + `resolveDistributionTax` on `CountryPlugin` + Null defaults

This task extends the interface and keeps the build green by implementing the new methods on `NullCountryPlugin` (zero/null defaults). No EE yet.

**Files:**
- Create: `src/plugins/country-plugin-retrieval.interface.ts`
- Modify: `src/plugins/country-plugin.interface.ts`, `src/plugins/null-country.plugin.ts`
- Test: `src/plugins/null-country.plugin.spec.ts` (extend if exists; else add)

- [ ] **Step 1: Create the retrieval sub-interface**

```typescript
// src/plugins/country-plugin-retrieval.interface.ts
import { CategoryMappingResult, CrossBorderTreatment, OrgContext, SupplierFacts, VATCode } from './country-plugin.interface';

/** A VAT computation broken out for display — nothing is posted or registered. */
export interface VatComputation {
  netMinorUnits: number;
  vatMinorUnits: number;
  grossMinorUnits: number;
  rate: number;
}

/** A read-only preview of how an expense WOULD book — registers nothing. */
export interface ExpenseTreatmentPreview {
  accountCode: string;
  vatCode: VATCode;
  rate: number;
  treatment: CrossBorderTreatment;
}

/**
 * Compute-only, side-effect-free methods for the advisory ("consultant") agent.
 * Everything here READS/CALCULATES and registers NOTHING — no posting, no DB
 * writes. The advisory agent's tools type against THIS narrow surface so they
 * cannot reach the resolution/posting methods of the full CountryPlugin.
 */
export interface CountryPluginRetrieval {
  /** Numeric VAT rate (0.0–1.0) for a plugin VAT code. 0 for zero/exempt/sentinel. */
  getVatRate(vatCode: VATCode): number;

  /** Pure VAT arithmetic on a net amount (minor units) under a VAT code. */
  computeVat(netMinorUnits: number, vatCode: VATCode): VatComputation;

  /** Read-only "what would this expense book as" — composes category + cross-border. Posts nothing. */
  previewExpenseTreatment(
    category: string,
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
  ): ExpenseTreatmentPreview;

  /** Jurisdiction VAT registration threshold in base-currency minor units, or null if none. */
  getVatRegistrationThreshold(orgContext: OrgContext): number | null;
}
```

- [ ] **Step 2: Extend `CountryPlugin` (interface)**

In `src/plugins/country-plugin.interface.ts`:
- Add `import { CountryPluginRetrieval } from './country-plugin-retrieval.interface';`
- Change the declaration to `export interface CountryPlugin extends CountryPluginRetrieval {` (keep all existing methods).
- Add the distribution-tax method with this doc + signature:
```typescript
  /**
   * Company-level tax due ON TOP of a dividend distribution, distinct from
   * `dividendWithholdingRate` (which is withheld FROM the shareholder).
   * Estonia taxes distributed profit at the company: CIT = 22/78 of the net
   * distribution, paid additionally; the shareholder receives the full amount.
   * Returns the tax account + amount (minor units), or null when the
   * jurisdiction has no such tax (IE/Null → null).
   *
   * @param netToOwner - the net amount the owner receives (base-currency minor units)
   */
  resolveDistributionTax(
    netToOwner: number,
    orgContext: OrgContext,
  ): { accountCode: string; amount: number } | null;
```

- [ ] **Step 3: Write failing tests for Null's new methods**

```typescript
// src/plugins/null-country.plugin.spec.ts  (add these; create the file if absent, mirroring existing plugin spec style)
import { NullCountryPlugin } from './null-country.plugin';
import { OrgContext, SupplierFacts } from './country-plugin.interface';

describe('NullCountryPlugin — retrieval + distribution tax', () => {
  const plugin = new NullCountryPlugin();
  const org: OrgContext = { country: 'IE', vatRegistered: true, baseCurrency: null };
  const supplier: SupplierFacts = { country: 'IE', goodsVsServices: 'services', classificationMemory: [] };

  it('getVatRate maps IE codes to 0.23 and sentinel to 0', () => {
    expect(plugin.getVatRate('IE_INPUT_23')).toBe(0.23);
    expect(plugin.getVatRate('IE_OUTPUT_23')).toBe(0.23);
    expect(plugin.getVatRate('NULL_STANDARD')).toBe(0);
  });

  it('computeVat returns net/vat/gross at the code rate', () => {
    expect(plugin.computeVat(10000, 'IE_INPUT_23')).toEqual({
      netMinorUnits: 10000, vatMinorUnits: 2300, grossMinorUnits: 12300, rate: 0.23,
    });
  });

  it('previewExpenseTreatment composes mapping + domestic treatment, posts nothing', () => {
    const preview = plugin.previewExpenseTreatment('software', supplier, org);
    expect(preview.accountCode).toBe('EXPENSE_SOFTWARE');
    expect(preview.vatCode).toBe('IE_INPUT_23');
    expect(preview.rate).toBe(0.23);
    expect(preview.treatment).toBe('domestic');
  });

  it('getVatRegistrationThreshold is null for the neutral plugin', () => {
    expect(plugin.getVatRegistrationThreshold(org)).toBeNull();
  });

  it('resolveDistributionTax is null (no distribution tax in IE/Null)', () => {
    expect(plugin.resolveDistributionTax(10000, org)).toBeNull();
  });
});
```

- [ ] **Step 4: Run to verify fail**

Run: `nvm use 24 && npx jest src/plugins/null-country.plugin.spec.ts`
Expected: FAIL — methods missing (and `tsc` errors that `NullCountryPlugin` doesn't implement the new interface members).

- [ ] **Step 5: Implement the new methods on `NullCountryPlugin`**

Add to `null-country.plugin.ts` (a small rate map keyed by its own codes):
```typescript
  getVatRate(vatCode: string): number {
    const rates: Record<string, number> = { IE_INPUT_23: 0.23, IE_OUTPUT_23: 0.23 };
    return rates[vatCode] ?? 0;
  }

  computeVat(netMinorUnits: number, vatCode: string): VatComputation {
    const rate = this.getVatRate(vatCode);
    const vatMinorUnits = Math.round(netMinorUnits * rate);
    return { netMinorUnits, vatMinorUnits, grossMinorUnits: netMinorUnits + vatMinorUnits, rate };
  }

  previewExpenseTreatment(category: string, supplierFacts: SupplierFacts, orgContext: OrgContext): ExpenseTreatmentPreview {
    const mapping = this.resolveCategoryMapping(category, supplierFacts, orgContext);
    const cross = this.resolveCrossBorderTreatment(supplierFacts, orgContext, { vatCharged: true });
    return { accountCode: mapping.accountCode, vatCode: mapping.vatCode, rate: this.getVatRate(mapping.vatCode), treatment: cross.treatment };
  }

  getVatRegistrationThreshold(_orgContext: OrgContext): number | null {
    return null;
  }

  resolveDistributionTax(_netToOwner: number, _orgContext: OrgContext): { accountCode: string; amount: number } | null {
    return null;
  }
```
Add the imports for `VatComputation`, `ExpenseTreatmentPreview` from `./country-plugin-retrieval.interface`. `StrictTestPlugin` extends Null → inherits these (no change needed; verify it still compiles).

> Any other `CountryPlugin` implementor in test files (e.g. `MockWithholdingPlugin` in `dividends.service.spec.ts`) must also gain the 5 new methods to compile — add minimal stubs there (returning the same null/0 defaults). Grep: `grep -rln "implements CountryPlugin" src --include=*.ts`.

- [ ] **Step 6: Run to verify pass + full build**

Run: `nvm use 24 && npm run build && npm run lint && npm test`
Expected: build 0 (every `CountryPlugin` implementor now satisfies the extended interface), lint 0, all suites green.

- [ ] **Step 7: Commit**

```bash
git add src/plugins/country-plugin-retrieval.interface.ts src/plugins/country-plugin.interface.ts src/plugins/null-country.plugin.ts src/plugins/null-country.plugin.spec.ts
git commit -m "feat(plugins): CountryPluginRetrieval (compute-only advisory surface) + resolveDistributionTax; Null defaults"
```
(Include any test-plugin stub files touched in step 5 in the add.)

---

## Task 2: `DISTRIBUTION_TAX_PAYABLE` account (migration 034)

**Files:**
- Create: `src/database/migrations/034_add_distribution_tax_account.ts`
- Modify: `src/database/migrations/index.ts`
- Test: `src/database/migrations/migration.spec.ts` (if a migration test exists; else assert via an existing real-DI spec that the account is queryable)

- [ ] **Step 1: Write the migration** (mirror `024_add_dividend_accounts.ts` structure)

```typescript
// src/database/migrations/034_add_distribution_tax_account.ts
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('account')
    .values({
      code: 'DISTRIBUTION_TAX_PAYABLE',
      name: 'Distribution Tax Payable',
      type: 'liability',
      currency: null,
      parent_id: null,
      is_system: 1,
    })
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.deleteFrom('account').where('code', '=', 'DISTRIBUTION_TAX_PAYABLE').execute();
}
```
> Match the exact column set of the `account` insert used in `024_add_dividend_accounts.ts` (it may omit `parent_id`/`is_system` or set them differently) — copy that migration's insert shape verbatim, only changing code/name.

- [ ] **Step 2: Register in `index.ts`**

```typescript
import * as m034 from './034_add_distribution_tax_account';
// ...
  '034_add_distribution_tax_account': m034,
```

- [ ] **Step 3: Write/extend a test that the account exists after migration**

Add to an existing real-DI migration/account spec (mirror how `024`'s accounts are asserted):
```typescript
it('seeds DISTRIBUTION_TAX_PAYABLE (liability) after migration 034', async () => {
  const row = await db.selectFrom('account').selectAll().where('code', '=', 'DISTRIBUTION_TAX_PAYABLE').executeTakeFirstOrThrow();
  expect(row.type).toBe('liability');
});
```

- [ ] **Step 4: Run + build**

Run: `nvm use 24 && npm run build && npm test`
Expected: green (migration chain 001→034 applies clean across all real-DI specs).

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations/034_add_distribution_tax_account.ts src/database/migrations/index.ts
git commit -m "feat(ledger): DISTRIBUTION_TAX_PAYABLE account (migration 034) for company-level distribution tax"
```

---

## Task 3: `EstoniaCountryPlugin` — VAT codes, mapping, validate, period, base currency, rounding, personal disposition

**Files:**
- Create: `src/plugins/estonia-country.plugin.ts`, `src/plugins/estonia-country.plugin.spec.ts`

- [ ] **Step 1: Write the failing test** (the VAT/mapping/period core)

```typescript
// src/plugins/estonia-country.plugin.spec.ts
import { EstoniaCountryPlugin } from './estonia-country.plugin';
import { OrgContext, SupplierFacts } from './country-plugin.interface';

describe('EstoniaCountryPlugin — VAT core', () => {
  const ee = new EstoniaCountryPlugin();
  const org: OrgContext = { country: 'EE', vatRegistered: true, baseCurrency: null };
  const eeSupplier: SupplierFacts = { country: 'EE', goodsVsServices: 'services', classificationMemory: [] };

  it('name + base currency + monthly period', () => {
    expect(ee.getName()).toBe('EE');
    expect(ee.getDefaultBaseCurrency()).toBe('EUR');
    expect(ee.getPeriodFrequencyOptions()).toEqual(['monthly']);
    expect(ee.getDefaultPeriodFrequency()).toBe('monthly');
  });

  it('exposes the EE VAT code set', () => {
    const codes = ee.getVATCodes();
    expect(codes).toEqual(expect.arrayContaining([
      'EE_OUTPUT_24', 'EE_INPUT_24', 'EE_OUTPUT_13', 'EE_INPUT_13',
      'EE_OUTPUT_9', 'EE_INPUT_9', 'EE_ZERO', 'EE_REVERSE_CHARGE', 'NULL_STANDARD',
    ]));
  });

  it('maps revenue → EE_OUTPUT_24 and expenses → EE_INPUT_24 (standard auto-map)', () => {
    expect(ee.resolveCategoryMapping('revenue', eeSupplier, org)).toEqual({ accountCode: 'REVENUE', vatCode: 'EE_OUTPUT_24' });
    expect(ee.resolveCategoryMapping('software', eeSupplier, org)).toEqual({ accountCode: 'EXPENSE_SOFTWARE', vatCode: 'EE_INPUT_24' });
    expect(ee.resolveCategoryMapping('wibble', eeSupplier, org)).toEqual({ accountCode: 'EXPENSE_OTHER', vatCode: 'EE_INPUT_24' });
  });

  it('validateVATCode accepts the EE set + sentinel, rejects unknown', () => {
    expect(ee.validateVATCode('EE_INPUT_24', { supplier: eeSupplier, org })).toBe(true);
    expect(ee.validateVATCode('EE_REVERSE_CHARGE', { supplier: eeSupplier, org })).toBe(true);
    expect(ee.validateVATCode('NULL_STANDARD', { supplier: eeSupplier, org })).toBe(true);
    expect(ee.validateVATCode('DK_INPUT_25', { supplier: eeSupplier, org })).toBe(false);
  });

  it('rounds to whole cents and resolves personal disposition by org type', () => {
    expect(ee.roundToBaseMinorUnits(100.4)).toBe(100);
    expect(ee.resolvePersonalDispositionAccount('company')).toBe('SHAREHOLDER_LOAN');
    expect(ee.resolvePersonalDispositionAccount('sole_proprietor')).toBe('OWNERS_DRAWINGS');
  });
});
```

- [ ] **Step 2: Run to verify fail** → `Cannot find module './estonia-country.plugin'`.

- [ ] **Step 3: Implement the core of `EstoniaCountryPlugin`**

Create `src/plugins/estonia-country.plugin.ts` with `@Injectable()`. Implement the methods in this step (cross-border + FX + retrieval + distribution tax come in Tasks 4–6 — but since TS requires the full interface to compile, implement ALL methods now, with Tasks 4-6 adding their TESTS and refining bodies). Provide:
- `VAT_RATES: Record<string, number>` = `{ EE_OUTPUT_24:0.24, EE_INPUT_24:0.24, EE_OUTPUT_13:0.13, EE_INPUT_13:0.13, EE_OUTPUT_9:0.09, EE_INPUT_9:0.09, EE_ZERO:0, EE_REVERSE_CHARGE:0.24, NULL_STANDARD:0 }` (reverse-charge self-accounted at the standard 24%).
- `getName()`→`'EE'`; `getDefaultBaseCurrency()`→`'EUR'`; `getPeriodFrequencyOptions()`→`['monthly']`; `getDefaultPeriodFrequency()`→`'monthly'`; `roundToBaseMinorUnits(a)`→`Math.round(a)`.
- `getVATCodes()`→`Object.keys(VAT_RATES)` (or the explicit list).
- `resolveCategoryMapping`: `category==='revenue'`→`{REVENUE, EE_OUTPUT_24}`; the 13 expense categories→their `EXPENSE_*` account with `EE_INPUT_24`; unknown→`{EXPENSE_OTHER, EE_INPUT_24}`. (Use the SAME category→account map the Null plugin uses — copy its mapping table, swapping the VAT code to the EE standard.)
- `validateVATCode(code)`→`code in VAT_RATES`.
- `resolvePersonalDispositionAccount(orgType)`→ `orgType==='sole_proprietor' ? 'OWNERS_DRAWINGS' : 'SHAREHOLDER_LOAN'`.
- Stub the remaining methods to be refined/tested in Tasks 4-6: `getReferenceRate` (Task 5), `resolveCrossBorderTreatment` (Task 4), the 4 retrieval methods (Task 6), `resolveDistributionTax` (Task 6 wiring uses it but implement here), `dividendWithholdingRate`→`0.0`, `assertDistributable` (Task 6). To keep this task self-contained and green, implement working bodies for all (the later tasks add their discriminating tests):
  - `getReferenceRate`: same-currency→1.0 + the hardcoded table from Task 5 (implement the table now).
  - `resolveCrossBorderTreatment`: the EU-logic from Task 4 (implement now).
  - retrieval + distribution tax: the bodies from Task 6 (implement now).

> Implementing all bodies in Task 3 (so the class compiles) while Tasks 4-6 add the *tests* that pin each behavior is the pragmatic order for a single class implementing a 17-method interface. Each later task is RED-first against the already-present body only if the body is wrong; if Task 3's body already satisfies a later test, note it and move on (the test still guards regressions).

- [ ] **Step 4: Run to verify pass** → `nvm use 24 && npx jest src/plugins/estonia-country.plugin.spec.ts` PASS (5 tests).

- [ ] **Step 5: Build + lint + commit**

Run: `nvm use 24 && npm run build && npm run lint && npx jest src/plugins`
```bash
git add src/plugins/estonia-country.plugin.ts src/plugins/estonia-country.plugin.spec.ts
git commit -m "feat(plugins): EstoniaCountryPlugin VAT core (codes, mapping, period, EUR, rounding)"
```

---

## Task 4: EE cross-border treatment (the semantic-Rules-override unblocker)

**Files:** Modify `estonia-country.plugin.ts` (refine `resolveCrossBorderTreatment` + add the EU member set), extend `estonia-country.plugin.spec.ts`.

- [ ] **Step 1: Write failing tests**

```typescript
describe('EstoniaCountryPlugin — cross-border', () => {
  const ee = new EstoniaCountryPlugin();
  const org: OrgContext = { country: 'EE', vatRegistered: true, baseCurrency: null };
  const mk = (country: string, gvs: 'goods'|'services'|'unknown'): SupplierFacts => ({ country, goodsVsServices: gvs, classificationMemory: [] });

  it('EE supplier → domestic, EE_INPUT_24', () => {
    expect(ee.resolveCrossBorderTreatment(mk('EE','services'), org, { vatCharged: true }))
      .toEqual({ treatment: 'domestic', vatCode: 'EE_INPUT_24' });
  });
  it('EU supplier (DE) → reverse_charge, EE_REVERSE_CHARGE (our code)', () => {
    expect(ee.resolveCrossBorderTreatment(mk('DE','services'), org, { vatCharged: false }))
      .toEqual({ treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' });
  });
  it('non-EU goods (US) → import', () => {
    expect(ee.resolveCrossBorderTreatment(mk('US','goods'), org, { vatCharged: false }).treatment).toBe('import');
  });
  it('non-EU services (US) with foreign VAT charged → foreign_cost (no reclaim), vatCode null', () => {
    expect(ee.resolveCrossBorderTreatment(mk('US','services'), org, { vatCharged: true }))
      .toEqual({ treatment: 'foreign_cost', vatCode: null });
  });
});
```

- [ ] **Step 2: Run** → the existing Task-3 body may already satisfy some; refine until all pass.

- [ ] **Step 3: Implement `resolveCrossBorderTreatment`**

```typescript
private static readonly EU = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
]);

resolveCrossBorderTreatment(supplierFacts: SupplierFacts, orgContext: OrgContext, context: { vatCharged: boolean }): CrossBorderResolution {
  const supplier = supplierFacts.country;
  if (supplier === orgContext.country) {
    return { treatment: 'domestic', vatCode: 'EE_INPUT_24' };
  }
  if (EstoniaCountryPlugin.EU.has(supplier)) {
    // Intra-Community acquisition — buyer self-accounts with OUR reverse-charge code.
    return { treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' };
  }
  // Non-EU: goods are an import (customs VAT); services are a foreign cost (no EE input VAT to reclaim).
  if (supplierFacts.goodsVsServices === 'goods') {
    return { treatment: 'import', vatCode: 'EE_INPUT_24' };
  }
  return { treatment: 'foreign_cost', vatCode: null };
}
```
> NOTE (documented limitation): the EU set is by political country code; the VAT-territory sub-region exceptions (Canary Islands excluded, Monaco included, etc., per CONTEXT.md "VAT territory") are a future refinement — note this in ADR-0027. Reverse-charge full two-sided posting (output+input boxes) is a VAT-report concern beyond plugin classification; the plugin returns the marker code only.

- [ ] **Step 4: Run** PASS. **Step 5: Commit** `git commit -am "feat(plugins): EE cross-border VAT treatment (EU reverse-charge / import / foreign-cost)"`

---

## Task 5: EE FX reference rates (the realized-FX unblocker)

**Files:** Modify `estonia-country.plugin.ts` (`getReferenceRate` + rate table), extend spec.

- [ ] **Step 1: Write failing tests**

```typescript
describe('EstoniaCountryPlugin — FX', () => {
  const ee = new EstoniaCountryPlugin();
  it('same currency → 1.0', () => {
    expect(ee.getReferenceRate('EUR','EUR','2026-06-09')).toBe(1.0);
  });
  it('returns deterministic EUR-cross rates (and inverse)', () => {
    expect(ee.getReferenceRate('USD','EUR','2026-06-09')).toBeCloseTo(0.92, 2);
    expect(ee.getReferenceRate('EUR','USD','2026-06-09')).toBeCloseTo(1.0 / 0.92, 2);
  });
  it('throws on an unknown currency pair (honest, never silent 1.0)', () => {
    expect(() => ee.getReferenceRate('JPY','EUR','2026-06-09')).toThrow(/rate/i);
  });
});
```

- [ ] **Step 2: Run** (Task-3 body may already match) → refine.

- [ ] **Step 3: Implement**

```typescript
// v1 PLACEHOLDER rates (deterministic for tests). Live ECB integration is deferred
// (tracked debt) — getReferenceRate is a pure sync function so it cannot fetch.
private static readonly RATES: Record<string, number> = {
  'USD→EUR': 0.92, 'GBP→EUR': 1.16,
};

getReferenceRate(fromCurrency: string, toCurrency: string, _date: string): number {
  if (fromCurrency === toCurrency) return 1.0;
  const direct = EstoniaCountryPlugin.RATES[`${fromCurrency}→${toCurrency}`];
  if (direct !== undefined) return direct;
  const inverse = EstoniaCountryPlugin.RATES[`${toCurrency}→${fromCurrency}`];
  if (inverse !== undefined) return 1.0 / inverse;
  throw new Error(`EE plugin: no reference rate for ${fromCurrency} → ${toCurrency} (live FX deferred)`);
}
```

- [ ] **Step 4: Run** PASS. **Step 5: Commit** `git commit -am "feat(plugins): EE deterministic EUR-cross reference rates (v1 placeholder; live ECB deferred)"`

---

## Task 6: EE retrieval methods + distribution tax + assertDistributable

**Files:** Modify `estonia-country.plugin.ts` (retrieval 4 methods, `resolveDistributionTax`, `assertDistributable`, `dividendWithholdingRate`), extend spec.

- [ ] **Step 1: Write failing tests**

```typescript
describe('EstoniaCountryPlugin — retrieval + distribution tax', () => {
  const ee = new EstoniaCountryPlugin();
  const org: OrgContext = { country: 'EE', vatRegistered: true, baseCurrency: null };
  const eeSup: SupplierFacts = { country: 'EE', goodsVsServices: 'services', classificationMemory: [] };

  it('getVatRate / computeVat at 24%', () => {
    expect(ee.getVatRate('EE_INPUT_24')).toBe(0.24);
    expect(ee.computeVat(100000, 'EE_INPUT_24')).toEqual({ netMinorUnits: 100000, vatMinorUnits: 24000, grossMinorUnits: 124000, rate: 0.24 });
  });
  it('previewExpenseTreatment for a domestic software expense', () => {
    expect(ee.previewExpenseTreatment('software', eeSup, org)).toEqual({ accountCode: 'EXPENSE_SOFTWARE', vatCode: 'EE_INPUT_24', rate: 0.24, treatment: 'domestic' });
  });
  it('getVatRegistrationThreshold = €40,000 in cents', () => {
    expect(ee.getVatRegistrationThreshold(org)).toBe(4000000);
  });
  it('dividendWithholdingRate is 0 (EE has no withholding)', () => {
    expect(ee.dividendWithholdingRate(org)).toBe(0.0);
  });
  it('resolveDistributionTax: 22/78 of net, to DISTRIBUTION_TAX_PAYABLE', () => {
    // net €1000.00 → tax = round(100000 * 22/78) = 28205
    expect(ee.resolveDistributionTax(100000, org)).toEqual({ accountCode: 'DISTRIBUTION_TAX_PAYABLE', amount: 28205 });
  });
  it('assertDistributable blocks when net + distribution tax exceeds distributable', () => {
    // net 100000 + tax 28205 = 128205 total equity hit
    expect(ee.assertDistributable(100000, 128205, org)).toBe(true);
    expect(ee.assertDistributable(100000, 128204, org)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → refine bodies until pass.

- [ ] **Step 3: Implement**

```typescript
getVatRate(vatCode: string): number { return EstoniaCountryPlugin.VAT_RATES[vatCode] ?? 0; }

computeVat(netMinorUnits: number, vatCode: string): VatComputation {
  const rate = this.getVatRate(vatCode);
  const vatMinorUnits = Math.round(netMinorUnits * rate);
  return { netMinorUnits, vatMinorUnits, grossMinorUnits: netMinorUnits + vatMinorUnits, rate };
}

previewExpenseTreatment(category: string, supplierFacts: SupplierFacts, orgContext: OrgContext): ExpenseTreatmentPreview {
  const mapping = this.resolveCategoryMapping(category, supplierFacts, orgContext);
  const cross = this.resolveCrossBorderTreatment(supplierFacts, orgContext, { vatCharged: true });
  return { accountCode: mapping.accountCode, vatCode: mapping.vatCode, rate: this.getVatRate(mapping.vatCode), treatment: cross.treatment };
}

getVatRegistrationThreshold(_orgContext: OrgContext): number | null { return 4000000; } // €40,000 in cents

dividendWithholdingRate(_orgContext: OrgContext): number { return 0.0; }

private distributionTax(netToOwner: number): number { return Math.round((netToOwner * 22) / 78); }

resolveDistributionTax(netToOwner: number, _orgContext: OrgContext): { accountCode: string; amount: number } | null {
  return { accountCode: 'DISTRIBUTION_TAX_PAYABLE', amount: this.distributionTax(netToOwner) };
}

assertDistributable(grossAmount: number, retainedEarnings: number, _orgContext: OrgContext): boolean {
  // Total equity hit = the net distribution + the company's distribution tax on top.
  const totalHit = grossAmount + this.distributionTax(grossAmount);
  return totalHit <= retainedEarnings;
}
```

- [ ] **Step 4: Run** PASS. **Step 5: Commit** `git commit -am "feat(plugins): EE retrieval methods + 22/78 distribution tax + distributable cap (net+tax)"`

---

## Task 7: Wire `EstoniaCountryPlugin` into `PluginLoader` + `PluginsModule`

**Files:** Modify `plugin-loader.service.ts`, `plugins.module.ts`; extend `plugin-loader.service.spec.ts`.

- [ ] **Step 1: Failing test** — `PluginLoader.resolve('EE')` returns the EE plugin (name `'EE'`), `resolve('XX')` still falls back to null.

```typescript
it('resolves the Estonia plugin for EE', () => {
  expect(loader.resolve('EE').getName()).toBe('EE');
});
```
(Update the loader spec's construction to pass an `EstoniaCountryPlugin` instance.)

- [ ] **Step 2: Run** → fail.

- [ ] **Step 3: Implement** — inject `EstoniaCountryPlugin` into `PluginLoader` and register:
```typescript
constructor(
  private readonly nullPlugin: NullCountryPlugin,
  private readonly estoniaPlugin: EstoniaCountryPlugin,
) {
  this.plugins.set('null', this.nullPlugin);
  this.plugins.set('EE', this.estoniaPlugin);
}
```
`plugins.module.ts`: add `EstoniaCountryPlugin` to `providers` and `exports`.

- [ ] **Step 4: Run** `nvm use 24 && npm run build && npm test` → green (the real DI graph now constructs the EE plugin). **Step 5: Commit** `git commit -am "feat(plugins): register EstoniaCountryPlugin for country code EE"`

---

## Task 8: `DividendsService` books the on-top distribution tax

**Files:** Modify `src/dividends/dividends.service.ts`; modify `src/dividends/dividends.service.spec.ts`.

- [ ] **Step 1: Failing test** — with a plugin whose `resolveDistributionTax` returns non-null, `declare` books the on-top tax line.

```typescript
// Add a MockDistributionTaxPlugin (withholding 0; resolveDistributionTax → { DISTRIBUTION_TAX_PAYABLE, round(net*22/78) }).
it('books distribution tax on top: Dr RETAINED_EARNINGS (net+tax) / Cr DIVIDEND_PAYABLE (net) / Cr DISTRIBUTION_TAX_PAYABLE (tax)', async () => {
  const result = await eeDividendsService.declare({ gross_amount: 100000, tax_point_date: '2026-06-15' });
  // net to owner = 100000 (no withholding); tax = round(100000*22/78) = 28205
  const lines = await db.selectFrom('voucher_line').innerJoin('account','account.id','voucher_line.account_id')
    .select(['account.code','voucher_line.base_amount','voucher_line.is_debit'])
    .where('voucher_line.voucher_id','=',result.voucher_id).execute();
  const re = lines.find(l => l.code === 'RETAINED_EARNINGS');
  const pay = lines.find(l => l.code === 'DIVIDEND_PAYABLE');
  const tax = lines.find(l => l.code === 'DISTRIBUTION_TAX_PAYABLE');
  expect(re!.is_debit).toBe(1); expect(re!.base_amount).toBe(128205);
  expect(pay!.base_amount).toBe(100000);
  expect(tax!.base_amount).toBe(28205);
  // balance
  expect(re!.base_amount).toBe(pay!.base_amount + tax!.base_amount);
});
```
(Seed enough distributable profits so `assertDistributable` passes; the EE/mock plugin's cap is net+tax.)

- [ ] **Step 2: Run** → fail (no tax line yet).

- [ ] **Step 3: Implement in `declare()`** — after computing `withholdingAmount`/`netPayable`, add:
```typescript
const distTax = this.plugin.resolveDistributionTax(netPayable, orgContext);
const distTaxAmount = distTax?.amount ?? 0;
const retainedDebit = dto.gross_amount + distTaxAmount; // tax is ON TOP of the gross
```
Change the `RETAINED_EARNINGS` debit line's `amount`/`base_amount` from `dto.gross_amount` to `retainedDebit`. After the withholding line block, add:
```typescript
if (distTax && distTaxAmount > 0) {
  lines.push({
    account_code: distTax.accountCode,
    amount: distTaxAmount, currency: baseCurrency, base_amount: distTaxAmount,
    fx_rate: 1.0, is_debit: false,
  });
}
```
The balance holds: `retainedDebit = gross + distTax = (netPayable + withholding) + distTax = netPayable + withholding + distTax` = sum of the three credit lines. Include `distTaxAmount` in the `DividendDeclarationResult` if the result type carries a breakdown (add a `distribution_tax_amount` field; otherwise leave the result shape unchanged).

> `assertDistributable` already receives `dto.gross_amount`; the EE plugin internally adds its own tax to the cap (Task 6), so no change to the assert call is needed.

- [ ] **Step 4: Run** `nvm use 24 && npm run build && npm run lint && npx jest src/dividends` → PASS (existing no-withholding + withholding tests stay green; new distribution-tax test passes). **Step 5: Commit** `git commit -am "feat(dividends): book company distribution tax on top of the dividend (EE CIT 22/78)"`

---

## Task 9: ADR-0027 + full gate

**Files:** Create `docs/adr/0027-estonia-country-plugin.md`; (optionally note EE in DOMAIN-MODEL/CONTEXT).

- [ ] **Step 1: Write ADR-0027** recording: the EE plugin as the first real jurisdiction; the verified Estonian VAT facts (24/13/9/0, monthly, €40k, EUR) with the sources; the **`CountryPluginRetrieval`** compute-only sub-interface (advisory agent reads, registers nothing); the **`resolveDistributionTax`** on-top model (distinct from `dividendWithholdingRate`) + the `DISTRIBUTION_TAX_PAYABLE` account; the documented limitations (EU set by political country code — sub-territory exceptions deferred; reverse-charge two-sided posting deferred to the VAT-report layer; FX rates hardcoded placeholders — live ECB deferred).

- [ ] **Step 2: Full wave gate**

Run: `nvm use 24 && npm run build && npm run lint && npm run test && npm run test:e2e`
Expected: all green.

- [ ] **Step 3: Grep gates** (must be empty):
```bash
grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"
```

- [ ] **Step 4: Commit** `git add docs/adr/0027-estonia-country-plugin.md && git commit -m "docs(adr-0027): Estonia country plugin, CountryPluginRetrieval, distribution-tax model"`

---

## Self-Review (author checklist — completed)

**1. Spec coverage:** EE VAT codes+mapping+validate+period+EUR+rounding+personal-disposition → Task 3; cross-border (EU reverse-charge/import/foreign-cost) → Task 4; real cross-currency FX → Task 5; CountryPluginRetrieval (4 compute-only methods) → Task 1 (interface + Null) + Task 6 (EE); distribution tax (22/78 on top) + DISTRIBUTION_TAX_PAYABLE + DividendsService → Tasks 1 (interface), 2 (account), 6 (EE), 8 (booking); wiring → Task 7; ADR + gate → Task 9. ✅

**2. Placeholder scan:** the FX rates and `getReferenceRate` are explicitly marked v1 placeholders (live ECB deferred — a tracked debt, not a plan TODO); the "implement all bodies in Task 3, pin with tests in Tasks 4-6" note is a deliberate ordering for a single multi-method class, not a vague placeholder. No bare TODOs.

**3. Type consistency:** `CountryPluginRetrieval`/`VatComputation`/`ExpenseTreatmentPreview`/`resolveDistributionTax({accountCode,amount}|null)`/`VAT_RATES` codes (`EE_INPUT_24` etc.) are consistent across Tasks 1–8. The distribution-tax base is `netToOwner`, computed `round(net×22/78)`, account `DISTRIBUTION_TAX_PAYABLE`, consistently in Tasks 6 and 8. `assertDistributable` cap = `gross + distributionTax(gross) ≤ retainedEarnings`.

---

## Execution Handoff

9 tasks, each red→green→commit under Node 24. Tasks are mostly sequential within the EE class (Task 1 interface → Task 3 class core → 4/5/6 refine+test → 7 wire → 8 dividends → 9 ADR/gate); Task 2 (migration) is independent and can land any time before Task 8. Recommended: subagent-driven, fresh subagent per task + two-stage review (the distribution-tax + cross-border tasks are accounting-correctness-sensitive — review carefully).
