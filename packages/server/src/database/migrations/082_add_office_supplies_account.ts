import { Kysely } from 'kysely';
import { Database } from '../types';

// Office consumables and small equipment expensed under the company's policy.
export async function up(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('account')
    .values({
      code: 'EXPENSE_OFFICE_SUPPLIES',
      name: 'Office Supplies Expense',
      type: 'expense',
      currency: null,
      parent_id: null,
      is_system: 1,
    })
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom('account')
    .where('code', '=', 'EXPENSE_OFFICE_SUPPLIES')
    .execute();
}
