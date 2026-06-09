import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('setting')
    .addColumn('id', 'integer', (col) => col.autoIncrement().primaryKey())
    .addColumn('key', 'text', (col) => col.notNull().unique())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('setting').execute();
}
