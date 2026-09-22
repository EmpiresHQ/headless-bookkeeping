import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .addColumn('classification_snapshot', 'text')
    .execute();
}
export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .dropColumn('classification_snapshot')
    .execute();
}
