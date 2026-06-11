import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .addColumn('processing_since', 'integer', (col) => col.defaultTo(null))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .dropColumn('processing_since')
    .execute();
}
