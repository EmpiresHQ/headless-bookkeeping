import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 053: add document.processing_attempts.
 *
 * Counts how many times the intake worker has claimed a document for
 * processing. The claim query excludes documents whose attempts reached the
 * cap so a "poison" document that keeps throwing cannot block the queue.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .addColumn('processing_attempts', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .dropColumn('processing_attempts')
    .execute();
}
