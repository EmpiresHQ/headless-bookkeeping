import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('allowance')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement().notNull())
    .addColumn('claimant_id', 'integer', (col) =>
      col.notNull().references('entity.id'),
    )
    .addColumn('trip_id', 'integer', (col) => col.references('business_trip.id'))
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('days', 'integer')
    .addColumn('km', 'integer')
    .addColumn('input_amount', 'integer')
    .addColumn('route_description', 'text')
    .addColumn('gross_amount', 'integer', (col) => col.notNull())
    .addColumn('tax_free_amount', 'integer', (col) => col.notNull())
    .addColumn('taxable_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull().defaultTo('EUR'))
    .addColumn('breakdown', 'text')
    .addColumn('period_start', 'text', (col) => col.notNull())
    .addColumn('period_end', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('draft'))
    .addColumn('voucher_id', 'integer', (col) => col.references('voucher.id'))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('allowance').execute();
}
