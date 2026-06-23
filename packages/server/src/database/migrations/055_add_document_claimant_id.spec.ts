import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 055: document.claimant_id', () => {
  it('adds nullable claimant_id defaulting to null', async () => {
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
    const doc = await db
      .insertInto('document')
      .values({ hash: 'h1', filename: 'f.pdf', mime_type: 'application/pdf', size_bytes: 100, storage_path: null, status: 'pending', created_at: now })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(doc.claimant_id).toBeNull();
    await db.destroy();
  });
});
