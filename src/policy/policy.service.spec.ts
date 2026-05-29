import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { PolicyService } from './policy.service';
import { DraftVoucher } from '../ledger/voucher/types';
import { RuleResult } from '../rules/types';

const draftVoucher = (
  over: Partial<DraftVoucher> = {},
  lineOverrides: Array<Partial<DraftVoucher['lines'][number]>> = [],
): DraftVoucher => ({
  voucher_number: 'TEST-001',
  tax_point_date: '2024-01-15',
  lines: [
    {
      account_code: 'EXPENSE_SOFTWARE',
      amount: 50000,
      currency: 'EUR',
      base_amount: 50000,
      fx_rate: 1,
      vat_code: 'IE_INPUT_23',
      is_debit: true,
    },
    {
      account_code: 'BANK_EUR',
      amount: 50000,
      currency: 'EUR',
      base_amount: 50000,
      fx_rate: 1,
      vat_code: null,
      is_debit: false,
    },
    ...lineOverrides,
  ],
  ...over,
});

const passedResult = (ruleType: string, overrideable: boolean): RuleResult => ({
  passed: true,
  ruleType,
  message: 'passed',
  overrideable,
});

const failedResult = (
  ruleType: string,
  overrideable: boolean,
  message = 'failed',
): RuleResult => ({
  passed: false,
  ruleType,
  message,
  overrideable,
});

describe('PolicyService (unit)', () => {
  let service: PolicyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PolicyService,
          useValue: {
            decide: jest.fn(),
            getConfig: jest.fn(),
            logOverride: jest.fn(),
            getOverrides: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PolicyService>(PolicyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('PolicyService (real-DI)', () => {
  let service: PolicyService;
  let db: Kysely<DBType>;

  beforeEach(async () => {
    const rawDb = new Database(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<DBType>({
      dialect: new SqliteDialect({
        database: rawDb,
      }),
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
        PolicyService,
      ],
    }).compile();

    service = module.get<PolicyService>(PolicyService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('decide()', () => {
    it('auto-posts when all rules pass and amount is within ceiling', () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];

      const decision = service.decide(voucher, results);
      expect(decision.action).toBe('auto-post');
      expect(decision.reason).toContain('All rules passed');
    });

    it('holds for approval when a structural rule fails (defensive)', () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        failedResult('structural', false, 'Debits do not balance'),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];

      const decision = service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Structural/hard rule failure');
      expect(decision.reason).toContain('Debits do not balance');
    });

    it('holds for approval when a hard process rule fails (defensive)', () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        failedResult('hard_process', false, 'Period is locked'),
        passedResult('semantic', true),
      ];

      const decision = service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Period is locked');
    });

    it('holds for approval when a semantic rule fails without override', () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        failedResult('semantic', true, 'Invalid VAT code'),
      ];

      const decision = service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Semantic rule failure');
      expect(decision.reason).toContain('Invalid VAT code');
    });

    it('auto-posts when semantic rule was overridden (passed:true)', () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        {
          passed: true,
          ruleType: 'semantic',
          message: 'Semantic validation overridden: special case',
          overrideable: true,
        },
      ];

      const decision = service.decide(voucher, results);
      expect(decision.action).toBe('auto-post');
    });

    it('holds for approval when amount exceeds ceiling', () => {
      const voucher: DraftVoucher = {
        voucher_number: 'TEST-001',
        tax_point_date: '2024-01-15',
        lines: [
          {
            account_code: 'EXPENSE_SOFTWARE',
            amount: 200000,
            currency: 'EUR',
            base_amount: 200000,
            fx_rate: 1,
            vat_code: 'IE_INPUT_23',
            is_debit: true,
          },
          {
            account_code: 'BANK_EUR',
            amount: 200000,
            currency: 'EUR',
            base_amount: 200000,
            fx_rate: 1,
            vat_code: null,
            is_debit: false,
          },
        ],
      };
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];

      const decision = service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('exceeds ceiling');
      expect(decision.reason).toContain('200000');
    });

    it('auto-posts when amount is exactly at ceiling', () => {
      const voucher: DraftVoucher = {
        voucher_number: 'TEST-001',
        tax_point_date: '2024-01-15',
        lines: [
          {
            account_code: 'EXPENSE_SOFTWARE',
            amount: 100000,
            currency: 'EUR',
            base_amount: 100000,
            fx_rate: 1,
            vat_code: 'IE_INPUT_23',
            is_debit: true,
          },
          {
            account_code: 'BANK_EUR',
            amount: 100000,
            currency: 'EUR',
            base_amount: 100000,
            fx_rate: 1,
            vat_code: null,
            is_debit: false,
          },
        ],
      };
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];

      const decision = service.decide(voucher, results);
      expect(decision.action).toBe('auto-post');
    });

    it('holds for approval when multiple conditions are met (reports first)', () => {
      const voucher = draftVoucher({}, [
        {
          account_code: 'EXPENSE_SOFTWARE',
          amount: 200000,
          currency: 'EUR',
          base_amount: 200000,
          fx_rate: 1,
          vat_code: 'IE_INPUT_23',
          is_debit: true,
        },
        {
          account_code: 'BANK_EUR',
          amount: 200000,
          currency: 'EUR',
          base_amount: 200000,
          fx_rate: 1,
          vat_code: null,
          is_debit: false,
        },
      ]);
      const results: RuleResult[] = [
        failedResult('structural', false, 'Unbalanced'),
        failedResult('semantic', true, 'Invalid VAT'),
      ];

      const decision = service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      // Structural failure is checked first
      expect(decision.reason).toContain('Structural/hard rule failure');
    });
  });

  describe('getConfig()', () => {
    it('returns hardcoded v1 defaults', () => {
      const config = service.getConfig();
      expect(config.auto_post_amount_ceiling).toBe(100000);
      expect(config.auto_post_min_confidence).toBe(0.8);
      expect(config.unknown_supplier_requires_approval).toBe(true);
      expect(config.always_approve_operations).toEqual([
        'correction',
        'reversal',
        'vat_lock',
      ]);
    });
  });

  describe('logOverride() + getOverrides()', () => {
    it('logs an override and retrieves it', async () => {
      const logged = await service.logOverride({
        business_object_type: 'expense',
        business_object_id: 42,
        rule_type: 'semantic',
        rule_name: 'vat_code_validity',
        reason: 'Supplier confirmed special VAT treatment',
        created_by: 'test-user',
      });

      expect(logged.id).toBeDefined();
      expect(logged.business_object_type).toBe('expense');
      expect(logged.business_object_id).toBe(42);
      expect(logged.rule_type).toBe('semantic');
      expect(logged.rule_name).toBe('vat_code_validity');
      expect(logged.reason).toBe('Supplier confirmed special VAT treatment');
      expect(logged.created_by).toBe('test-user');
      expect(logged.created_at).toBeGreaterThan(0);

      const all = await service.getOverrides();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(logged.id);
    });

    it('returns overrides in descending created_at order', async () => {
      await service.logOverride({
        business_object_type: 'expense',
        business_object_id: 1,
        rule_type: 'semantic',
        rule_name: 'vat_code_validity',
        reason: 'First override',
        created_by: 'user-a',
      });

      // Delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 100));

      await service.logOverride({
        business_object_type: 'sales_invoice',
        business_object_id: 2,
        rule_type: 'semantic',
        rule_name: 'category_mapping',
        reason: 'Second override',
        created_by: 'user-b',
      });

      const all = await service.getOverrides();
      expect(all).toHaveLength(2);
      expect(all[0].reason).toBe('Second override');
      expect(all[1].reason).toBe('First override');
      expect(all[0].created_at).toBeGreaterThanOrEqual(all[1].created_at);
    });

    it('returns empty array when no overrides exist', async () => {
      const all = await service.getOverrides();
      expect(all).toEqual([]);
    });
  });
});
