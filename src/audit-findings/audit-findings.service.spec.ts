import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import Database from 'better-sqlite3';
import { Database as DBType } from '../database/types';
import { migrations } from '../database/migrations';
import { AuditFindingsService } from './audit-findings.service';
import { AuditFinding, CreateAuditFindingDto } from './types';

const createFindingDto = (
  over: Partial<CreateAuditFindingDto> = {},
): CreateAuditFindingDto => ({
  finding_type: 'missing_receipt',
  severity: 'medium',
  description: 'Expense without receipt',
  referenced_object_type: 'expense',
  referenced_object_id: 1,
  ...over,
});

describe('AuditFindingsService (real-DI)', () => {
  let service: AuditFindingsService;
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
        AuditFindingsService,
      ],
    }).compile();

    service = module.get<AuditFindingsService>(AuditFindingsService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('create()', () => {
    it('creates an open finding with all fields', async () => {
      const dto = createFindingDto();
      const finding: AuditFinding = await service.create(dto);

      expect(finding.id).toBeDefined();
      expect(finding.finding_type).toBe('missing_receipt');
      expect(finding.severity).toBe('medium');
      expect(finding.description).toBe('Expense without receipt');
      expect(finding.referenced_object_type).toBe('expense');
      expect(finding.referenced_object_id).toBe(1);
      expect(finding.status).toBe('open');
      expect(finding.created_at).toBeGreaterThan(0);
      expect(finding.resolved_at).toBeNull();
    });

    it('creates a finding without optional references', async () => {
      const dto: CreateAuditFindingDto = {
        finding_type: 'deadline_approaching',
        severity: 'high',
        description: 'VAT filing deadline in 3 days',
      };
      const finding = await service.create(dto);

      expect(finding.referenced_object_type).toBeNull();
      expect(finding.referenced_object_id).toBeNull();
    });

    it('throws on invalid severity', async () => {
      // @ts-expect-error testing invalid severity
      const dto = createFindingDto({ severity: 'extreme' });
      await expect(service.create(dto)).rejects.toThrow('Invalid severity');
    });
  });

  describe('list()', () => {
    it('returns all findings when no filter', async () => {
      await service.create(createFindingDto({ severity: 'low' }));
      await service.create(createFindingDto({ severity: 'high' }));

      const findings = await service.list();
      expect(findings).toHaveLength(2);
    });

    it('filters by severity', async () => {
      await service.create(createFindingDto({ severity: 'low' }));
      await service.create(createFindingDto({ severity: 'high' }));
      await service.create(createFindingDto({ severity: 'high' }));

      const findings = await service.list('high');
      expect(findings).toHaveLength(2);
      findings.forEach((f) => expect(f.severity).toBe('high'));
    });

    it('returns empty array when no findings match filter', async () => {
      await service.create(createFindingDto({ severity: 'low' }));
      const findings = await service.list('critical');
      expect(findings).toEqual([]);
    });

    it('returns findings in descending created_at order', async () => {
      await service.create(createFindingDto({ description: 'first' }));
      await new Promise((r) => setTimeout(r, 100));
      await service.create(createFindingDto({ description: 'second' }));

      const findings = await service.list();
      expect(findings[0].description).toBe('second');
      expect(findings[1].description).toBe('first');
    });

    it('throws on invalid severity filter', async () => {
      // @ts-expect-error testing invalid severity filter
      await expect(service.list('invalid')).rejects.toThrow('Invalid severity');
    });
  });

  describe('resolve()', () => {
    it('marks a finding as resolved with resolved_at timestamp', async () => {
      const created = await service.create(createFindingDto());
      const resolved = await service.resolve(created.id);

      expect(resolved.status).toBe('resolved');
      expect(resolved.resolved_at).toBeGreaterThan(0);
    });

    it('throws when finding not found', async () => {
      await expect(service.resolve(9999)).rejects.toThrow('not found');
    });
  });

  describe('snooze()', () => {
    it('marks a finding as snoozed', async () => {
      const created = await service.create(createFindingDto());
      const snoozed = await service.snooze(created.id);

      expect(snoozed.status).toBe('snoozed');
    });

    it('throws when finding not found', async () => {
      await expect(service.snooze(9999)).rejects.toThrow('not found');
    });
  });

  describe('getOpenFindings()', () => {
    it('returns only open findings', async () => {
      const open1 = await service.create(
        createFindingDto({ description: 'open1' }),
      );
      const open2 = await service.create(
        createFindingDto({ description: 'open2' }),
      );
      await service.resolve(open1.id);
      await service.snooze(open2.id);
      await service.create(createFindingDto({ description: 'open3' }));

      const openFindings = await service.getOpenFindings();
      expect(openFindings).toHaveLength(1);
      expect(openFindings[0].description).toBe('open3');
    });

    it('returns empty array when no open findings', async () => {
      const created = await service.create(createFindingDto());
      await service.resolve(created.id);

      const openFindings = await service.getOpenFindings();
      expect(openFindings).toEqual([]);
    });
  });
});
