import { Kysely, sql } from 'kysely';
import { Database } from '../types';

/**
 * The facts that decide how much of a health reimbursement is tax-exempt, and
 * the accounts its taxable excess is booked to (issue #212).
 *
 * Until now a health allowance was routed through the same code path as phone
 * and internet — "employer-defined, no statutory ceiling" — so any amount was
 * classified entirely tax-free and no per-employee accumulation existed. That
 * is wrong twice over: the exemption HAS a statutory cap per claimant per
 * window, and it is conditional. Neither the cap nor the conditions can be
 * decided from what the row recorded, because the row recorded none of them.
 *
 * Four eligibility facts are added, all NULLABLE, because a pre-existing row
 * genuinely never recorded them. NULL means "not recorded" — read as NOT
 * eligible, never as eligible. A legacy health claim is therefore booked as a
 * fully taxable fringe benefit rather than being silently exempted by a
 * back-filled default that nobody ever asserted:
 *
 *  - `health_category` — which category of health/sports expenditure this is.
 *    The qualifying list is jurisdiction- and DATE-specific (EE widened it on
 *    2025-01-01), so the category is stored raw and judged by the plugin.
 *  - `claimant_relation` — 'employee' | 'board_member' | 'other'. The exemption
 *    exists only for a person in an employment or board relationship.
 *  - `supporting_document_id` / `supporting_document_ref` — WHICH document
 *    evidences the expense: an intake Document already in the books, or an
 *    external reference when the paper lives elsewhere. A boolean "documents
 *    exist" is not evidence — an auditor asks which one — so the claim carries
 *    the pointer itself.
 *  - `provider_registration` — the licence/registration of the service
 *    provider, for the categories that qualify only because a registered
 *    provider supplied the service. A general check-up invoice from an unlisted
 *    provider is not eligible merely for being medical.
 *  - `offered_to_all_employees` — the benefit is available to every eligible
 *    employee. A perk given to one person is taxable however health-related.
 *
 * Three decision columns record what was actually DECIDED when the claim was
 * posted, so a posted claim is explicable from the books rather than from
 * whatever the rules say today:
 *
 *  - `exemption_basis` — why the exempt part was the size it was.
 *  - `limit_window` — the accumulation window the allocation was made against
 *    ('2026' for an annual cap, '2024-Q3' for a quarterly one). Stored because
 *    the window KIND itself changed over time.
 *  - `fringe_income_tax_amount` / `fringe_social_tax_amount` — the employer's
 *    own tax on the taxable excess, owed IN ADDITION to what the claimant is
 *    paid. NOT NULL DEFAULT 0, which states what each existing row RECORDED,
 *    not what was owed on it: the old code produced no taxable excess for a
 *    health claim, so no tax was ever computed. Some of those claims may well
 *    have owed some. The zero is therefore a record of what the books hold,
 *    and a row with no `exemption_basis` is flagged by the health benefit
 *    report as unresolved rather than quietly treated as settled.
 *
 * Four accounts are seeded. The taxable excess is NOT ordinary salary — it is a
 * fringe benefit, taxed at the employer at its own rates and declared on its
 * own TSD annex — so it needs its own expense account rather than being folded
 * into EXPENSE_SALARY where it would be indistinguishable from payroll.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('allowance')
    .addColumn('health_category', 'text')
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('claimant_relation', 'text', (col) =>
      col.check(
        sql`claimant_relation IS NULL OR claimant_relation IN ('employee', 'board_member', 'other')`,
      ),
    )
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('supporting_document_id', 'integer', (col) =>
      col.references('document.id'),
    )
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('supporting_document_ref', 'text')
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('provider_registration', 'text')
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('offered_to_all_employees', 'integer', (col) =>
      col.check(
        sql`offered_to_all_employees IS NULL OR offered_to_all_employees IN (0, 1)`,
      ),
    )
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('exemption_basis', 'text')
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('limit_window', 'text')
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('fringe_income_tax_amount', 'integer', (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`fringe_income_tax_amount >= 0`),
    )
    .execute();

  await db.schema
    .alterTable('allowance')
    .addColumn('fringe_social_tax_amount', 'integer', (col) =>
      col
        .notNull()
        .defaultTo(0)
        .check(sql`fringe_social_tax_amount >= 0`),
    )
    .execute();

  // The per-claimant accumulation query filters on (claimant_id, type, status)
  // and ranges over period_start. Without this index every posting scans the
  // whole table to find out how much of a cap is left.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_allowance_claimant_type_period
    ON allowance(claimant_id, type, period_start)
  `.execute(db);

  await db
    .insertInto('account')
    .values([
      {
        code: 'EXPENSE_FRINGE_BENEFIT',
        name: 'Fringe Benefits',
        type: 'expense',
        currency: null,
        parent_id: null,
        is_system: 1,
      },
      {
        code: 'EXPENSE_FRINGE_BENEFIT_TAX',
        name: 'Fringe Benefit Tax',
        type: 'expense',
        currency: null,
        parent_id: null,
        is_system: 1,
      },
      {
        code: 'FRINGE_BENEFIT_INCOME_TAX_PAYABLE',
        name: 'Fringe Benefit Income Tax Payable',
        type: 'liability',
        currency: null,
        parent_id: null,
        is_system: 1,
      },
      {
        code: 'SOCIAL_TAX_PAYABLE',
        name: 'Social Tax Payable',
        type: 'liability',
        currency: null,
        parent_id: null,
        is_system: 1,
      },
    ])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom('account')
    .where('code', 'in', [
      'EXPENSE_FRINGE_BENEFIT',
      'EXPENSE_FRINGE_BENEFIT_TAX',
      'FRINGE_BENEFIT_INCOME_TAX_PAYABLE',
      'SOCIAL_TAX_PAYABLE',
    ])
    .execute();

  await sql`DROP INDEX IF EXISTS idx_allowance_claimant_type_period`.execute(
    db,
  );

  for (const column of [
    'health_category',
    'claimant_relation',
    'supporting_document_id',
    'supporting_document_ref',
    'provider_registration',
    'offered_to_all_employees',
    'exemption_basis',
    'limit_window',
    'fringe_income_tax_amount',
    'fringe_social_tax_amount',
  ]) {
    await db.schema.alterTable('allowance').dropColumn(column).execute();
  }
}
