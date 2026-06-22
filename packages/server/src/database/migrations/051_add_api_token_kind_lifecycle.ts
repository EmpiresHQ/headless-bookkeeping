import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('api_token')
    .addColumn('kind', 'text', (col) => col.notNull().defaultTo('static'))
    .execute();
  await db.schema
    .alterTable('api_token')
    .addColumn('expires_at', 'integer')
    .execute();
  await db.schema
    .alterTable('api_token')
    .addColumn('consumed_at', 'integer')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('api_token').dropColumn('consumed_at').execute();
  await db.schema.alterTable('api_token').dropColumn('expires_at').execute();
  await db.schema.alterTable('api_token').dropColumn('kind').execute();
}
