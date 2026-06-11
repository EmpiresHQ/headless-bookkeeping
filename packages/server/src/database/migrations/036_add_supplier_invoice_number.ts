import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('expense')
    .addColumn('supplier_invoice_number', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('expense')
    .dropColumn('supplier_invoice_number')
    .execute();
}
