import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { PolicyService } from './policy.service';
import { PolicyContext } from './types';
import { DraftVoucher } from '../ledger/voucher/types';
import { RuleResult } from '../rules/types';

const draftVoucher = (
  over: Partial<DraftVoucher> = {},
  lineOverrides: Array<DraftVoucher['lines'][number]> = [],
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

const passedResult = (
  ruleType: 'structural' | 'hard_process' | 'semantic',
  overrideable: boolean,
): RuleResult => ({
  passed: true,
  ruleType,
  message: 'passed',
  overrideable,
});

const failedResult = (
  ruleType: 'structural' | 'hard_process' | 'semantic',
  overrideable: boolean,
  message = 'failed',
): RuleResult => ({
  passed: false,
  ruleType,
  message,
  overrideable,
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
    // These tests each target ONE gate (ceiling / confidence / supplier /
    // semantic). The master switch defaults to false (hold-for-approval for
    // everything), so it must be explicitly enabled here to keep exercising
    // the gate each test actually names. The switch itself is covered by its
    // own describe block below.
    beforeEach(async () => {
      await service.updateConfig({ auto_post_enabled: true });
    });

    it('auto-posts when all rules pass and amount is within ceiling', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('auto-post');
      expect(decision.reason).toContain('All rules passed');
    });

    it('holds for approval when a structural rule fails (defensive)', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        failedResult('structural', false, 'Debits do not balance'),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Structural/hard rule failure');
      expect(decision.reason).toContain('Debits do not balance');
    });

    it('holds for approval when a hard process rule fails (defensive)', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        failedResult('hard_process', false, 'Period is locked'),
        passedResult('semantic', true),
      ];

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Period is locked');
    });

    it('holds for approval when a semantic rule fails without override', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        failedResult('semantic', true, 'Invalid VAT code'),
      ];

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Semantic rule failure');
      expect(decision.reason).toContain('Invalid VAT code');
    });

    it('auto-posts when semantic rule was overridden (passed:true)', async () => {
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

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('auto-post');
    });

    it('holds for approval when amount exceeds ceiling', async () => {
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

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('exceeds ceiling');
      expect(decision.reason).toContain('200000');
    });

    it('auto-posts when amount is exactly at ceiling', async () => {
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

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('auto-post');
    });

    it('holds for approval when multiple conditions are met (reports first)', async () => {
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

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      // Structural failure is checked first
      expect(decision.reason).toContain('Structural/hard rule failure');
    });

    it('auto-posts when confidence is at threshold (0.8)', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      const ctx: PolicyContext = { confidence: 0.8 };

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('auto-post');
    });

    it('auto-posts when confidence is above threshold (0.95)', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      const ctx: PolicyContext = { confidence: 0.95 };

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('auto-post');
    });

    it('holds for approval when confidence is below threshold (0.79)', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      const ctx: PolicyContext = { confidence: 0.79 };

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain(
        'AI confidence 0.79 below threshold 0.8',
      );
    });

    it('holds for approval when confidence is very low (0.1)', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      const ctx: PolicyContext = { confidence: 0.1 };

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain(
        'AI confidence 0.1 below threshold 0.8',
      );
    });

    it('skips confidence check when confidence is undefined (backward compatible)', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      // Empty context — no confidence field
      const ctx: PolicyContext = {};

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('auto-post');
    });

    it('skips confidence check when context is not provided (backward compatible)', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];

      // No context argument at all
      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('auto-post');
    });

    it('holds for approval when supplier is unknown', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      const ctx: PolicyContext = { supplierKnown: false };

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Unknown supplier requires approval');
    });

    it('auto-posts when supplier is known', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      const ctx: PolicyContext = { supplierKnown: true };

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('auto-post');
    });

    it('skips supplier check when supplierKnown is undefined', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      const ctx: PolicyContext = {};

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('auto-post');
    });

    it('holds for approval when both confidence is low AND supplier is unknown', async () => {
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        passedResult('semantic', true),
      ];
      const ctx: PolicyContext = { confidence: 0.5, supplierKnown: false };

      const decision = await service.decide(voucher, results, ctx);
      expect(decision.action).toBe('hold-for-approval');
      // Confidence is checked before supplier
      expect(decision.reason).toContain(
        'AI confidence 0.5 below threshold 0.8',
      );
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

  describe('getConfig() — table-backed (ADR-0005)', () => {
    it('reads the seeded defaults from the policy_config table', async () => {
      const config = await service.getConfig();
      expect(config).toEqual({
        auto_post_amount_ceiling: 100000,
        auto_post_min_confidence: 0.8,
        unknown_supplier_requires_approval: true,
        always_approve_operations: ['correction', 'reversal', 'vat_lock'],
        auto_post_enabled: false,
      });
    });

    it('defaults auto_post_enabled to false when no row is seeded (kill switch)', async () => {
      const config = await service.getConfig();
      expect(config.auto_post_enabled).toBe(false);
    });

    it('reflects an updated ceiling row in getConfig()', async () => {
      await db
        .updateTable('policy_config')
        .set({ value: '50000', updated_at: Math.floor(Date.now() / 1000) })
        .where('key', '=', 'auto_post_amount_ceiling')
        .execute();

      const config = await service.getConfig();
      expect(config.auto_post_amount_ceiling).toBe(50000);
    });

    it('falls back to the in-code default for an absent row', async () => {
      // Remove the seeded ceiling row entirely.
      await db
        .deleteFrom('policy_config')
        .where('key', '=', 'auto_post_amount_ceiling')
        .execute();

      const config = await service.getConfig();
      // DEFAULT_CONFIG fallback.
      expect(config.auto_post_amount_ceiling).toBe(100000);
      // Other keys still come from their (present) rows.
      expect(config.auto_post_min_confidence).toBe(0.8);
    });
  });

  describe('updateConfig() — operator edits over the table (A3)', () => {
    it('updates only the provided keys and leaves the rest intact', async () => {
      const updated = await service.updateConfig({
        auto_post_amount_ceiling: 250000,
      });
      expect(updated.auto_post_amount_ceiling).toBe(250000);
      // Untouched keys keep their seeded values.
      expect(updated.auto_post_min_confidence).toBe(0.8);
      expect(updated.unknown_supplier_requires_approval).toBe(true);

      // Persisted: a fresh read reflects the change.
      expect((await service.getConfig()).auto_post_amount_ceiling).toBe(250000);
    });

    it('round-trips boolean and string-array values', async () => {
      const updated = await service.updateConfig({
        unknown_supplier_requires_approval: false,
        always_approve_operations: ['reversal'],
      });
      expect(updated.unknown_supplier_requires_approval).toBe(false);
      expect(updated.always_approve_operations).toEqual(['reversal']);
    });

    it('round-trips auto_post_enabled: true (kill switch)', async () => {
      const updated = await service.updateConfig({ auto_post_enabled: true });
      expect(updated.auto_post_enabled).toBe(true);
      expect((await service.getConfig()).auto_post_enabled).toBe(true);
    });
  });

  describe('decide() — auto_post_enabled master switch', () => {
    const passingResults: RuleResult[] = [
      passedResult('structural', false),
      passedResult('hard_process', false),
      passedResult('semantic', true),
    ];
    // Draft passes every other gate: amount under ceiling, confidence above
    // threshold, supplier known. Only the master switch is in play.
    const passingContext: PolicyContext = {
      confidence: 0.95,
      supplierKnown: true,
    };

    it('holds for approval when auto_post_enabled is false, even though every other gate passes', async () => {
      // Default config: auto_post_enabled is false (no row seeded).
      const voucher = draftVoucher();

      const decision = await service.decide(
        voucher,
        passingResults,
        passingContext,
      );
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Auto-posting is disabled');
    });

    it('auto-posts when auto_post_enabled is true and every other gate passes', async () => {
      await service.updateConfig({ auto_post_enabled: true });
      const voucher = draftVoucher();

      const decision = await service.decide(
        voucher,
        passingResults,
        passingContext,
      );
      expect(decision.action).toBe('auto-post');
    });

    it('holds with the semantic-failure reason (not the kill-switch reason) when auto-post is disabled and a semantic rule fails without override', async () => {
      // Default config: auto_post_enabled is false (no row seeded). The
      // semantic-failure check must run BEFORE the kill switch, so the
      // approver still sees the specific semantic reason, not the generic
      // "Auto-posting is disabled" message.
      const voucher = draftVoucher();
      const results: RuleResult[] = [
        passedResult('structural', false),
        passedResult('hard_process', false),
        failedResult('semantic', true, 'Invalid VAT code'),
      ];

      const decision = await service.decide(voucher, results);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('Semantic rule failure');
      expect(decision.reason).toContain('Invalid VAT code');
      expect(decision.reason).not.toContain('Auto-posting is disabled');
    });
  });

  describe('decide() — reads config from the table', () => {
    const passingResults: RuleResult[] = [
      passedResult('structural', false),
      passedResult('hard_process', false),
      passedResult('semantic', true),
    ];

    beforeEach(async () => {
      // These tests target the ceiling/confidence gates specifically; the
      // master switch must be enabled or the kill switch would short-circuit
      // before those gates are ever reached.
      await service.updateConfig({ auto_post_enabled: true });
    });

    it('holds a previously auto-posting voucher once the ceiling row is lowered', async () => {
      // Voucher of 20000 base-currency minor units: auto-posts under the
      // seeded 100000 ceiling.
      const voucher = draftVoucher({}, [
        {
          account_code: 'EXPENSE_SOFTWARE',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: 'IE_INPUT_23',
          is_debit: true,
        },
        {
          account_code: 'BANK_EUR',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: null,
          is_debit: false,
        },
      ]);

      const before = await service.decide(voucher, passingResults);
      expect(before.action).toBe('auto-post');

      // Lower the ceiling in the table to 50000 → the same voucher now holds.
      await db
        .updateTable('policy_config')
        .set({ value: '50000', updated_at: Math.floor(Date.now() / 1000) })
        .where('key', '=', 'auto_post_amount_ceiling')
        .execute();

      const after = await service.decide(voucher, passingResults);
      expect(after.action).toBe('hold-for-approval');
      expect(after.reason).toContain('exceeds ceiling 50000');
    });

    it('holds at confidence 0.85 once the threshold row is raised to 0.9', async () => {
      const voucher = draftVoucher();
      const ctx: PolicyContext = { confidence: 0.85 };

      const before = await service.decide(voucher, passingResults, ctx);
      expect(before.action).toBe('auto-post');

      await db
        .updateTable('policy_config')
        .set({ value: '0.9', updated_at: Math.floor(Date.now() / 1000) })
        .where('key', '=', 'auto_post_min_confidence')
        .execute();

      const after = await service.decide(voucher, passingResults, ctx);
      expect(after.action).toBe('hold-for-approval');
      expect(after.reason).toContain('below threshold 0.9');
    });

    it('falls back to the default ceiling for decide() when the row is absent', async () => {
      await db
        .deleteFrom('policy_config')
        .where('key', '=', 'auto_post_amount_ceiling')
        .execute();

      // 200000 still exceeds the in-code fallback ceiling of 100000.
      const voucher = draftVoucher({}, [
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
      ]);

      const decision = await service.decide(voucher, passingResults);
      expect(decision.action).toBe('hold-for-approval');
      expect(decision.reason).toContain('exceeds ceiling 100000');
    });
  });
});
