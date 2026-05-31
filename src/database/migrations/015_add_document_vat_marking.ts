import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('expense')
    .addColumn('document_vat_marking', 'text')
    .execute();

  await db.schema
    .alterTable('sales_invoice')
    .addColumn('document_vat_marking', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  // SQLite does not support DROP COLUMN in older versions;
  // Kysely handles this by recreating the table if needed.
  await db.schema
    .alterTable('expense')
    .dropColumn('document_vat_marking')
    .execute();

  await db.schema
    .alterTable('sales_invoice')
    .dropColumn('document_vat_marking')
    .execute();
}
