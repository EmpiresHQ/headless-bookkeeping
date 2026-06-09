// src/audit-log/audit-log.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AuditLogService } from './audit-log.service';

describe('AuditLogService (integration)', () => {
  let db: Kysely<Database>;
  let audit: AuditLogService;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('migrate failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        AuditLogService,
      ],
    }).compile();
    audit = module.get(AuditLogService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('records an entry with a JSON-serialized detail', async () => {
    await audit.record({
      actor: '999',
      action: 'interaction.action_point.commit',
      outcome: 'accepted',
      target_type: 'conversation',
      target_id: 7,
      detail: { actionIntent: 'approve', ref: '42' },
    });
    const row = await db
      .selectFrom('audit_log')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.actor).toBe('999');
    expect(row.action).toBe('interaction.action_point.commit');
    expect(row.outcome).toBe('accepted');
    expect(row.target_id).toBe(7);
    expect(JSON.parse(row.detail ?? '{}')).toEqual({
      actionIntent: 'approve',
      ref: '42',
    });
    expect(row.occurred_at).toBeGreaterThan(0);
  });

  it('defaults optional fields to null', async () => {
    await audit.record({
      actor: 'system',
      action: 'interaction.received',
      outcome: 'allowed',
    });
    const row = await db
      .selectFrom('audit_log')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.target_type).toBeNull();
    expect(row.target_id).toBeNull();
    expect(row.detail).toBeNull();
  });

  it('is append-only — the DB rejects UPDATE and DELETE', async () => {
    await audit.record({ actor: 'system', action: 'x', outcome: 'allowed' });
    await expect(
      db.updateTable('audit_log').set({ outcome: 'tampered' }).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('audit_log').execute()).rejects.toThrow(
      /append-only/,
    );
  });
});
