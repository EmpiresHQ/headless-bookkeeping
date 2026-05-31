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

    it('sweep() creates a sample AuditFinding', async () => {
      const before = await auditFindingsService.list();
      expect(before).toHaveLength(0);

      await auditAgent.sweep();

      const after = await auditFindingsService.list();
      expect(after).toHaveLength(1);
      expect(after[0].finding_type).toBe('missing_receipt');
      expect(after[0].severity).toBe('medium');
      expect(after[0].status).toBe('open');
    });
  });

  describe('SecretaryAgent', () => {
    it('has a notify method', () => {
      expect(typeof secretaryAgent.notify).toBe('function');
    });

    it('notify() logs open findings (no external calls)', async () => {
      // Create an open finding
      await auditFindingsService.create({
        finding_type: 'test_finding',
        severity: 'high',
        description: 'Test description',
      });

      // Should not throw — logs to console only
      await expect(secretaryAgent.notify()).resolves.not.toThrow();
    });

    it('notify() handles no open findings gracefully', async () => {
      await expect(secretaryAgent.notify()).resolves.not.toThrow();
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
