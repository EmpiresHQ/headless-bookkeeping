import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('allowance')
    .addColumn('id', 'integer', (col) =>
      col.primaryKey().autoIncrement().notNull(),
    )
    .addColumn('claimant_id', 'integer', (col) =>
      col.notNull().references('entity.id'),
    )
    .addColumn('trip_id', 'integer', (col) =>
      col.references('business_trip.id'),
    )
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

  // Enforce at most one trip-linked allowance of a given type per claimant.
  // Partial index (WHERE trip_id IS NOT NULL): non-trip allowances (phone,
  // internet, health, ad-hoc mileage) carry trip_id = NULL and SQLite treats
  // each NULL as distinct, so a full 3-column UNIQUE would permit duplicate
  // NULL-trip rows anyway. The partial index constrains only trip-linked rows,
  // leaving NULL-trip allowances unconstrained (multiple phone allowances
  // across months are legitimate).
  await sql`
    CREATE UNIQUE INDEX idx_allowance_unique_per_trip
    ON allowance(claimant_id, type, trip_id)
    WHERE trip_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_allowance_unique_per_trip`.execute(db);
  await db.schema.dropTable('allowance').execute();
}
