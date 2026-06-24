import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('business_trip')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement().notNull())
    .addColumn('claimant_id', 'integer', (col) =>
      col.notNull().references('entity.id'),
    )
    .addColumn('departure_date', 'text', (col) => col.notNull())
    .addColumn('return_date', 'text', (col) => col.notNull())
    .addColumn('destination_country', 'text', (col) => col.notNull())
    .addColumn('purpose', 'text')
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('business_trip').execute();
}
