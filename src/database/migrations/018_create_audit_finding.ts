import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('audit_finding')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('finding_type', 'text', (col) => col.notNull())
    .addColumn('severity', 'text', (col) => col.notNull().defaultTo('low'))
    .addColumn('description', 'text', (col) => col.notNull())
    .addColumn('referenced_object_type', 'text')
    .addColumn('referenced_object_id', 'integer')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('open'))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('resolved_at', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('audit_finding').ifExists().execute();
}
