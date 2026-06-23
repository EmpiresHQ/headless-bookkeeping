import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 053: add document.processing_attempts', () => {
  it('adds processing_attempts defaulting to 0', async () => {
    const db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();

    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('document')
      .values({
        hash: 'h1',
        filename: 'f.png',
        mime_type: 'image/png',
        size_bytes: 1,
        storage_path: null,
        status: 'pending',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.processing_attempts).toBe(0);
    await db.destroy();
  });
});
