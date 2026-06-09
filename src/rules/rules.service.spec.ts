import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { RulesService } from './rules.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { OrgContext, SupplierFacts } from '../plugins/country-plugin.interface';
import { ResolvedLine, Override, SemanticValidationContext } from './types';
import { isUnresolvedSemanticFailure, mustReject } from './rules.guards';

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
  category: 'software',
};

// Mock the canonical lock check so the hard tier can be exercised in isolation
// (PeriodLockService itself is covered by its own integration spec).
const mockPeriodLock = {
  findLockedPeriod: jest.fn(),
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
        { provide: PeriodLockService, useValue: mockPeriodLock },
      ],
    }).compile();

    service = module.get<RulesService>(RulesService);
  });

  describe('structural tier', () => {
    it('passes a balanced voucher', async () => {
      const result = await service.validate('structural', {
        resolvedLines: [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validAccountIds: validIds,
      });
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('structural');
      expect(result.overrideable).toBe(false);
    });

    it('fails an unbalanced voucher → passed:false, overrideable:false', async () => {
      const result = await service.validate('structural', {
        resolvedLines: [
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
        validAccountIds: validIds,
      });
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(false);
      expect(result.message).toContain('do not balance');
      expect(mustReject(result)).toBe(true);
      expect(isUnresolvedSemanticFailure(result)).toBe(false);
    });

    it('fails a non-existent account → passed:false, overrideable:false', async () => {
      const result = await service.validate('structural', {
        resolvedLines: [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 42, is_debit: false }),
        ],
        validAccountIds: validIds,
      });
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(false);
      expect(result.message).toContain('Account does not exist');
    });

    it('structural failure + Override attempt → still passed:false', async () => {
      const override: Override = {
        ruleType: 'structural',
        reason: 'I want to force this through',
      };
      const result = await service.validate('structural', {
        resolvedLines: [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 42, is_debit: false }),
        ],
        validAccountIds: validIds,
        override,
      });
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(false);
    });
  });

  describe('hard process tier', () => {
    afterEach(() => mockPeriodLock.findLockedPeriod.mockReset());

    it('passes when the tax-point date is not in a locked period', async () => {
      mockPeriodLock.findLockedPeriod.mockResolvedValue(undefined);

      const result = await service.validateHardProcess('2026-05-15');

      expect(mockPeriodLock.findLockedPeriod).toHaveBeenCalledWith(
        '2026-05-15',
      );
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('hard_process');
      expect(result.overrideable).toBe(false);
    });

    it('fails (non-overridable) when the tax-point date is in a locked period', async () => {
      mockPeriodLock.findLockedPeriod.mockResolvedValue({
        id: 1,
        name: 'Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
      });

      const result = await service.validateHardProcess('2026-02-15');

      expect(result.passed).toBe(false);
      expect(result.ruleType).toBe('hard_process');
      expect(result.overrideable).toBe(false);
      expect(result.message).toContain('locked period Q1');
      expect(mustReject(result)).toBe(true);
    });

    it('is reachable through the unified validate() entry (same async shape)', async () => {
      mockPeriodLock.findLockedPeriod.mockResolvedValue(undefined);

      const result = await service.validate('hard_process', {
        taxPointDate: '2026-05-15',
      });

      expect(mockPeriodLock.findLockedPeriod).toHaveBeenCalledWith(
        '2026-05-15',
      );
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('hard_process');
      expect(result.overrideable).toBe(false);
    });
  });

  describe('semantic tier', () => {
    it('passes with valid VAT code and known category', async () => {
      const result = await service.validate('semantic', {
        resolvedLines: [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validAccountIds: validIds,
        context: defaultSemanticContext,
      });
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('semantic');
      expect(result.overrideable).toBe(true);
    });

    it('fails with invalid VAT code → passed:false, overrideable:true', async () => {
      const result = await service.validate('semantic', {
        resolvedLines: [
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
        validAccountIds: validIds,
        context: defaultSemanticContext,
      });
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('Invalid VAT code');
      expect(isUnresolvedSemanticFailure(result)).toBe(true);
      expect(mustReject(result)).toBe(false);
    });

    it('fails with invalid VAT code on unknown category → passed:false, overrideable:true', async () => {
      // NullCountryPlugin maps unknown categories to EXPENSE_OTHER,
      // so category mapping never fails. The real semantic gate is VAT code validity.
      const result = await service.validate('semantic', {
        resolvedLines: [
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
        validAccountIds: validIds,
        context: defaultSemanticContext,
      });
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('Invalid VAT code');
    });

    it('semantic failure + Override reason → passed:true', async () => {
      const override: Override = {
        ruleType: 'semantic',
        reason: 'Supplier confirmed this is a valid special VAT treatment',
      };
      const result = await service.validate('semantic', {
        resolvedLines: [
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
        validAccountIds: validIds,
        context: defaultSemanticContext,
        override,
      });
      expect(result.passed).toBe(true);
      expect(result.ruleType).toBe('semantic');
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('overridden');
      expect(result.message).toContain(override.reason);
    });

    it('fails when context is missing', async () => {
      const result = await service.validate('semantic', {
        resolvedLines: [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validAccountIds: validIds,
      });
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('requires context');
    });

    it('override on wrong ruleType is ignored', async () => {
      const override: Override = {
        ruleType: 'hard_process',
        reason: 'Wrong tier override',
      };
      const result = await service.validate('semantic', {
        resolvedLines: [
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
        validAccountIds: validIds,
        context: defaultSemanticContext,
        override,
      });
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
    });
  });

  describe('semantic tier — cross-border treatment (ADR-0002)', () => {
    // A foreign supplier whose VAT territory the NullCountryPlugin does not
    // cover resolves to `unresolvable`. The kernel must never silently reclaim
    // a foreign document_vat_marking, so this surfaces as an overrideable
    // semantic failure → held for Approval by Policy (book gross as cost).
    const foreignSupplier: SupplierFacts = {
      country: 'US',
      goodsVsServices: 'services',
      classificationMemory: [],
    };
    const foreignContext: SemanticValidationContext = {
      countryCode: 'null',
      supplierFacts: foreignSupplier,
      orgContext: defaultOrg,
      category: 'software',
    };

    it('unresolvable foreign-supplier treatment → overrideable failure (held for Approval)', async () => {
      const result = await service.validate('semantic', {
        resolvedLines: [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validAccountIds: validIds,
        context: foreignContext,
      });
      expect(result.passed).toBe(false);
      expect(result.overrideable).toBe(true);
      expect(result.message).toContain('cross-border');
      expect(isUnresolvedSemanticFailure(result)).toBe(true);
      expect(mustReject(result)).toBe(false);
    });

    it('resolvable domestic (same-country) treatment → passes', async () => {
      const result = await service.validate('semantic', {
        resolvedLines: [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validAccountIds: validIds,
        context: defaultSemanticContext,
      });
      expect(result.passed).toBe(true);
    });

    it('unresolvable cross-border can be relaxed by a logged Override', async () => {
      const override: Override = {
        ruleType: 'semantic',
        reason:
          'US supplier confirmed reverse-charge applies; book accordingly',
      };
      const result = await service.validate('semantic', {
        resolvedLines: [
          resolvedLine({ account_id: 1, is_debit: true }),
          resolvedLine({ account_id: 2, is_debit: false }),
        ],
        validAccountIds: validIds,
        context: foreignContext,
        override,
      });
      expect(result.passed).toBe(true);
      expect(result.message).toContain('overridden');
    });
  });

  describe('validateAll — unified single-call tier interface', () => {
    beforeEach(() =>
      mockPeriodLock.findLockedPeriod.mockResolvedValue(undefined),
    );
    afterEach(() => mockPeriodLock.findLockedPeriod.mockReset());

    it('runs all three tiers and returns them in declaration order', async () => {
      const lines = [
        resolvedLine({ account_id: 1, is_debit: true }),
        resolvedLine({ account_id: 2, is_debit: false }),
      ];
      const { structural, hardProcess, semantic } = await service.validateAll({
        resolvedLines: lines,
        validAccountIds: validIds,
        taxPointDate: '2026-05-15',
        context: defaultSemanticContext,
        semanticLines: lines,
      });
      expect(structural.ruleType).toBe('structural');
      expect(structural.passed).toBe(true);
      expect(hardProcess.ruleType).toBe('hard_process');
      expect(hardProcess.passed).toBe(true);
      expect(semantic.ruleType).toBe('semantic');
      expect(semantic.passed).toBe(true);
    });

    it('skips the semantic tier (passing) when no lines carry a real VAT code', async () => {
      const lines = [
        resolvedLine({ account_id: 1, is_debit: true }),
        resolvedLine({ account_id: 2, is_debit: false }),
      ];
      const { semantic } = await service.validateAll({
        resolvedLines: lines,
        validAccountIds: validIds,
        taxPointDate: '2026-05-15',
        context: defaultSemanticContext,
        semanticLines: [],
      });
      expect(semantic.passed).toBe(true);
      expect(semantic.message).toContain('skipped');
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
        { provide: PeriodLockService, useValue: mockPeriodLock },
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

    const structural = await service.validate('structural', {
      resolvedLines: lines,
      validAccountIds,
    });
    expect(structural.passed).toBe(true);
    expect(structural.overrideable).toBe(false);

    const semantic = await service.validate('semantic', {
      resolvedLines: lines,
      validAccountIds,
      context: defaultSemanticContext,
    });
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

    const result = await service.validate('structural', {
      resolvedLines: lines,
      validAccountIds,
    });
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

    const result = await service.validate('semantic', {
      resolvedLines: lines,
      validAccountIds,
      context: defaultSemanticContext,
    });
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

    const result = await service.validate('semantic', {
      resolvedLines: lines,
      validAccountIds,
      context: defaultSemanticContext,
      override,
    });
    expect(result.passed).toBe(true);
    expect(result.overrideable).toBe(true);
    expect(result.message).toContain('overridden');
  });
});
