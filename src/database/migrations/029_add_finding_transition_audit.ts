import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Deepen the AuditFinding buffer (ADR-0018) into a real state machine: record
 * who/when/why on each lifecycle transition. All columns are nullable so the
 * migration is backward-compatible with existing rows (they keep NULL audit
 * fields until the next guarded transition writes them).
 *
 *  - snoozed_at:        when the finding was last snoozed (mirror of resolved_at)
 *  - transitioned_by:   actor that triggered the last open→resolved/snoozed/… move
 *  - transition_reason: free-text reason recorded on the transition
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('audit_finding')
    .addColumn('snoozed_at', 'integer')
    .execute();
  await db.schema
    .alterTable('audit_finding')
    .addColumn('transitioned_by', 'text')
    .execute();
  await db.schema
    .alterTable('audit_finding')
    .addColumn('transition_reason', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('audit_finding')
    .dropColumn('transition_reason')
    .execute();
  await db.schema
    .alterTable('audit_finding')
    .dropColumn('transitioned_by')
    .execute();
  await db.schema
    .alterTable('audit_finding')
    .dropColumn('snoozed_at')
    .execute();
}
