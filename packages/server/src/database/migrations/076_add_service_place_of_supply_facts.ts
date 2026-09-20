import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * The facts a service sale's VAT treatment actually turns on (issue #209).
 *
 * Estonian VAT on a service is decided by WHERE the supply is taxed (KMS §10),
 * and that place depends on two things the books did not record:
 *
 *  1. `entity.tax_status` — whether the recipient is a taxable person acting as
 *     such (a business) or a non-taxable person (a consumer). A country code
 *     cannot answer this: an FI customer may be either, and the answer flips a
 *     general-rule service between 0% (Art. 44/196, the customer reverse-charges)
 *     and 24% (taxed where WE are established). It is deliberately NOT
 *     backfilled — every existing row stays NULL, which reads as *unknown*, not
 *     as "consumer". An unknown status that would change the answer is refused
 *     at posting time with the fact named, never guessed. This is the
 *     CUSTOMER's status; our own VAT registration lives on `organization`.
 *
 *  2. `sales_invoice.supply_type` + `sales_invoice.service_place_rule` — what
 *     THIS invoice supplies and under which place-of-supply rule. `supply_type`
 *     is nullable and falls back to the counterparty's `goods_vs_services`, so
 *     invoices written before this migration keep the treatment they had.
 *     `service_place_rule` defaults to 'general' because the general rule IS
 *     the residual one (§10 lg 1 / lg 2) — an exception exists only when
 *     someone declares it. A declared exception is never blanket-classified:
 *     the plugin refuses it with an actionable message rather than inventing a
 *     treatment it does not implement.
 *
 * Posted vouchers and filed snapshots are untouched: these columns feed the
 * classification of FUTURE drafts only.
 */
const SERVICE_PLACE_RULES = [
  'general',
  'immovable_property',
  'passenger_transport',
  'cultural_artistic_sporting_admission',
  'restaurant_catering',
  'short_term_hire_of_means_of_transport',
  'electronically_supplied_to_consumer',
  'other_special',
] as const;

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('entity')
    .addColumn('tax_status', 'text', (col) =>
      col.check(
        sql`tax_status IS NULL OR tax_status IN ('taxable_business', 'non_taxable', 'unknown')`,
      ),
    )
    .execute();

  await db.schema
    .alterTable('sales_invoice')
    .addColumn('supply_type', 'text', (col) =>
      col.check(
        sql`supply_type IS NULL OR supply_type IN ('goods', 'services')`,
      ),
    )
    .execute();

  const ruleList = SERVICE_PLACE_RULES.map((r) => `'${r}'`).join(', ');
  await db.schema
    .alterTable('sales_invoice')
    .addColumn('service_place_rule', 'text', (col) =>
      col
        .notNull()
        .defaultTo('general')
        .check(sql.raw(`service_place_rule IN (${ruleList})`)),
    )
    .execute();

  // Existing rows: state the backfill rather than relying on SQLite filling an
  // ALTER-added NOT NULL DEFAULT column. 'general' is the residual rule, so this
  // asserts nothing new about them — it is the rule they were already treated under.
  await sql`UPDATE sales_invoice SET service_place_rule = 'general' WHERE service_place_rule IS NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('sales_invoice')
    .dropColumn('service_place_rule')
    .execute();
  await db.schema
    .alterTable('sales_invoice')
    .dropColumn('supply_type')
    .execute();
  await db.schema.alterTable('entity').dropColumn('tax_status').execute();
}
