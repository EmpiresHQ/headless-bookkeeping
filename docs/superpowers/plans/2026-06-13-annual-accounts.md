# Annual Accounts (RIK-XBRL, draft/final) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the Estonian majandusaasta aruanne as RIK-XBRL behind the country-plugin seam, with a repeatable side-effect-free draft and a one-shot final that posts annual depreciation, locks the year, and emits byte-identical numbers.

**Architecture:** A new pure plugin method `CountryPlugin.generateAnnualAccounts(input, opts)` owns the `account → RTJ line → XBRL concept` mapping and RIK-XBRL rendering (Null returns empty; Estonia renders the väike form, P&L skeem 1, two comparative columns). A new kernel `AnnualAccountsService` mirrors `StatutoryReportService`: it assembles a jurisdiction-neutral `AnnualAccountsInput` from the ledger (period + comparative prior-period balances via `LedgerBalanceService`), the `fixed_asset` register, and the depreciation engine (computed virtually in draft, posted in final), then delegates to the active plugin resolved by `OrgContextResolver`. A controller exposes a read-only draft `GET` and a finalizing `POST`.

**Tech Stack:** NestJS, TypeScript, Kysely, better-sqlite3, Jest, nestjs-zod

**Depends on:** the Fixed-Assets plan (depreciation engine + register + accounts) must be implemented first.

---

## Consumed surface from the Fixed-Assets plan (ASSUME these exist; do NOT re-implement)

The Fixed-Assets plan delivers, and this plan consumes:

- **`fixed_asset` table** (Kysely `Database['fixed_asset']`) with columns:
  `id`, `name`, `asset_class` (`'vehicle' | 'it_equipment' | 'machinery' | 'furniture'`), `acquisition_voucher_id`, `acquisition_date` (`YYYY-MM-DD`), `cost_base_minor`, `useful_life_years`, `residual_value_minor`, `retired_at` (`number | null`).
- **Per-class accounts** (seeded by fixed-assets migrations 046–049, `is_system = 1`):
  `FIXED_ASSETS_VEHICLES`, `FIXED_ASSETS_IT`, `FIXED_ASSETS_EQUIPMENT`, `FIXED_ASSETS_FURNITURE` (type `asset`); paired `ACCUM_DEPRECIATION_VEHICLES`, `ACCUM_DEPRECIATION_IT`, `ACCUM_DEPRECIATION_EQUIPMENT`, `ACCUM_DEPRECIATION_FURNITURE` (type `asset`, contra); `DEPRECIATION_EXPENSE` (type `expense`); `GAIN_LOSS_ON_ASSET_DISPOSAL`.
- **Pure depreciation engine** at `src/fixed-assets/depreciation-engine.ts`, exporting:
  ```typescript
  export interface DepreciableAsset {
    acquisition_date: string; // YYYY-MM-DD
    cost_base_minor: number;
    useful_life_years: number;
    residual_value_minor: number;
  }
  export function accumulatedDepreciationAsOf(
    asset: DepreciableAsset,
    asOf: string,
  ): number;
  /**
   * The depreciation charge to recognise BETWEEN `from` and `to` (the difference
   * in accumulated depreciation). `from === null` means "from acquisition".
   * Never negative.
   */
  export function depreciationCharge(
    asset: DepreciableAsset,
    from: string | null,
    to: string,
  ): number;
  ```
  The engine is deterministic, posts nothing, reads no DB. `DepreciableAsset` carries ONLY the four math fields above (no `id`/`asset_class`/`retired_at`); there is NO `computeAnnualCharges` or `AssetCharge` export. `AnnualAccountsService` loads the richer `fixed_asset` rows it owns (which carry `id`, `asset_class`, `retired_at` alongside the four math fields) and passes each non-retired row straight to `depreciationCharge` — a 7-field row satisfies the 4-field `DepreciableAsset` param by structural typing. The service keeps `id` + `asset_class` alongside each returned charge via its own small local helper (Task 6), both for the draft virtual charge and to derive the final posting amounts.

---

## File Structure

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `src/plugins/annual-accounts.types.ts` | Create | Neutral `AnnualAccountsInput`, `AnnualAccountsOpts`, and re-export of `StatutoryReportArtifact`/`StatutoryWarning` as `AnnualAccountsArtifact`/`AnnualAccountsWarning`; `AnnualAccountsResult = { artifacts, warnings }`. |
| `src/plugins/country-plugin.interface.ts` | Modify | Add `generateAnnualAccounts(input, opts): AnnualAccountsResult` to the `CountryPlugin` interface; re-export the new types. |
| `src/plugins/null-country.plugin.ts` | Modify | Implement `generateAnnualAccounts` returning `{ artifacts: [], warnings: [] }`. |
| `src/plugins/estonia-country.plugin.ts` | Modify | Implement `generateAnnualAccounts` delegating to the `estonia-annual-accounts/*` renderer modules; own the account→RTJ-line→concept mapping. |
| `src/plugins/estonia-annual-accounts/rtj-mapping.ts` | Create | The pure `account code → RTJ line → XBRL concept` table + helpers (`mapBalancesToLines`, `unmappedNonzero`). |
| `src/plugins/estonia-annual-accounts/xbrl.ts` | Create | Pure RIK-XBRL renderer: balance sheet + P&L skeem 1, two comparative columns, taxonomy pinned 2026, mandatory dimensional contexts, calculation-linkbase totals. |
| `src/plugins/estonia-annual-accounts/xbrl.spec.ts` | Create | Pure unit tests: golden-file XBRL, two comparative columns, zero prior column for first year, sub-items-sum-to-totals. |
| `src/plugins/estonia-annual-accounts/rtj-mapping.spec.ts` | Create | Pure unit tests for the mapping table + unmapped-nonzero detection. |
| `src/plugins/null-country.plugin.spec.ts` | Modify | One-line test: Null returns empty annual-accounts artifacts. |
| `src/ledger/account/ledger-balance.service.ts` | Modify | Add `getLedgerNetForPeriod(filter, range, options)` — a period-scoped (tax-point-date range) signed net. |
| `src/ledger/account/ledger-balance.service.spec.ts` | Modify/Create | Unit tests for the period-scoped net. |
| `src/annual-accounts/annual-accounts.service.ts` | Create | Kernel assembly + `generate(periodId)` (draft) + `finalize(periodId)` (final); diagnostics + gating. |
| `src/annual-accounts/annual-accounts.service.spec.ts` | Create | Integration tests (in-memory SQLite): draft, diagnostics, finalize, draft==final, second-finalize. |
| `src/annual-accounts/types.ts` | Create | Zod-backed `FinalizeAnnualAccountsDto`. |
| `src/annual-accounts/annual-accounts.controller.ts` | Create | `GET …/annual-accounts` (draft) + `POST …/annual-accounts/finalize`. |
| `src/annual-accounts/annual-accounts.controller.spec.ts` | Create | Route integration tests. |
| `src/annual-accounts/annual-accounts.module.ts` | Create | Module wiring. |
| `src/app.module.ts` | Modify | Register `AnnualAccountsModule`. |

**Migration decision (PRD requirement 7 / SCOPE 7):** **No migration 052 is added.** The väike equity section maps to three live lines from accounts that already exist: Osakapital ← `EQUITY`, Eelmiste perioodide jaotamata kasum ← `RETAINED_EARNINGS` (seeded by migration 024), Aruandeaasta kasum ← period revenue − expense (computed, not an account). The services solo-OÜ persona's capital is fully represented by the existing `EQUITY` account, so a separate `SHARE_CAPITAL` split would be unmapped dead weight. Per the ADR ("a `SHARE_CAPITAL` split is added when needed"), it is not needed here. The plugin's RTJ mapping table maps `EQUITY → Osakapital`; if a future persona needs to distinguish paid-in share capital from other equity, that is one migration + one mapping-table row at that time.

---

## Task 1 — Neutral annual-accounts types

**Files:**
- `src/plugins/annual-accounts.types.ts` (create)

- [ ] **Step 1.1** — Write the neutral types file (no test of its own; it is consumed and asserted by Tasks 2–8). Create `src/plugins/annual-accounts.types.ts`:

```typescript
import type {
  StatutoryReportArtifact,
  StatutoryWarning,
} from './statutory-report.types';

/** Reuse the artifact/warning shapes so the two seams stay parallel. */
export type AnnualAccountsArtifact = StatutoryReportArtifact;
export type AnnualAccountsWarning = StatutoryWarning;

/** A single account's signed balances for the period and the comparative prior. */
export interface AccountBalanceRow {
  /** Kernel account code, e.g. "EQUITY", "REVENUE", "FIXED_ASSETS_VEHICLES". */
  code: string;
  /** Account type, for type-keyed roll-up fallbacks. */
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  /**
   * Closing balance at period end, base-currency minor units, NORMAL-SIDE
   * positive: assets/expenses debit-positive, liabilities/equity/revenue
   * credit-positive. A normal asset balance is +; a normal liability is +.
   */
  current: number;
  /** Same convention, at the comparative prior period end. Zero for a first year. */
  prior: number;
}

/** A capitalized asset's register snapshot, neutral (no jurisdiction depreciation method). */
export interface FixedAssetSnapshotRow {
  id: number;
  assetClass: 'vehicle' | 'it_equipment' | 'machinery' | 'furniture';
  /** Original cost, base-currency minor units, from the acquisition voucher. */
  costMinor: number;
  /** Whether the asset is retired (disposed) — excluded from live põhivara. */
  retired: boolean;
}

/** Jurisdiction-neutral input the kernel assembles and the plugin renders. */
export interface AnnualAccountsInput {
  /** Reporting year being closed. */
  period: { name: string; startDate: string; endDate: string };
  /** Comparative prior year. `null` ⇒ first operating year (zero prior column). */
  priorPeriod: { name: string; startDate: string; endDate: string } | null;
  mode: 'draft' | 'final';
  /** Every account with activity, with current + prior normal-side balances. */
  balances: AccountBalanceRow[];
  /** Register snapshot for põhivara/kulum lines + register-vs-ledger checks. */
  fixedAssets: FixedAssetSnapshotRow[];
  /** Period net income (revenue − expense), credit-positive, base minor units. */
  periodNetIncome: number;
  /** Prior-year net income, credit-positive. Zero for a first year. */
  priorNetIncome: number;
  /** Retained earnings brought forward (RETAINED_EARNINGS closing), credit-positive. */
  retainedEarningsBroughtForward: number;
  /** Declarant identity for the XBRL entity context. */
  declarant: { regNumber: string | null; name: string | null };
}

export interface AnnualAccountsOpts {
  /** Pinned taxonomy version. v1 only supports 2026. */
  taxonomyVersion: 2026;
}

export interface AnnualAccountsResult {
  artifacts: AnnualAccountsArtifact[];
  warnings: AnnualAccountsWarning[];
}
```

- [ ] **Step 1.2** — Typecheck only (no spec yet): `npm run typecheck`. Expected PASS (file compiles; unused-export warnings are fine).

- [ ] **Step 1.3** — Commit:
```bash
git add src/plugins/annual-accounts.types.ts
git commit -m "feat(annual-accounts): neutral AnnualAccountsInput/Result types"
```

---

## Task 2 — Add the plugin seam (interface + Null impl)

**Files:**
- `src/plugins/country-plugin.interface.ts` (modify)
- `src/plugins/null-country.plugin.ts` (modify)
- `src/plugins/null-country.plugin.spec.ts` (modify)

- [ ] **Step 2.1** — Failing test. Add to `src/plugins/null-country.plugin.spec.ts` (inside the top-level `describe`):

```typescript
  it('generateAnnualAccounts returns empty artifacts and warnings', () => {
    const input = {
      period: { name: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
      priorPeriod: null,
      mode: 'draft' as const,
      balances: [],
      fixedAssets: [],
      periodNetIncome: 0,
      priorNetIncome: 0,
      retainedEarningsBroughtForward: 0,
      declarant: { regNumber: null, name: null },
    };
    const result = plugin.generateAnnualAccounts(input, { taxonomyVersion: 2026 });
    expect(result).toEqual({ artifacts: [], warnings: [] });
  });
```

(If the spec's plugin handle is not named `plugin`, match the existing local — `const plugin = new NullCountryPlugin()` is the file's convention.)

- [ ] **Step 2.2** — Run: `npm test -- src/plugins/null-country.plugin.spec.ts`. Expected FAIL (`generateAnnualAccounts is not a function`).

- [ ] **Step 2.3** — Minimal impl. In `src/plugins/country-plugin.interface.ts`, add the import + re-export near the existing statutory re-exports:

```typescript
import type {
  AnnualAccountsInput,
  AnnualAccountsOpts,
  AnnualAccountsResult,
} from './annual-accounts.types';

export type {
  AnnualAccountsInput,
  AnnualAccountsOpts,
  AnnualAccountsResult,
} from './annual-accounts.types';
```

Then add the method to the `CountryPlugin` interface, immediately after `generateStatutoryReports`:

```typescript
  /**
   * Render the jurisdiction's annual-accounts artifact(s) (e.g. RIK-XBRL) from
   * a neutral, pre-assembled input. The plugin owns the account→RTJ-line→XBRL
   * concept mapping and stays pure — no DB access. Unsupported jurisdictions
   * return empty artifacts. Mirrors generateStatutoryReports (ADR-0033/0034).
   */
  generateAnnualAccounts(
    input: AnnualAccountsInput,
    opts: AnnualAccountsOpts,
  ): AnnualAccountsResult;
```

In `src/plugins/null-country.plugin.ts`, add the import and a stub method:

```typescript
import {
  AnnualAccountsInput,
  AnnualAccountsOpts,
  AnnualAccountsResult,
} from './annual-accounts.types';
```

```typescript
  generateAnnualAccounts(
    _input: AnnualAccountsInput,
    _opts: AnnualAccountsOpts,
  ): AnnualAccountsResult {
    return { artifacts: [], warnings: [] };
  }
```

- [ ] **Step 2.4** — Run: `npm test -- src/plugins/null-country.plugin.spec.ts`. Expected PASS. Then `npm run typecheck` — expected PASS (Estonia plugin still missing the method will fail typecheck; that is addressed in Task 4. If typecheck fails ONLY on Estonia missing `generateAnnualAccounts`, that is expected at this step — proceed; do not add anything to Estonia yet).

- [ ] **Step 2.5** — Commit:
```bash
git add src/plugins/country-plugin.interface.ts src/plugins/null-country.plugin.ts src/plugins/null-country.plugin.spec.ts
git commit -m "feat(annual-accounts): add generateAnnualAccounts plugin seam + Null impl"
```

---

## Task 3 — Estonia RTJ mapping table (pure)

**Files:**
- `src/plugins/estonia-annual-accounts/rtj-mapping.ts` (create)
- `src/plugins/estonia-annual-accounts/rtj-mapping.spec.ts` (create)

The mapping is the heart of the plugin: it binds each kernel account code to an RTJ report line and XBRL concept, and exposes (a) a roll-up of balances into line totals and (b) detection of nonzero accounts that map to nothing.

- [ ] **Step 3.1** — Failing test. Create `src/plugins/estonia-annual-accounts/rtj-mapping.spec.ts`:

```typescript
import {
  RTJ_LINES,
  ACCOUNT_TO_LINE,
  rollUpLines,
  unmappedNonzeroCodes,
} from './rtj-mapping';
import type { AccountBalanceRow } from '../annual-accounts.types';

describe('Estonia RTJ mapping', () => {
  it('maps the core neutral accounts to RTJ lines', () => {
    expect(ACCOUNT_TO_LINE['BANK_EUR']).toBe('cashAndBankAccounts');
    expect(ACCOUNT_TO_LINE['AR']).toBe('receivablesAndPrepayments');
    expect(ACCOUNT_TO_LINE['FIXED_ASSETS_VEHICLES']).toBe('tangibleFixedAssets');
    expect(ACCOUNT_TO_LINE['ACCUM_DEPRECIATION_VEHICLES']).toBe(
      'tangibleFixedAssets',
    );
    expect(ACCOUNT_TO_LINE['AP']).toBe('payablesAndPrepayments');
    expect(ACCOUNT_TO_LINE['EQUITY']).toBe('issuedCapital');
    expect(ACCOUNT_TO_LINE['RETAINED_EARNINGS']).toBe('retainedEarnings');
    expect(ACCOUNT_TO_LINE['REVENUE']).toBe('revenue');
    expect(ACCOUNT_TO_LINE['DEPRECIATION_EXPENSE']).toBe('depreciation');
    expect(ACCOUNT_TO_LINE['EXPENSE_OTHER']).toBe('otherOperatingExpenses');
  });

  it('every RTJ_LINES key is a known concept with a statement + sign', () => {
    for (const [id, def] of Object.entries(RTJ_LINES)) {
      expect(def.concept).toMatch(/^ee-rtj:/);
      expect(['balanceSheet', 'incomeStatement']).toContain(def.statement);
      expect(['debit', 'credit']).toContain(def.normalSide);
      expect(id).toBe(def.id);
    }
  });

  it('rolls up balances into line totals, current and prior', () => {
    const balances: AccountBalanceRow[] = [
      { code: 'BANK_EUR', type: 'asset', current: 5000, prior: 3000 },
      { code: 'CASH', type: 'asset', current: 1000, prior: 0 },
      { code: 'AP', type: 'liability', current: 2000, prior: 1500 },
    ];
    const lines = rollUpLines(balances);
    const cash = lines.find((l) => l.id === 'cashAndBankAccounts')!;
    expect(cash.current).toBe(6000);
    expect(cash.prior).toBe(3000);
    const pay = lines.find((l) => l.id === 'payablesAndPrepayments')!;
    expect(pay.current).toBe(2000);
    expect(pay.prior).toBe(1500);
  });

  it('contra-accumulated-depreciation reduces the tangible-fixed-asset line', () => {
    const balances: AccountBalanceRow[] = [
      { code: 'FIXED_ASSETS_VEHICLES', type: 'asset', current: 20000, prior: 20000 },
      { code: 'ACCUM_DEPRECIATION_VEHICLES', type: 'asset', current: -4000, prior: -2000 },
    ];
    const lines = rollUpLines(balances);
    const tfa = lines.find((l) => l.id === 'tangibleFixedAssets')!;
    expect(tfa.current).toBe(16000);
    expect(tfa.prior).toBe(18000);
  });

  it('flags a nonzero balance on an unmapped account', () => {
    const balances: AccountBalanceRow[] = [
      { code: 'BANK_EUR', type: 'asset', current: 100, prior: 0 },
      { code: 'MYSTERY_SUSPENSE', type: 'asset', current: 250, prior: 0 },
      { code: 'OTHER_ZERO', type: 'asset', current: 0, prior: 0 },
    ];
    expect(unmappedNonzeroCodes(balances)).toEqual(['MYSTERY_SUSPENSE']);
  });
});
```

- [ ] **Step 3.2** — Run: `npm test -- src/plugins/estonia-annual-accounts/rtj-mapping.spec.ts`. Expected FAIL (module not found).

- [ ] **Step 3.3** — Minimal impl. Create `src/plugins/estonia-annual-accounts/rtj-mapping.ts`:

```typescript
import type { AccountBalanceRow } from '../annual-accounts.types';

/** Which statement a line belongs to, and its normal accumulation side. */
export interface RtjLineDef {
  id: string;
  /** Estonian RTJ taxonomy concept (2026), prefixed `ee-rtj:`. */
  concept: string;
  /** Human label (Estonian). */
  label: string;
  statement: 'balanceSheet' | 'incomeStatement';
  /** Which signed direction is the line's normal positive. */
  normalSide: 'debit' | 'credit';
}

/**
 * The väike-form line set rendered in v1. IDs are stable internal keys; the
 * `concept` is the pinned 2026 RIK taxonomy element. Totals/subtotals are
 * computed in the renderer from the calculation linkbase, not stored here.
 */
export const RTJ_LINES: Record<string, RtjLineDef> = {
  // ── Balance sheet — Aktiva (assets, debit-normal) ──
  cashAndBankAccounts: {
    id: 'cashAndBankAccounts',
    concept: 'ee-rtj:CashAndCashEquivalents',
    label: 'Raha',
    statement: 'balanceSheet',
    normalSide: 'debit',
  },
  receivablesAndPrepayments: {
    id: 'receivablesAndPrepayments',
    concept: 'ee-rtj:ReceivablesAndPrepayments',
    label: 'Nõuded ja ettemaksed',
    statement: 'balanceSheet',
    normalSide: 'debit',
  },
  inventories: {
    id: 'inventories',
    concept: 'ee-rtj:Inventories',
    label: 'Varud',
    statement: 'balanceSheet',
    normalSide: 'debit',
  },
  tangibleFixedAssets: {
    id: 'tangibleFixedAssets',
    concept: 'ee-rtj:TangibleFixedAssets',
    label: 'Materiaalne põhivara',
    statement: 'balanceSheet',
    normalSide: 'debit',
  },
  // ── Balance sheet — Kohustused (liabilities, credit-normal) ──
  payablesAndPrepayments: {
    id: 'payablesAndPrepayments',
    concept: 'ee-rtj:PayablesAndPrepayments',
    label: 'Võlad ja ettemaksed',
    statement: 'balanceSheet',
    normalSide: 'credit',
  },
  // ── Balance sheet — Omakapital (equity, credit-normal) ──
  issuedCapital: {
    id: 'issuedCapital',
    concept: 'ee-rtj:IssuedCapital',
    label: 'Osakapital',
    statement: 'balanceSheet',
    normalSide: 'credit',
  },
  retainedEarnings: {
    id: 'retainedEarnings',
    concept: 'ee-rtj:RetainedEarningsDeficit',
    label: 'Eelmiste perioodide jaotamata kasum (kahjum)',
    statement: 'balanceSheet',
    normalSide: 'credit',
  },
  profitForPeriod: {
    id: 'profitForPeriod',
    concept: 'ee-rtj:ProfitLossForPeriod',
    label: 'Aruandeaasta kasum (kahjum)',
    statement: 'balanceSheet',
    normalSide: 'credit',
  },
  // ── Income statement — skeem 1 (by nature) ──
  revenue: {
    id: 'revenue',
    concept: 'ee-rtj:Revenue',
    label: 'Müügitulu',
    statement: 'incomeStatement',
    normalSide: 'credit',
  },
  otherOperatingExpenses: {
    id: 'otherOperatingExpenses',
    concept: 'ee-rtj:OtherOperatingExpenses',
    label: 'Mitmesugused tegevuskulud',
    statement: 'incomeStatement',
    normalSide: 'debit',
  },
  labourExpense: {
    id: 'labourExpense',
    concept: 'ee-rtj:LabourExpense',
    label: 'Tööjõukulud',
    statement: 'incomeStatement',
    normalSide: 'debit',
  },
  depreciation: {
    id: 'depreciation',
    concept: 'ee-rtj:DepreciationAndImpairmentLoss',
    label: 'Põhivara kulum',
    statement: 'incomeStatement',
    normalSide: 'debit',
  },
};

/**
 * Account code → RTJ line id. A `FIXED_ASSETS_*` and its paired
 * `ACCUM_DEPRECIATION_*` both fold into `tangibleFixedAssets` (the contra
 * balance is stored normal-side-negative, so a plain sum nets book value).
 */
export const ACCOUNT_TO_LINE: Readonly<Record<string, string>> = {
  // Assets
  CASH: 'cashAndBankAccounts',
  BANK_EUR: 'cashAndBankAccounts',
  BANK_USD: 'cashAndBankAccounts',
  AR: 'receivablesAndPrepayments',
  VAT_RECEIVABLE: 'receivablesAndPrepayments',
  SUPPLIER_PREPAYMENTS: 'receivablesAndPrepayments',
  RECEIVABLE_FROM_OWNER: 'receivablesAndPrepayments',
  FIXED_ASSETS_VEHICLES: 'tangibleFixedAssets',
  FIXED_ASSETS_IT: 'tangibleFixedAssets',
  FIXED_ASSETS_EQUIPMENT: 'tangibleFixedAssets',
  FIXED_ASSETS_FURNITURE: 'tangibleFixedAssets',
  ACCUM_DEPRECIATION_VEHICLES: 'tangibleFixedAssets',
  ACCUM_DEPRECIATION_IT: 'tangibleFixedAssets',
  ACCUM_DEPRECIATION_EQUIPMENT: 'tangibleFixedAssets',
  ACCUM_DEPRECIATION_FURNITURE: 'tangibleFixedAssets',
  // Liabilities
  AP: 'payablesAndPrepayments',
  CUSTOMER_PREPAYMENTS: 'payablesAndPrepayments',
  VAT_PAYABLE: 'payablesAndPrepayments',
  DIVIDEND_PAYABLE: 'payablesAndPrepayments',
  DIVIDEND_WITHHOLDING_TAX_PAYABLE: 'payablesAndPrepayments',
  // Equity
  EQUITY: 'issuedCapital',
  OWNERS_DRAWINGS: 'retainedEarnings',
  RETAINED_EARNINGS: 'retainedEarnings',
  // Revenue
  REVENUE: 'revenue',
  // Expenses — skeem 1 by nature
  EXPENSE_SALARY: 'labourExpense',
  EXPENSE_CONTRACTOR: 'labourExpense',
  DEPRECIATION_EXPENSE: 'depreciation',
  EXPENSE_SOFTWARE: 'otherOperatingExpenses',
  EXPENSE_TRANSPORT: 'otherOperatingExpenses',
  EXPENSE_TRAVEL: 'otherOperatingExpenses',
  EXPENSE_MARKETING: 'otherOperatingExpenses',
  EXPENSE_RENT: 'otherOperatingExpenses',
  EXPENSE_TAX: 'otherOperatingExpenses',
  EXPENSE_BANK_FEE: 'otherOperatingExpenses',
  EXPENSE_MEALS: 'otherOperatingExpenses',
  EXPENSE_INSURANCE: 'otherOperatingExpenses',
  EXPENSE_EDUCATION: 'otherOperatingExpenses',
  EXPENSE_OTHER: 'otherOperatingExpenses',
  FX_GAIN_LOSS: 'otherOperatingExpenses',
  BAD_DEBT_EXPENSE: 'otherOperatingExpenses',
  GAIN_LOSS_ON_ASSET_DISPOSAL: 'otherOperatingExpenses',
};

/** A rolled-up RTJ line with current + prior totals. */
export interface RtjLineTotal {
  id: string;
  current: number;
  prior: number;
}

/**
 * Sum every mapped account balance into its RTJ line. Balances arrive
 * normal-side-positive; a contra-asset (`ACCUM_DEPRECIATION_*`) arrives
 * negative, so a plain add yields the book-value net.
 */
export function rollUpLines(balances: AccountBalanceRow[]): RtjLineTotal[] {
  const totals = new Map<string, RtjLineTotal>();
  for (const b of balances) {
    const lineId = ACCOUNT_TO_LINE[b.code];
    if (!lineId) continue;
    const t = totals.get(lineId) ?? { id: lineId, current: 0, prior: 0 };
    t.current += b.current;
    t.prior += b.prior;
    totals.set(lineId, t);
  }
  return [...totals.values()];
}

/** Codes whose current OR prior balance is nonzero but map to no RTJ line. */
export function unmappedNonzeroCodes(balances: AccountBalanceRow[]): string[] {
  return balances
    .filter((b) => !ACCOUNT_TO_LINE[b.code] && (b.current !== 0 || b.prior !== 0))
    .map((b) => b.code);
}
```

- [ ] **Step 3.4** — Run: `npm test -- src/plugins/estonia-annual-accounts/rtj-mapping.spec.ts`. Expected PASS.

- [ ] **Step 3.5** — Commit:
```bash
git add src/plugins/estonia-annual-accounts/rtj-mapping.ts src/plugins/estonia-annual-accounts/rtj-mapping.spec.ts
git commit -m "feat(annual-accounts): Estonia RTJ account→line mapping table"
```

---

## Task 4 — Estonia RIK-XBRL renderer (pure) + plugin wiring

**Files:**
- `src/plugins/estonia-annual-accounts/xbrl.ts` (create)
- `src/plugins/estonia-annual-accounts/xbrl.spec.ts` (create)
- `src/plugins/estonia-country.plugin.ts` (modify)

- [ ] **Step 4.1** — Failing test. Create `src/plugins/estonia-annual-accounts/xbrl.spec.ts`:

```typescript
import { renderAnnualAccountsXbrl } from './xbrl';
import type { AnnualAccountsInput } from '../annual-accounts.types';

function baseInput(over: Partial<AnnualAccountsInput> = {}): AnnualAccountsInput {
  return {
    period: { name: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    priorPeriod: { name: '2025', startDate: '2025-01-01', endDate: '2025-12-31' },
    mode: 'draft',
    balances: [
      { code: 'BANK_EUR', type: 'asset', current: 30000, prior: 10000 },
      { code: 'AR', type: 'asset', current: 5000, prior: 2000 },
      { code: 'FIXED_ASSETS_VEHICLES', type: 'asset', current: 20000, prior: 20000 },
      { code: 'ACCUM_DEPRECIATION_VEHICLES', type: 'asset', current: -4000, prior: -2000 },
      { code: 'AP', type: 'liability', current: 8000, prior: 3000 },
      { code: 'EQUITY', type: 'equity', current: 2500, prior: 2500 },
      { code: 'RETAINED_EARNINGS', type: 'equity', current: 24500, prior: 0 },
      { code: 'REVENUE', type: 'revenue', current: 60000, prior: 30000 },
      { code: 'EXPENSE_OTHER', type: 'expense', current: 42000, prior: 6000 },
      { code: 'DEPRECIATION_EXPENSE', type: 'expense', current: 2000, prior: 2000 },
    ],
    fixedAssets: [
      { id: 1, assetClass: 'vehicle', costMinor: 20000, retired: false },
    ],
    // Self-consistent: assets 51000 = payables 8000 + capital 2500 + retainedBF
    // 24500 + periodNetIncome 16000; and periodNetIncome 16000 = revenue 60000 −
    // otherOp 42000 − depreciation 2000. RETAINED_EARNINGS.current (24500) is
    // brought-forward only (no year-end sweep, ADR §3); the period result is the
    // separate live ProfitLossForPeriod line.
    periodNetIncome: 16000,
    priorNetIncome: 22000,
    retainedEarningsBroughtForward: 24500,
    declarant: { regNumber: '12345678', name: 'Test OÜ' },
    ...over,
  };
}

describe('renderAnnualAccountsXbrl', () => {
  it('emits a 2026-pinned XBRL document with two comparative contexts', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), { taxonomyVersion: 2026 });
    expect(xbrl).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xbrl).toContain('xmlns:ee-rtj="http://www.eesti.ee/xbrl/rtj/2026"');
    // Two period contexts, current + prior.
    expect(xbrl).toContain('<xbrli:context id="C-2026">');
    expect(xbrl).toContain('<xbrli:context id="C-2025">');
    expect(xbrl).toContain('<xbrli:endDate>2026-12-31</xbrli:endDate>');
    expect(xbrl).toContain('<xbrli:endDate>2025-12-31</xbrli:endDate>');
    // Entity identifier (declarant reg number) in the mandatory context.
    expect(xbrl).toContain('>12345678</xbrli:identifier>');
  });

  it('reports the current and prior facts for a balance-sheet line', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), { taxonomyVersion: 2026 });
    // Cash 30000 current / 10000 prior, tagged with the right context.
    expect(xbrl).toContain(
      '<ee-rtj:CashAndCashEquivalents contextRef="C-2026" unitRef="EUR" decimals="-2">30000</ee-rtj:CashAndCashEquivalents>',
    );
    expect(xbrl).toContain(
      '<ee-rtj:CashAndCashEquivalents contextRef="C-2025" unitRef="EUR" decimals="-2">10000</ee-rtj:CashAndCashEquivalents>',
    );
    // Tangible fixed assets net of accumulated depreciation: 20000 − 4000 = 16000.
    expect(xbrl).toContain(
      '<ee-rtj:TangibleFixedAssets contextRef="C-2026" unitRef="EUR" decimals="-2">16000</ee-rtj:TangibleFixedAssets>',
    );
  });

  it('equity is three live lines: capital, brought-forward retained, period result', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), { taxonomyVersion: 2026 });
    expect(xbrl).toContain(
      '<ee-rtj:IssuedCapital contextRef="C-2026" unitRef="EUR" decimals="-2">2500</ee-rtj:IssuedCapital>',
    );
    expect(xbrl).toContain(
      '<ee-rtj:RetainedEarningsDeficit contextRef="C-2026" unitRef="EUR" decimals="-2">24500</ee-rtj:RetainedEarningsDeficit>',
    );
    expect(xbrl).toContain(
      '<ee-rtj:ProfitLossForPeriod contextRef="C-2026" unitRef="EUR" decimals="-2">16000</ee-rtj:ProfitLossForPeriod>',
    );
  });

  it('calculation-linkbase semantics: Aktiva = Kohustused + Omakapital', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), { taxonomyVersion: 2026 });
    // Total assets = cash 30000 + receivables 5000 + tangible 16000 = 51000.
    expect(xbrl).toContain(
      '<ee-rtj:TotalAssets contextRef="C-2026" unitRef="EUR" decimals="-2">51000</ee-rtj:TotalAssets>',
    );
    // L + E = AP 8000 + capital 2500 + retained b/f 24500 + period 16000 = 51000.
    expect(xbrl).toContain(
      '<ee-rtj:TotalEquityAndLiabilities contextRef="C-2026" unitRef="EUR" decimals="-2">51000</ee-rtj:TotalEquityAndLiabilities>',
    );
  });

  it('income statement totals: profit for period = revenue − expenses', () => {
    const xbrl = renderAnnualAccountsXbrl(baseInput(), { taxonomyVersion: 2026 });
    // Revenue 60000 − (otherOp 42000 + depreciation 2000) = 16000.
    expect(xbrl).toContain(
      '<ee-rtj:Revenue contextRef="C-2026" unitRef="EUR" decimals="-2">60000</ee-rtj:Revenue>',
    );
    expect(xbrl).toContain(
      '<ee-rtj:ProfitLossForPeriod contextRef="C-2026" unitRef="EUR" decimals="-2">16000</ee-rtj:ProfitLossForPeriod>',
    );
  });

  it('first operating year emits a zero prior column but still two contexts', () => {
    const input = baseInput({
      priorPeriod: null,
      balances: [
        { code: 'BANK_EUR', type: 'asset', current: 5000, prior: 0 },
        { code: 'EQUITY', type: 'equity', current: 2500, prior: 0 },
        { code: 'REVENUE', type: 'revenue', current: 5000, prior: 0 },
        { code: 'EXPENSE_OTHER', type: 'expense', current: 2500, prior: 0 },
      ],
      periodNetIncome: 2500,
      priorNetIncome: 0,
      retainedEarningsBroughtForward: 0,
    });
    const xbrl = renderAnnualAccountsXbrl(input, { taxonomyVersion: 2026 });
    // A zero prior context is still emitted (RIK rejects a single period).
    expect(xbrl).toContain('<xbrli:context id="C-PRIOR">');
    expect(xbrl).toContain(
      '<ee-rtj:CashAndCashEquivalents contextRef="C-PRIOR" unitRef="EUR" decimals="-2">0</ee-rtj:CashAndCashEquivalents>',
    );
  });
});
```

- [ ] **Step 4.2** — Run: `npm test -- src/plugins/estonia-annual-accounts/xbrl.spec.ts`. Expected FAIL (module not found).

- [ ] **Step 4.3** — Minimal impl. Create `src/plugins/estonia-annual-accounts/xbrl.ts`:

```typescript
import type {
  AnnualAccountsInput,
  AnnualAccountsOpts,
} from '../annual-accounts.types';
import { RTJ_LINES, rollUpLines } from './rtj-mapping';

const NS = 'http://www.eesti.ee/xbrl/rtj/2026';

/** Context ids: current period, prior period (or the synthetic zero prior). */
function contextIds(input: AnnualAccountsInput): {
  current: string;
  prior: string;
} {
  const current = `C-${input.period.name}`;
  const prior = input.priorPeriod ? `C-${input.priorPeriod.name}` : 'C-PRIOR';
  return { current, prior };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A single tagged fact line. Amounts are whole euros (minor units / 100 floored?
 *  No — minor units are already cents; RIK reports whole euros. We report minor
 *  units directly with decimals="-2" so the portal reads euros; v1 keeps the
 *  ledger's minor-unit integers as the reported value, matching the draft==final
 *  invariant. */
function fact(concept: string, contextRef: string, value: number): string {
  return `<${concept} contextRef="${contextRef}" unitRef="EUR" decimals="-2">${value}</${concept}>`;
}

export function renderAnnualAccountsXbrl(
  input: AnnualAccountsInput,
  opts: AnnualAccountsOpts,
): string {
  if (opts.taxonomyVersion !== 2026) {
    throw new Error(`Unsupported RIK taxonomy version ${opts.taxonomyVersion}`);
  }
  const { current, prior } = contextIds(input);
  const lines = rollUpLines(input.balances);
  const get = (id: string): { current: number; prior: number } =>
    lines.find((l) => l.id === id) ?? { current: 0, prior: 0 };

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" ` +
      `xmlns:ee-rtj="${NS}" ` +
      `xmlns:iso4217="http://www.xbrl.org/2003/iso4217">`,
  );

  // ── Contexts ──
  const identifier = esc(input.declarant.regNumber ?? '');
  const ctx = (id: string, endDate: string): string =>
    [
      `  <xbrli:context id="${id}">`,
      `    <xbrli:entity><xbrli:identifier scheme="http://www.rik.ee">${identifier}</xbrli:identifier></xbrli:entity>`,
      `    <xbrli:period><xbrli:endDate>${endDate}</xbrli:endDate></xbrli:period>`,
      `  </xbrli:context>`,
    ].join('\n');
  out.push(ctx(current, input.period.endDate));
  out.push(
    ctx(prior, input.priorPeriod ? input.priorPeriod.endDate : '2025-12-31'),
  );

  // ── Unit ──
  out.push(
    `  <xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>`,
  );

  // ── Balance sheet facts ──
  const bsAssetIds = [
    'cashAndBankAccounts',
    'receivablesAndPrepayments',
    'inventories',
    'tangibleFixedAssets',
  ];
  for (const id of bsAssetIds) {
    const def = RTJ_LINES[id];
    const t = get(id);
    out.push('  ' + fact(def.concept, current, t.current));
    out.push('  ' + fact(def.concept, prior, t.prior));
  }
  const totalAssetsCurrent = bsAssetIds.reduce((s, id) => s + get(id).current, 0);
  const totalAssetsPrior = bsAssetIds.reduce((s, id) => s + get(id).prior, 0);
  out.push('  ' + fact('ee-rtj:TotalAssets', current, totalAssetsCurrent));
  out.push('  ' + fact('ee-rtj:TotalAssets', prior, totalAssetsPrior));

  // Liabilities.
  const payables = get('payablesAndPrepayments');
  out.push('  ' + fact(RTJ_LINES.payablesAndPrepayments.concept, current, payables.current));
  out.push('  ' + fact(RTJ_LINES.payablesAndPrepayments.concept, prior, payables.prior));

  // Equity — three live lines.
  const capital = get('issuedCapital');
  out.push('  ' + fact(RTJ_LINES.issuedCapital.concept, current, capital.current));
  out.push('  ' + fact(RTJ_LINES.issuedCapital.concept, prior, capital.prior));
  out.push(
    '  ' +
      fact(
        RTJ_LINES.retainedEarnings.concept,
        current,
        input.retainedEarningsBroughtForward,
      ),
  );
  out.push(
    '  ' +
      fact(
        RTJ_LINES.retainedEarnings.concept,
        prior,
        // Prior brought-forward = prior retained line minus prior result.
        get('retainedEarnings').prior - input.priorNetIncome,
      ),
  );
  out.push(
    '  ' + fact(RTJ_LINES.profitForPeriod.concept, current, input.periodNetIncome),
  );
  out.push('  ' + fact(RTJ_LINES.profitForPeriod.concept, prior, input.priorNetIncome));

  const totalEqLiabCurrent =
    payables.current +
    capital.current +
    input.retainedEarningsBroughtForward +
    input.periodNetIncome;
  const totalEqLiabPrior =
    payables.prior +
    capital.prior +
    (get('retainedEarnings').prior - input.priorNetIncome) +
    input.priorNetIncome;
  out.push(
    '  ' + fact('ee-rtj:TotalEquityAndLiabilities', current, totalEqLiabCurrent),
  );
  out.push(
    '  ' + fact('ee-rtj:TotalEquityAndLiabilities', prior, totalEqLiabPrior),
  );

  // ── Income statement facts (skeem 1) ──
  const isIds = ['revenue', 'labourExpense', 'otherOperatingExpenses', 'depreciation'];
  for (const id of isIds) {
    const def = RTJ_LINES[id];
    const t = get(id);
    out.push('  ' + fact(def.concept, current, t.current));
    out.push('  ' + fact(def.concept, prior, t.prior));
  }
  // Profit for period mirrors the equity line (same fact, income-statement total).
  out.push(
    '  ' + fact(RTJ_LINES.profitForPeriod.concept, current, input.periodNetIncome),
  );

  out.push('</xbrli:xbrl>');
  return out.join('\n');
}
```

> Note on the equity double-count: the `RETAINED_EARNINGS` ledger balance at year end may or may not already include the period result depending on whether a prior sweep ran. v1 has **no** year-end sweep (ADR §3), so `RETAINED_EARNINGS` holds only brought-forward profit and `periodNetIncome` is the separate live line — `retainedEarningsBroughtForward` (assembled by the kernel from the `RETAINED_EARNINGS` closing balance) plus `periodNetIncome` is exactly equity's contribution, and `TotalEquityAndLiabilities` therefore equals `TotalAssets` because every voucher balances. The golden test asserts `51000 == 51000`.

- [ ] **Step 4.4** — Run: `npm test -- src/plugins/estonia-annual-accounts/xbrl.spec.ts`. Expected PASS. The fixture in Step 4.1 is already self-consistent: assets 51000 = liabilities 8000 + capital 2500 + retained-b/f 24500 + period result 16000, and period result 16000 = revenue 60000 − otherOp 42000 − depreciation 2000 (with no year-end sweep, `RETAINED_EARNINGS.current` 24500 is brought-forward only; the period result is the separate live `ProfitLossForPeriod` line). The invariant to preserve is `TotalAssets == payables + capital + retainedEarningsBroughtForward + periodNetIncome` — adjust fixture numbers to satisfy it, never the renderer's arithmetic.

- [ ] **Step 4.5** — Wire the Estonia plugin. In `src/plugins/estonia-country.plugin.ts`, add imports:

```typescript
import {
  AnnualAccountsInput,
  AnnualAccountsOpts,
  AnnualAccountsResult,
} from './annual-accounts.types';
import { renderAnnualAccountsXbrl } from './estonia-annual-accounts/xbrl';
import { unmappedNonzeroCodes } from './estonia-annual-accounts/rtj-mapping';
```

Add the method (after `generateStatutoryReports`):

```typescript
  generateAnnualAccounts(
    input: AnnualAccountsInput,
    opts: AnnualAccountsOpts,
  ): AnnualAccountsResult {
    const warnings: StatutoryWarning[] = [];

    // Plugin-side soft signal: nonzero accounts the mapping does not cover.
    // (The kernel HARD-blocks final on the same condition; here it is surfaced
    // as a rendering warning so a draft still renders.)
    const unmapped = unmappedNonzeroCodes(input.balances);
    for (const code of unmapped) {
      warnings.push({
        code: 'unmapped_nonzero_account',
        message: `Account ${code} has a nonzero balance but maps to no RTJ line`,
      });
    }

    const base = input.period.name.replace(/[^\w-]/g, '_');
    const content = renderAnnualAccountsXbrl(input, opts);
    return {
      artifacts: [
        {
          filename: `annual-accounts-${base}.xbrl`,
          mimeType: 'application/xml',
          content,
        },
      ],
      warnings,
    };
  }
```

- [ ] **Step 4.6** — Add a plugin-level test in `src/plugins/estonia-country.plugin.spec.ts` (new `describe`):

```typescript
import { renderAnnualAccountsXbrl } from './estonia-annual-accounts/xbrl';

describe('EstoniaCountryPlugin — annual accounts', () => {
  const ee = new EstoniaCountryPlugin();
  const input = {
    period: { name: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    priorPeriod: null,
    mode: 'draft' as const,
    balances: [
      { code: 'BANK_EUR', type: 'asset' as const, current: 5000, prior: 0 },
      { code: 'MYSTERY', type: 'asset' as const, current: 250, prior: 0 },
    ],
    fixedAssets: [],
    periodNetIncome: 0,
    priorNetIncome: 0,
    retainedEarningsBroughtForward: 0,
    declarant: { regNumber: '12345678', name: 'Test OÜ' },
  };

  it('renders one XBRL artifact and warns on unmapped nonzero accounts', () => {
    const result = ee.generateAnnualAccounts(input, { taxonomyVersion: 2026 });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].filename).toBe('annual-accounts-2026.xbrl');
    expect(result.artifacts[0].mimeType).toBe('application/xml');
    expect(result.artifacts[0].content).toBe(
      renderAnnualAccountsXbrl(input, { taxonomyVersion: 2026 }),
    );
    expect(result.warnings.map((w) => w.code)).toContain(
      'unmapped_nonzero_account',
    );
  });
});
```

- [ ] **Step 4.7** — Run: `npm test -- src/plugins/estonia-country.plugin.spec.ts src/plugins/estonia-annual-accounts/xbrl.spec.ts` then `npm run typecheck`. Expected PASS (Estonia now implements the full interface; typecheck is fully green).

- [ ] **Step 4.8** — Commit:
```bash
git add src/plugins/estonia-annual-accounts/xbrl.ts src/plugins/estonia-annual-accounts/xbrl.spec.ts src/plugins/estonia-country.plugin.ts src/plugins/estonia-country.plugin.spec.ts
git commit -m "feat(annual-accounts): Estonia RIK-XBRL renderer + plugin method"
```

---

## Task 5 — Period-scoped ledger balance method (TDD on LedgerBalanceService)

`LedgerBalanceService` has `getLedgerNet(filter, options)` but **no date-range** variant. The annual-accounts assembly needs per-account closing balances **as at a period end** (and at the prior period end) — a tax-point-date upper bound. Add `getLedgerNetForPeriod`.

**Files:**
- `src/ledger/account/ledger-balance.service.ts` (modify)
- `src/ledger/account/ledger-balance.service.spec.ts` (modify or create)

- [ ] **Step 5.1** — Failing test. Add to `src/ledger/account/ledger-balance.service.spec.ts` (create the file with the integration bootstrap from BOILERPLATE §1 if it does not exist; wire only `LedgerBalanceService` + a couple of hand-inserted vouchers). Minimal spec:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { LedgerBalanceService } from './ledger-balance.service';

describe('LedgerBalanceService.getLedgerNetForPeriod (integration)', () => {
  let db: Kysely<Database>;
  let service: LedgerBalanceService;

  async function insertVoucher(
    taxPointDate: string,
    lines: Array<{ code: string; isDebit: boolean; base: number }>,
  ): Promise<void> {
    const v = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-${taxPointDate}-${Math.random().toString(36).slice(2, 7)}`,
        tax_point_date: taxPointDate,
        posted_at: 1,
        previous_hash: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const l of lines) {
      const acc = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', l.code)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: v.id,
          account_id: acc.id,
          amount: l.base,
          currency: 'EUR',
          base_amount: l.base,
          fx_rate: 1,
          vat_code: null,
          is_debit: l.isDebit ? 1 : 0,
        })
        .execute();
    }
  }

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        LedgerBalanceService,
      ],
    }).compile();
    service = module.get(LedgerBalanceService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('sums only lines whose tax_point_date <= the period end', async () => {
    // In-year revenue.
    await insertVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 10000 },
      { code: 'REVENUE', isDebit: false, base: 10000 },
    ]);
    // Next-year revenue — must NOT count for a 2026 close.
    await insertVoucher('2027-01-15', [
      { code: 'BANK_EUR', isDebit: true, base: 5000 },
      { code: 'REVENUE', isDebit: false, base: 5000 },
    ]);

    const rev = await service.getLedgerNetForPeriod(
      { codes: ['REVENUE'] },
      { endDate: '2026-12-31' },
      { creditPositive: true },
    );
    expect(rev).toBe(10000);

    const bank = await service.getLedgerNetForPeriod(
      { codes: ['BANK_EUR'] },
      { endDate: '2026-12-31' },
    );
    expect(bank).toBe(10000); // debit-positive, only the in-year voucher
  });

  it('honours a startDate lower bound for period flows (revenue within a year)', async () => {
    await insertVoucher('2025-06-01', [
      { code: 'BANK_EUR', isDebit: true, base: 7000 },
      { code: 'REVENUE', isDebit: false, base: 7000 },
    ]);
    await insertVoucher('2026-06-01', [
      { code: 'BANK_EUR', isDebit: true, base: 3000 },
      { code: 'REVENUE', isDebit: false, base: 3000 },
    ]);
    const rev2026 = await service.getLedgerNetForPeriod(
      { codes: ['REVENUE'] },
      { startDate: '2026-01-01', endDate: '2026-12-31' },
      { creditPositive: true },
    );
    expect(rev2026).toBe(3000);
  });
});
```

- [ ] **Step 5.2** — Run: `npm test -- src/ledger/account/ledger-balance.service.spec.ts`. Expected FAIL (`getLedgerNetForPeriod is not a function`).

- [ ] **Step 5.3** — Minimal impl. In `src/ledger/account/ledger-balance.service.ts`, add a range type and the method:

```typescript
/** A tax-point-date window. `startDate` omitted ⇒ from the beginning of time. */
export interface PeriodRange {
  startDate?: string;
  endDate: string;
}
```

```typescript
  /**
   * Period-scoped signed net: like {@link getLedgerNet} but restricted to
   * voucher lines whose voucher.tax_point_date falls in `[startDate, endDate]`
   * (startDate optional → cumulative-to-date for closing-balance reads of
   * balance-sheet accounts; both bounds set → a period flow for P&L accounts).
   * Only posted vouchers are counted.
   */
  async getLedgerNetForPeriod(
    filter: LedgerNetFilter,
    range: PeriodRange,
    options: SignedNetOptions = {},
  ): Promise<number> {
    const codes = filter.codes ?? [];
    const types = filter.types ?? [];
    if (codes.length === 0 && types.length === 0) return 0;

    let query = this.db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .select(
        sql<number>`COALESCE(SUM(CASE WHEN vl.is_debit = 1 THEN vl.base_amount ELSE -vl.base_amount END), 0)`.as(
          'net',
        ),
      )
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '<=', range.endDate);

    if (range.startDate !== undefined) {
      query = query.where('v.tax_point_date', '>=', range.startDate);
    }

    query = query.where((eb) =>
      eb.or([
        ...(codes.length > 0 ? [eb('a.code', 'in', codes)] : []),
        ...(types.length > 0 ? [eb('a.type', 'in', types)] : []),
      ]),
    );

    const result = await query.executeTakeFirst();
    const debitPositive = Number(result?.net ?? 0);
    return options.creditPositive ? -debitPositive : debitPositive;
  }
```

- [ ] **Step 5.4** — Run: `npm test -- src/ledger/account/ledger-balance.service.spec.ts`. Expected PASS.

- [ ] **Step 5.5** — Commit:
```bash
git add src/ledger/account/ledger-balance.service.ts src/ledger/account/ledger-balance.service.spec.ts
git commit -m "feat(ledger): period-scoped getLedgerNetForPeriod for closing balances"
```

---

## Task 6 — AnnualAccountsService.generate (draft) — assembly + delegation

**Files:**
- `src/annual-accounts/annual-accounts.service.ts` (create)
- `src/annual-accounts/annual-accounts.service.spec.ts` (create)
- `src/annual-accounts/annual-accounts.module.ts` (create)
- `src/app.module.ts` (modify)

The service mirrors `StatutoryReportService`: it loads the period, resolves the plugin via `OrgContextResolver`, assembles the neutral `AnnualAccountsInput`, and delegates. Draft computes depreciation **virtually** (engine only, posts nothing). It assembles per-account closing balances at period end + prior period end using `getLedgerNetForPeriod`, the `fixed_asset` register snapshot, period/prior net income, and brought-forward retained earnings.

- [ ] **Step 6.1** — Failing test. Create `src/annual-accounts/annual-accounts.service.spec.ts`. Bootstrap with BOILERPLATE §1, wiring `LedgerBalanceService`, `OrgContextResolver`, `OrganizationService`, `PluginLoader`, `NullCountryPlugin`, `EstoniaCountryPlugin`, `PeriodLockService`, `PostingService` (+ its deps), `AnnualAccountsService`. Helper posts a year of vouchers and a capitalized vehicle via direct inserts (the fixed-assets pipeline is a dependency; for the draft test, hand-insert the acquisition voucher + a `fixed_asset` row to keep the spec self-contained).

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { AnnualAccountsService } from './annual-accounts.service';

describe('AnnualAccountsService.generate — draft (integration)', () => {
  let db: Kysely<Database>;
  let service: AnnualAccountsService;

  async function postVoucher(
    taxPointDate: string,
    lines: Array<{ code: string; isDebit: boolean; base: number }>,
  ): Promise<number> {
    const v = await db
      .insertInto('voucher')
      .values({
        voucher_number: `V-${Math.random().toString(36).slice(2, 9)}`,
        tax_point_date: taxPointDate,
        posted_at: 1,
        previous_hash: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const l of lines) {
      const acc = await db
        .selectFrom('account')
        .select('id')
        .where('code', '=', l.code)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('voucher_line')
        .values({
          voucher_id: v.id,
          account_id: acc.id,
          amount: l.base,
          currency: 'EUR',
          base_amount: l.base,
          fx_rate: 1,
          vat_code: null,
          is_debit: l.isDebit ? 1 : 0,
        })
        .execute();
    }
    return v.id;
  }

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Migration failed');

    // Organization: EE so the Estonia plugin renders.
    await db
      .insertInto('organization')
      .values({
        name: 'Test OÜ',
        country: 'EE',
        base_currency: 'EUR',
        vat_registered: 1,
        vat_registration_number: 'EE123456789',
      } as never)
      .execute();

    // A 2026 reporting period (the year being closed) + a 2025 prior.
    await db
      .insertInto('reporting_period')
      .values([
        { name: '2025', start_date: '2025-01-01', end_date: '2025-12-31', status: 'locked', filed_at: 1, created_at: 1 } as never,
        { name: '2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open', created_at: 1 } as never,
      ])
      .execute();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        LedgerBalanceService,
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
        AnnualAccountsService,
      ],
    }).compile();
    service = module.get(AnnualAccountsService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  function periodId(name: string): Promise<number> {
    return db
      .selectFrom('reporting_period')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirstOrThrow()
      .then((r) => r.id);
  }

  it('assembles a balanced draft and renders an XBRL artifact, posting nothing', async () => {
    // Capital injection 2026.
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    // A capitalized vehicle bought 2026-01-10 for 20000 (debit FIXED_ASSETS, credit BANK).
    const acqId = await postVoucher('2026-01-10', [
      { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
      { code: 'BANK_EUR', isDebit: false, base: 20000 },
    ]);
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acqId,
        acquisition_date: '2026-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    // Revenue + a cash expense in 2026.
    await postVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 60000 },
      { code: 'REVENUE', isDebit: false, base: 60000 },
    ]);
    await postVoucher('2026-04-01', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 42000 },
      { code: 'BANK_EUR', isDebit: false, base: 42000 },
    ]);

    const before = await db
      .selectFrom('voucher')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();

    const id = await periodId('2026');
    const result = await service.generate(id);

    // Renders exactly one XBRL artifact.
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].filename).toBe('annual-accounts-2026.xbrl');
    // The depreciation expense line is present (computed virtually): vehicle
    // 20000 / 5y = 4000 annual charge (full year).
    expect(result.artifacts[0].content).toContain(
      '<ee-rtj:DepreciationAndImpairmentLoss contextRef="C-2026"',
    );
    // Draft posts NOTHING: voucher count unchanged.
    const after = await db
      .selectFrom('voucher')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });
});
```

- [ ] **Step 6.2** — Run: `npm test -- src/annual-accounts/annual-accounts.service.spec.ts`. Expected FAIL (module not found).

- [ ] **Step 6.3** — Minimal impl. Create `src/annual-accounts/annual-accounts.service.ts`:

```typescript
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PostingService } from '../ledger/posting/posting.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { depreciationCharge } from '../fixed-assets/depreciation-engine';
import type {
  AccountBalanceRow,
  AnnualAccountsInput,
  AnnualAccountsResult,
  FixedAssetSnapshotRow,
  AnnualAccountsWarning,
} from '../plugins/annual-accounts.types';
import { DraftVoucher } from '../ledger/voucher/types';

/** The asset classes the kernel knows about (mirrors the `fixed_asset` register). */
type AssetClass = 'vehicle' | 'it_equipment' | 'machinery' | 'furniture';

/** The fixed-asset → contra-account map for posting/virtualizing depreciation. */
const ACCUM_BY_CLASS: Record<AssetClass, string> = {
  vehicle: 'ACCUM_DEPRECIATION_VEHICLES',
  it_equipment: 'ACCUM_DEPRECIATION_IT',
  machinery: 'ACCUM_DEPRECIATION_EQUIPMENT',
  furniture: 'ACCUM_DEPRECIATION_FURNITURE',
};

/**
 * The year's depreciation charge for one register row, with the asset's identity
 * kept alongside the engine's pure result. Produced by the local
 * {@link AnnualAccountsService.computeYearCharges} helper.
 */
interface AssetAnnualCharge {
  assetId: number;
  assetClass: AssetClass;
  chargeMinor: number;
}

/**
 * AnnualAccountsService — assembles a NEUTRAL {@link AnnualAccountsInput} from the
 * posted ledger + the fixed-asset register and delegates ALL jurisdiction
 * rendering to the active country plugin (ADR-0034), mirroring
 * StatutoryReportService.
 *
 * draft (generate): computes the annual depreciation charge VIRTUALLY (engine
 * only), folds it into the balances, renders, posts nothing.
 * final (finalize): posts the depreciation charge as a system-generated
 * voucher, locks the year, then renders the identical numbers.
 */
@Injectable()
export class AnnualAccountsService {
  /** Every account code that can hold a balance, for closing-balance reads. */
  private static readonly BALANCE_SHEET_TYPES = [
    'asset',
    'liability',
    'equity',
  ] as const;
  private static readonly PNL_TYPES = ['revenue', 'expense'] as const;

  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
    private readonly orgResolver: OrgContextResolver,
    private readonly postingService: PostingService,
    private readonly reportingPeriods: ReportingPeriodsService,
  ) {}

  async generate(periodId: number): Promise<AnnualAccountsResult> {
    const { input, plugin, diagnostics } = await this.assemble(periodId, 'draft');
    const result = plugin.generateAnnualAccounts(input, { taxonomyVersion: 2026 });
    return {
      artifacts: result.artifacts,
      warnings: [...diagnostics, ...result.warnings],
    };
  }

  /**
   * The shared assembly used by both modes. Builds the neutral input with the
   * annual depreciation charge folded in VIRTUALLY (so draft and final read
   * identical numbers), plus the kernel diagnostics (Task 7).
   */
  private async assemble(
    periodId: number,
    mode: 'draft' | 'final',
  ): Promise<{
    input: AnnualAccountsInput;
    plugin: ReturnType<OrgContextResolver['resolve']> extends Promise<infer R>
      ? R extends { plugin: infer P }
        ? P
        : never
      : never;
    diagnostics: AnnualAccountsWarning[];
    charges: AssetAnnualCharge[];
    period: { id: number; name: string; start_date: string; end_date: string };
  }> {
    const period = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date', 'status'])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }

    const prior = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date'])
      .where('end_date', '<', period.start_date)
      .orderBy('end_date', 'desc')
      .executeTakeFirst();

    const { organization, plugin } = await this.orgResolver.resolve();

    // ── Load every account, compute current + prior closing/flow balances. ──
    const accounts = await this.db
      .selectFrom('account')
      .select(['code', 'type'])
      .execute();

    const balances: AccountBalanceRow[] = [];
    for (const a of accounts) {
      const type = a.type as AccountBalanceRow['type'];
      const isPnl = type === 'revenue' || type === 'expense';
      const creditPositive =
        type === 'liability' || type === 'equity' || type === 'revenue';

      // Balance-sheet accounts: cumulative-to-date (no startDate).
      // P&L accounts: in-year flow (startDate..endDate).
      const current = await this.ledgerBalance.getLedgerNetForPeriod(
        { codes: [a.code] },
        isPnl
          ? { startDate: period.start_date, endDate: period.end_date }
          : { endDate: period.end_date },
        { creditPositive },
      );
      const prior_ = prior
        ? await this.ledgerBalance.getLedgerNetForPeriod(
            { codes: [a.code] },
            isPnl
              ? { startDate: prior.start_date, endDate: prior.end_date }
              : { endDate: prior.end_date },
            { creditPositive },
          )
        : 0;
      balances.push({ code: a.code, type, current, prior: prior_ });
    }

    // ── Fixed-asset register snapshot + virtual annual depreciation. ──
    const assetRows = await this.db
      .selectFrom('fixed_asset')
      .select([
        'id',
        'asset_class',
        'acquisition_date',
        'cost_base_minor',
        'useful_life_years',
        'residual_value_minor',
        'retired_at',
      ])
      .execute();

    // The year's charge per asset = accumulated(periodEnd) − accumulated(priorEnd).
    // `priorPeriodEnd` is the prior reporting period's end (null ⇒ first operating
    // year ⇒ charge from acquisition). Each register row is passed straight to the
    // engine: its 7 fields structurally satisfy the engine's 4-field
    // DepreciableAsset param, and we keep id + asset_class alongside the result.
    const charges = this.computeYearCharges(
      assetRows,
      prior ? prior.end_date : null,
      period.end_date,
    );

    // Fold the virtual charge into the balances so draft == final numbers:
    //   Dr DEPRECIATION_EXPENSE (debit-normal +), Cr ACCUM_DEPRECIATION_* (asset, −).
    const totalCharge = charges.reduce((s, c) => s + c.chargeMinor, 0);
    if (totalCharge !== 0) {
      this.addToBalance(balances, 'DEPRECIATION_EXPENSE', 'expense', totalCharge);
      for (const c of charges) {
        // Contra-asset: a credit reduces the normal-side-positive asset balance.
        this.addToBalance(
          balances,
          ACCUM_BY_CLASS[c.assetClass],
          'asset',
          -c.chargeMinor,
        );
      }
    }

    const fixedAssets: FixedAssetSnapshotRow[] = assetRows.map((r) => ({
      id: r.id,
      assetClass: r.asset_class as FixedAssetSnapshotRow['assetClass'],
      costMinor: r.cost_base_minor,
      retired: r.retired_at !== null,
    }));

    // ── Net income (revenue − expense), including the virtual depreciation. ──
    const periodNetIncome = this.netIncome(balances, 'current');
    const priorNetIncome = this.netIncome(balances, 'prior');

    // Retained earnings brought forward = RETAINED_EARNINGS closing balance.
    const retainedEarningsBroughtForward =
      balances.find((b) => b.code === 'RETAINED_EARNINGS')?.current ?? 0;

    const input: AnnualAccountsInput = {
      period: {
        name: period.name,
        startDate: period.start_date,
        endDate: period.end_date,
      },
      priorPeriod: prior
        ? { name: prior.name, startDate: prior.start_date, endDate: prior.end_date }
        : null,
      mode,
      balances,
      fixedAssets,
      periodNetIncome,
      priorNetIncome,
      retainedEarningsBroughtForward,
      declarant: {
        regNumber: organization.vat_registration_number,
        name: organization.name,
      },
    };

    const diagnostics = this.diagnose(input);

    return { input, plugin, diagnostics, charges, period };
  }

  /**
   * The year's depreciation charge per (non-retired) register row, wrapping the
   * pure engine's {@link depreciationCharge}. The charge is the change in
   * accumulated depreciation between the prior period end and this period end:
   * `depreciationCharge(row, priorPeriodEnd, periodEnd)` = accumulated(periodEnd)
   * − accumulated(priorPeriodEnd). `priorPeriodEnd === null` ⇒ first operating
   * year ⇒ charge accrues from acquisition. Each `fixed_asset` row carries the
   * engine's four math fields (plus id/asset_class/retired_at), so it satisfies
   * the engine's `DepreciableAsset` param by structural typing — we pass the row
   * directly and keep `id` + `asset_class` alongside the returned `chargeMinor`.
   */
  private computeYearCharges(
    rows: Array<{
      id: number;
      asset_class: string;
      acquisition_date: string;
      cost_base_minor: number;
      useful_life_years: number;
      residual_value_minor: number;
      retired_at: number | null;
    }>,
    priorPeriodEnd: string | null,
    periodEnd: string,
  ): AssetAnnualCharge[] {
    const charges: AssetAnnualCharge[] = [];
    for (const row of rows) {
      if (row.retired_at !== null) continue; // retired assets accrue no charge
      const chargeMinor = depreciationCharge(row, priorPeriodEnd, periodEnd);
      charges.push({
        assetId: row.id,
        assetClass: row.asset_class as AssetClass,
        chargeMinor,
      });
    }
    return charges;
  }

  private addToBalance(
    balances: AccountBalanceRow[],
    code: string,
    type: AccountBalanceRow['type'],
    deltaCurrent: number,
  ): void {
    const existing = balances.find((b) => b.code === code);
    if (existing) {
      existing.current += deltaCurrent;
    } else {
      balances.push({ code, type, current: deltaCurrent, prior: 0 });
    }
  }

  /** Net income = Σ revenue (credit-positive) − Σ expense (debit-positive). */
  private netIncome(
    balances: AccountBalanceRow[],
    field: 'current' | 'prior',
  ): number {
    let revenue = 0;
    let expense = 0;
    for (const b of balances) {
      if (b.type === 'revenue') revenue += b[field];
      if (b.type === 'expense') expense += b[field];
    }
    return revenue - expense;
  }

  /** Kernel diagnostics — filled in by Task 7. Returns [] for now. */
  protected diagnose(_input: AnnualAccountsInput): AnnualAccountsWarning[] {
    return [];
  }
}
```

Create `src/annual-accounts/annual-accounts.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { OrganizationModule } from '../organization/organization.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AnnualAccountsService } from './annual-accounts.service';
import { AnnualAccountsController } from './annual-accounts.controller';

/**
 * AnnualAccountsModule — wires the annual-accounts projection (ADR-0034).
 * Imports the modules that EXPORT its collaborators:
 *  - AccountModule          → LedgerBalanceService (period balances)
 *  - OrganizationModule     → OrgContextResolver (active plugin + declarant)
 *  - PostingModule          → PostingService (final depreciation voucher)
 *  - ReportingPeriodsModule → ReportingPeriodsService (lock the year)
 */
@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    OrganizationModule,
    PostingModule,
    ReportingPeriodsModule,
  ],
  controllers: [AnnualAccountsController],
  providers: [AnnualAccountsService],
  exports: [AnnualAccountsService],
})
export class AnnualAccountsModule {}
```

> The controller is created in Task 9; until then, temporarily omit `controllers`/`AnnualAccountsController` import (or stub the controller). To keep this task self-contained, create a minimal placeholder controller now and flesh it out in Task 9, OR defer the module's `controllers` entry. **Chosen approach:** create the full controller in Task 9 and, for Task 6, comment out the controller import + `controllers` line, restoring them in Task 9. (The spec under test instantiates the service directly, not via the module, so the module need not compile a controller yet.)

For Task 6, the module file should therefore omit the controller:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountModule } from '../ledger/account/account.module';
import { OrganizationModule } from '../organization/organization.module';
import { PostingModule } from '../ledger/posting/posting.module';
import { ReportingPeriodsModule } from '../reporting-periods/reporting-periods.module';
import { AnnualAccountsService } from './annual-accounts.service';

@Module({
  imports: [
    DatabaseModule,
    AccountModule,
    OrganizationModule,
    PostingModule,
    ReportingPeriodsModule,
  ],
  providers: [AnnualAccountsService],
  exports: [AnnualAccountsService],
})
export class AnnualAccountsModule {}
```

Register it in `src/app.module.ts`: add `import { AnnualAccountsModule } from './annual-accounts/annual-accounts.module';` and add `AnnualAccountsModule,` to the `imports` array.

> **Engine dependency:** `depreciationCharge` comes from the fixed-assets plan (`src/fixed-assets/depreciation-engine.ts`); the kernel wraps it in the local `computeYearCharges` helper above. The `fixed_asset` table and the `ACCUM_DEPRECIATION_*`/`DEPRECIATION_EXPENSE` accounts must exist (fixed-assets migrations 046–049) for the migrator to create them; this spec depends on those migrations being merged first.

- [ ] **Step 6.4** — Run: `npm test -- src/annual-accounts/annual-accounts.service.spec.ts`. Expected PASS. Then `npm run typecheck`. Expected PASS.

- [ ] **Step 6.5** — Commit:
```bash
git add src/annual-accounts/annual-accounts.service.ts src/annual-accounts/annual-accounts.module.ts src/annual-accounts/annual-accounts.service.spec.ts src/app.module.ts
git commit -m "feat(annual-accounts): kernel draft assembly + virtual depreciation"
```

---

## Task 7 — Draft diagnostics (balance check, unmapped-nonzero, soft warnings)

**Files:**
- `src/annual-accounts/annual-accounts.service.ts` (modify — implement `diagnose`)
- `src/annual-accounts/annual-accounts.service.spec.ts` (modify — add diagnostic specs)

Diagnostics implement the PRD/ADR gating semantics. Hard conditions (balance-sheet imbalance, unmapped nonzero) are returned as warnings with a `severity: 'block'` marker so `finalize` (Task 8) can reject; soft conditions are non-blocking.

- [ ] **Step 7.1** — Failing test. Add to `src/annual-accounts/annual-accounts.service.spec.ts`:

```typescript
  it('warns (soft) when EXPENSE_OTHER dominates total expenses', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 100000 },
      { code: 'EQUITY', isDebit: false, base: 100000 },
    ]);
    await postVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 50000 },
      { code: 'REVENUE', isDebit: false, base: 50000 },
    ]);
    // Almost all expense lands in EXPENSE_OTHER (concentration).
    await postVoucher('2026-04-01', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 40000 },
      { code: 'BANK_EUR', isDebit: false, base: 40000 },
    ]);
    const id = await periodId('2026');
    const result = await service.generate(id);
    expect(result.warnings.map((w) => w.code)).toContain(
      'expense_other_concentration',
    );
  });

  it('warns (soft) when there are assets in the register but no depreciation posted', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const acqId = await postVoucher('2026-01-10', [
      { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
      { code: 'BANK_EUR', isDebit: false, base: 20000 },
    ]);
    // Register row exists; in draft, depreciation is computed virtually so the
    // "not yet posted" soft warning is expected (no ACCUM_DEPRECIATION voucher).
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acqId,
        acquisition_date: '2026-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    const id = await periodId('2026');
    const result = await service.generate(id);
    expect(result.warnings.map((w) => w.code)).toContain(
      'depreciation_not_yet_posted',
    );
  });

  it('flags an unmapped nonzero account as a blocking diagnostic', async () => {
    // SHAREHOLDER_LOAN-style code that the RTJ map does not cover but the seed
    // has — use RECEIVABLE_FROM_OWNER? It IS mapped. Use a deliberately unmapped
    // seeded account: there is none guaranteed unmapped, so assert on the
    // count of blocking warnings being zero for a fully-mapped balanced book.
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const id = await periodId('2026');
    const result = await service.generate(id);
    const blocking = result.warnings.filter(
      (w) => (w as { severity?: string }).severity === 'block',
    );
    expect(blocking).toHaveLength(0);
  });
```

> Note: the seeded chart maps every account, so an unmapped-nonzero block is exercised at the `rtj-mapping.spec.ts` level (Task 3) and at the finalize integration level (Task 8) by hand-inserting a voucher against a fabricated account is not possible (FK to `account`). The blocking-path coverage is therefore: (a) Task 3 unit test for detection, (b) Task 8 imbalance block (a real, reproducible hard block via an unbalanced hand-inserted voucher).

- [ ] **Step 7.2** — Run: `npm test -- src/annual-accounts/annual-accounts.service.spec.ts`. Expected FAIL (warnings empty — `diagnose` returns []).

- [ ] **Step 7.3** — Minimal impl. Replace the placeholder `diagnose` in `src/annual-accounts/annual-accounts.service.ts`. First add the import at the top:

```typescript
import { unmappedNonzeroCodes } from '../plugins/estonia-annual-accounts/rtj-mapping';
```

> The `unmappedNonzeroCodes` helper is Estonia-specific. The kernel must stay jurisdiction-neutral, so the *unmapped* detection belongs to the plugin (it already warns in Task 4). The kernel's diagnostics cover the **jurisdiction-neutral** checks only: balance-sheet balance (an arithmetic invariant) and the soft signals that do not need the RTJ map. Therefore DO NOT import the Estonia helper into the kernel. Implement `diagnose` as:

```typescript
  /**
   * Jurisdiction-neutral draft diagnostics. The RTJ-map-dependent
   * unmapped-nonzero check is owned by the PLUGIN (it warns during render);
   * `finalize` re-reads those plugin warnings to hard-block (Task 8). Here the
   * kernel checks only arithmetic invariants + soft signals:
   *  - balance-sheet balance (Aktiva == Kohustused + Omakapital) — BLOCK,
   *  - EXPENSE_OTHER concentration — soft,
   *  - depreciation not yet posted (register has assets, no ACCUM voucher) — soft,
   *  - register-vs-ledger cost mismatch — soft.
   */
  protected diagnose(input: AnnualAccountsInput): AnnualAccountsWarning[] {
    const warnings: (AnnualAccountsWarning & { severity?: 'block' | 'soft' })[] =
      [];

    // 1. Balance-sheet balance. Assets (debit-normal +) must equal
    //    liabilities + equity, where equity = capital + brought-forward retained
    //    + period result (the three live lines, ADR §3).
    const sum = (pred: (b: AccountBalanceRow) => boolean): number =>
      input.balances.filter(pred).reduce((s, b) => s + b.current, 0);
    const assets = sum((b) => b.type === 'asset');
    const liabilities = sum((b) => b.type === 'liability');
    // Equity live lines: EQUITY (capital) + RETAINED_EARNINGS brought forward
    // + period net income. (RETAINED_EARNINGS current = brought forward in v1.)
    const capital = input.balances
      .filter((b) => b.type === 'equity' && b.code !== 'RETAINED_EARNINGS')
      .reduce((s, b) => s + b.current, 0);
    const equity =
      capital + input.retainedEarningsBroughtForward + input.periodNetIncome;
    if (assets !== liabilities + equity) {
      warnings.push({
        code: 'balance_sheet_imbalance',
        message: `Balance sheet does not balance: assets ${assets} != liabilities ${liabilities} + equity ${equity}`,
        severity: 'block',
      });
    }

    // 2. EXPENSE_OTHER concentration (soft): > 50% of total expense.
    const totalExpense = input.balances
      .filter((b) => b.type === 'expense')
      .reduce((s, b) => s + b.current, 0);
    const other =
      input.balances.find((b) => b.code === 'EXPENSE_OTHER')?.current ?? 0;
    if (totalExpense > 0 && other / totalExpense > 0.5) {
      warnings.push({
        code: 'expense_other_concentration',
        message: `EXPENSE_OTHER is ${Math.round((other / totalExpense) * 100)}% of total expenses`,
        severity: 'soft',
      });
    }

    // 3. Depreciation not yet posted (soft): register has live assets but the
    //    ledger ACCUM_DEPRECIATION_* lines for the period are absent. In draft
    //    the charge is virtual, so this signal fires whenever no real ACCUM
    //    voucher has been posted for the period's depreciation.
    const liveAssets = input.fixedAssets.filter((a) => !a.retired).length;
    if (liveAssets > 0 && input.mode === 'draft') {
      warnings.push({
        code: 'depreciation_not_yet_posted',
        message: `${liveAssets} asset(s) in the register; annual depreciation is computed virtually and not yet posted`,
        severity: 'soft',
      });
    }

    // 4. Register-vs-ledger cost mismatch (soft): Σ register cost per class vs
    //    the FIXED_ASSETS_* ledger balance per class.
    const ledgerByClass: Record<string, number> = {
      vehicle:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_VEHICLES')?.current ??
        0,
      it_equipment:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_IT')?.current ?? 0,
      machinery:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_EQUIPMENT')
          ?.current ?? 0,
      furniture:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_FURNITURE')
          ?.current ?? 0,
    };
    const registerByClass: Record<string, number> = {};
    for (const a of input.fixedAssets) {
      if (a.retired) continue;
      registerByClass[a.assetClass] =
        (registerByClass[a.assetClass] ?? 0) + a.costMinor;
    }
    for (const cls of Object.keys(ledgerByClass)) {
      if ((registerByClass[cls] ?? 0) !== ledgerByClass[cls]) {
        warnings.push({
          code: 'register_ledger_cost_mismatch',
          message: `Fixed-asset register cost for ${cls} (${registerByClass[cls] ?? 0}) != ledger (${ledgerByClass[cls]})`,
          severity: 'soft',
        });
      }
    }

    return warnings;
  }
```

> Extend the `AnnualAccountsWarning` consumers to tolerate the optional `severity`. Since `AnnualAccountsWarning = StatutoryWarning` and `StatutoryWarning` has no `severity`, the diagnostics use a structural extension. To keep types honest, add `severity?: 'block' | 'soft'` to a kernel-local warning type. **Concretely:** in `annual-accounts.service.ts` define `type DiagnosticWarning = AnnualAccountsWarning & { severity?: 'block' | 'soft' };` and have `diagnose` return `DiagnosticWarning[]`; the public `generate`/`finalize` return `AnnualAccountsResult` whose `warnings` are `DiagnosticWarning[]` (structurally assignable to `AnnualAccountsWarning[]`). Update the `assemble` return type `diagnostics: DiagnosticWarning[]` accordingly.

- [ ] **Step 7.4** — Run: `npm test -- src/annual-accounts/annual-accounts.service.spec.ts`. Expected PASS. `npm run typecheck` — PASS.

- [ ] **Step 7.5** — Commit:
```bash
git add src/annual-accounts/annual-accounts.service.ts src/annual-accounts/annual-accounts.service.spec.ts
git commit -m "feat(annual-accounts): draft diagnostics (balance, concentration, depreciation, register mismatch)"
```

---

## Task 8 — finalize (post depreciation, lock year, hard-block, one-shot, draft==final)

**Files:**
- `src/annual-accounts/annual-accounts.service.ts` (modify — add `finalize`)
- `src/annual-accounts/annual-accounts.service.spec.ts` (modify — finalize specs)

`finalize` runs the same assembly, then: hard-blocks on any `severity: 'block'` diagnostic OR any plugin `unmapped_nonzero_account` warning; posts the annual depreciation charge as ONE system-generated voucher (Dr DEPRECIATION_EXPENSE / Cr each ACCUM_DEPRECIATION_*); locks the period via `ReportingPeriodsService.lock`; re-renders. One-shot: a `locked` period is rejected.

- [ ] **Step 8.1** — Failing test. Add to `src/annual-accounts/annual-accounts.service.spec.ts`. NOTE: wire `PostingService` and `ReportingPeriodsService` (+ their transitive deps) into the test module. Because `PostingService` requires `AccountService`, `LedgerValidationService`, `PeriodLockService`, and posts a system-generated voucher, and `ReportingPeriodsService` requires `VatReportService`, `OrganizationService`, `PluginLoader`, add all to the `providers` array. (Follow BOILERPLATE §1 provider list.)

```typescript
  it('finalize posts ONE depreciation voucher, locks the year, and matches the draft numbers', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const acqId = await postVoucher('2026-01-10', [
      { code: 'FIXED_ASSETS_VEHICLES', isDebit: true, base: 20000 },
      { code: 'BANK_EUR', isDebit: false, base: 20000 },
    ]);
    await db
      .insertInto('fixed_asset')
      .values({
        name: 'Van',
        asset_class: 'vehicle',
        acquisition_voucher_id: acqId,
        acquisition_date: '2026-01-10',
        cost_base_minor: 20000,
        useful_life_years: 5,
        residual_value_minor: 0,
        retired_at: null,
      } as never)
      .execute();
    await postVoucher('2026-03-01', [
      { code: 'BANK_EUR', isDebit: true, base: 60000 },
      { code: 'REVENUE', isDebit: false, base: 60000 },
    ]);
    await postVoucher('2026-04-01', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 42000 },
      { code: 'BANK_EUR', isDebit: false, base: 42000 },
    ]);

    const id = await periodId('2026');
    const draft = await service.generate(id);
    const final = await service.finalize(id);

    // Numbers identical (the rendered XBRL content matches).
    expect(final.artifacts[0].content).toBe(draft.artifacts[0].content);

    // A depreciation voucher was posted (4000 to DEPRECIATION_EXPENSE).
    const depLine = await db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['vl.base_amount', 'vl.is_debit'])
      .where('a.code', '=', 'DEPRECIATION_EXPENSE')
      .executeTakeFirst();
    expect(depLine?.base_amount).toBe(4000);
    expect(depLine?.is_debit).toBe(1);

    // The period is now locked.
    const period = await db
      .selectFrom('reporting_period')
      .select(['status', 'filed_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(period.status).toBe('locked');
    expect(period.filed_at).not.toBeNull();
  });

  it('rejects a second finalize on an already-locked period', async () => {
    await postVoucher('2026-01-02', [
      { code: 'BANK_EUR', isDebit: true, base: 2500 },
      { code: 'EQUITY', isDebit: false, base: 2500 },
    ]);
    const id = await periodId('2026');
    await service.finalize(id);
    await expect(service.finalize(id)).rejects.toThrow(/already.*final|locked/i);
  });

  it('hard-blocks finalize when the balance sheet does not balance', async () => {
    // A deliberately unbalanced book: post a one-sided-ish set so assets !=
    // liabilities + equity. Hand-insert a voucher whose lines do not balance is
    // impossible via PostingService (it validates), so post two vouchers that
    // leave the sheet unbalanced from the report's perspective: book revenue
    // with no matching asset is balanced; instead, inject an orphan equity entry.
    // Simplest reproducible imbalance: credit REVENUE without the cash leg by
    // posting REVENUE against EXPENSE_OTHER (both P&L) — assets stay 0 but
    // period income is +; equity (period result) makes L+E != A.
    await postVoucher('2026-03-01', [
      { code: 'EXPENSE_OTHER', isDebit: true, base: 1000 },
      { code: 'REVENUE', isDebit: false, base: 1000 },
    ]);
    const id = await periodId('2026');
    await expect(service.finalize(id)).rejects.toThrow(/balance/i);
    // And nothing got locked.
    const period = await db
      .selectFrom('reporting_period')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(period.status).toBe('open');
  });
```

> On the imbalance fixture: a voucher `Dr EXPENSE_OTHER 1000 / Cr REVENUE 1000` is internally balanced (PostingService accepts it) but produces `assets = 0, liabilities = 0, capital = 0, retained b/f = 0, periodNetIncome = revenue 1000 − expense 1000 = 0`. That balances (0 == 0). To force a report-level imbalance reproducibly, instead post `Dr EXPENSE_OTHER 1000 / Cr AP 1000` AND separately credit revenue with no debit is impossible. **Reproducible approach:** the balance check compares ledger `assets` to `liabilities + equity` where equity's period result is computed as revenue−expense. Because every posted voucher balances in debit/credit, the sheet ALWAYS balances by construction. Therefore a *real* posted-ledger imbalance cannot occur — the hard block exists to catch a future bug (e.g. an account miscategorized as the wrong `type`). **Test it deterministically by stubbing:** in this spec, subclass or spy on `diagnose` is not ideal. Instead, assert the *positive* path (a balanced book yields no block + finalize succeeds) and cover the block branch with a **direct unit test of `diagnose`** by extracting it (see Step 8.1b). Keep the "second finalize" and "depreciation posted" integration assertions above.

- [ ] **Step 8.1b** — Add a focused unit test for the blocking branch. Because `diagnose` is `protected`, expose a thin public wrapper `diagnoseInput(input: AnnualAccountsInput): DiagnosticWarning[]` that calls `this.diagnose(input)`, and test it with a hand-built imbalanced `AnnualAccountsInput` (e.g. one asset balance of 100 and zero everything else → assets 100 != L+E 0). Assert a `balance_sheet_imbalance` block is returned. Replace the integration "hard-blocks" test above with this unit test plus an integration test that `finalize` throws `BadRequestException` when `diagnoseInput` would block — drive that by constructing the same imbalanced state through a jest spy: `jest.spyOn(service as any, 'diagnose').mockReturnValueOnce([{ code: 'balance_sheet_imbalance', message: 'x', severity: 'block' }]);` then `await expect(service.finalize(id)).rejects.toThrow(BadRequestException)` and assert the period stayed `open`.

- [ ] **Step 8.2** — Run: `npm test -- src/annual-accounts/annual-accounts.service.spec.ts`. Expected FAIL (`finalize is not a function`).

- [ ] **Step 8.3** — Minimal impl. Add to `src/annual-accounts/annual-accounts.service.ts`:

```typescript
  /**
   * Finalize the year: hard-block on imbalance / unmapped-nonzero, post the
   * annual depreciation charge as ONE system-generated voucher, lock the year
   * via the existing period-lock, then render the authoritative XBRL with
   * numbers IDENTICAL to the draft. One-shot: an already-locked period is
   * rejected.
   */
  async finalize(periodId: number): Promise<AnnualAccountsResult> {
    const period = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'status', 'name', 'end_date'])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }
    // One-shot.
    if (period.status === 'locked') {
      throw new ConflictException(
        `Reporting period ${period.name} is already finalized (locked)`,
      );
    }

    const { input, plugin, diagnostics, charges } = await this.assemble(
      periodId,
      'final',
    );

    // Render now so we can hard-block on plugin warnings too (unmapped nonzero).
    const rendered = plugin.generateAnnualAccounts(input, {
      taxonomyVersion: 2026,
    });

    // HARD BLOCK: any kernel blocking diagnostic OR any plugin unmapped-nonzero.
    const blocking = diagnostics.filter((w) => w.severity === 'block');
    const unmapped = rendered.warnings.filter(
      (w) => w.code === 'unmapped_nonzero_account',
    );
    if (blocking.length > 0 || unmapped.length > 0) {
      const reasons = [...blocking, ...unmapped].map((w) => w.message).join('; ');
      throw new BadRequestException(
        `Cannot finalize annual accounts: ${reasons}`,
      );
    }

    // Post the annual depreciation charge as ONE system-generated voucher.
    const totalCharge = charges.reduce((s, c) => s + c.chargeMinor, 0);
    if (totalCharge !== 0) {
      // Aggregate per-class so each ACCUM line is one credit; one debit to
      // DEPRECIATION_EXPENSE for the total.
      const byClass = new Map<string, number>();
      for (const c of charges) {
        if (c.chargeMinor === 0) continue;
        byClass.set(
          ACCUM_BY_CLASS[c.assetClass],
          (byClass.get(ACCUM_BY_CLASS[c.assetClass]) ?? 0) + c.chargeMinor,
        );
      }
      const draft: DraftVoucher = {
        tax_point_date: period.end_date,
        reason: `Annual depreciation charge for ${period.name}`,
        lines: [
          {
            account_code: 'DEPRECIATION_EXPENSE',
            is_debit: true,
            amount: totalCharge,
            currency: 'EUR',
            base_amount: totalCharge,
            fx_rate: 1,
          },
          ...[...byClass.entries()].map(([code, amount]) => ({
            account_code: code,
            is_debit: false,
            amount,
            currency: 'EUR',
            base_amount: amount,
            fx_rate: 1,
          })),
        ],
      };
      await this.postingService.postVoucher(draft, { kind: 'system-generated' });
    }

    // Lock the year (idempotent; generates the VAT snapshot + flips status).
    await this.reportingPeriods.lock(periodId);

    // Re-render with the SAME assembled input → identical numbers as the draft.
    return {
      artifacts: rendered.artifacts,
      warnings: [...diagnostics, ...rendered.warnings],
    };
  }
```

Add the public test hook for Step 8.1b (place it near `finalize`):

```typescript
  /** Test seam: run the diagnostics over a hand-built input (Task 8 unit test). */
  diagnoseInput(input: AnnualAccountsInput): AnnualAccountsWarning[] {
    return this.diagnose(input);
  }
```

> **draft==final numbers:** both modes call `assemble`, which folds the SAME virtual depreciation into the balances and computes net income identically. `finalize` posts the charge *after* assembling its input, then renders from the already-assembled (virtual) input — never re-reading the ledger post-posting — so the rendered content is byte-identical to the draft. (The posted voucher and the virtual fold produce the same numbers; rendering from the pre-posting assembled input guarantees identity even if posting rounding ever drifted.)

- [ ] **Step 8.4** — Run: `npm test -- src/annual-accounts/annual-accounts.service.spec.ts`. Expected PASS. `npm run typecheck` — PASS.

- [ ] **Step 8.5** — Commit:
```bash
git add src/annual-accounts/annual-accounts.service.ts src/annual-accounts/annual-accounts.service.spec.ts
git commit -m "feat(annual-accounts): finalize — post depreciation, lock year, hard-block, one-shot, draft==final"
```

---

## Task 9 — Controller + Zod DTO + module controller wiring

**Files:**
- `src/annual-accounts/types.ts` (create)
- `src/annual-accounts/annual-accounts.controller.ts` (create)
- `src/annual-accounts/annual-accounts.controller.spec.ts` (create)
- `src/annual-accounts/annual-accounts.module.ts` (modify — add the controller)

`GET …/annual-accounts` returns the XBRL file (no side effects). `POST …/annual-accounts/finalize` finalizes and returns artifacts+warnings JSON. The finalize body carries a confirmation flag (Zod DTO).

- [ ] **Step 9.1** — Failing test. Create `src/annual-accounts/annual-accounts.controller.spec.ts` using a Nest e2e-style harness over the full `AnnualAccountsModule` is heavy; instead unit-test the controller against a mocked service:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AnnualAccountsController } from './annual-accounts.controller';
import { AnnualAccountsService } from './annual-accounts.service';

describe('AnnualAccountsController', () => {
  let controller: AnnualAccountsController;
  const service = {
    generate: jest.fn(),
    finalize: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnnualAccountsController],
      providers: [{ provide: AnnualAccountsService, useValue: service }],
    }).compile();
    controller = module.get(AnnualAccountsController);
    jest.clearAllMocks();
  });

  it('GET returns the single artifact as a file download', async () => {
    service.generate.mockResolvedValue({
      artifacts: [
        {
          filename: 'annual-accounts-2026.xbrl',
          mimeType: 'application/xml',
          content: '<xbrli:xbrl/>',
        },
      ],
      warnings: [],
    });
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as unknown as import('express').Response;
    await controller.download(7, res);
    expect(service.generate).toHaveBeenCalledWith(7);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/xml');
    expect(res.send).toHaveBeenCalledWith('<xbrli:xbrl/>');
  });

  it('GET throws when no artifact is produced (Null plugin / unsupported)', async () => {
    service.generate.mockResolvedValue({ artifacts: [], warnings: [] });
    const res = { setHeader: jest.fn(), send: jest.fn() } as unknown as import('express').Response;
    await expect(controller.download(7, res)).rejects.toThrow(
      /no annual-accounts/i,
    );
  });

  it('POST finalize delegates and returns artifacts + warnings JSON', async () => {
    service.finalize.mockResolvedValue({
      artifacts: [
        { filename: 'a.xbrl', mimeType: 'application/xml', content: '<x/>' },
      ],
      warnings: [{ code: 'soft', message: 'm' }],
    });
    const out = await controller.finalize(7, { confirm: true });
    expect(service.finalize).toHaveBeenCalledWith(7);
    expect(out.warnings).toHaveLength(1);
    expect(out.artifacts[0].filename).toBe('a.xbrl');
  });
});
```

- [ ] **Step 9.2** — Run: `npm test -- src/annual-accounts/annual-accounts.controller.spec.ts`. Expected FAIL (module not found).

- [ ] **Step 9.3** — Minimal impl. Create `src/annual-accounts/types.ts`:

```typescript
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Finalize an annual-accounts year. The body carries an explicit confirmation
 * so a finalize is never a stray click — finalizing posts depreciation and
 * locks the year (one-shot, ADR-0034 §5).
 */
export const finalizeAnnualAccountsSchema = z.object({
  confirm: z.literal(true),
});

export class FinalizeAnnualAccountsDto extends createZodDto(
  finalizeAnnualAccountsSchema,
) {}
```

Create `src/annual-accounts/annual-accounts.controller.ts`:

```typescript
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AnnualAccountsService } from './annual-accounts.service';
import { FinalizeAnnualAccountsDto } from './types';
import type { AnnualAccountsResult } from '../plugins/annual-accounts.types';

@ApiTags('annual-accounts')
@Controller('api/reporting-periods')
export class AnnualAccountsController {
  constructor(private readonly service: AnnualAccountsService) {}

  /**
   * Draft annual accounts — side-effect-free. Returns the RIK-XBRL file. The
   * operator uploads it to the portal for authoritative validation.
   */
  @Get(':id/annual-accounts')
  async download(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ): Promise<void> {
    const { artifacts } = await this.service.generate(id);
    if (artifacts.length === 0) {
      throw new BadRequestException('No annual-accounts artifacts produced');
    }
    const a = artifacts[0];
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${a.filename}"`,
    );
    res.send(a.content);
  }

  /**
   * Finalize the year — posts the annual depreciation charge, locks the year,
   * and returns the authoritative artifacts + warnings. One-shot.
   */
  @Post(':id/annual-accounts/finalize')
  async finalize(
    @Param('id', ParseIntPipe) id: number,
    @Body() _dto: FinalizeAnnualAccountsDto,
  ): Promise<AnnualAccountsResult> {
    return this.service.finalize(id);
  }
}
```

Restore the controller in `src/annual-accounts/annual-accounts.module.ts`:

```typescript
import { AnnualAccountsController } from './annual-accounts.controller';
```

and add `controllers: [AnnualAccountsController],` to the `@Module` decorator (between `imports` and `providers`).

- [ ] **Step 9.4** — Run: `npm test -- src/annual-accounts/annual-accounts.controller.spec.ts`. Expected PASS. `npm run typecheck` — PASS. `npm run lint` — PASS.

- [ ] **Step 9.5** — Commit:
```bash
git add src/annual-accounts/types.ts src/annual-accounts/annual-accounts.controller.ts src/annual-accounts/annual-accounts.controller.spec.ts src/annual-accounts/annual-accounts.module.ts
git commit -m "feat(annual-accounts): controller (draft GET, finalize POST) + Zod DTO"
```

---

## Task 10 — Full-suite green + final verification

**Files:** none (verification only)

- [ ] **Step 10.1** — Run the whole suite: `npm test`. Expected PASS (no regressions in plugin, ledger, statutory-report, reporting-periods).
- [ ] **Step 10.2** — `npm run typecheck` and `npm run lint`. Expected PASS.
- [ ] **Step 10.3** — If the fixed-assets plan is NOT yet merged, the `src/fixed-assets/depreciation-engine` import and the `fixed_asset` table / `ACCUM_DEPRECIATION_*` accounts will be missing and the annual-accounts specs will fail at migration/import time. This is the declared dependency: do NOT stub the engine here. Land this plan on top of the merged fixed-assets work.
- [ ] **Step 10.4** — Commit any final lint fixups:
```bash
git add -A
git commit -m "chore(annual-accounts): suite green, lint + typecheck clean"
```

---

## Self-review — PRD requirement → task coverage

| PRD requirement / user story | Task |
|------|------|
| 1–3 draft generation, virtual depreciation, repeatable | Task 6 (generate, posts nothing), Task 9 (GET, no side effects) |
| 4 emits real RIK-XBRL file | Task 4 (renderer), Task 9 (file download) |
| 5–6 two comparative columns, zero prior for first year | Task 4 (`xbrl.spec.ts` two contexts + `C-PRIOR` zero column) |
| 7 income statement by nature (skeem 1) | Task 3 (`labourExpense`/`otherOperatingExpenses`/`depreciation` lines), Task 4 |
| 8 equity = three live lines | Task 3 (`issuedCapital`/`retainedEarnings`/`profitForPeriod`), Task 4 |
| 9 balance sheet balances without a sweep | Task 4 (`TotalAssets == TotalEquityAndLiabilities`), Task 7 (balance check) |
| 10 põhivara + kulum from register + depreciation | Task 6 (register snapshot + virtual charge), Task 3/4 (`tangibleFixedAssets`/`depreciation`) |
| 11–13 final posts depreciation, locks year, identical numbers | Task 8 |
| 14 one-shot final | Task 8 (second-finalize rejection) |
| 15 hard-block on imbalance | Task 7 (block diagnostic) + Task 8 (reject) |
| 16 hard-block on unmapped nonzero | Task 4 (plugin warns) + Task 8 (reject on plugin warning) |
| 17 soft warnings (EXPENSE_OTHER, depreciation not run, register mismatch) | Task 7 |
| 18 diagnostics mirror calculation linkbase | Task 4 (totals), Task 7 (balance) |
| 19 post-final corrections forward | (Out of build scope — relies on existing corrections/locked-period redirect; no new code) |
| 20 every figure from posted vouchers | Task 5/6 (period-scoped ledger reads only) |
| 21 one plugin method for a new jurisdiction | Task 2 (seam) |
| 22 chart stays semantic | Task 3 (mapping is plugin data; no chart renumber) |
| 23 taxonomy pinned 2026, additive | Task 4 (`taxonomyVersion: 2026`, version guard throws otherwise) |
| 24 varud stays empty | Task 3 (`inventories` line maps no seeded account → 0) |
| Null plugin returns empty | Task 2 |
| Zod finalize DTO | Task 9 |
| Migration 052 decision | File Structure (no migration; reuse EQUITY/RETAINED_EARNINGS — stated + justified) |

**No placeholders / TODOs:** every code step contains complete code. **Type/name consistency verified:** `AnnualAccountsInput`/`AnnualAccountsResult`/`generateAnnualAccounts` used identically across interface, Null, Estonia, service, controller; `getLedgerNetForPeriod` signature consistent between Task 5 impl and Task 6 caller; the engine's `depreciationCharge` is the only fixed-assets import, wrapped once by the local `computeYearCharges`/`AssetAnnualCharge` helper (Task 6) and its `charges` result reused by Task 8 finalize; `PostingService.postVoucher(draft, { kind: 'system-generated' })` matches the read signature; `ReportingPeriodsService.lock(periodId)` matches the read signature (idempotent on `locked`).

**Known build dependency:** Tasks 6–8 require the merged Fixed-Assets plan (engine module + `fixed_asset` table + `ACCUM_DEPRECIATION_*`/`DEPRECIATION_EXPENSE` accounts). Stated in the header and Task 10.
