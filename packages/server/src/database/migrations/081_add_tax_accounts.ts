import { Kysely } from 'kysely';
import { Database } from '../types';

// Keep recoverable withholding, withholding payable, and tax advances separate.
// These are balance-sheet accounts, not tax expenses.
const accounts = [
  {
    code: 'INCOME_TAX_RECEIVABLE',
    name: 'Income Tax Receivable (withheld)',
    type: 'asset',
  },
  { code: 'TAX_PREPAYMENTS', name: 'Tax Prepayments', type: 'asset' },
  {
    code: 'INCOME_TAX_PAYABLE',
    name: 'Income Tax Payable (withheld)',
    type: 'liability',
  },
];

export async function up(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('account')
    .values(
      accounts.map((account) => ({
        ...account,
        currency: null,
        parent_id: null,
        is_system: 1,
      })),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom('account')
    .where(
      'code',
      'in',
      accounts.map((account) => account.code),
    )
    .execute();
}
