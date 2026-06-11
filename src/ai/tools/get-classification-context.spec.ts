import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../../database/types';
import { migrations } from '../../database/migrations';
import { EntitiesService } from '../../entities/entities.service';
import { ExpensesService } from '../../expenses/expenses.service';
import { VoucherProjectionService } from '../../ledger/projection/voucher-projection.service';
import { PluginLoader } from '../../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../../plugins/estonia-country.plugin';
import { CurrencyService } from '../../currency/currency.service';
import { OrganizationService } from '../../organization/organization.service';
import { OrgContextResolver } from '../../organization/org-context.resolver';
import {
  SupplierFacts,
  OrgContext,
} from '../../plugins/country-plugin.interface';
import { createGetClassificationContextTool } from './index';
import { PeriodLockService } from '../../reporting-periods/period-lock.service';

/**
 * Unit tests for the composed deep read `getClassificationContext`.
 *
 * Proves: supplier resolved (matched) vs proposed; that the Supplier's
 * Classification memory ACTUALLY reaches the country plugin's
 * resolveCategoryMapping (the bug fix — previewCategoryMapping previously
 * hardcoded classificationMemory: []); that the plugin stays the sole
 * resolver of Account + VAT code; and the empty-history case.
 */
describe('getClassificationContext (composed deep read)', () => {
  let db: Kysely<Database>;
  let entitiesService: EntitiesService;
  let expensesService: ExpensesService;
  let organizationService: OrganizationService;
  let pluginLoader: PluginLoader;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        EntitiesService,
        ExpensesService,
        {
          provide: PeriodLockService,
          useValue: {
            assertPeriodOpen: jest.fn().mockResolvedValue(undefined),
            findLockedPeriod: jest.fn().mockResolvedValue(undefined),
            getCurrentOpenPeriod: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    entitiesService = module.get(EntitiesService);
    expensesService = module.get(ExpensesService);
    organizationService = module.get(OrganizationService);
    pluginLoader = module.get(PluginLoader);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('resolves an existing Supplier on its registration key (matched)', async () => {
    const supplier = await entitiesService.onboard({
      role: 'supplier',
      country: 'IE',
      name: 'Acme Software Ltd',
      registrationKey: 'IE1234567',
      goodsVsServices: 'services',
    });

    const tool = createGetClassificationContextTool(
      entitiesService,
      expensesService,
      pluginLoader,
      organizationService,
    );

    const result = await tool.execute({
      category: 'software',
      evidence: { registrationKey: 'IE1234567', name: 'ACME SW' },
    });

    expect(result.supplier.resolution).toBe('matched');
    expect(result.supplier.matchEntityId).toBe(supplier.id);
    // Identity facts come from the resolved Supplier, not the OCR name.
    expect(result.supplier.name).toBe('Acme Software Ltd');
    expect(result.supplier.country).toBe('IE');
    expect(result.supplier.goodsVsServices).toBe('services');
  });

  it('proposes a new Supplier when no registration key matches', async () => {
    const tool = createGetClassificationContextTool(
      entitiesService,
      expensesService,
      pluginLoader,
      organizationService,
    );

    const result = await tool.execute({
      category: 'software',
      evidence: {
        registrationKey: 'DE999',
        name: 'Neuer Lieferant GmbH',
        country: 'DE',
        goodsVsServices: 'goods',
      },
    });

    expect(result.supplier.resolution).toBe('proposed');
    expect(result.supplier.matchEntityId).toBeUndefined();
    expect(result.supplier.name).toBe('Neuer Lieferant GmbH');
    expect(result.supplier.country).toBe('DE');
    expect(result.supplier.goodsVsServices).toBe('goods');
    // A proposed (new) Supplier has no Classification memory.
    expect(result.classificationMemory).toEqual([]);
  });

  it("includes the matched Supplier's Classification memory from expense history", async () => {
    const supplier = await entitiesService.onboard({
      role: 'supplier',
      country: 'IE',
      name: 'Walmart',
      registrationKey: 'IE5550000',
      goodsVsServices: 'goods',
    });

    // Historical purchases: software twice, meals once.
    for (const category of ['software', 'software', 'meals']) {
      await expensesService.createExpense({
        supplier_id: supplier.id,
        category,
        gross_amount: 1000,
        vat_amount: 200,
        currency: 'EUR',
        tax_point_date: '2026-01-01',
      });
    }

    const tool = createGetClassificationContextTool(
      entitiesService,
      expensesService,
      pluginLoader,
      organizationService,
    );

    const result = await tool.execute({
      category: 'software',
      evidence: { registrationKey: 'IE5550000' },
    });

    expect(result.classificationMemory.sort()).toEqual(['meals', 'software']);
  });

  it('flows the Classification memory THROUGH to the plugin (fixes the hardcoded [] bug)', async () => {
    const supplier = await entitiesService.onboard({
      role: 'supplier',
      country: 'IE',
      name: 'Memory Co',
      registrationKey: 'IE7770000',
      goodsVsServices: 'services',
    });

    await expensesService.createExpense({
      supplier_id: supplier.id,
      category: 'software',
      gross_amount: 1000,
      vat_amount: 200,
      currency: 'EUR',
      tax_point_date: '2026-01-01',
    });

    // Spy on the plugin to capture the SupplierFacts it actually receives.
    const plugin = pluginLoader.resolve('IE');
    const seen: SupplierFacts[] = [];
    const spy = jest
      .spyOn(plugin, 'resolveCategoryMapping')
      .mockImplementation(
        (
          _category: string,
          supplierFacts: SupplierFacts,
          _orgContext: OrgContext,
        ) => {
          seen.push(supplierFacts);
          return { accountCode: 'EXPENSE_SOFTWARE', vatCode: 'IE_INPUT_23' };
        },
      );

    const tool = createGetClassificationContextTool(
      entitiesService,
      expensesService,
      pluginLoader,
      organizationService,
    );

    await tool.execute({
      category: 'software',
      evidence: { registrationKey: 'IE7770000' },
    });

    expect(seen).toHaveLength(1);
    // The bug fix: the memory reaches the plugin instead of an empty array.
    expect(seen[0].classificationMemory).toEqual(['software']);

    spy.mockRestore();
  });

  it('keeps the country plugin as the sole resolver of Account + VAT code', async () => {
    const plugin = pluginLoader.resolve('IE');
    const spy = jest.spyOn(plugin, 'resolveCategoryMapping').mockReturnValue({
      accountCode: 'SENTINEL_ACCT',
      vatCode: 'SENTINEL_VAT',
    });

    const tool = createGetClassificationContextTool(
      entitiesService,
      expensesService,
      pluginLoader,
      organizationService,
    );

    const result = await tool.execute({
      category: 'software',
      evidence: { country: 'IE', goodsVsServices: 'services' },
    });

    // The mapping is whatever the plugin returned — the tool invents nothing.
    expect(result.mapping).toEqual({
      accountCode: 'SENTINEL_ACCT',
      vatCode: 'SENTINEL_VAT',
    });
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it('handles the empty-history case for a matched Supplier with no expenses', async () => {
    await entitiesService.onboard({
      role: 'supplier',
      country: 'IE',
      name: 'Brand New Supplier',
      registrationKey: 'IE0001111',
      goodsVsServices: 'services',
    });

    const tool = createGetClassificationContextTool(
      entitiesService,
      expensesService,
      pluginLoader,
      organizationService,
    );

    const result = await tool.execute({
      category: 'software',
      evidence: { registrationKey: 'IE0001111' },
    });

    expect(result.supplier.resolution).toBe('matched');
    expect(result.classificationMemory).toEqual([]);
    // Mapping still resolves via the plugin even with no memory.
    expect(result.mapping.accountCode).toBe('EXPENSE_SOFTWARE');
    expect(result.mapping.vatCode).toBe('IE_INPUT_23');
  });
});
