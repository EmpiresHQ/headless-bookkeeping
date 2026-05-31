import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('voucher_sequence')
    .ifNotExists()
    .addColumn('year', 'text', (col) => col.primaryKey())
    .addColumn('last_number', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('voucher_sequence').ifExists().execute();
}
