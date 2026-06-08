import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 024: Seed dividend-related accounts into the canonical chart.
 *
 * Per ADR-0023:
 * - RETAINED_EARNINGS (equity) — the source of dividend distributions;
 *   declaration debits this account.
 * - DIVIDEND_PAYABLE (liability) — the amount owed to the owner after
 *   declaration; settled by bank outflow.
 * - DIVIDEND_WITHHOLDING_TAX_PAYABLE (liability) — when a country plugin
 *   applies dividend withholding tax (e.g. DK udbytteskat), the withheld
 *   portion is credited here instead of DIVIDEND_PAYABLE.
 *
 * These are system accounts (is_system = 1), seeded into the existing
 * account table — no new table is created.
 */
const SEED: Array<{
  code: string;
  name: string;
  type: string;
  currency: string | null;
}> = [
  {
    code: 'RETAINED_EARNINGS',
    name: 'Retained Earnings',
    type: 'equity',
    currency: null,
  },
  {
    code: 'DIVIDEND_PAYABLE',
    name: 'Dividend Payable',
    type: 'liability',
    currency: null,
  },
  {
    code: 'DIVIDEND_WITHHOLDING_TAX_PAYABLE',
    name: 'Dividend Withholding Tax Payable',
    type: 'liability',
    currency: null,
  },
];

export async function up(db: Kysely<Database>): Promise<void> {
  for (const a of SEED) {
    await db
      .insertInto('account')
      .values({
        code: a.code,
        name: a.name,
        type: a.type,
        currency: a.currency,
        parent_id: null,
        is_system: 1,
      })
      .execute();
  }
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom('account')
    .where('code', 'in', SEED.map((a) => a.code) as [string, ...string[]])
    .execute();
}
