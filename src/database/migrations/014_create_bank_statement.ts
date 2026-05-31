import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // Bank statement: represents an uploaded bank statement file for a specific
  // bank account, covering a date range.
  await db.schema
    .createTable('bank_statement')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('account_id', 'integer', (col) =>
      col.notNull().references('account.id'),
    )
    .addColumn('start_date', 'text', (col) => col.notNull())
    .addColumn('end_date', 'text', (col) => col.notNull())
    .addColumn('uploaded_at', 'integer', (col) => col.notNull())
    .addColumn('file_path', 'text')
    .execute();

  // Bank transaction: a single line from a bank statement. Amount is signed
  // cents: positive = incoming/credit, negative = outgoing/debit.
  //
  // Foreign-leg capture: when source_currency is set and differs from the
  // statement's account currency, at least one of source_amount/fx_rate must
  // be present (enforced in service, not DB).
  //
  // NO matched_voucher_id: matching is N:M via reconciliation_match (Task 22).
  await db.schema
    .createTable('bank_transaction')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('statement_id', 'integer', (col) =>
      col.notNull().references('bank_statement.id'),
    )
    .addColumn('transaction_date', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    // Signed cents: + = incoming/credit, − = outgoing/debit.
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    // Source currency: the payment's original currency when bank-converted.
    .addColumn('source_currency', 'text')
    // Cents in source_currency.
    .addColumn('source_amount', 'integer')
    // The bank's actual conversion rate.
    .addColumn('fx_rate', 'real')
    .addColumn('counterparty_iban', 'text')
    // Card merchant descriptor.
    .addColumn('counterparty_descriptor', 'text')
    // Parsed invoice number / match key.
    .addColumn('reference', 'text')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('open')
        .check(
          sql`status IN ('open', 'prepayment', 'personal', 'bank_fee', 'dividend')`,
        ),
    )
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('bank_transaction').ifExists().execute();
  await db.schema.dropTable('bank_statement').ifExists().execute();
}
