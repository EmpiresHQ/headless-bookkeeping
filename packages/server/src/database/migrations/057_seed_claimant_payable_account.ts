import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 057: Seed CLAIMANT_PAYABLE liability account.
 *
 * The CLAIMANT_PAYABLE account is the credit leg when an expense carries
 * a claimant_id (Task 3 / claimant-reimbursement flow). It records the amount
 * the organisation owes to the claimant for their out-of-pocket expense.
 *
 * System account: is_system = 1, no parent, no currency (multi-currency safe).
 */
const SEED: Array<{
  code: string;
  name: string;
  type: string;
  currency: string | null;
}> = [
  {
    code: 'CLAIMANT_PAYABLE',
    name: 'Claimant Payable',
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
