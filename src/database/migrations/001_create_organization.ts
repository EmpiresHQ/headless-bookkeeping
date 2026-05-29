import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('organization')
    .ifNotExists()
    // Single-tenant singleton: the organization always has id = 1. The CHECK
    // makes the singleton a DB-level invariant — a second INSERT must also use
    // id = 1 and therefore collides on the primary key (ADR-0003).
    .addColumn('id', 'integer', (col) => col.primaryKey().check(sql`id = 1`))
    .addColumn('country', 'text', (col) => col.notNull())
    // base_currency is a nullable OVERRIDE. NULL means "inherit the base
    // currency from the country plugin"; a value pins an explicit override
    // (ADR-0004).
    .addColumn('base_currency', 'text')
    .addColumn('vat_registered', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();

  // Seed the default organization: Ireland, no currency override (resolves to
  // the country plugin's default base currency, EUR).
  await db
    .insertInto('organization')
    .values({
      id: 1,
      country: 'IE',
      base_currency: null,
      vat_registered: 0,
      created_at: Math.floor(Date.now() / 1000),
    })
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('organization').ifExists().execute();
}
