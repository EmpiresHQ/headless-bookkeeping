import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('voucher')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('voucher_number', 'text', (col) => col.notNull().unique())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('posted_at', 'integer')
    .addColumn('previous_hash', 'text')
    .addColumn('reverses_id', 'integer', (col) => col.references('voucher.id'))
    .addColumn('corrects_object_type', 'text')
    .addColumn('corrects_object_id', 'integer')
    .addColumn('reason', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('voucher').ifExists().execute();
}
