import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { RulesService } from './rules.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { OrgContext, SupplierFacts } from '../plugins/country-plugin.interface';
import { ResolvedLine, Override, SemanticValidationContext } from './types';
import { canOverride, mustReject } from './rules.guards';

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

const defaultSemanticContext: SemanticValidationContext = {
  countryCode: 'null',
  supplierFacts: defaultSupplier,
  orgContext: defaultOrg,
};

const resolvedLine = (over: Partial<ResolvedLine>): ResolvedLine => ({
  account_id: 1,
  amount: 10000,
  currency: 'EUR',
  base_amount: 10000,
  fx_rate: 1,
  is_debit: true,
  account_currency: null,
  vat_code: 'IE_INPUT_23',
  category: 'software',
  ...over,
});

describe('RulesService (unit)', () => {
  let service: RulesService;
  const validIds = new Set([1, 2]);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RulesService,
        LedgerValidationService,
        PluginLoader,
        NullCountryPlugin,
      ],
    }).compile();

    service = module.get<RulesService>(RulesService);
  });

  describe('structural tier', () => {
    it('passes a balanced voucher', () => {
      const result = service.validate(
        [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validIds,
        'structural',
      );
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('structural');
      expect(result.overrideable).toBe(false);
    });

    it('fails an unbalanced voucher → passed:false, overrideable:false', () => {
      const result = service.validate(
        [
          resolvedLine({
            account_id: 1,
            amount: 10000,
            base_amount: 10000,
            is_debit: true,
          }),
          resolvedLine({
            account_id: 2,
            amount: 9900,
            base_amount: 9900,
            is_debit: false,
          }),
        ],
        validIds,
        'structural',
      );
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(false);
      expect(result.message).toContain('do not balance');
      expect(mustReject(result)).toBe(true);
      expect(canOverride(result)).toBe(false);
    });

    it('fails a non-existent account → passed:false, overrideable:false', () => {
      const result = service.validate(
        [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 42, is_debit: false }),
        ],
        validIds,
        'structural',
      );
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(false);
      expect(result.message).toContain('Account does not exist');
    });

    it('structural failure + Override attempt → still passed:false', () => {
      const override: Override = {
        ruleType: 'structural',
        reason: 'I want to force this through',
      };
      const result = service.validate(
        [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 42, is_debit: false }),
        ],
        validIds,
        'structural',
        undefined,
        override,
      );
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(false);
    });
  });

  describe('hard process tier', () => {
    it('always passes (stub until Wave 6)', () => {
      const result = service.validate(
        [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validIds,
        'hard',
      );
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('hard_process');
      expect(result.overrideable).toBe(false);
      expect(result.message).toContain('period lock stub');
    });
  });

  describe('semantic tier', () => {
    it('passes with valid VAT code and known category', () => {
      const result = service.validate(
        [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validIds,
        'semantic',
        defaultSemanticContext,
      );
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('semantic');
      expect(result.overrideable).toBe(true);
    });

    it('fails with invalid VAT code → passed:false, overrideable:true', () => {
      const result = service.validate(
        [
          resolvedLine({
            account_id: 1,
            is_debit: true,
            vat_code: 'DK_INPUT_25',
          }),
          resolvedLine({
            account_id: 2,
            is_debit: false,
            vat_code: 'DK_INPUT_25',
          }),
        ],
        validIds,
        'semantic',
        defaultSemanticContext,
      );
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('Invalid VAT code');
      expect(canOverride(result)).toBe(true);
      expect(mustReject(result)).toBe(false);
    });

    it('fails with invalid VAT code on unknown category → passed:false, overrideable:true', () => {
      // NullCountryPlugin maps unknown categories to EXPENSE_OTHER,
      // so category mapping never fails. The real semantic gate is VAT code validity.
      const result = service.validate(
        [
          resolvedLine({
            account_id: 1,
            is_debit: true,
            category: 'totally-unknown-category',
            vat_code: 'INVALID_VAT_CODE',
          }),
          resolvedLine({
            account_id: 2,
            is_debit: false,
            category: 'totally-unknown-category',
            vat_code: 'INVALID_VAT_CODE',
          }),
        ],
        validIds,
        'semantic',
        defaultSemanticContext,
      );
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('Invalid VAT code');
    });

    it('semantic failure + Override reason → passed:true', () => {
      const override: Override = {
        ruleType: 'semantic',
        reason: 'Supplier confirmed this is a valid special VAT treatment',
      };
      const result = service.validate(
        [
          resolvedLine({
            account_id: 1,
            is_debit: true,
            vat_code: 'INVALID_VAT_CODE',
          }),
          resolvedLine({
            account_id: 2,
            is_debit: false,
            vat_code: 'INVALID_VAT_CODE',
          }),
        ],
        validIds,
        'semantic',
        defaultSemanticContext,
        override,
      );
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('semantic');
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('overridden');
      expect(result.message).toContain(override.reason);
    });

    it('fails when context is missing', () => {
      const result = service.validate(
        [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validIds,
        'semantic',
      );
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('requires context');
    });

    it('override on wrong ruleType is ignored', () => {
      const override: Override = {
        ruleType: 'hard_process',
        reason: 'Wrong tier override',
      };
      const result = service.validate(
        [
          resolvedLine({
            account_id: 1,
            is_debit: true,
            vat_code: 'INVALID',
          }),
          resolvedLine({
            account_id: 2,
            is_debit: false,
            vat_code: 'INVALID',
          }),
        ],
        validIds,
        'semantic',
        defaultSemanticContext,
        override,
      );
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
    });
  });
});

describe('RulesService (real-DI against seeded chart + NullCountryPlugin)', () => {
  let service: RulesService;
  let db: Kysely<DBType>;
  let validAccountIds: Set<number>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RulesService,
        LedgerValidationService,
        PluginLoader,
        NullCountryPlugin,
      ],
    }).compile();

    service = module.get<RulesService>(RulesService);

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

    const accounts = await db.selectFrom('account').select(['id']).execute();
    validAccountIds = new Set(accounts.map((a) => a.id));
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('has a seeded chart with enough accounts for real validation', () => {
    expect(validAccountIds.size).toBeGreaterThanOrEqual(20);
  });

  it('passes structural + semantic for a balanced expense voucher with real account IDs', async () => {
    // Pick two real account IDs from the seeded chart.
    const _ids = Array.from(validAccountIds);
    const bankEur = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirst();
    const expenseSoftware = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'EXPENSE_SOFTWARE')
      .executeTakeFirst();

    expect(bankEur).toBeDefined();
    expect(expenseSoftware).toBeDefined();

    const lines: ResolvedLine[] = [
      {
        account_id: expenseSoftware!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: true,
        account_currency: null,
        vat_code: 'IE_INPUT_23',
        category: 'software',
      },
      {
        account_id: bankEur!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: false,
        account_currency: null,
        vat_code: 'IE_INPUT_23',
        category: 'software',
      },
    ];

    const structural = service.validate(lines, validAccountIds, 'structural');
    expect(structural.passed).toBe(true);
    expect(structural.overrideable).toBe(false);

    const semantic = service.validate(
      lines,
      validAccountIds,
      'semantic',
      defaultSemanticContext,
    );
    expect(semantic.passed).toBe(true);
    expect(semantic.overrideable).toBe(true);
  });

  it('fails structural for an unbalanced voucher even with real account IDs', async () => {
    const bankEur = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirst();
    const expenseSoftware = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'EXPENSE_SOFTWARE')
      .executeTakeFirst();

    const lines: ResolvedLine[] = [
      {
        account_id: expenseSoftware!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: true,
        account_currency: null,
        vat_code: 'IE_INPUT_23',
        category: 'software',
      },
      {
        account_id: bankEur!.id,
        amount: 9900,
        currency: 'EUR',
        base_amount: 9900,
        fx_rate: 1,
        is_debit: false,
        account_currency: null,
        vat_code: 'IE_INPUT_23',
        category: 'software',
      },
    ];

    const result = service.validate(lines, validAccountIds, 'structural');
    expect(result.passed).toBe(false);
    expect(result.overrideable).toBe(false);
    expect(result.message).toContain('do not balance');
  });

  it('fails semantic for invalid VAT code against real seeded chart', async () => {
    const bankEur = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirst();
    const expenseSoftware = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'EXPENSE_SOFTWARE')
      .executeTakeFirst();

    const lines: ResolvedLine[] = [
      {
        account_id: expenseSoftware!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: true,
        account_currency: null,
        vat_code: 'DK_INPUT_25',
        category: 'software',
      },
      {
        account_id: bankEur!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: false,
        account_currency: null,
        vat_code: 'DK_INPUT_25',
        category: 'software',
      },
    ];

    const result = service.validate(
      lines,
      validAccountIds,
      'semantic',
      defaultSemanticContext,
    );
    expect(result.passed).toBe(false);
    expect(result.overrideable).toBe(true);
    expect(result.message).toContain('Invalid VAT code');
  });

  it('semantic failure can be overridden even with real account IDs', async () => {
    const bankEur = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'BANK_EUR')
      .executeTakeFirst();
    const expenseSoftware = await db
      .selectFrom('account')
      .select('id')
      .where('code', '=', 'EXPENSE_SOFTWARE')
      .executeTakeFirst();

    const lines: ResolvedLine[] = [
      {
        account_id: expenseSoftware!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: true,
        account_currency: null,
        vat_code: 'DK_INPUT_25',
        category: 'software',
      },
      {
        account_id: bankEur!.id,
        amount: 10000,
        currency: 'EUR',
        base_amount: 10000,
        fx_rate: 1,
        is_debit: false,
        account_currency: null,
        vat_code: 'DK_INPUT_25',
        category: 'software',
      },
    ];

    const override: Override = {
      ruleType: 'semantic',
      reason: 'Cross-border triangulation — DK supplier, IE recipient',
    };

    const result = service.validate(
      lines,
      validAccountIds,
      'semantic',
      defaultSemanticContext,
      override,
    );
    expect(result.passed).toBe(true);
    expect(result.overrideable).toBe(true);
    expect(result.message).toContain('overridden');
  });
});
