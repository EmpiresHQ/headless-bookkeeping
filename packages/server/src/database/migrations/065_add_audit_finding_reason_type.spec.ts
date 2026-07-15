import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 065: add audit_finding.reason_type', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
  });

  afterEach(() => db.destroy());

  it('adds a reason_type column to audit_finding', async () => {
    const result = await sql<{
      name: string;
    }>`PRAGMA table_info(audit_finding)`.execute(db);
    const colNames = result.rows.map((r) => r.name);
    expect(colNames).toContain('reason_type');
  });

  it('round-trips a row inserted with reason_type = NULL (legacy rows)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('audit_finding')
      .values({
        finding_type: 'needs_triage',
        severity: 'medium',
        description: 'legacy finding with no reason_type',
        referenced_object_type: 'document',
        referenced_object_id: 1,
        status: 'open',
        created_at: now,
        resolved_at: null,
        reason_type: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.reason_type).toBeNull();
  });

  it('round-trips a row inserted with a reason_type value', async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('audit_finding')
      .values({
        finding_type: 'needs_triage',
        severity: 'medium',
        description: 'AI classification failed during enrichment',
        referenced_object_type: 'document',
        referenced_object_id: 2,
        status: 'open',
        created_at: now,
        resolved_at: null,
        reason_type: 'classification_failed',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.reason_type).toBe('classification_failed');
  });
});
