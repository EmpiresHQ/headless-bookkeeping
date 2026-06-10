import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('organization')
    .addColumn('vat_registration_number', 'text')
    .execute();
  await db.schema.alterTable('organization').addColumn('name', 'text').execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('organization')
    .dropColumn('vat_registration_number')
    .execute();
  await db.schema.alterTable('organization').dropColumn('name').execute();
}
