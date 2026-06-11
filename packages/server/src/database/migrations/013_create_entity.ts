import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // 1. Create entity table (ADR-0014: counterparty identified by strong keys)
  await db.schema
    .createTable('entity')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('role', 'text', (col) =>
      col.notNull().check(sql`role IN ('supplier', 'customer')`),
    )
    .addColumn('country', 'text', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('goods_vs_services', 'text', (col) =>
      col.check(sql`goods_vs_services IN ('goods', 'services', 'unknown')`),
    )
    .addColumn('created_at', 'integer')
    .addColumn('updated_at', 'integer')
    .execute();

  // 2. Create entity_identifier child table
  await db.schema
    .createTable('entity_identifier')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('entity_id', 'integer', (col) =>
      col.notNull().references('entity.id').onDelete('cascade'),
    )
    .addColumn('kind', 'text', (col) =>
      col
        .notNull()
        .check(
          sql`kind IN ('registration_key', 'iban', 'merchant_descriptor', 'name_alias')`,
        ),
    )
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('confirmed', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  // 3. Add REAL FK: expense.supplier_id → entity.id
  // SQLite cannot ALTER an existing column to add a FK, so we recreate the table.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`BEGIN TRANSACTION`.execute(db);
  await sql`ALTER TABLE expense RENAME TO expense_old`.execute(db);
  await db.schema
    .createTable('expense')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('document_id', 'integer')
    .addColumn('supplier_id', 'integer', (col) => col.references('entity.id'))
    .addColumn('category', 'text', (col) => col.notNull())
    .addColumn('gross_amount', 'integer', (col) => col.notNull())
    .addColumn('vat_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('draft')
        .check(sql`status IN ('draft', 'pending', 'posted', 'reversed')`),
    )
    .addColumn('voucher_id', 'integer')
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .addColumn('updated_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();
  await sql`INSERT INTO expense SELECT * FROM expense_old`.execute(db);
  await sql`DROP TABLE expense_old`.execute(db);
  await sql`COMMIT`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);

  // 4. Add REAL FK: sales_invoice.customer_id → entity.id
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`BEGIN TRANSACTION`.execute(db);
  await sql`ALTER TABLE sales_invoice RENAME TO sales_invoice_old`.execute(db);
  await db.schema
    .createTable('sales_invoice')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('customer_id', 'integer', (col) => col.references('entity.id'))
    .addColumn('invoice_number', 'text', (col) => col.notNull().unique())
    .addColumn('gross_amount', 'integer', (col) => col.notNull())
    .addColumn('vat_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('due_date', 'text')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('draft')
        .check(sql`status IN ('draft', 'pending', 'posted', 'reversed')`),
    )
    .addColumn('sent_at', 'integer')
    .addColumn('voucher_id', 'integer', (col) => col.references('voucher.id'))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();
  await sql`INSERT INTO sales_invoice SELECT * FROM sales_invoice_old`.execute(
    db,
  );
  await sql`DROP TABLE sales_invoice_old`.execute(db);
  await sql`COMMIT`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Reverse the FK additions by recreating tables without FKs
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`BEGIN TRANSACTION`.execute(db);
  await sql`ALTER TABLE sales_invoice RENAME TO sales_invoice_old`.execute(db);
  await db.schema
    .createTable('sales_invoice')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('customer_id', 'integer')
    .addColumn('invoice_number', 'text', (col) => col.notNull().unique())
    .addColumn('gross_amount', 'integer', (col) => col.notNull())
    .addColumn('vat_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('due_date', 'text')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('draft')
        .check(sql`status IN ('draft', 'pending', 'posted', 'reversed')`),
    )
    .addColumn('sent_at', 'integer')
    .addColumn('voucher_id', 'integer', (col) => col.references('voucher.id'))
    .addColumn('created_at', 'integer', (col) => col.notNull())
    .addColumn('updated_at', 'integer', (col) => col.notNull())
    .execute();
  await sql`INSERT INTO sales_invoice SELECT * FROM sales_invoice_old`.execute(
    db,
  );
  await sql`DROP TABLE sales_invoice_old`.execute(db);
  await sql`COMMIT`.execute(db);

  await sql`BEGIN TRANSACTION`.execute(db);
  await sql`ALTER TABLE expense RENAME TO expense_old`.execute(db);
  await db.schema
    .createTable('expense')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('document_id', 'integer')
    .addColumn('supplier_id', 'integer')
    .addColumn('category', 'text', (col) => col.notNull())
    .addColumn('gross_amount', 'integer', (col) => col.notNull())
    .addColumn('vat_amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'text', (col) => col.notNull())
    .addColumn('tax_point_date', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('draft')
        .check(sql`status IN ('draft', 'pending', 'posted', 'reversed')`),
    )
    .addColumn('voucher_id', 'integer')
    .addColumn('created_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .addColumn('updated_at', 'integer', (col) =>
      col.notNull().defaultTo(sql`(unixepoch())`),
    )
    .execute();
  await sql`INSERT INTO expense SELECT * FROM expense_old`.execute(db);
  await sql`DROP TABLE expense_old`.execute(db);
  await sql`COMMIT`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);

  await db.schema.dropTable('entity_identifier').ifExists().execute();
  await db.schema.dropTable('entity').ifExists().execute();
}
