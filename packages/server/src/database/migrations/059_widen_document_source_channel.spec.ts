import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 059: widen document_source.channel', () => {
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

  it('accepts email_sync and email_push channels', async () => {
    const now = Math.floor(Date.now() / 1000);
    const doc = await db
      .insertInto('document')
      .values({
        hash: 'h1',
        filename: 'f.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1,
        storage_path: null,
        status: 'pending',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Test email_sync
    await db
      .insertInto('document_source')
      .values({
        document_id: doc.id,
        channel: 'email_sync' as any,
        source_identifier: 'msg-1',
        received_at: now,
      })
      .execute();

    // Test email_push
    await db
      .insertInto('document_source')
      .values({
        document_id: doc.id,
        channel: 'email_push' as any,
        source_identifier: 'msg-2',
        received_at: now,
      })
      .execute();

    const rows = await db
      .selectFrom('document_source')
      .selectAll()
      .where('document_id', '=', doc.id)
      .execute();

    const channels = rows.map((r) => r.channel).sort();
    expect(channels).toEqual(['email_push', 'email_sync']);
  });
});
