import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('sales_invoice')
    .addColumn('document_id', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('sales_invoice').dropColumn('document_id').execute();
}
