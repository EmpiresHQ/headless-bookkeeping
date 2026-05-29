import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('policy_config')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('key', 'text', (col) => col.notNull().unique())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();

  const now = Math.floor(Date.now() / 1000);
  await db
    .insertInto('policy_config')
    .values([
      { key: 'auto_post_amount_ceiling', value: '100000', updated_at: now },
      { key: 'auto_post_min_confidence', value: '0.8', updated_at: now },
      {
        key: 'unknown_supplier_requires_approval',
        value: 'true',
        updated_at: now,
      },
      {
        key: 'always_approve_operations',
        value: JSON.stringify(['correction', 'reversal', 'vat_lock']),
        updated_at: now,
      },
    ])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('policy_config').ifExists().execute();
}
