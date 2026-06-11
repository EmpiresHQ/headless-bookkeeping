import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { Migrator } from 'kysely/migration';
import { Logger } from '@nestjs/common';
import { NullCountryPlugin } from './null-country.plugin';
import { EstoniaCountryPlugin } from './estonia-country.plugin';
import { PluginLoader } from './plugin-loader.service';
import {
  StrictTestPlugin,
  STRICT_REJECTED_VAT,
  STRICT_REJECTED_CATEGORY,
} from './strict-test.plugin';
import { OrgContext, SupplierFacts } from './country-plugin.interface';

const defaultSupplier: SupplierFacts = {
  country: 'IE',
  goodsVsServices: 'services',
  classificationMemory: [],
};

const defaultOrg: OrgContext = {
  country: 'IE',
  vatRegistered: true,
  baseCurrency: null,
};

describe('NullCountryPlugin', () => {
  let plugin: NullCountryPlugin;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NullCountryPlugin],
    }).compile();

    plugin = module.get<NullCountryPlugin>(NullCountryPlugin);
  });

  describe('getVATCodes', () => {
    it('should return IE VAT codes plus NULL_STANDARD', () => {
      expect(plugin.getVATCodes()).toEqual([
        'NULL_STANDARD',
        'IE_INPUT_23',
        'IE_OUTPUT_23',
      ]);
    });
  });

  describe('resolveCategoryMapping', () => {
    it('should return expected defaults for "software"', () => {
      const result = plugin.resolveCategoryMapping(
        'software',
        defaultSupplier,
        defaultOrg,
      );
      expect(result).toEqual({
        accountCode: 'EXPENSE_SOFTWARE',
        vatCode: 'IE_INPUT_23',
      });
    });

    it('should return generic fallback for unknown categories', () => {
      const result = plugin.resolveCategoryMapping(
        'widgets',
        defaultSupplier,
        defaultOrg,
      );
      expect(result).toEqual({
        accountCode: 'EXPENSE_OTHER',
        vatCode: 'IE_INPUT_23',
      });
    });

    it('should map "revenue" to REVENUE + IE_OUTPUT_23', () => {
      const result = plugin.resolveCategoryMapping(
        'revenue',
        defaultSupplier,
        defaultOrg,
      );
      expect(result).toEqual({
        accountCode: 'REVENUE',
        vatCode: 'IE_OUTPUT_23',
      });
    });

    it('should map "transport" to EXPENSE_TRANSPORT + IE_INPUT_23', () => {
      const result = plugin.resolveCategoryMapping(
        'transport',
        defaultSupplier,
        defaultOrg,
      );
      expect(result).toEqual({
        accountCode: 'EXPENSE_TRANSPORT',
        vatCode: 'IE_INPUT_23',
      });
    });

    it('should map "rent" to EXPENSE_RENT + IE_INPUT_23', () => {
      const result = plugin.resolveCategoryMapping(
        'rent',
        defaultSupplier,
        defaultOrg,
      );
      expect(result).toEqual({
        accountCode: 'EXPENSE_RENT',
        vatCode: 'IE_INPUT_23',
      });
    });
  });

  describe('getReferenceRate', () => {
    it('should return 1.0 when the two currencies are the same (EUR→EUR)', () => {
      expect(plugin.getReferenceRate('EUR', 'EUR', '2026-03-15')).toBe(1.0);
    });

    it('should return 1.0 when the two currencies are the same (DKK→DKK)', () => {
      expect(plugin.getReferenceRate('DKK', 'DKK', '2026-03-15')).toBe(1.0);
    });

    it('should throw for cross-currency (EUR→DKK)', () => {
      expect(() => plugin.getReferenceRate('EUR', 'DKK', '2026-03-15')).toThrow(
        'Cross-currency FX not supported in null plugin: EUR → DKK',
      );
    });

    it('should throw for cross-currency (USD→EUR)', () => {
      expect(() => plugin.getReferenceRate('USD', 'EUR', '2026-03-15')).toThrow(
        'Cross-currency FX not supported in null plugin: USD → EUR',
      );
    });

    it('should return 1.0 for same-currency regardless of date', () => {
      // The date parameter is accepted but ignored by the null plugin
      expect(plugin.getReferenceRate('EUR', 'EUR', '2020-01-01')).toBe(1.0);
      expect(plugin.getReferenceRate('EUR', 'EUR', '2030-12-31')).toBe(1.0);
    });
  });

  describe('roundToBaseMinorUnits', () => {
    it('rounds to integer minor units with Math.round semantics (half away from zero)', () => {
      // Behavior-preserving for IE/EUR: identical to the kernel's former
      // hardcoded Math.round.
      expect(plugin.roundToBaseMinorUnits(98.76)).toBe(99);
      expect(plugin.roundToBaseMinorUnits(2.5)).toBe(3);
      expect(plugin.roundToBaseMinorUnits(2.4)).toBe(2);
      expect(plugin.roundToBaseMinorUnits(714)).toBe(714);
    });
  });

  describe('validateVATCode', () => {
    it('should return true for "NULL_STANDARD"', () => {
      expect(
        plugin.validateVATCode('NULL_STANDARD', {
          supplier: defaultSupplier,
          org: defaultOrg,
        }),
      ).toBe(true);
    });

    it('should return true for "IE_INPUT_23"', () => {
      expect(
        plugin.validateVATCode('IE_INPUT_23', {
          supplier: defaultSupplier,
          org: defaultOrg,
        }),
      ).toBe(true);
    });

    it('should return true for "IE_OUTPUT_23"', () => {
      expect(
        plugin.validateVATCode('IE_OUTPUT_23', {
          supplier: defaultSupplier,
          org: defaultOrg,
        }),
      ).toBe(true);
    });

    it('should return false for any other VAT code', () => {
      expect(
        plugin.validateVATCode('DK_INPUT_25', {
          supplier: defaultSupplier,
          org: defaultOrg,
        }),
      ).toBe(false);
    });
  });
});

describe('PluginLoader', () => {
  let loader: PluginLoader;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NullCountryPlugin, EstoniaCountryPlugin, PluginLoader],
    }).compile();

    loader = module.get<PluginLoader>(PluginLoader);
  });

  describe('resolve', () => {
    it('should return a CountryPlugin instance for "DK"', () => {
      const result = loader.resolve('DK');
      expect(result).toBeDefined();
      expect(typeof result.getName).toBe('function');
      expect(typeof result.getVATCodes).toBe('function');
      expect(typeof result.resolveCategoryMapping).toBe('function');
    });

    it('should return NullCountryPlugin for unrecognized country codes', () => {
      const result = loader.resolve('XX');
      expect(result.getName()).toBe('null');
    });

    it('should return NullCountryPlugin for "null"', () => {
      const result = loader.resolve('null');
      expect(result.getName()).toBe('null');
    });

    it('resolves the Estonia plugin for EE', () => {
      expect(loader.resolve('EE').getName()).toBe('EE');
    });
  });

  describe('resolve observability (friction #6)', () => {
    it('warns (not silently) when falling back to the neutral default for an unknown country', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const result = loader.resolve('DK');

      expect(result.getName()).toBe('null');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain('DK');
      expect(message).toContain('NullCountryPlugin');

      warn.mockRestore();
    });

    it('does NOT warn for "null" — the neutral plugin is a registered, legitimate default deployment', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      loader.resolve('null');

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('warns once per distinct unknown country code (spam control), not once per resolve()', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      loader.resolve('DK');
      loader.resolve('DK');
      loader.resolve('DK');
      loader.resolve('DE');

      // One warning for DK, one for DE — not four.
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });
});

describe('StrictTestPlugin (second adapter — real seam)', () => {
  let plugin: StrictTestPlugin;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StrictTestPlugin],
    }).compile();

    plugin = module.get<StrictTestPlugin>(StrictTestPlugin);
  });

  it('identifies itself as a distinct plugin from the null default', () => {
    expect(plugin.getName()).toBe('strict-test');
  });

  it('maps the trigger Category to the known-bad VAT code', () => {
    const result = plugin.resolveCategoryMapping(
      STRICT_REJECTED_CATEGORY,
      defaultSupplier,
      defaultOrg,
    );
    expect(result.vatCode).toBe(STRICT_REJECTED_VAT);
  });

  it('FORCES a semantic failure: rejects the known-bad VAT code', () => {
    expect(
      plugin.validateVATCode(STRICT_REJECTED_VAT, {
        supplier: defaultSupplier,
        org: defaultOrg,
      }),
    ).toBe(false);
  });

  it('still accepts the inherited NullCountryPlugin VAT codes (only the bad code fails)', () => {
    expect(
      plugin.validateVATCode('IE_INPUT_23', {
        supplier: defaultSupplier,
        org: defaultOrg,
      }),
    ).toBe(true);
  });

  it('inherits NullCountryPlugin minor-unit rounding (Math.round) unchanged', () => {
    expect(plugin.roundToBaseMinorUnits(98.76)).toBe(99);
    expect(plugin.roundToBaseMinorUnits(2.5)).toBe(3);
  });

  it('falls through to NullCountryPlugin mapping for ordinary categories', () => {
    const result = plugin.resolveCategoryMapping(
      'software',
      defaultSupplier,
      defaultOrg,
    );
    expect(result).toEqual({
      accountCode: 'EXPENSE_SOFTWARE',
      vatCode: 'IE_INPUT_23',
    });
  });
});

describe('NullCountryPlugin real-DI against seeded chart', () => {
  let plugin: NullCountryPlugin;
  let db: Kysely<DBType>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NullCountryPlugin],
    }).compile();

    plugin = module.get<NullCountryPlugin>(NullCountryPlugin);

    db = new Kysely<DBType>({
      dialect: new SqliteDialect({
        database: new Database(':memory:'),
      }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('should resolve expense categories to accounts that exist in the seeded chart', async () => {
    const categories = [
      'software',
      'transport',
      'travel',
      'marketing',
      'salary',
      'contractor',
      'rent',
      'tax',
      'bank fee',
      'meals',
      'insurance',
      'education',
    ];

    for (const category of categories) {
      const mapping = plugin.resolveCategoryMapping(
        category,
        defaultSupplier,
        defaultOrg,
      );

      const account = await db
        .selectFrom('account')
        .select('code')
        .where('code', '=', mapping.accountCode)
        .executeTakeFirst();

      expect(account).toBeDefined();
      expect(account!.code).toBe(mapping.accountCode);
      expect(mapping.vatCode).toBe('IE_INPUT_23');
    }
  });

  it('should resolve "revenue" to REVENUE which exists in the seeded chart', async () => {
    const mapping = plugin.resolveCategoryMapping(
      'revenue',
      defaultSupplier,
      defaultOrg,
    );

    const account = await db
      .selectFrom('account')
      .select('code')
      .where('code', '=', mapping.accountCode)
      .executeTakeFirst();

    expect(account).toBeDefined();
    expect(account!.code).toBe('REVENUE');
    expect(mapping.vatCode).toBe('IE_OUTPUT_23');
  });

  it('should resolve unknown categories to EXPENSE_OTHER which exists in the seeded chart', async () => {
    const mapping = plugin.resolveCategoryMapping(
      'unknown-category',
      defaultSupplier,
      defaultOrg,
    );

    const account = await db
      .selectFrom('account')
      .select('code')
      .where('code', '=', mapping.accountCode)
      .executeTakeFirst();

    expect(account).toBeDefined();
    expect(account!.code).toBe('EXPENSE_OTHER');
    expect(mapping.vatCode).toBe('IE_INPUT_23');
  });
});
