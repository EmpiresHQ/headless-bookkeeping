import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Issue #203: persist WHICH date's rate was applied and WHO published it,
 * beside the rate itself.
 *
 * `fx_rate` alone cannot be audited. 0.92 on a 2024 line and 0.92 on a 2026
 * line are indistinguishable from a placeholder that ignored the date — which
 * is exactly how this defect stayed invisible. `fx_rate_date` makes the
 * non-business-day fallback explicit (a Saturday tax point legitimately
 * carries the preceding Friday's rate_date), and `fx_rate_source` names the
 * authority.
 *
 * Both columns are NULLABLE, and deliberately so. A line posted before this
 * migration has no provenance and MUST stay distinguishable as such: it is not
 * retroactively blessed by back-filling a source it never had. NULL therefore
 * reads as "provenance unknown — posted before #203", which is a finding to be
 * reviewed, not a defect to be papered over. Posted lines are immutable
 * (ADR-0019, enforced by trigger); nothing here rewrites one.
 *
 * The hash chain (ADR-0013) is intentionally left alone: `computeVoucherHash`
 * commits to an explicit field list that these columns do not join. Adding
 * them would change the canonical form for every voucher and break
 * verification of the existing chain, to commit to an attribute of a rate the
 * chain already commits to.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('voucher_line')
    .addColumn('fx_rate_date', 'text')
    .execute();
  await db.schema
    .alterTable('voucher_line')
    .addColumn('fx_rate_source', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('voucher_line')
    .dropColumn('fx_rate_source')
    .execute();
  await db.schema
    .alterTable('voucher_line')
    .dropColumn('fx_rate_date')
    .execute();
}
