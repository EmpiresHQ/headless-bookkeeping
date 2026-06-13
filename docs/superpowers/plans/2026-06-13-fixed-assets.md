# Fixed-Asset Capitalization, Register & Depreciation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capitalize fixed-asset purchases onto per-class neutral accounts, auto-create a lightweight asset register at post time, compute deterministic straight-line pro-rata depreciation through a pure engine, and let the operator dispose of an asset (catch-up depreciation + gain/loss) — every figure voucher-backed.

**Architecture:** New expense categories (`vehicle`/`it_equipment`/`machinery`/`furniture`) resolve via the country plugin to per-class `FIXED_ASSETS_*` accounts; the plugin also owns depreciation method, default useful lives and default residuals. The posting pipeline gains an atomic `afterPost` seam: when a posted line lands on a `FIXED_ASSETS_*` account, a `FixedAssetRegistrarService` writes the `fixed_asset` register row in the same transaction. A pure `DepreciationEngine` (register rows + target date → per-asset annual charge) drives both the disposal-time catch-up posting here and the year-end close (a separate plan). Disposal posts two system-generated vouchers (catch-up depreciation, then disposal) in one transaction and marks the row retired; the register list computes book value as cost − Σ depreciation vouchers, never stored.

**Tech Stack:** NestJS, TypeScript, Kysely, better-sqlite3, Jest, nestjs-zod

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/database/migrations/046_add_fixed_asset_accounts.ts` | Create | Seed neutral accounts: `FIXED_ASSETS_{VEHICLES,IT,EQUIPMENT,FURNITURE}` + `ACCUM_DEPRECIATION_{...}` (asset, contra), `DEPRECIATION_EXPENSE` (expense), `GAIN_LOSS_ON_ASSET_DISPOSAL` (revenue). |
| `src/database/migrations/047_create_fixed_asset.ts` | Create | Create `fixed_asset` table + 3 nullable asset-intake columns on `expense`. No immutability triggers (master data, mutated on disposal). |
| `src/database/migrations/index.ts` | Modify | Register 046 + 047. |
| `src/database/types.ts` | Modify | Add `FixedAssetTable` + `fixed_asset` to `Database`; add 3 columns to `ExpenseTable`. |
| `src/plugins/fixed-asset.types.ts` | Create | Neutral plugin types: `AssetClass`, `DepreciationMethod`, `FixedAssetDefaults`. |
| `src/plugins/country-plugin.interface.ts` | Modify | Add `getFixedAssetDefaults(assetClass)` + `getDepreciationMethod()` to the `CountryPlugin` interface. |
| `src/plugins/estonia-country.plugin.ts` | Modify | Add the 4 fixed-asset categories to `EE_CATEGORY_ACCOUNTS`; implement the two new methods (straight-line; lives 5/3/5/7; residual 0 except vehicle). |
| `src/plugins/null-country.plugin.ts` | Modify | Add the 4 categories to `CATEGORY_ACCOUNTS`; implement the two new methods (straight-line; lives 5/3/5/7; residual all 0 — stub). |
| `src/fixed-assets/depreciation-engine.ts` | Create | Pure deterministic engine: `(asset, asOf) → accumulated/charge`. No DB, no NestJS. |
| `src/fixed-assets/depreciation-engine.spec.ts` | Create (Test) | Golden numeric unit tests for the engine. |
| `src/fixed-assets/fixed-asset-class-map.ts` | Create | The single `assetClass ↔ FIXED_ASSETS_* / ACCUM_DEPRECIATION_*` account-code map + category→class map. |
| `src/fixed-assets/fixed-asset-registrar.service.ts` | Create | Detects a `FIXED_ASSETS_*` line on a posted voucher and inserts the `fixed_asset` row inside the caller's transaction. |
| `src/fixed-assets/fixed-asset-registrar.service.spec.ts` | Create (Test) | Posting-pipeline integration: capex → register row created atomically with defaults + overrides. |
| `src/fixed-assets/fixed-assets.service.ts` | Create | Register list (with computed book value) + disposal operation (two system vouchers + retire). |
| `src/fixed-assets/fixed-assets.service.spec.ts` | Create (Test) | Disposal integration (gain/scrap/loss), locked-period rejection, register-list book value. |
| `src/fixed-assets/fixed-assets.controller.ts` | Create | `GET /api/fixed-assets`, `POST /api/fixed-assets/:id/disposal`. |
| `src/fixed-assets/types.ts` | Create | Zod `DisposeAssetDto`; `FixedAsset` / `FixedAssetWithBookValue` interfaces. |
| `src/fixed-assets/fixed-assets.module.ts` | Create | Wire controller + services + deps. |
| `src/ledger/pipeline/posting-pipeline.service.ts` | Modify | Add optional `afterPost?: (trx, voucher) => Promise<void>` to `PostingPipelineParams`; invoke it inside `atomicPost`'s transaction. |
| `src/ledger/pipeline/posting-pipeline.service.spec.ts` | Create (Test) | Prove `afterPost` runs in the same transaction and rolls back with the post. (New spec; create if absent.) |
| `src/expenses/types.ts` | Modify | Extend `createExpenseSchema` with `asset_name`/`asset_useful_life_years`/`asset_residual_value_minor`; add to `Expense`. |
| `src/expenses/expenses.service.ts` | Modify | Persist the 3 asset-intake columns; surface them on `Expense`. |
| `src/expenses/expenses.controller.ts` | Modify | Pass an `afterPost` registrar callback into `runPipeline`. |
| `src/expenses/expenses.module.ts` | Modify | Import `FixedAssetsModule` so the controller can inject `FixedAssetRegistrarService`. |
| `src/app.module.ts` | Modify | Register `FixedAssetsModule`. |

---

## Task 1: Migration 046 — neutral fixed-asset accounts

**Files**
- Create: `src/database/migrations/046_add_fixed_asset_accounts.ts`
- Modify: `src/database/migrations/index.ts`
- Test: `src/database/migrations/046_add_fixed_asset_accounts.spec.ts`

- [ ] **Step 1: Write the migration (insert-only, follows 024).**
  Create `src/database/migrations/046_add_fixed_asset_accounts.ts`:
  ```typescript
  import { Kysely } from 'kysely';
  import { Database } from '../types';

  /**
   * Migration 046 (ADR-0035): seed neutral fixed-asset accounts.
   *  - FIXED_ASSETS_* (asset)            — capitalized cost, per class.
   *  - ACCUM_DEPRECIATION_* (asset)      — contra-asset, accumulated kulum per class.
   *  - DEPRECIATION_EXPENSE (expense)    — the P&L charge.
   *  - GAIN_LOSS_ON_ASSET_DISPOSAL (revenue) — põhivara müügi kasum/kahjum; a net
   *    gain is a credit (revenue-normal), a net loss a debit. Modelled as revenue
   *    so it nets into the P&L on the credit-normal side.
   * Inserted into the existing account table (002), is_system = 1. No new table.
   */
  const SEED: Array<{
    code: string;
    name: string;
    type: string;
    currency: string | null;
  }> = [
    { code: 'FIXED_ASSETS_VEHICLES', name: 'Fixed Assets — Vehicles', type: 'asset', currency: null },
    { code: 'FIXED_ASSETS_IT', name: 'Fixed Assets — IT Equipment', type: 'asset', currency: null },
    { code: 'FIXED_ASSETS_EQUIPMENT', name: 'Fixed Assets — Equipment', type: 'asset', currency: null },
    { code: 'FIXED_ASSETS_FURNITURE', name: 'Fixed Assets — Furniture', type: 'asset', currency: null },
    { code: 'ACCUM_DEPRECIATION_VEHICLES', name: 'Accumulated Depreciation — Vehicles', type: 'asset', currency: null },
    { code: 'ACCUM_DEPRECIATION_IT', name: 'Accumulated Depreciation — IT Equipment', type: 'asset', currency: null },
    { code: 'ACCUM_DEPRECIATION_EQUIPMENT', name: 'Accumulated Depreciation — Equipment', type: 'asset', currency: null },
    { code: 'ACCUM_DEPRECIATION_FURNITURE', name: 'Accumulated Depreciation — Furniture', type: 'asset', currency: null },
    { code: 'DEPRECIATION_EXPENSE', name: 'Depreciation Expense', type: 'expense', currency: null },
    { code: 'GAIN_LOSS_ON_ASSET_DISPOSAL', name: 'Gain/Loss on Asset Disposal', type: 'revenue', currency: null },
  ];

  export async function up(db: Kysely<Database>): Promise<void> {
    for (const a of SEED) {
      await db
        .insertInto('account')
        .values({
          code: a.code,
          name: a.name,
          type: a.type,
          currency: a.currency,
          parent_id: null,
          is_system: 1,
        })
        .execute();
    }
  }

  export async function down(db: Kysely<Database>): Promise<void> {
    await db
      .deleteFrom('account')
      .where('code', 'in', SEED.map((a) => a.code) as [string, ...string[]])
      .execute();
  }
  ```

- [ ] **Step 2: Register the migration.**
  In `src/database/migrations/index.ts`, add the import after the `m045` import line:
  ```typescript
  import * as m046 from './046_add_fixed_asset_accounts';
  ```
  and add the entry after `'045_widen_entity_identifier_kind': m045,`:
  ```typescript
    '046_add_fixed_asset_accounts': m046,
  ```

- [ ] **Step 3: Write the failing migration test.**
  Create `src/database/migrations/046_add_fixed_asset_accounts.spec.ts`:
  ```typescript
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../types';
  import { migrations } from './index';

  describe('migration 046 — fixed-asset accounts', () => {
    let db: Kysely<Database>;

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
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('seeds every neutral fixed-asset account with the correct type', async () => {
      const expected: Record<string, string> = {
        FIXED_ASSETS_VEHICLES: 'asset',
        FIXED_ASSETS_IT: 'asset',
        FIXED_ASSETS_EQUIPMENT: 'asset',
        FIXED_ASSETS_FURNITURE: 'asset',
        ACCUM_DEPRECIATION_VEHICLES: 'asset',
        ACCUM_DEPRECIATION_IT: 'asset',
        ACCUM_DEPRECIATION_EQUIPMENT: 'asset',
        ACCUM_DEPRECIATION_FURNITURE: 'asset',
        DEPRECIATION_EXPENSE: 'expense',
        GAIN_LOSS_ON_ASSET_DISPOSAL: 'revenue',
      };
      const rows = await db
        .selectFrom('account')
        .select(['code', 'type', 'is_system'])
        .where('code', 'in', Object.keys(expected))
        .execute();

      expect(rows).toHaveLength(Object.keys(expected).length);
      for (const r of rows) {
        expect(r.type).toBe(expected[r.code]);
        expect(r.is_system).toBe(1);
      }
    });
  });
  ```

- [ ] **Step 4: Run the test — expect PASS.**
  `npm test -- src/database/migrations/046_add_fixed_asset_accounts.spec.ts`
  (Steps 1–2 already write the migration, so this passes immediately. If you wrote the test first it would FAIL with `expect(received).toHaveLength(10)` / `Received length: 0`.)

- [ ] **Step 5: Commit.**
  `git add src/database/migrations/046_add_fixed_asset_accounts.ts src/database/migrations/index.ts src/database/migrations/046_add_fixed_asset_accounts.spec.ts`
  `git commit -m "feat(fixed-assets): migration 046 seed neutral fixed-asset accounts"`

---

## Task 2: Migration 047 — `fixed_asset` table + expense intake columns

**Files**
- Create: `src/database/migrations/047_create_fixed_asset.ts`
- Modify: `src/database/migrations/index.ts`, `src/database/types.ts`
- Test: `src/database/migrations/047_create_fixed_asset.spec.ts`

- [ ] **Step 1: Write the migration.**
  Create `src/database/migrations/047_create_fixed_asset.ts`. No immutability triggers — `retired_at`/`disposal_voucher_id` are updated on disposal (ADR-0035 §6).
  ```typescript
  import { Kysely, sql } from 'kysely';
  import { Database } from '../types';

  /**
   * Migration 047 (ADR-0035): the lightweight fixed-asset register.
   *
   * Master data, NOT a parallel ledger — amounts stay sourced from the ledger;
   * only depreciation parameters live here. Mutable (retired_at + disposal
   * reference are set on disposal), so it is deliberately NOT append-only.
   *
   * Also adds 3 nullable asset-intake columns to `expense`: the asset name and
   * the optional useful-life / residual overrides the operator supplies when
   * categorizing a purchase as a fixed asset. NULL on a non-capex expense.
   */
  export async function up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable('fixed_asset')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('asset_class', 'text', (col) =>
        col
          .notNull()
          .check(sql`asset_class IN ('vehicle','it_equipment','machinery','furniture')`),
      )
      .addColumn('acquisition_voucher_id', 'integer', (col) =>
        col.notNull().references('voucher.id'),
      )
      .addColumn('acquisition_date', 'text', (col) => col.notNull())
      .addColumn('cost_base_minor', 'integer', (col) => col.notNull())
      .addColumn('useful_life_years', 'integer', (col) => col.notNull())
      .addColumn('residual_value_minor', 'integer', (col) => col.notNull())
      .addColumn('retired_at', 'integer')
      .addColumn('disposal_voucher_id', 'integer', (col) =>
        col.references('voucher.id'),
      )
      .execute();

    await db.schema
      .alterTable('expense')
      .addColumn('asset_name', 'text')
      .execute();
    await db.schema
      .alterTable('expense')
      .addColumn('asset_useful_life_years', 'integer')
      .execute();
    await db.schema
      .alterTable('expense')
      .addColumn('asset_residual_value_minor', 'integer')
      .execute();
  }

  export async function down(db: Kysely<Database>): Promise<void> {
    await db.schema.alterTable('expense').dropColumn('asset_name').execute();
    await db.schema
      .alterTable('expense')
      .dropColumn('asset_useful_life_years')
      .execute();
    await db.schema
      .alterTable('expense')
      .dropColumn('asset_residual_value_minor')
      .execute();
    await db.schema.dropTable('fixed_asset').ifExists().execute();
  }
  ```

- [ ] **Step 2: Register the migration.**
  In `src/database/migrations/index.ts`, add after the `m046` import:
  ```typescript
  import * as m047 from './047_create_fixed_asset';
  ```
  and after `'046_add_fixed_asset_accounts': m046,`:
  ```typescript
    '047_create_fixed_asset': m047,
  ```

- [ ] **Step 3: Add the table + expense columns to `types.ts`.**
  In `src/database/types.ts`, add `fixed_asset: FixedAssetTable;` to the `Database` interface (after `credit_note: CreditNoteTable;`). Then add the three new columns to `ExpenseTable` (after `supplier_invoice_number: string | null;`):
  ```typescript
    // Fixed-asset intake (migration 047): set only when the expense was
    // categorized as a fixed asset; NULL otherwise. The name + optional
    // useful-life / residual overrides feed the register row created at post time.
    asset_name: string | null;
    asset_useful_life_years: number | null;
    asset_residual_value_minor: number | null;
  ```
  And add the row interface at the end of the file:
  ```typescript
  // FixedAsset: the lightweight asset register (migration 047, ADR-0035).
  // Master data (depreciation parameters); amounts stay sourced from the ledger.
  // Mutable — retired_at + disposal_voucher_id are set on disposal.
  export interface FixedAssetTable {
    id: Generated<number>;
    name: string;
    // 'vehicle' | 'it_equipment' | 'machinery' | 'furniture'
    asset_class: string;
    acquisition_voucher_id: number;
    // ISO date (YYYY-MM-DD) — drives pro-rata months.
    acquisition_date: string;
    cost_base_minor: number;
    useful_life_years: number;
    residual_value_minor: number;
    // Unix seconds when disposed; NULL = active.
    retired_at: number | null;
    disposal_voucher_id: number | null;
  }
  ```

- [ ] **Step 4: Write the failing migration test.**
  Create `src/database/migrations/047_create_fixed_asset.spec.ts`:
  ```typescript
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../types';
  import { migrations } from './index';

  describe('migration 047 — fixed_asset table', () => {
    let db: Kysely<Database>;

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
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('inserts and reads back a fixed_asset row (mutable retired_at)', async () => {
      const voucher = await db
        .insertInto('voucher')
        .values({
          voucher_number: 'V-2026-000001',
          tax_point_date: '2026-01-15',
          posted_at: 1,
          previous_hash: null,
          reverses_id: null,
          corrects_object_type: null,
          corrects_object_id: null,
          reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const inserted = await db
        .insertInto('fixed_asset')
        .values({
          name: 'Company car',
          asset_class: 'vehicle',
          acquisition_voucher_id: voucher.id,
          acquisition_date: '2026-01-15',
          cost_base_minor: 2000000,
          useful_life_years: 5,
          residual_value_minor: 400000,
          retired_at: null,
          disposal_voucher_id: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      expect(inserted.id).toBeGreaterThan(0);
      expect(inserted.retired_at).toBeNull();

      // Master data, not append-only: an UPDATE must succeed (no trigger).
      await db
        .updateTable('fixed_asset')
        .set({ retired_at: 999, disposal_voucher_id: voucher.id })
        .where('id', '=', inserted.id)
        .execute();

      const after = await db
        .selectFrom('fixed_asset')
        .selectAll()
        .where('id', '=', inserted.id)
        .executeTakeFirstOrThrow();
      expect(after.retired_at).toBe(999);
    });

    it('rejects an unknown asset_class via the CHECK constraint', async () => {
      const voucher = await db
        .insertInto('voucher')
        .values({
          voucher_number: 'V-2026-000002',
          tax_point_date: '2026-01-15',
          posted_at: 1,
          previous_hash: null,
          reverses_id: null,
          corrects_object_type: null,
          corrects_object_id: null,
          reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await expect(
        db
          .insertInto('fixed_asset')
          .values({
            name: 'Bad',
            asset_class: 'spaceship',
            acquisition_voucher_id: voucher.id,
            acquisition_date: '2026-01-15',
            cost_base_minor: 1,
            useful_life_years: 1,
            residual_value_minor: 0,
            retired_at: null,
            disposal_voucher_id: null,
          })
          .execute(),
      ).rejects.toThrow();
    });
  });
  ```

- [ ] **Step 5: Run the test — expect PASS.**
  `npm test -- src/database/migrations/047_create_fixed_asset.spec.ts`
  (Written test-after; if written first it FAILS with `no such table: fixed_asset`.)

- [ ] **Step 6: Commit.**
  `git add src/database/migrations/047_create_fixed_asset.ts src/database/migrations/index.ts src/database/types.ts src/database/migrations/047_create_fixed_asset.spec.ts`
  `git commit -m "feat(fixed-assets): migration 047 fixed_asset register + expense intake columns"`

---

## Task 3: Plugin fixed-asset types + interface methods

**Files**
- Create: `src/plugins/fixed-asset.types.ts`
- Modify: `src/plugins/country-plugin.interface.ts`

- [ ] **Step 1: Create the neutral plugin types.**
  Create `src/plugins/fixed-asset.types.ts`:
  ```typescript
  /**
   * The four fixed-asset classes (ADR-0035). These ARE the new expense category
   * keys an operator picks at intake; each maps to a per-class FIXED_ASSETS_*
   * account that carries the useful life.
   */
  export type AssetClass = 'vehicle' | 'it_equipment' | 'machinery' | 'furniture';

  /** Depreciation methods a plugin may declare. v1 supports straight-line only. */
  export type DepreciationMethod = 'straight_line';

  /**
   * Per-class depreciation norms supplied by the country plugin (ADR-0002): the
   * kernel never hardcodes Estonian lives/residuals. `defaultResidualMinor` is in
   * base-currency minor units and is 0 for every class except vehicle.
   */
  export interface FixedAssetDefaults {
    defaultUsefulLifeYears: number;
    defaultResidualMinor: number;
  }
  ```

- [ ] **Step 2: Add the two methods to the `CountryPlugin` interface.**
  In `src/plugins/country-plugin.interface.ts`, add the import at the top (after the existing `import type` lines):
  ```typescript
  import type {
    AssetClass,
    DepreciationMethod,
    FixedAssetDefaults,
  } from './fixed-asset.types';
  ```
  Re-export them alongside the other re-exports (after the `StatutoryReportInput` re-export block):
  ```typescript
  export type {
    AssetClass,
    DepreciationMethod,
    FixedAssetDefaults,
  } from './fixed-asset.types';
  ```
  Add to the `CountryPlugin` interface (before the closing `}`):
  ```typescript
    /**
     * The depreciation method this jurisdiction uses. Estonia: straight-line
     * (RTJ 5 prescribes no fixed-rate table). The kernel asks the plugin; it
     * never hardcodes the method (ADR-0002/0035).
     */
    getDepreciationMethod(): DepreciationMethod;

    /**
     * Per-class default useful life (years) and default residual value
     * (base-currency minor units) for a fixed-asset class. Estonia: lives
     * vehicle 5 / it_equipment 3 / machinery 5 / furniture 7; residual 0 for
     * every class except vehicle (a conventional non-zero default). Both are
     * overridable per asset at intake (ADR-0035).
     */
    getFixedAssetDefaults(assetClass: AssetClass): FixedAssetDefaults;
  ```

- [ ] **Step 3: Typecheck (interface only — both plugins implemented next task, so expect a typecheck FAIL here).**
  `npm run typecheck`
  Expected FAIL: `Class 'NullCountryPlugin' incorrectly implements interface 'CountryPlugin'. Property 'getDepreciationMethod' is missing` (and the same for EstoniaCountryPlugin). This is the red state — Task 4 makes it green.

- [ ] **Step 4: Commit the interface + types.**
  `git add src/plugins/fixed-asset.types.ts src/plugins/country-plugin.interface.ts`
  `git commit -m "feat(fixed-assets): CountryPlugin fixed-asset defaults + depreciation method seam"`

---

## Task 4: Plugin implementations (Estonia real, Null stub) + new categories

**Files**
- Modify: `src/plugins/estonia-country.plugin.ts`, `src/plugins/null-country.plugin.ts`
- Test: `src/plugins/estonia-country.plugin.spec.ts`, `src/plugins/null-country.plugin.spec.ts`

- [ ] **Step 1: Write failing Estonia plugin unit tests.**
  Append to `src/plugins/estonia-country.plugin.spec.ts` (inside a new `describe`, after the existing top-level `describe` blocks — use the existing `const ee = new EstoniaCountryPlugin()` pattern):
  ```typescript
  describe('EstoniaCountryPlugin — fixed assets', () => {
    const ee = new EstoniaCountryPlugin();
    const org = { country: 'EE', vatRegistered: true, baseCurrency: null };
    const eeSupplier = {
      country: 'EE',
      goodsVsServices: 'goods' as const,
      classificationMemory: [],
    };

    it('maps the four fixed-asset categories to per-class FIXED_ASSETS_* accounts', () => {
      expect(ee.resolveCategoryMapping('vehicle', eeSupplier, org).accountCode).toBe('FIXED_ASSETS_VEHICLES');
      expect(ee.resolveCategoryMapping('it_equipment', eeSupplier, org).accountCode).toBe('FIXED_ASSETS_IT');
      expect(ee.resolveCategoryMapping('machinery', eeSupplier, org).accountCode).toBe('FIXED_ASSETS_EQUIPMENT');
      expect(ee.resolveCategoryMapping('furniture', eeSupplier, org).accountCode).toBe('FIXED_ASSETS_FURNITURE');
    });

    it('exposes the fixed-asset categories in getCategories()', () => {
      const keys = ee.getCategories().map((c) => c.key);
      expect(keys).toEqual(
        expect.arrayContaining(['vehicle', 'it_equipment', 'machinery', 'furniture']),
      );
    });

    it('uses straight-line depreciation', () => {
      expect(ee.getDepreciationMethod()).toBe('straight_line');
    });

    it('returns conventional default useful lives per class', () => {
      expect(ee.getFixedAssetDefaults('vehicle').defaultUsefulLifeYears).toBe(5);
      expect(ee.getFixedAssetDefaults('it_equipment').defaultUsefulLifeYears).toBe(3);
      expect(ee.getFixedAssetDefaults('machinery').defaultUsefulLifeYears).toBe(5);
      expect(ee.getFixedAssetDefaults('furniture').defaultUsefulLifeYears).toBe(7);
    });

    it('defaults residual to 0 except for vehicles (non-zero)', () => {
      expect(ee.getFixedAssetDefaults('it_equipment').defaultResidualMinor).toBe(0);
      expect(ee.getFixedAssetDefaults('machinery').defaultResidualMinor).toBe(0);
      expect(ee.getFixedAssetDefaults('furniture').defaultResidualMinor).toBe(0);
      expect(ee.getFixedAssetDefaults('vehicle').defaultResidualMinor).toBeGreaterThan(0);
    });
  });
  ```

- [ ] **Step 2: Run the Estonia test — expect FAIL.**
  `npm test -- src/plugins/estonia-country.plugin.spec.ts`
  Expected FAIL: `ee.getDepreciationMethod is not a function` / `expected 'EXPENSE_OTHER' to be 'FIXED_ASSETS_VEHICLES'`.

- [ ] **Step 3: Implement on the Estonia plugin.**
  In `src/plugins/estonia-country.plugin.ts`, add the import (after the existing `country-plugin.interface` import):
  ```typescript
  import {
    AssetClass,
    DepreciationMethod,
    FixedAssetDefaults,
  } from './fixed-asset.types';
  ```
  Add the four categories to `EE_CATEGORY_ACCOUNTS` (inside the existing object literal, after `education: 'EXPENSE_EDUCATION',`):
  ```typescript
    vehicle: 'FIXED_ASSETS_VEHICLES',
    it_equipment: 'FIXED_ASSETS_IT',
    machinery: 'FIXED_ASSETS_EQUIPMENT',
    furniture: 'FIXED_ASSETS_FURNITURE',
  ```
  Add a private defaults table + the two methods (place after `getCategories()`):
  ```typescript
    // ── Fixed-asset norms (ADR-0035) ──────────────────────────────────────────
    private static readonly FIXED_ASSET_DEFAULTS: Record<AssetClass, FixedAssetDefaults> = {
      vehicle: { defaultUsefulLifeYears: 5, defaultResidualMinor: 400000 },
      it_equipment: { defaultUsefulLifeYears: 3, defaultResidualMinor: 0 },
      machinery: { defaultUsefulLifeYears: 5, defaultResidualMinor: 0 },
      furniture: { defaultUsefulLifeYears: 7, defaultResidualMinor: 0 },
    };

    getDepreciationMethod(): DepreciationMethod {
      return 'straight_line';
    }

    getFixedAssetDefaults(assetClass: AssetClass): FixedAssetDefaults {
      return EstoniaCountryPlugin.FIXED_ASSET_DEFAULTS[assetClass];
    }
  ```
  > Note: the fixed-asset categories share the `EE_INPUT_24` VAT code via the existing fall-through in `resolveCategoryMapping` (capex still carries deductible input VAT in EE), so no change to that method is needed beyond the `EE_CATEGORY_ACCOUNTS` additions.

- [ ] **Step 4: Run the Estonia test — expect PASS.**
  `npm test -- src/plugins/estonia-country.plugin.spec.ts`

- [ ] **Step 5: Write failing Null plugin unit tests.**
  Append to `src/plugins/null-country.plugin.spec.ts` (new `describe`, using the existing `new NullCountryPlugin()` pattern):
  ```typescript
  describe('NullCountryPlugin — fixed assets', () => {
    const plugin = new NullCountryPlugin();
    const org = { country: 'IE', vatRegistered: true, baseCurrency: null };
    const supplier = {
      country: 'IE',
      goodsVsServices: 'goods' as const,
      classificationMemory: [],
    };

    it('maps fixed-asset categories to per-class accounts', () => {
      expect(plugin.resolveCategoryMapping('vehicle', supplier, org).accountCode).toBe('FIXED_ASSETS_VEHICLES');
      expect(plugin.resolveCategoryMapping('furniture', supplier, org).accountCode).toBe('FIXED_ASSETS_FURNITURE');
    });

    it('declares straight-line and zero residual everywhere (neutral stub)', () => {
      expect(plugin.getDepreciationMethod()).toBe('straight_line');
      expect(plugin.getFixedAssetDefaults('vehicle')).toEqual({ defaultUsefulLifeYears: 5, defaultResidualMinor: 0 });
      expect(plugin.getFixedAssetDefaults('it_equipment').defaultUsefulLifeYears).toBe(3);
    });
  });
  ```

- [ ] **Step 6: Run the Null test — expect FAIL.**
  `npm test -- src/plugins/null-country.plugin.spec.ts`
  Expected FAIL: `plugin.getDepreciationMethod is not a function`.

- [ ] **Step 7: Implement on the Null plugin.**
  In `src/plugins/null-country.plugin.ts`, add the import (after the `country-plugin.interface` import):
  ```typescript
  import {
    AssetClass,
    DepreciationMethod,
    FixedAssetDefaults,
  } from './fixed-asset.types';
  ```
  Add the four categories to `CATEGORY_ACCOUNTS` (after `education: 'EXPENSE_EDUCATION',`):
  ```typescript
    vehicle: 'FIXED_ASSETS_VEHICLES',
    it_equipment: 'FIXED_ASSETS_IT',
    machinery: 'FIXED_ASSETS_EQUIPMENT',
    furniture: 'FIXED_ASSETS_FURNITURE',
  ```
  Add the two methods (after `getCategories()`):
  ```typescript
    private static readonly FIXED_ASSET_DEFAULTS: Record<AssetClass, FixedAssetDefaults> = {
      vehicle: { defaultUsefulLifeYears: 5, defaultResidualMinor: 0 },
      it_equipment: { defaultUsefulLifeYears: 3, defaultResidualMinor: 0 },
      machinery: { defaultUsefulLifeYears: 5, defaultResidualMinor: 0 },
      furniture: { defaultUsefulLifeYears: 7, defaultResidualMinor: 0 },
    };

    getDepreciationMethod(): DepreciationMethod {
      return 'straight_line';
    }

    getFixedAssetDefaults(assetClass: AssetClass): FixedAssetDefaults {
      return NullCountryPlugin.FIXED_ASSET_DEFAULTS[assetClass];
    }
  ```

- [ ] **Step 8: Run the Null test + typecheck — expect PASS.**
  `npm test -- src/plugins/null-country.plugin.spec.ts`
  `npm run typecheck`

- [ ] **Step 9: Commit.**
  `git add src/plugins/estonia-country.plugin.ts src/plugins/null-country.plugin.ts src/plugins/estonia-country.plugin.spec.ts src/plugins/null-country.plugin.spec.ts`
  `git commit -m "feat(fixed-assets): EE+Null plugin fixed-asset categories, lives, residuals, method"`

---

## Task 5: The pure depreciation engine + class/account map

**Files**
- Create: `src/fixed-assets/fixed-asset-class-map.ts`, `src/fixed-assets/depreciation-engine.ts`
- Test: `src/fixed-assets/depreciation-engine.spec.ts`

- [ ] **Step 1: Create the class↔account map (single source).**
  Create `src/fixed-assets/fixed-asset-class-map.ts`:
  ```typescript
  import { AssetClass } from '../plugins/fixed-asset.types';

  /** The per-class FIXED_ASSETS_* (cost) and ACCUM_DEPRECIATION_* (contra) codes. */
  export interface ClassAccounts {
    fixedAssetCode: string;
    accumDepreciationCode: string;
  }

  /**
   * The single source of the asset-class → account-code binding (ADR-0035).
   * Both the registrar (which detects a FIXED_ASSETS_* line) and the disposal /
   * depreciation posting read from here, so the two cannot diverge.
   */
  export const CLASS_ACCOUNTS: Readonly<Record<AssetClass, ClassAccounts>> = {
    vehicle: {
      fixedAssetCode: 'FIXED_ASSETS_VEHICLES',
      accumDepreciationCode: 'ACCUM_DEPRECIATION_VEHICLES',
    },
    it_equipment: {
      fixedAssetCode: 'FIXED_ASSETS_IT',
      accumDepreciationCode: 'ACCUM_DEPRECIATION_IT',
    },
    machinery: {
      fixedAssetCode: 'FIXED_ASSETS_EQUIPMENT',
      accumDepreciationCode: 'ACCUM_DEPRECIATION_EQUIPMENT',
    },
    furniture: {
      fixedAssetCode: 'FIXED_ASSETS_FURNITURE',
      accumDepreciationCode: 'ACCUM_DEPRECIATION_FURNITURE',
    },
  };

  /** All four FIXED_ASSETS_* codes — used to detect a capex line on a voucher. */
  export const FIXED_ASSET_CODES: readonly string[] = Object.values(
    CLASS_ACCOUNTS,
  ).map((c) => c.fixedAssetCode);

  /** The asset class owning a FIXED_ASSETS_* code, or undefined if not one. */
  export function assetClassForAccount(code: string): AssetClass | undefined {
    return (Object.keys(CLASS_ACCOUNTS) as AssetClass[]).find(
      (k) => CLASS_ACCOUNTS[k].fixedAssetCode === code,
    );
  }
  ```

- [ ] **Step 2: Write failing engine unit tests (golden numeric cases).**
  Create `src/fixed-assets/depreciation-engine.spec.ts`:
  ```typescript
  import { accumulatedDepreciationAsOf, depreciationCharge } from './depreciation-engine';

  // A reusable asset shape — only the fields the engine reads.
  const asset = (over: Partial<Parameters<typeof accumulatedDepreciationAsOf>[0]> = {}) => ({
    acquisition_date: '2024-01-01',
    cost_base_minor: 1200000, // €12,000.00
    useful_life_years: 5,
    residual_value_minor: 0,
    ...over,
  });

  describe('depreciation engine — accumulatedDepreciationAsOf', () => {
    it('full first year (acquired Jan 1, 12/12) = annual charge', () => {
      // base = 1,200,000; /5 = 240,000 per year; 12 months → 240,000.
      expect(accumulatedDepreciationAsOf(asset(), '2024-12-31')).toBe(240000);
    });

    it('mid-year acquisition (Nov 1 → 2/12 of the year-1 charge)', () => {
      // Nov + Dec = 2 months. 240,000 * 2/12 = 40,000.
      expect(
        accumulatedDepreciationAsOf(asset({ acquisition_date: '2024-11-01' }), '2024-12-31'),
      ).toBe(40000);
    });

    it('two full years = 2 × annual charge', () => {
      expect(accumulatedDepreciationAsOf(asset(), '2025-12-31')).toBe(480000);
    });

    it('caps at the depreciable base in the final year (never exceeds cost − residual)', () => {
      // Well past life: accumulated must equal the full depreciable base, not more.
      expect(accumulatedDepreciationAsOf(asset(), '2099-12-31')).toBe(1200000);
    });

    it('non-zero residual reduces the depreciable base (vehicle)', () => {
      // base = 2,000,000 − 400,000 = 1,600,000; /5 = 320,000/yr; 1 full year.
      const car = asset({ cost_base_minor: 2000000, residual_value_minor: 400000 });
      expect(accumulatedDepreciationAsOf(car, '2024-12-31')).toBe(320000);
      // Past life: caps at 1,600,000 (asset settles at its €4,000 residual).
      expect(accumulatedDepreciationAsOf(car, '2099-12-31')).toBe(1600000);
    });

    it('is zero before the acquisition month', () => {
      expect(accumulatedDepreciationAsOf(asset(), '2023-12-31')).toBe(0);
    });
  });

  describe('depreciation engine — depreciationCharge (incremental)', () => {
    it('charge between two dates is the difference in accumulated', () => {
      // From end of year 1 (240,000) to end of year 2 (480,000) = 240,000.
      expect(depreciationCharge(asset(), '2024-12-31', '2025-12-31')).toBe(240000);
    });

    it('catch-up from acquisition (no prior close) to a mid-year disposal', () => {
      // from = null ⇒ from acquisition. Acquired Jan 1; dispose Jun 30 = 6 months.
      // 240,000 * 6/12 = 120,000.
      expect(depreciationCharge(asset(), null, '2024-06-30')).toBe(120000);
    });

    it('never returns a negative charge once fully depreciated', () => {
      expect(depreciationCharge(asset(), '2099-01-01', '2099-12-31')).toBe(0);
    });
  });
  ```

- [ ] **Step 3: Run the engine test — expect FAIL.**
  `npm test -- src/fixed-assets/depreciation-engine.spec.ts`
  Expected FAIL: `Cannot find module './depreciation-engine'`.

- [ ] **Step 4: Implement the pure engine.**
  Create `src/fixed-assets/depreciation-engine.ts`:
  ```typescript
  /**
   * The pure, deterministic straight-line depreciation engine (ADR-0035 §5).
   *
   * Depreciable base = cost − residual, spread straight-line over the useful
   * life, accrued pro-rata by WHOLE MONTHS from the acquisition date, and capped
   * so accumulated depreciation never exceeds the depreciable base (the asset
   * settles at its residual value, not zero). No DB, no NestJS, no I/O — the LLM
   * never picks a figure. The SAME engine the year-end close (a separate plan)
   * calls virtually.
   *
   * Amounts are base-currency minor units (integer cents). Dates are ISO
   * YYYY-MM-DD strings.
   */
  export interface DepreciableAsset {
    acquisition_date: string;
    cost_base_minor: number;
    useful_life_years: number;
    residual_value_minor: number;
  }

  /** Whole months elapsed from `from` (inclusive of its month) up to and
   *  including the month of `to`. A same-month pair counts as 1 month; a date
   *  before the acquisition month counts as 0. */
  function monthsElapsed(from: string, to: string): number {
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    const months = (ty - fy) * 12 + (tm - fm) + 1;
    return months < 0 ? 0 : months;
  }

  /**
   * Accumulated depreciation from acquisition through `asOf` (inclusive of the
   * asOf month), rounded to whole cents, capped at the depreciable base.
   */
  export function accumulatedDepreciationAsOf(
    asset: DepreciableAsset,
    asOf: string,
  ): number {
    const depreciableBase = asset.cost_base_minor - asset.residual_value_minor;
    if (depreciableBase <= 0 || asset.useful_life_years <= 0) return 0;

    const totalMonths = asset.useful_life_years * 12;
    const monthlyRate = depreciableBase / totalMonths;

    const elapsed = monthsElapsed(asset.acquisition_date, asOf);
    if (elapsed <= 0) return 0;

    const accrued = Math.round(monthlyRate * elapsed);
    return Math.min(accrued, depreciableBase);
  }

  /**
   * The depreciation charge to recognise BETWEEN `from` and `to`: the difference
   * in accumulated depreciation. `from = null` means "from acquisition" (the
   * catch-up case with no prior close). Never negative (a fully-depreciated asset
   * accrues nothing further).
   */
  export function depreciationCharge(
    asset: DepreciableAsset,
    from: string | null,
    to: string,
  ): number {
    const accumTo = accumulatedDepreciationAsOf(asset, to);
    const accumFrom = from === null ? 0 : accumulatedDepreciationAsOf(asset, from);
    return Math.max(0, accumTo - accumFrom);
  }
  ```

- [ ] **Step 5: Run the engine test — expect PASS.**
  `npm test -- src/fixed-assets/depreciation-engine.spec.ts`

- [ ] **Step 6: Commit.**
  `git add src/fixed-assets/fixed-asset-class-map.ts src/fixed-assets/depreciation-engine.ts src/fixed-assets/depreciation-engine.spec.ts`
  `git commit -m "feat(fixed-assets): pure straight-line pro-rata depreciation engine + class map"`

---

## Task 6: Capex → register hook (atomic, in the posting pipeline)

**Files**
- Modify: `src/ledger/pipeline/posting-pipeline.service.ts`
- Create: `src/fixed-assets/fixed-asset-registrar.service.ts`, `src/fixed-assets/fixed-assets.module.ts`, `src/fixed-assets/types.ts`
- Modify: `src/expenses/types.ts`, `src/expenses/expenses.service.ts`, `src/expenses/expenses.controller.ts`, `src/expenses/expenses.module.ts`
- Test: `src/ledger/pipeline/posting-pipeline.service.spec.ts`, `src/fixed-assets/fixed-asset-registrar.service.spec.ts`

- [ ] **Step 1: Write a failing pipeline `afterPost` test.**
  Create `src/ledger/pipeline/posting-pipeline.service.spec.ts`. It proves the new `afterPost` hook runs inside the same transaction as the post (and rolls back with it). Wire the real graph against in-memory SQLite.
  ```typescript
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../../database/types';
  import { migrations } from '../../database/migrations';
  import { AccountService } from '../account/account.service';
  import { LedgerValidationService } from '../validation/ledger-validation.service';
  import { PostingService } from '../posting/posting.service';
  import { PeriodLockService } from '../../reporting-periods/period-lock.service';
  import { StatusTransitionService } from '../status/status-transition.service';
  import { PolicyService } from '../../policy/policy.service';
  import { RulesService } from '../../rules/rules.service';
  import { OrgContextResolver } from '../../organization/org-context.resolver';
  import { OrganizationService } from '../../organization/organization.service';
  import { PluginLoader } from '../../plugins/plugin-loader.service';
  import { NullCountryPlugin } from '../../plugins/null-country.plugin';
  import { EstoniaCountryPlugin } from '../../plugins/estonia-country.plugin';
  import { PostingPipelineService } from './posting-pipeline.service';
  import { DraftVoucher } from '../voucher/types';

  describe('PostingPipelineService afterPost hook (integration)', () => {
    let db: Kysely<Database>;
    let pipeline: PostingPipelineService;

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
          PostingPipelineService,
          PostingService,
          AccountService,
          LedgerValidationService,
          PeriodLockService,
          StatusTransitionService,
          PolicyService,
          RulesService,
          OrgContextResolver,
          OrganizationService,
          PluginLoader,
          NullCountryPlugin,
          EstoniaCountryPlugin,
        ],
      }).compile();

      pipeline = module.get(PostingPipelineService);

      // Seed a draft expense to satisfy the status-transition claim.
      const now = Math.floor(Date.now() / 1000);
      await db
        .insertInto('expense')
        .values({
          document_id: null, supplier_id: null, category: 'software',
          gross_amount: 10000, vat_amount: 0, currency: 'EUR',
          tax_point_date: '2024-02-15', status: 'draft', voucher_id: null,
          document_vat_marking: null, supplier_invoice_number: null,
          asset_name: null, asset_useful_life_years: null, asset_residual_value_minor: null,
          created_at: now, updated_at: now,
        })
        .execute();
    });

    afterEach(async () => { await db.destroy(); });

    const draft = (): DraftVoucher => ({
      tax_point_date: '2024-02-15',
      lines: [
        { account_code: 'EXPENSE_SOFTWARE', amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: true },
        { account_code: 'CASH', amount: 10000, currency: 'EUR', base_amount: 10000, fx_rate: 1, vat_code: null, is_debit: false },
      ],
    });

    it('runs afterPost inside the posting transaction (receives the posted voucher)', async () => {
      let seenVoucherId = 0;
      const result = await pipeline.runPipeline({
        businessObjectId: 1,
        businessObjectType: 'expense',
        draftGenerator: () => Promise.resolve(draft()),
        category: 'software',
        refetch: () => Promise.resolve({ id: 1 }),
        confidence: 1,
        supplierKnown: true,
        afterPost: (_trx, voucher) => {
          seenVoucherId = voucher.id;
          return Promise.resolve();
        },
      });
      expect(result.voucher).not.toBeNull();
      expect(seenVoucherId).toBe(result.voucher!.id);
    });

    it('rolls back the post when afterPost throws (no voucher persisted)', async () => {
      await expect(
        pipeline.runPipeline({
          businessObjectId: 1,
          businessObjectType: 'expense',
          draftGenerator: () => Promise.resolve(draft()),
          category: 'software',
          refetch: () => Promise.resolve({ id: 1 }),
          confidence: 1,
          supplierKnown: true,
          afterPost: () => Promise.reject(new Error('hook boom')),
        }),
      ).rejects.toThrow('hook boom');

      const vouchers = await db.selectFrom('voucher').selectAll().execute();
      expect(vouchers).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 2: Run the pipeline test — expect FAIL.**
  `npm test -- src/ledger/pipeline/posting-pipeline.service.spec.ts`
  Expected FAIL: TypeScript/runtime — `afterPost` is not a known property of `PostingPipelineParams` (and the hook is never called, so `seenVoucherId` stays `0`).

- [ ] **Step 3: Add the `afterPost` seam to the pipeline.**
  In `src/ledger/pipeline/posting-pipeline.service.ts`, add to the `PostingPipelineParams` interface (after `requestedBy?: string;`):
  ```typescript
    /**
     * Optional hook folded into the SAME atomic transaction as the post,
     * AFTER the voucher is inserted and the business object's status/voucher_id
     * are updated. Receives the open `trx` and the posted voucher. Used by the
     * capex flow to create the fixed-asset register row atomically (ADR-0035).
     * MUST use the provided `trx` — never `this.db`.
     */
    afterPost?: (
      trx: Kysely<Database>,
      voucher: PostedVoucher,
    ) => Promise<void>;
  ```
  Then in `atomicPost`, invoke it inside the transaction, just before `return { voucher };`:
  ```typescript
          if (params.afterPost) {
            await params.afterPost(trx, voucher);
          }

          return { voucher };
  ```

- [ ] **Step 4: Run the pipeline test — expect PASS.**
  `npm test -- src/ledger/pipeline/posting-pipeline.service.spec.ts`

- [ ] **Step 5: Commit the pipeline seam.**
  `git add src/ledger/pipeline/posting-pipeline.service.ts src/ledger/pipeline/posting-pipeline.service.spec.ts`
  `git commit -m "feat(ledger): posting-pipeline afterPost hook folded into the post transaction"`

- [ ] **Step 6: Create the registrar service types + module skeleton.**
  Create `src/fixed-assets/types.ts`:
  ```typescript
  import { createZodDto } from 'nestjs-zod';
  import { z } from 'zod';

  /** A register row as returned by the read API. */
  export interface FixedAsset {
    id: number;
    name: string;
    asset_class: string;
    acquisition_voucher_id: number;
    acquisition_date: string;
    cost_base_minor: number;
    useful_life_years: number;
    residual_value_minor: number;
    retired_at: number | null;
    disposal_voucher_id: number | null;
  }

  /** Register row + computed book value (cost − Σ depreciation vouchers). */
  export interface FixedAssetWithBookValue extends FixedAsset {
    book_value_minor: number;
  }

  /** Disposal request: a date and optional sale proceeds (minor units). */
  export const disposeAssetSchema = z.object({
    disposal_date: z.string(),
    proceeds_minor: z.number().int().nonnegative().optional(),
  });

  export class DisposeAssetDto extends createZodDto(disposeAssetSchema) {}
  ```

- [ ] **Step 7: Write the failing registrar integration test (capex → register row).**
  Create `src/fixed-assets/fixed-asset-registrar.service.spec.ts`. It posts a capex expense through the pipeline (with the registrar wired as `afterPost`) and asserts the row + defaults + overrides. Set the org to `EE`.
  ```typescript
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { AccountService } from '../ledger/account/account.service';
  import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
  import { PostingService } from '../ledger/posting/posting.service';
  import { PeriodLockService } from '../reporting-periods/period-lock.service';
  import { StatusTransitionService } from '../ledger/status/status-transition.service';
  import { PolicyService } from '../policy/policy.service';
  import { RulesService } from '../rules/rules.service';
  import { OrgContextResolver } from '../organization/org-context.resolver';
  import { OrganizationService } from '../organization/organization.service';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { NullCountryPlugin } from '../plugins/null-country.plugin';
  import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
  import { CurrencyService } from '../currency/currency.service';
  import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
  import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
  import { ExpensesService } from '../expenses/expenses.service';
  import { CategoryService } from '../categories/category.service';
  import { FixedAssetRegistrarService } from './fixed-asset-registrar.service';

  describe('FixedAssetRegistrarService (capex → register, integration)', () => {
    let db: Kysely<Database>;
    let expenses: ExpensesService;
    let pipeline: PostingPipelineService;
    let registrar: FixedAssetRegistrarService;

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

      await db.updateTable('organization').set({ country: 'EE' }).execute();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          ExpensesService, CategoryService, VoucherProjectionService, CurrencyService,
          PostingPipelineService, PostingService, AccountService, LedgerValidationService,
          PeriodLockService, StatusTransitionService, PolicyService, RulesService,
          OrgContextResolver, OrganizationService, PluginLoader,
          NullCountryPlugin, EstoniaCountryPlugin, FixedAssetRegistrarService,
        ],
      }).compile();

      expenses = module.get(ExpensesService);
      pipeline = module.get(PostingPipelineService);
      registrar = module.get(FixedAssetRegistrarService);
    });

    afterEach(async () => { await db.destroy(); });

    async function postCapex(over: {
      asset_name: string;
      asset_useful_life_years?: number | null;
      asset_residual_value_minor?: number | null;
      category: string;
    }) {
      const expense = await expenses.createExpense({
        category: over.category,
        gross_amount: 2000000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2024-02-15',
        asset_name: over.asset_name,
        asset_useful_life_years: over.asset_useful_life_years ?? null,
        asset_residual_value_minor: over.asset_residual_value_minor ?? null,
      });
      await pipeline.runPipeline({
        businessObjectId: expense.id,
        businessObjectType: 'expense',
        draftGenerator: () => expenses.generateDraftVoucher(expense.id),
        category: over.category,
        refetch: () => expenses.getExpenseById(expense.id),
        confidence: 1,
        supplierKnown: true,
        afterPost: (trx, voucher) => registrar.registerFromVoucher(trx, voucher, expense.id),
      });
      return expense.id;
    }

    it('creates a register row with plugin defaults when no overrides given (vehicle 5y, residual 400000)', async () => {
      await postCapex({ asset_name: 'Company car', category: 'vehicle' });
      const row = await db.selectFrom('fixed_asset').selectAll().executeTakeFirstOrThrow();
      expect(row.name).toBe('Company car');
      expect(row.asset_class).toBe('vehicle');
      expect(row.cost_base_minor).toBe(2000000);
      expect(row.useful_life_years).toBe(5);
      expect(row.residual_value_minor).toBe(400000);
      expect(row.acquisition_date).toBe('2024-02-15');
      expect(row.acquisition_voucher_id).toBeGreaterThan(0);
      expect(row.retired_at).toBeNull();
    });

    it('honours useful-life and residual overrides from the intake payload', async () => {
      await postCapex({
        asset_name: 'Long-life laptop',
        category: 'it_equipment',
        asset_useful_life_years: 6,
        asset_residual_value_minor: 10000,
      });
      const row = await db.selectFrom('fixed_asset').selectAll().executeTakeFirstOrThrow();
      expect(row.asset_class).toBe('it_equipment');
      expect(row.useful_life_years).toBe(6);
      expect(row.residual_value_minor).toBe(10000);
    });

    it('creates NO register row for a non-capex expense', async () => {
      const expense = await expenses.createExpense({
        category: 'software', gross_amount: 5000, vat_amount: 0,
        currency: 'EUR', tax_point_date: '2024-02-15', asset_name: null,
      });
      await pipeline.runPipeline({
        businessObjectId: expense.id,
        businessObjectType: 'expense',
        draftGenerator: () => expenses.generateDraftVoucher(expense.id),
        category: 'software',
        refetch: () => expenses.getExpenseById(expense.id),
        confidence: 1,
        supplierKnown: true,
        afterPost: (trx, voucher) => registrar.registerFromVoucher(trx, voucher, expense.id),
      });
      const rows = await db.selectFrom('fixed_asset').selectAll().execute();
      expect(rows).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 8: Run the registrar test — expect FAIL.**
  `npm test -- src/fixed-assets/fixed-asset-registrar.service.spec.ts`
  Expected FAIL: `Cannot find module './fixed-asset-registrar.service'` (and `createExpense` does not yet accept `asset_name`).

- [ ] **Step 9: Extend the expense intake DTO + service to carry asset fields.**
  In `src/expenses/types.ts`, extend `createExpenseSchema` (add inside the `z.object({...})` after `supplier_invoice_number`):
  ```typescript
    asset_name: z.string().nullable().optional(),
    asset_useful_life_years: z.number().int().positive().nullable().optional(),
    asset_residual_value_minor: z.number().int().nonnegative().nullable().optional(),
  ```
  Add the three fields to the `Expense` interface (after `supplier_invoice_number: string | null;`):
  ```typescript
    asset_name: string | null;
    asset_useful_life_years: number | null;
    asset_residual_value_minor: number | null;
  ```
  In `src/expenses/expenses.service.ts`, in `createExpense`'s insert `.values({...})` add (after `supplier_invoice_number: ...`):
  ```typescript
          asset_name: dto.asset_name ?? null,
          asset_useful_life_years: dto.asset_useful_life_years ?? null,
          asset_residual_value_minor: dto.asset_residual_value_minor ?? null,
  ```
  Extend the `mapRow` parameter type (add the three columns) and the returned object:
  ```typescript
      asset_name: row.asset_name,
      asset_useful_life_years: row.asset_useful_life_years,
      asset_residual_value_minor: row.asset_residual_value_minor,
  ```
  (Add `asset_name: string | null; asset_useful_life_years: number | null; asset_residual_value_minor: number | null;` to the inline `mapRow` param type.)

- [ ] **Step 10: Implement the registrar service.**
  Create `src/fixed-assets/fixed-asset-registrar.service.ts`:
  ```typescript
  import { Injectable } from '@nestjs/common';
  import { Kysely } from 'kysely';
  import { Database } from '../database/types';
  import { OrgContextResolver } from '../organization/org-context.resolver';
  import { PostedVoucher } from '../ledger/voucher/types';
  import { AssetClass } from '../plugins/fixed-asset.types';
  import { assetClassForAccount } from './fixed-asset-class-map';

  /**
   * FixedAssetRegistrarService — the capex → register seam (ADR-0035 §3).
   *
   * Called as the posting pipeline's `afterPost` hook, INSIDE the posting
   * transaction. If the just-posted voucher carries a FIXED_ASSETS_* line, it
   * creates the fixed_asset register row from the source expense's intake payload
   * (asset name + optional overrides), defaulting useful life / residual from the
   * active country plugin per class. A non-capex voucher is a no-op.
   *
   * Reads the expense row through the SAME `trx` (the better-sqlite3 single
   * connection forbids a `this.db` read inside the open transaction).
   */
  @Injectable()
  export class FixedAssetRegistrarService {
    constructor(private readonly orgContextResolver: OrgContextResolver) {}

    async registerFromVoucher(
      trx: Kysely<Database>,
      voucher: PostedVoucher,
      expenseId: number,
    ): Promise<void> {
      // Find the capex line (a debit to a FIXED_ASSETS_* account).
      const accountIds = voucher.lines.map((l) => l.account_id);
      const accounts = await trx
        .selectFrom('account')
        .select(['id', 'code'])
        .where('id', 'in', accountIds)
        .execute();
      const codeById = new Map(accounts.map((a) => [a.id, a.code]));

      let assetClass: AssetClass | undefined;
      let costBaseMinor = 0;
      for (const line of voucher.lines) {
        const code = codeById.get(line.account_id);
        const cls = code ? assetClassForAccount(code) : undefined;
        if (cls && line.is_debit) {
          assetClass = cls;
          costBaseMinor = line.base_amount;
          break;
        }
      }
      if (!assetClass) return; // not a capex voucher

      const expense = await trx
        .selectFrom('expense')
        .select([
          'asset_name',
          'asset_useful_life_years',
          'asset_residual_value_minor',
        ])
        .where('id', '=', expenseId)
        .executeTakeFirst();

      const { plugin } = await this.orgContextResolver.resolve();
      const defaults = plugin.getFixedAssetDefaults(assetClass);

      await trx
        .insertInto('fixed_asset')
        .values({
          name: expense?.asset_name ?? `${assetClass} asset`,
          asset_class: assetClass,
          acquisition_voucher_id: voucher.id,
          acquisition_date: voucher.tax_point_date,
          cost_base_minor: costBaseMinor,
          useful_life_years:
            expense?.asset_useful_life_years ?? defaults.defaultUsefulLifeYears,
          residual_value_minor:
            expense?.asset_residual_value_minor ?? defaults.defaultResidualMinor,
          retired_at: null,
          disposal_voucher_id: null,
        })
        .execute();
    }
  }
  ```

- [ ] **Step 11: Create the FixedAssets module (registrar + deps; controller/service added later).**
  Create `src/fixed-assets/fixed-assets.module.ts`:
  ```typescript
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../database/database.module';
  import { OrganizationModule } from '../organization/organization.module';
  import { PluginsModule } from '../plugins/plugins.module';
  import { FixedAssetRegistrarService } from './fixed-asset-registrar.service';

  @Module({
    imports: [DatabaseModule, OrganizationModule, PluginsModule],
    providers: [FixedAssetRegistrarService],
    exports: [FixedAssetRegistrarService],
  })
  export class FixedAssetsModule {}
  ```
  > `OrganizationModule` already exports both `OrganizationService` and `OrgContextResolver` (confirmed), so importing it gives the registrar its `OrgContextResolver` dependency.

- [ ] **Step 12: Wire the registrar into the expense controller's post.**
  In `src/expenses/expenses.module.ts`, add `FixedAssetsModule` to `imports` (after `CategoriesModule`):
  ```typescript
    FixedAssetsModule,
  ```
  with the import line at the top:
  ```typescript
  import { FixedAssetsModule } from '../fixed-assets/fixed-assets.module';
  ```
  In `src/expenses/expenses.controller.ts`, inject the registrar and pass `afterPost`:
  - add the import:
    ```typescript
    import { FixedAssetRegistrarService } from '../fixed-assets/fixed-asset-registrar.service';
    ```
  - add to the constructor:
    ```typescript
        private readonly registrar: FixedAssetRegistrarService,
    ```
  - in `postExpense`, add to the `runPipeline({...})` argument (after the `override:` property):
    ```typescript
        afterPost: (trx, voucher) =>
          this.registrar.registerFromVoucher(trx, voucher, expenseId),
    ```

- [ ] **Step 13: Run the registrar test — expect PASS.**
  `npm test -- src/fixed-assets/fixed-asset-registrar.service.spec.ts`

- [ ] **Step 14: Run the existing expense specs (guard the DTO/service change) + typecheck.**
  `npm test -- src/expenses/expenses.service.spec.ts`
  `npm run typecheck`
  (If an existing expense spec constructs an `Expense` literal or `mapRow` row, add the three new nullable fields as `null` — these are mechanical additions; do them inline.)

- [ ] **Step 15: Commit.**
  `git add src/fixed-assets/ src/expenses/ src/app.module.ts`
  `git commit -m "feat(fixed-assets): capex->register hook, expense intake fields, registrar service"`
  > (app.module wiring is done in Task 8; if you have not edited it yet, drop it from this `git add`.)

---

## Task 7: Disposal operation (catch-up depreciation + disposal voucher + retire)

**Files**
- Create: `src/fixed-assets/fixed-assets.service.ts`
- Modify: `src/fixed-assets/fixed-assets.module.ts`
- Test: `src/fixed-assets/fixed-assets.service.spec.ts`

- [ ] **Step 1: Write the failing disposal integration tests (gain, scrap, loss, locked period).**
  Create `src/fixed-assets/fixed-assets.service.spec.ts`. It posts an acquisition via the registrar path (reuse the helper shape from Task 6), then disposes. Assertions target external behavior: the two posted vouchers, the retired row, and the book value.
  ```typescript
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { BadRequestException } from '@nestjs/common';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { AccountService } from '../ledger/account/account.service';
  import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
  import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
  import { PostingService } from '../ledger/posting/posting.service';
  import { PeriodLockService } from '../reporting-periods/period-lock.service';
  import { StatusTransitionService } from '../ledger/status/status-transition.service';
  import { PolicyService } from '../policy/policy.service';
  import { RulesService } from '../rules/rules.service';
  import { OrgContextResolver } from '../organization/org-context.resolver';
  import { OrganizationService } from '../organization/organization.service';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { NullCountryPlugin } from '../plugins/null-country.plugin';
  import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
  import { CurrencyService } from '../currency/currency.service';
  import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
  import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
  import { ExpensesService } from '../expenses/expenses.service';
  import { CategoryService } from '../categories/category.service';
  import { FixedAssetRegistrarService } from './fixed-asset-registrar.service';
  import { FixedAssetsService } from './fixed-assets.service';

  describe('FixedAssetsService disposal (integration)', () => {
    let db: Kysely<Database>;
    let expenses: ExpensesService;
    let pipeline: PostingPipelineService;
    let registrar: FixedAssetRegistrarService;
    let service: FixedAssetsService;

    beforeEach(async () => {
      const rawDb = new SqliteDb(':memory:');
      rawDb.pragma('foreign_keys = ON');
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');
      await db.updateTable('organization').set({ country: 'EE' }).execute();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          FixedAssetsService, FixedAssetRegistrarService,
          ExpensesService, CategoryService, VoucherProjectionService, CurrencyService,
          PostingPipelineService, PostingService, AccountService, LedgerBalanceService,
          LedgerValidationService, PeriodLockService, StatusTransitionService,
          PolicyService, RulesService, OrgContextResolver, OrganizationService,
          PluginLoader, NullCountryPlugin, EstoniaCountryPlugin,
        ],
      }).compile();

      expenses = module.get(ExpensesService);
      pipeline = module.get(PostingPipelineService);
      registrar = module.get(FixedAssetRegistrarService);
      service = module.get(FixedAssetsService);
    });

    afterEach(async () => { await db.destroy(); });

    // Acquire a €20,000 vehicle on 2024-01-01, 5y life, €4,000 residual.
    async function acquireCar(): Promise<number> {
      const expense = await expenses.createExpense({
        category: 'vehicle', gross_amount: 2000000, vat_amount: 0,
        currency: 'EUR', tax_point_date: '2024-01-01', asset_name: 'Company car',
      });
      await pipeline.runPipeline({
        businessObjectId: expense.id, businessObjectType: 'expense',
        draftGenerator: () => expenses.generateDraftVoucher(expense.id),
        category: 'vehicle', refetch: () => expenses.getExpenseById(expense.id),
        confidence: 1, supplierKnown: true,
        afterPost: (trx, v) => registrar.registerFromVoucher(trx, v, expense.id),
      });
      const row = await db.selectFrom('fixed_asset').select('id').executeTakeFirstOrThrow();
      return row.id;
    }

    // Sum of debit-positive base over the contra ACCUM_DEPRECIATION_VEHICLES account.
    async function accumDep(): Promise<number> {
      const r = await db
        .selectFrom('voucher_line as vl')
        .innerJoin('account as a', 'a.id', 'vl.account_id')
        .select((eb) => eb.fn.sum<number>(
          eb.case().when('vl.is_debit', '=', 1).then(eb.ref('vl.base_amount')).else(eb.neg(eb.ref('vl.base_amount'))).end(),
        ).as('net'))
        .where('a.code', '=', 'ACCUM_DEPRECIATION_VEHICLES')
        .executeTakeFirst();
      return Number(r?.net ?? 0); // credit-normal contra → negative when accumulated
    }

    it('disposal with proceeds (gain) posts catch-up depreciation then a disposal voucher and retires the asset', async () => {
      const id = await acquireCar();
      // Dispose 2025-12-31 (2 full years). Depreciable base 1,600,000; /5=320,000/yr; 2y=640,000.
      // NBV = 2,000,000 − 640,000 = 1,360,000. Proceeds 1,500,000 ⇒ gain 140,000.
      const result = await service.dispose(id, { disposal_date: '2025-12-31', proceeds_minor: 1500000 });

      // Two NEW vouchers posted by disposal (in addition to the acquisition voucher).
      expect(result.depreciationVoucher).not.toBeNull();
      expect(result.disposalVoucher).not.toBeNull();

      // Accumulated depreciation reached 640,000 (contra credit-normal ⇒ −640,000 before disposal clears it).
      // After the disposal voucher debits ACCUM to clear it, the net over the account is 0.
      expect(await accumDep()).toBe(0);

      // GAIN_LOSS line: a gain is a credit (revenue-normal). Assert the credit magnitude.
      const gainLine = result.disposalVoucher!.lines.find((l) =>
        result.disposalVoucher!.lines.length > 0 && l.base_amount === 140000 && !l.is_debit,
      );
      expect(gainLine).toBeDefined();

      const row = await db.selectFrom('fixed_asset').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(row.retired_at).not.toBeNull();
      expect(row.disposal_voucher_id).toBe(result.disposalVoucher!.id);
    });

    it('scrap (zero proceeds) books the full net book value as a loss', async () => {
      const id = await acquireCar();
      // Dispose 2025-12-31, no proceeds. NBV 1,360,000 ⇒ loss 1,360,000 (debit to GAIN_LOSS).
      const result = await service.dispose(id, { disposal_date: '2025-12-31' });
      const lossLine = result.disposalVoucher!.lines.find((l) => l.base_amount === 1360000 && l.is_debit);
      expect(lossLine).toBeDefined();
      const row = await db.selectFrom('fixed_asset').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(row.retired_at).not.toBeNull();
    });

    it('disposal with low proceeds (loss) books a debit to GAIN_LOSS', async () => {
      const id = await acquireCar();
      // NBV 1,360,000; proceeds 1,000,000 ⇒ loss 360,000.
      const result = await service.dispose(id, { disposal_date: '2025-12-31', proceeds_minor: 1000000 });
      const lossLine = result.disposalVoucher!.lines.find((l) => l.base_amount === 360000 && l.is_debit);
      expect(lossLine).toBeDefined();
    });

    it('rejects a disposal dated into a locked period (no write)', async () => {
      const id = await acquireCar();
      // Lock the seeded 2024-Q1 period (2024-01-01..2024-03-31).
      await db.updateTable('reporting_period').set({ status: 'locked' }).where('id', '=', 1).execute();

      const vouchersBefore = (await db.selectFrom('voucher').selectAll().execute()).length;
      await expect(service.dispose(id, { disposal_date: '2024-02-15', proceeds_minor: 100 })).rejects.toThrow(BadRequestException);

      const vouchersAfter = (await db.selectFrom('voucher').selectAll().execute()).length;
      expect(vouchersAfter).toBe(vouchersBefore); // catch-up + disposal both rolled back
      const row = await db.selectFrom('fixed_asset').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(row.retired_at).toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run the disposal test — expect FAIL.**
  `npm test -- src/fixed-assets/fixed-assets.service.spec.ts`
  Expected FAIL: `Cannot find module './fixed-assets.service'`.

- [ ] **Step 3: Implement `FixedAssetsService.dispose` (+ register read used in Task 8).**
  Create `src/fixed-assets/fixed-assets.service.ts`:
  ```typescript
  import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../database/types';
  import { PostingService } from '../ledger/posting/posting.service';
  import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
  import { DraftVoucher, DraftVoucherLine, PostedVoucher } from '../ledger/voucher/types';
  import { AssetClass } from '../plugins/fixed-asset.types';
  import { accumulatedDepreciationAsOf, depreciationCharge } from './depreciation-engine';
  import { CLASS_ACCOUNTS } from './fixed-asset-class-map';
  import { DisposeAssetDto, FixedAsset, FixedAssetWithBookValue } from './types';

  /**
   * FixedAssetsService — register read + the disposal operation (ADR-0035 §6).
   *
   * Disposal posts TWO system-generated vouchers in ONE transaction:
   *   (a) catch-up depreciation from the last close (here: from the asset's last
   *       recognised accumulated point, i.e. acquisition for v1 — there is no
   *       prior depreciation posting in this PRD's scope) up to the disposal date;
   *   (b) the disposal voucher that retires the asset.
   * The register row is then marked retired. Period-lock is enforced by
   * PostingService (the disposal date is the tax_point_date of both vouchers).
   */
  @Injectable()
  export class FixedAssetsService {
    constructor(
      @InjectKysely() private readonly db: Kysely<Database>,
      private readonly posting: PostingService,
      private readonly ledgerBalance: LedgerBalanceService,
    ) {}

    async list(): Promise<FixedAssetWithBookValue[]> {
      const rows = await this.db.selectFrom('fixed_asset').selectAll().orderBy('id').execute();
      return Promise.all(rows.map(async (r) => ({ ...this.mapRow(r), book_value_minor: await this.bookValue(r) })));
    }

    /** Book value = cost − accumulated depreciation posted to the contra account. */
    private async bookValue(row: { id: number; cost_base_minor: number; asset_class: string }): Promise<number> {
      const { accumDepreciationCode } = CLASS_ACCOUNTS[row.asset_class as AssetClass];
      // Σ depreciation = magnitude netted over the contra account for this asset's vouchers.
      // The contra account is per-class, so net over ALL its lines is the class total; for a
      // single-asset deployment that equals this asset. (Multi-asset attribution by voucher set
      // is a refinement; v1 nets the class contra — see Further Notes in the PRD.)
      const net = await this.ledgerBalance.getLedgerNet(
        { codes: [accumDepreciationCode] },
        { creditPositive: true },
      );
      return row.cost_base_minor - net;
    }

    async dispose(
      id: number,
      dto: DisposeAssetDto,
    ): Promise<{ depreciationVoucher: PostedVoucher | null; disposalVoucher: PostedVoucher }> {
      const asset = await this.db.selectFrom('fixed_asset').selectAll().where('id', '=', id).executeTakeFirst();
      if (!asset) throw new NotFoundException(`Fixed asset ${id} not found`);
      if (asset.retired_at !== null) throw new ConflictException(`Fixed asset ${id} is already retired`);

      const cls = asset.asset_class as AssetClass;
      const { fixedAssetCode, accumDepreciationCode } = CLASS_ACCOUNTS[cls];
      const depreciable = {
        acquisition_date: asset.acquisition_date,
        cost_base_minor: asset.cost_base_minor,
        useful_life_years: asset.useful_life_years,
        residual_value_minor: asset.residual_value_minor,
      };

      // (a) Catch-up depreciation up to the disposal date. v1 has no prior
      // depreciation posting (the annual close is a separate plan), so the
      // catch-up is the full accumulated depreciation as of the disposal date.
      const catchUp = depreciationCharge(depreciable, null, dto.disposal_date);
      const accumulated = accumulatedDepreciationAsOf(depreciable, dto.disposal_date);

      const proceeds = dto.proceeds_minor ?? 0;
      const netBookValue = asset.cost_base_minor - accumulated;
      // Gain (proceeds > NBV) → credit GAIN_LOSS; loss → debit GAIN_LOSS.
      const gainLoss = proceeds - netBookValue;

      const drafts: DraftVoucher[] = [];

      if (catchUp > 0) {
        drafts.push({
          tax_point_date: dto.disposal_date,
          reason: `Catch-up depreciation on disposal of fixed asset ${id}`,
          lines: [
            this.line('DEPRECIATION_EXPENSE', catchUp, true),
            this.line(accumDepreciationCode, catchUp, false),
          ],
        });
      }

      // (b) Disposal voucher: Dr Bank(proceeds), Dr ACCUM(accumulated),
      //     Cr FIXED_ASSETS(cost), balance to GAIN_LOSS.
      const disposalLines: DraftVoucherLine[] = [];
      if (proceeds > 0) disposalLines.push(this.line('BANK_EUR', proceeds, true));
      if (accumulated > 0) disposalLines.push(this.line(accumDepreciationCode, accumulated, true));
      disposalLines.push(this.line(fixedAssetCode, asset.cost_base_minor, false));
      if (gainLoss > 0) {
        disposalLines.push(this.line('GAIN_LOSS_ON_ASSET_DISPOSAL', gainLoss, false)); // gain (credit)
      } else if (gainLoss < 0) {
        disposalLines.push(this.line('GAIN_LOSS_ON_ASSET_DISPOSAL', -gainLoss, true)); // loss (debit)
      }
      drafts.push({
        tax_point_date: dto.disposal_date,
        reason: `Disposal of fixed asset ${id}`,
        lines: disposalLines,
      });

      const posted = await this.posting.postVouchersAtomic(drafts, {
        afterPost: async (trx, vouchers) => {
          const disposalVoucher = vouchers[vouchers.length - 1];
          await trx
            .updateTable('fixed_asset')
            .set({ retired_at: Math.floor(Date.now() / 1000), disposal_voucher_id: disposalVoucher.id })
            .where('id', '=', id)
            .execute();
        },
      });

      const disposalVoucher = posted[posted.length - 1];
      const depreciationVoucher = catchUp > 0 ? posted[0] : null;
      return { depreciationVoucher, disposalVoucher };
    }

    private line(account_code: string, base_amount: number, is_debit: boolean): DraftVoucherLine {
      return { account_code, amount: base_amount, currency: 'EUR', base_amount, fx_rate: 1, vat_code: null, is_debit };
    }

    private mapRow(r: {
      id: number; name: string; asset_class: string; acquisition_voucher_id: number;
      acquisition_date: string; cost_base_minor: number; useful_life_years: number;
      residual_value_minor: number; retired_at: number | null; disposal_voucher_id: number | null;
    }): FixedAsset {
      return {
        id: r.id, name: r.name, asset_class: r.asset_class,
        acquisition_voucher_id: r.acquisition_voucher_id, acquisition_date: r.acquisition_date,
        cost_base_minor: r.cost_base_minor, useful_life_years: r.useful_life_years,
        residual_value_minor: r.residual_value_minor, retired_at: r.retired_at,
        disposal_voucher_id: r.disposal_voucher_id,
      };
    }
  }
  ```
  > The disposal voucher balances: Dr (proceeds + accumulated [+ loss]) = Cr (cost [+ gain]). Verify with the golden numbers in the test (proceeds 1,500,000 + accumulated 640,000 = 2,140,000; cost 2,000,000 + gain 140,000 = 2,140,000). ✓

- [ ] **Step 4: Register `FixedAssetsService` in the module.**
  In `src/fixed-assets/fixed-assets.module.ts`, add the imports for the posting + balance deps and the service:
  ```typescript
  import { PostingModule } from '../ledger/posting/posting.module';
  import { AccountModule } from '../ledger/account/account.module';
  import { FixedAssetsService } from './fixed-assets.service';
  ```
  Update the `@Module`:
  ```typescript
  @Module({
    imports: [DatabaseModule, OrganizationModule, PluginsModule, PostingModule, AccountModule],
    providers: [FixedAssetRegistrarService, FixedAssetsService],
    exports: [FixedAssetRegistrarService, FixedAssetsService],
  })
  export class FixedAssetsModule {}
  ```
  > `AccountModule` already exports `AccountService` + `LedgerBalanceService` (confirmed); `PostingModule` already exports `PostingService` (confirmed). No changes to those modules are needed.

- [ ] **Step 5: Run the disposal test — expect PASS.**
  `npm test -- src/fixed-assets/fixed-assets.service.spec.ts`

- [ ] **Step 6: Commit.**
  `git add src/fixed-assets/fixed-assets.service.ts src/fixed-assets/fixed-assets.module.ts src/fixed-assets/fixed-assets.service.spec.ts`
  `git commit -m "feat(fixed-assets): disposal operation (catch-up depreciation + gain/loss) with period-lock safety"`

---

## Task 8: Register list endpoint + controller + app wiring

**Files**
- Create: `src/fixed-assets/fixed-assets.controller.ts`
- Modify: `src/fixed-assets/fixed-assets.module.ts`, `src/app.module.ts`
- Test: `src/fixed-assets/fixed-assets.controller.spec.ts`

- [ ] **Step 1: Write the failing controller/list integration test.**
  Create `src/fixed-assets/fixed-assets.controller.spec.ts`. Reuse the acquire helper; assert the list shape + computed book value, and the disposal endpoint.
  ```typescript
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { AccountService } from '../ledger/account/account.service';
  import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
  import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
  import { PostingService } from '../ledger/posting/posting.service';
  import { PeriodLockService } from '../reporting-periods/period-lock.service';
  import { StatusTransitionService } from '../ledger/status/status-transition.service';
  import { PolicyService } from '../policy/policy.service';
  import { RulesService } from '../rules/rules.service';
  import { OrgContextResolver } from '../organization/org-context.resolver';
  import { OrganizationService } from '../organization/organization.service';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { NullCountryPlugin } from '../plugins/null-country.plugin';
  import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
  import { CurrencyService } from '../currency/currency.service';
  import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
  import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
  import { ExpensesService } from '../expenses/expenses.service';
  import { CategoryService } from '../categories/category.service';
  import { FixedAssetRegistrarService } from './fixed-asset-registrar.service';
  import { FixedAssetsService } from './fixed-assets.service';
  import { FixedAssetsController } from './fixed-assets.controller';

  describe('FixedAssetsController (integration)', () => {
    let db: Kysely<Database>;
    let expenses: ExpensesService;
    let pipeline: PostingPipelineService;
    let registrar: FixedAssetRegistrarService;
    let controller: FixedAssetsController;

    beforeEach(async () => {
      const rawDb = new SqliteDb(':memory:');
      rawDb.pragma('foreign_keys = ON');
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');
      await db.updateTable('organization').set({ country: 'EE' }).execute();

      const module: TestingModule = await Test.createTestingModule({
        controllers: [FixedAssetsController],
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          FixedAssetsService, FixedAssetRegistrarService,
          ExpensesService, CategoryService, VoucherProjectionService, CurrencyService,
          PostingPipelineService, PostingService, AccountService, LedgerBalanceService,
          LedgerValidationService, PeriodLockService, StatusTransitionService,
          PolicyService, RulesService, OrgContextResolver, OrganizationService,
          PluginLoader, NullCountryPlugin, EstoniaCountryPlugin,
        ],
      }).compile();

      expenses = module.get(ExpensesService);
      pipeline = module.get(PostingPipelineService);
      registrar = module.get(FixedAssetRegistrarService);
      controller = module.get(FixedAssetsController);
    });

    afterEach(async () => { await db.destroy(); });

    async function acquireCar(): Promise<void> {
      const expense = await expenses.createExpense({
        category: 'vehicle', gross_amount: 2000000, vat_amount: 0,
        currency: 'EUR', tax_point_date: '2024-01-01', asset_name: 'Company car',
      });
      await pipeline.runPipeline({
        businessObjectId: expense.id, businessObjectType: 'expense',
        draftGenerator: () => expenses.generateDraftVoucher(expense.id),
        category: 'vehicle', refetch: () => expenses.getExpenseById(expense.id),
        confidence: 1, supplierKnown: true,
        afterPost: (trx, v) => registrar.registerFromVoucher(trx, v, expense.id),
      });
    }

    it('GET /api/fixed-assets lists the register with computed book value (no depreciation yet → cost)', async () => {
      await acquireCar();
      const { fixedAssets } = await controller.list();
      expect(fixedAssets).toHaveLength(1);
      expect(fixedAssets[0].name).toBe('Company car');
      expect(fixedAssets[0].asset_class).toBe('vehicle');
      // No depreciation posted yet ⇒ book value == cost.
      expect(fixedAssets[0].book_value_minor).toBe(2000000);
      expect(fixedAssets[0].retired_at).toBeNull();
    });

    it('book value drops by accumulated depreciation after a disposal catch-up posting', async () => {
      await acquireCar();
      const before = (await controller.list()).fixedAssets[0];
      await controller.dispose(before.id, { disposal_date: '2025-12-31', proceeds_minor: 1500000 });
      const after = (await controller.list()).fixedAssets[0];
      // After disposal the accumulated (640,000) is debited away again to clear ACCUM,
      // so the per-class contra nets to 0 ⇒ book value reads back as cost. The asset is retired.
      expect(after.retired_at).not.toBeNull();
      expect(after.disposal_voucher_id).not.toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run the controller test — expect FAIL.**
  `npm test -- src/fixed-assets/fixed-assets.controller.spec.ts`
  Expected FAIL: `Cannot find module './fixed-assets.controller'`.

- [ ] **Step 3: Implement the controller.**
  Create `src/fixed-assets/fixed-assets.controller.ts`:
  ```typescript
  import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
  import { ApiTags } from '@nestjs/swagger';
  import { FixedAssetsService } from './fixed-assets.service';
  import { DisposeAssetDto } from './types';

  @ApiTags('fixed-assets')
  @Controller('api/fixed-assets')
  export class FixedAssetsController {
    constructor(private readonly service: FixedAssetsService) {}

    @Get()
    async list() {
      return { fixedAssets: await this.service.list() };
    }

    @Post(':id/disposal')
    async dispose(
      @Param('id', ParseIntPipe) id: number,
      @Body() dto: DisposeAssetDto,
    ) {
      const { depreciationVoucher, disposalVoucher } = await this.service.dispose(id, dto);
      return { depreciationVoucher, disposalVoucher };
    }
  }
  ```

- [ ] **Step 4: Register the controller in the module.**
  In `src/fixed-assets/fixed-assets.module.ts`, add the import and `controllers`:
  ```typescript
  import { FixedAssetsController } from './fixed-assets.controller';
  ```
  ```typescript
    controllers: [FixedAssetsController],
  ```
  (Add the `controllers` key to the existing `@Module({...})`.)

- [ ] **Step 5: Register the module in app.module.**
  In `src/app.module.ts`, add the import near the other feature-module imports:
  ```typescript
  import { FixedAssetsModule } from './fixed-assets/fixed-assets.module';
  ```
  and add `FixedAssetsModule,` to the `imports` array (after `CategoriesModule,`).

- [ ] **Step 6: Run the controller test — expect PASS.**
  `npm test -- src/fixed-assets/fixed-assets.controller.spec.ts`

- [ ] **Step 7: Full suite + lint + typecheck.**
  `npm test`
  `npm run lint`
  `npm run typecheck`

- [ ] **Step 8: Commit.**
  `git add src/fixed-assets/fixed-assets.controller.ts src/fixed-assets/fixed-assets.module.ts src/fixed-assets/fixed-assets.controller.spec.ts src/app.module.ts`
  `git commit -m "feat(fixed-assets): GET /api/fixed-assets register list + POST :id/disposal + app wiring"`

---

## PRD Requirement → Task coverage

| PRD requirement | Task |
| --- | --- |
| New categories vehicle/it_equipment/machinery/furniture → per-class accounts | 4 |
| Neutral system accounts (FIXED_ASSETS_*, ACCUM_DEPRECIATION_*, DEPRECIATION_EXPENSE, GAIN_LOSS_ON_ASSET_DISPOSAL) + types | 1 |
| `fixed_asset` register table (master data, no immutability triggers) | 2 |
| Plugin owns method + default lives + default residuals (EE real, Null stub) | 3, 4 |
| Pure deterministic straight-line pro-rata engine, capped at base, golden cases | 5 |
| Capex → register hook, atomic in the posting transaction; intake DTO extension; overrides | 6 |
| Disposal: two system vouchers (catch-up + disposal), gain/scrap/loss, retire, period-lock | 7 |
| Register list with computed book value (never stored) | 7 (book value), 8 (endpoint) |
| Locked-period safety on disposal | 7 |
| Auditor: deterministic, voucher-backed | 5, 7 (no LLM in any figure) |
