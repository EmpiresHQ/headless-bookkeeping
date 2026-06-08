import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { AccountingAgent } from './accounting.agent';
import { ReconciliationAgent } from './reconciliation.agent';
import { AuditAgent } from './audit.agent';
import { SecretaryAgent } from './secretary.agent';
import { DevAgent } from './dev.agent';

describe('Agents (real-DI)', () => {
  let db: Kysely<DBType>;
  let auditFindingsService: AuditFindingsService;
  let auditAgent: AuditAgent;
  let secretaryAgent: SecretaryAgent;

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
        AuditFindingsService,
        AccountingAgent,
        ReconciliationAgent,
        AuditAgent,
        SecretaryAgent,
        DevAgent,
      ],
    }).compile();

    auditFindingsService =
      module.get<AuditFindingsService>(AuditFindingsService);
    auditAgent = module.get<AuditAgent>(AuditAgent);
    secretaryAgent = module.get<SecretaryAgent>(SecretaryAgent);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('AccountingAgent', () => {
    it('is instantiable', () => {
      const agent = new AccountingAgent();
      expect(agent).toBeDefined();
    });
  });

  describe('ReconciliationAgent', () => {
    it('is instantiable', () => {
      const agent = new ReconciliationAgent();
      expect(agent).toBeDefined();
    });
  });

  describe('AuditAgent', () => {
    it('has a sweep method', () => {
      expect(typeof auditAgent.sweep).toBe('function');
    });

    it('sweep() is a no-op — it never fabricates findings on the live cron', async () => {
      const before = await auditFindingsService.list();
      expect(before).toHaveLength(0);

      auditAgent.sweep();

      // The scheduled sweep must write nothing (an hourly INSERT would flood
      // audit_finding). Demo findings come only from a seed/fixture.
      const after = await auditFindingsService.list();
      expect(after).toHaveLength(0);
    });
  });

  describe('SecretaryAgent', () => {
    it('has a notify method', () => {
      expect(typeof secretaryAgent.notify).toBe('function');
    });

    it('notify() logs open findings (no external calls)', async () => {
      // Create an open finding
      await auditFindingsService.create({
        finding_type: 'missing_receipt',
        severity: 'high',
        description: 'Test description',
      });

      // Should not throw — logs to console only
      await expect(secretaryAgent.notify()).resolves.not.toThrow();
    });

    it('notify() handles no open findings gracefully', async () => {
      await expect(secretaryAgent.notify()).resolves.not.toThrow();
    });

    it('branches its nag copy on the typed finding kind', async () => {
      const triage = await auditFindingsService.create({
        finding_type: 'needs_triage',
        severity: 'medium',
        description: 'doc 7',
        referenced_object_type: 'document',
        referenced_object_id: 7,
      });
      const receipt = await auditFindingsService.create({
        finding_type: 'missing_receipt',
        severity: 'medium',
        description: 'expense 3',
        referenced_object_type: 'expense',
        referenced_object_id: 3,
      });
      const hold = await auditFindingsService.create({
        finding_type: 'policy_hold',
        severity: 'medium',
        description: 'draft 9',
      });

      const triageNag = secretaryAgent.nagFor(triage);
      const receiptNag = secretaryAgent.nagFor(receipt);
      const holdNag = secretaryAgent.nagFor(hold);

      // Each kind produces distinct, kind-specific phrasing — the buffer is no
      // longer flattened into one identical nag line.
      expect(triageNag).toContain('triage');
      expect(receiptNag).toContain('receipt');
      expect(holdNag).toContain('Policy hold');
      expect(new Set([triageNag, receiptNag, holdNag]).size).toBe(3);
      // The typed reference is surfaced when present.
      expect(triageNag).toContain('document #7');
    });
  });

  describe('DevAgent', () => {
    it('is disabled by default', () => {
      const agent = new DevAgent();
      expect(agent.isEnabled()).toBe(false);
    });

    it('can be enabled via environment variable', () => {
      const original = process.env.DEV_AGENT_ENABLED;
      try {
        process.env.DEV_AGENT_ENABLED = 'true';
        const agent = new DevAgent();
        expect(agent.isEnabled()).toBe(true);
      } finally {
        process.env.DEV_AGENT_ENABLED = original;
      }
    });
  });
});
