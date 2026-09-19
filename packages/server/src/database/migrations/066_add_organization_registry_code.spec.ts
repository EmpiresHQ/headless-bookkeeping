import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

it('adds a nullable registry code without changing existing VAT identity and rolls back cleanly', async () => {
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
  });
  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    expect(
      (await migrator.migrateTo('065_add_audit_finding_reason_type')).error,
    ).toBeUndefined();
    await db
      .updateTable('organization')
      .set({
        name: 'Existing OÜ',
        vat_registration_number: 'EE102983355',
      })
      .where('id', '=', 1)
      .execute();
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(
      await db.selectFrom('organization').selectAll().executeTakeFirstOrThrow(),
    ).toMatchObject({
      registry_code: null,
      name: 'Existing OÜ',
      vat_registration_number: 'EE102983355',
    });
    await db
      .updateTable('organization')
      .set({ registry_code: '17499653' })
      .where('id', '=', 1)
      .execute();
    expect((await migrator.migrateDown()).error).toBeUndefined();
    const row = await db
      .selectFrom('organization')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row).not.toHaveProperty('registry_code');
    expect(row.vat_registration_number).toBe('EE102983355');
  } finally {
    await db.destroy();
  }
});
