import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { Migrator } from 'kysely/migration';
import { NullCountryPlugin } from './null-country.plugin';
import { PluginLoader } from './plugin-loader.service';
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

  describe('getName', () => {
    it('should return "null"', () => {
      expect(plugin.getName()).toBe('null');
    });
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

  describe('getPeriodFrequencyOptions', () => {
    it('should return ["yearly"]', () => {
      expect(plugin.getPeriodFrequencyOptions()).toEqual(['yearly']);
    });
  });

  describe('getDefaultPeriodFrequency', () => {
    it('should return "yearly"', () => {
      expect(plugin.getDefaultPeriodFrequency()).toBe('yearly');
    });
  });

  describe('getDefaultBaseCurrency', () => {
    it('should return "EUR" as the neutral default', () => {
      expect(plugin.getDefaultBaseCurrency()).toBe('EUR');
    });
  });

  describe('validateVATCode', () => {
    it('should return true for "NULL_STANDARD"', () => {
      expect(plugin.validateVATCode('NULL_STANDARD', {})).toBe(true);
    });

    it('should return true for "IE_INPUT_23"', () => {
      expect(plugin.validateVATCode('IE_INPUT_23', {})).toBe(true);
    });

    it('should return true for "IE_OUTPUT_23"', () => {
      expect(plugin.validateVATCode('IE_OUTPUT_23', {})).toBe(true);
    });

    it('should return false for any other VAT code', () => {
      expect(plugin.validateVATCode('DK_INPUT_25', {})).toBe(false);
    });
  });
});

describe('PluginLoader', () => {
  let loader: PluginLoader;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NullCountryPlugin, PluginLoader],
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
