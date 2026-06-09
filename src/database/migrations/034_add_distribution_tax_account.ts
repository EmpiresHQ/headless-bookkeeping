import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 034: Seed DISTRIBUTION_TAX_PAYABLE into the canonical chart.
 *
 * Per ADR-0027 (Estonia country plugin):
 * - DISTRIBUTION_TAX_PAYABLE (liability) — the company-level CIT due ON TOP
 *   of a dividend distribution under Estonia's 22/78 distribution-tax regime.
 *   Distinct from DIVIDEND_WITHHOLDING_TAX_PAYABLE (which is withheld FROM
 *   the shareholder). The shareholder receives the full declared amount; the
 *   company books and pays this tax separately.
 *
 * System account (is_system = 1), seeded into the existing account table —
 * no new table is created.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('account')
    .values({
      code: 'DISTRIBUTION_TAX_PAYABLE',
      name: 'Distribution Tax Payable',
      type: 'liability',
      currency: null,
      parent_id: null,
      is_system: 1,
    })
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom('account')
    .where('code', '=', 'DISTRIBUTION_TAX_PAYABLE')
    .execute();
}
