import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('override')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('business_object_type', 'text', (col) => col.notNull())
    .addColumn('business_object_id', 'integer', (col) => col.notNull())
    .addColumn('rule_type', 'text', (col) => col.notNull())
    .addColumn('rule_name', 'text', (col) => col.notNull())
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('created_by', 'text', (col) => col.notNull())
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('override').ifExists().execute();
}
