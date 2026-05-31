import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('approval')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('object_type', 'text', (col) =>
      col.notNull().check(sql`object_type IN ('expense', 'sales_invoice')`),
    )
    .addColumn('object_id', 'integer', (col) => col.notNull())
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(
          sql`status IN ('pending', 'approved', 'rejected', 'superseded')`,
        ),
    )
    .addColumn('requested_by', 'text', (col) => col.notNull())
    .addColumn('approved_by', 'text')
    .addColumn('rejected_reason', 'text')
    .addColumn('superseded_by', 'integer', (col) =>
      col.references('approval.id'),
    )
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .addColumn('resolved_at', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('approval').ifExists().execute();
}
