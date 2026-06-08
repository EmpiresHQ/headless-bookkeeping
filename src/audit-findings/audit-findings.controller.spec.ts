import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { AuditFindingsController } from './audit-findings.controller';
import { AuditFindingsService } from './audit-findings.service';

describe('AuditFindingsController (real-DI)', () => {
  let controller: AuditFindingsController;
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
      controllers: [AuditFindingsController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AuditFindingsService,
      ],
    }).compile();

    controller = module.get<AuditFindingsController>(AuditFindingsController);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('POST /api/audit-findings', () => {
    it('creates a finding and returns it', async () => {
      const result = await controller.create({
        finding_type: 'missing_receipt',
        severity: 'medium',
        description: 'Test finding',
      });

      expect(result.finding.id).toBeDefined();
      expect(result.finding.status).toBe('open');
      expect(result.finding.description).toBe('Test finding');
    });
  });

  describe('GET /api/audit-findings', () => {
    it('lists all findings', async () => {
      await controller.create({
        finding_type: 'type_a',
        severity: 'low',
        description: 'Finding A',
      });
      await controller.create({
        finding_type: 'type_b',
        severity: 'high',
        description: 'Finding B',
      });

      const result = await controller.list();
      expect(result.findings).toHaveLength(2);
    });

    it('filters by severity', async () => {
      await controller.create({
        finding_type: 'type_a',
        severity: 'low',
        description: 'Finding A',
      });
      await controller.create({
        finding_type: 'type_b',
        severity: 'high',
        description: 'Finding B',
      });

      const result = await controller.list('high');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('high');
    });
  });

  describe('POST /api/audit-findings/:id/resolve', () => {
    it('resolves a finding', async () => {
      const created = await controller.create({
        finding_type: 'test',
        severity: 'low',
        description: 'To resolve',
      });

      const result = await controller.resolve(created.finding.id);
      expect(result.finding.status).toBe('resolved');
      expect(result.finding.resolved_at).toBeGreaterThan(0);
    });
  });

  describe('POST /api/audit-findings/:id/snooze', () => {
    it('snoozes a finding', async () => {
      const created = await controller.create({
        finding_type: 'test',
        severity: 'low',
        description: 'To snooze',
      });

      const result = await controller.snooze(created.finding.id);
      expect(result.finding.status).toBe('snoozed');
    });
  });
});
