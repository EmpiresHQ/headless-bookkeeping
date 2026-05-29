import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('organization')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('country', 'text', (col) => col.notNull())
    .addColumn('base_currency', 'text', (col) => col.notNull())
    .addColumn('vat_registered', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  // Seed default organization
  await db
    .insertInto('organization')
    .values({
      country: 'DK',
      base_currency: 'DKK',
      vat_registered: 0,
      created_at: Math.floor(Date.now() / 1000),
    })
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('organization').ifExists().execute();
}
