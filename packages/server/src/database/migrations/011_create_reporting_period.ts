import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('reporting_period')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('start_date', 'text', (col) => col.notNull())
    .addColumn('end_date', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('open'))
    .addColumn('filed_at', 'integer')
    .addColumn('vat_report_snapshot_id', 'integer')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  const now = Math.floor(Date.now() / 1000);
  await db
    .insertInto('reporting_period')
    .values({
      name: '2024-Q1',
      start_date: '2024-01-01',
      end_date: '2024-03-31',
      status: 'open',
      created_at: now,
    })
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('reporting_period').ifExists().execute();
}
