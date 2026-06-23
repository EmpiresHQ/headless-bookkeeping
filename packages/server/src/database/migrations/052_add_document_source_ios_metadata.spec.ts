import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('migration 052 — document_source ios metadata', () => {
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
    if (error) throw error;
  });

  afterEach(async () => db.destroy());

  it('defaults captured_at and precheck_json to null', async () => {
    const doc = await db
      .insertInto('document')
      .values({
        hash: 'h1',
        filename: 'a.heic',
        mime_type: 'image/heic',
        size_bytes: 10,
        storage_path: null,
        status: 'pending',
        created_at: 1750000000,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto('document_source')
      .values({
        document_id: doc.id,
        channel: 'upload',
        source_identifier: null,
        received_at: 1750000000,
      })
      .execute();

    const row = await db
      .selectFrom('document_source')
      .select(['captured_at', 'precheck_json'])
      .executeTakeFirstOrThrow();
    expect(row.captured_at).toBeNull();
    expect(row.precheck_json).toBeNull();
  });

  it('accepts ios metadata values', async () => {
    const doc = await db
      .insertInto('document')
      .values({
        hash: 'h2',
        filename: 'b.heic',
        mime_type: 'image/heic',
        size_bytes: 10,
        storage_path: null,
        status: 'pending',
        created_at: 1750000000,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto('document_source')
      .values({
        document_id: doc.id,
        channel: 'ios_photo_library',
        source_identifier: 'ABC-123/L0/001',
        received_at: 1750000000,
        captured_at: 1749990000,
        precheck_json: '{"decision":"upload"}',
      })
      .execute();

    const row = await db
      .selectFrom('document_source')
      .select(['captured_at', 'precheck_json'])
      .where('source_identifier', '=', 'ABC-123/L0/001')
      .executeTakeFirstOrThrow();
    expect(row.captured_at).toBe(1749990000);
    expect(row.precheck_json).toBe('{"decision":"upload"}');
  });
});
