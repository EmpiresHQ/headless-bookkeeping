import { Kysely, sql } from 'kysely';
import { Database } from '../types';

const SEED: Array<{
  code: string;
  name: string;
  type: string;
  currency: string | null;
}> = [
  // Assets
  { code: 'CASH', name: 'Cash', type: 'asset', currency: null },
  { code: 'BANK_EUR', name: 'Bank (EUR)', type: 'asset', currency: null },
  { code: 'BANK_USD', name: 'Bank (USD)', type: 'asset', currency: 'USD' },
  { code: 'AR', name: 'Accounts Receivable', type: 'asset', currency: null },
  {
    code: 'VAT_RECEIVABLE',
    name: 'VAT Receivable (input VAT)',
    type: 'asset',
    currency: null,
  },
  {
    code: 'SUPPLIER_PREPAYMENTS',
    name: 'Supplier Prepayments',
    type: 'asset',
    currency: null,
  },
  {
    code: 'RECEIVABLE_FROM_OWNER',
    name: 'Receivable from Owner',
    type: 'asset',
    currency: null,
  },
  // Liabilities
  { code: 'AP', name: 'Accounts Payable', type: 'liability', currency: null },
  {
    code: 'CUSTOMER_PREPAYMENTS',
    name: 'Customer Prepayments',
    type: 'liability',
    currency: null,
  },
  {
    code: 'VAT_PAYABLE',
    name: 'VAT Payable (output VAT)',
    type: 'liability',
    currency: null,
  },
  // Equity
  { code: 'EQUITY', name: 'Equity', type: 'equity', currency: null },
  {
    code: 'OWNERS_DRAWINGS',
    name: "Owner's Drawings",
    type: 'equity',
    currency: null,
  },
  // Revenue
  { code: 'REVENUE', name: 'Revenue', type: 'revenue', currency: null },
  // Expenses
  {
    code: 'EXPENSE_SOFTWARE',
    name: 'Software Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_TRANSPORT',
    name: 'Transport Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_TRAVEL',
    name: 'Travel Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_MARKETING',
    name: 'Marketing Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_SALARY',
    name: 'Salary Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_CONTRACTOR',
    name: 'Contractor Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_RENT',
    name: 'Rent Expense',
    type: 'expense',
    currency: null,
  },
  { code: 'EXPENSE_TAX', name: 'Tax Expense', type: 'expense', currency: null },
  {
    code: 'EXPENSE_BANK_FEE',
    name: 'Bank Fee Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_MEALS',
    name: 'Meals Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_INSURANCE',
    name: 'Insurance Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_EDUCATION',
    name: 'Education Expense',
    type: 'expense',
    currency: null,
  },
  {
    code: 'EXPENSE_OTHER',
    name: 'Other Expense',
    type: 'expense',
    currency: null,
  },
  { code: 'FX_GAIN_LOSS', name: 'Foreign Exchange Gain/Loss', type: 'expense', currency: null },
  {
    code: 'BAD_DEBT_EXPENSE',
    name: 'Bad Debt Expense',
    type: 'expense',
    currency: null,
  },
];

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('account')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('code', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`type IN ('asset', 'liability', 'equity', 'revenue', 'expense')`,
        ),
    )
    .addColumn('currency', 'text')
    .addColumn('parent_id', 'integer', (col) => col.references('account.id'))
    .addColumn('is_system', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

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
  await db.schema.dropTable('account').ifExists().execute();
}
