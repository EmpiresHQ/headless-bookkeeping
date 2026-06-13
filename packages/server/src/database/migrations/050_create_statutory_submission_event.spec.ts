import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('050_create_statutory_submission_event (migration)', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error instanceof Error ? error : new Error('Migration failed');

    await db
      .insertInto('reporting_period')
      .values({
        name: '2026-Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'locked',
        filed_at: 1000,
        vat_report_snapshot_id: null,
        created_at: 1000,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  const insertEvent = () =>
    db
      .insertInto('statutory_submission_event')
      .values({
        reporting_period_id: 1,
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: 42,
        event_kind: 'prepared',
        external_ref: null,
        occurred_at: 1234,
        actor: 'system',
        note: null,
      })
      .execute();

  it('inserts an event row', async () => {
    await insertEvent();
    const row = await db
      .selectFrom('statutory_submission_event')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.reporting_period_id).toBe(1);
    expect(row.report_kind).toBe('EE_KMD');
    expect(row.source_snapshot_type).toBe('vat_report');
    expect(row.source_snapshot_id).toBe(42);
    expect(row.event_kind).toBe('prepared');
    expect(row.external_ref).toBeNull();
    expect(row.actor).toBe('system');
  });

  it('is append-only — the DB rejects UPDATE', async () => {
    await insertEvent();
    await expect(
      db
        .updateTable('statutory_submission_event')
        .set({ event_kind: 'tampered' })
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('is append-only — the DB rejects DELETE', async () => {
    await insertEvent();
    await expect(
      db.deleteFrom('statutory_submission_event').execute(),
    ).rejects.toThrow(/append-only/);
  });
});
