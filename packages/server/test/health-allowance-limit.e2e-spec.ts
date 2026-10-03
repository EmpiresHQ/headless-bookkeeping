import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';

/**
 * The health/sports exemption end to end (issue #212).
 *
 * The bug report's own path: POST a EUR 1000 health claim over HTTP and watch
 * it be classified entirely tax-free. What must happen instead is that EUR 400
 * is exempt, EUR 600 is a taxable fringe benefit, the employer's income and
 * social tax on that 600 reach the ledger as the employer's own cost, and the
 * declaration figures come back out matching what was posted.
 *
 * Only an end-to-end run shows the parts a unit test cannot: that the split
 * PERSISTED on the row, the VOUCHER that was posted and the REPORT agree,
 * because all three now come from one allocation made inside one transaction;
 * and that two approvals racing for the same remaining exemption cannot both
 * take it.
 */
describe('Health allowance limit (E2E)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  const QUALIFYING = {
    health_category: 'sports_facility_fee',
    claimant_relation: 'employee',
    supporting_document_ref: 'INV-2026-0042',
    offered_to_all_employees: true,
  };

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    root = mkdtempSync(join(tmpdir(), 'health-allowance-e2e-'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .compile();

    app = module.createNestApplication();
    await app.init();

    token = 'test-token-health-212';
    await db
      .insertInto('api_token')
      .values({
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'e2e-health-212',
      })
      .execute();

    await http()
      .put('/api/organization')
      .set(auth())
      .send({
        country: 'EE',
        vat_registered: true,
        vat_registration_number: 'EE100000001',
        registry_code: '17499653',
        name: 'Test OÜ',
      })
      .expect(200);
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  // ── helpers ─────────────────────────────────────────────────────────────

  async function seedClaimant(name: string): Promise<number> {
    const row = await db
      .insertInto('entity')
      .values({
        role: 'employee',
        country: 'EE',
        name,
        goods_vs_services: null,
        created_at: 0,
        updated_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function createHealthClaim(
    claimantId: number,
    inputAmount: number,
    periodStart = '2026-09-01',
    facts: Record<string, unknown> = QUALIFYING,
  ): Promise<number> {
    const res = await http()
      .post('/api/allowances')
      .set(auth())
      .send({
        type: 'health',
        claimant_id: claimantId,
        input_amount: inputAmount,
        period_start: periodStart,
        ...facts,
      })
      .expect(201);
    return res.body.id as number;
  }

  async function submitAndGetApprovalId(allowanceId: number): Promise<number> {
    await http()
      .post(`/api/allowances/${allowanceId}/submit`)
      .set(auth())
      .expect(204);
    const list = await http()
      .get('/api/approvals?status=pending&object_type=allowance')
      .set(auth())
      .expect(200);
    const approval = (
      list.body.approvals as { id: number; object_id: number }[]
    ).find((a) => a.object_id === allowanceId);
    if (!approval)
      throw new Error(`No pending approval for allowance ${allowanceId}`);
    return approval.id;
  }

  function approve(approvalId: number) {
    return http()
      .post(`/api/approvals/${approvalId}/approve`)
      .set(auth())
      .send({ approved_by: 'owner' });
  }

  async function voucherLines(voucherId: number) {
    return db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as code',
        'voucher_line.base_amount as amount',
        'voucher_line.is_debit as is_debit',
        'voucher_line.vat_code as vat_code',
      ])
      .where('voucher_line.voucher_id', '=', voucherId)
      .execute();
  }

  // ── the reported case ───────────────────────────────────────────────────

  it('posts EUR 1000 as 400 exempt + 600 taxable, with the employer tax on top', async () => {
    const claimantId = await seedClaimant('Mari');
    const allowanceId = await createHealthClaim(claimantId, 100000);

    // Even the draft must not claim the whole amount is tax-free.
    const draft = await db
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', allowanceId)
      .executeTakeFirstOrThrow();
    expect(draft.tax_free_amount).toBe(40000);
    expect(draft.taxable_amount).toBe(60000);

    const approvalId = await submitAndGetApprovalId(allowanceId);
    const res = await approve(approvalId).expect(201);
    const voucherId = res.body.voucher.id as number;

    const posted = await db
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', allowanceId)
      .executeTakeFirstOrThrow();

    expect(posted).toMatchObject({
      status: 'posted',
      gross_amount: 100000,
      tax_free_amount: 40000,
      taxable_amount: 60000,
      fringe_income_tax_amount: 16923,
      fringe_social_tax_amount: 25385,
      exemption_basis: 'statutory_health_exemption',
      limit_window: '2026',
      voucher_id: voucherId,
    });

    const lines = await voucherLines(voucherId);
    const amountOf = (code: string, isDebit: boolean) =>
      lines.find((l) => l.code === code && l.is_debit === (isDebit ? 1 : 0))
        ?.amount;

    // The exempt part is a health expense; the excess is a FRINGE BENEFIT with
    // its own expense account, not ordinary salary.
    expect(amountOf('EXPENSE_OTHER', true)).toBe(40000);
    expect(amountOf('EXPENSE_FRINGE_BENEFIT', true)).toBe(60000);
    expect(amountOf('EXPENSE_FRINGE_BENEFIT_TAX', true)).toBe(42308);
    // The claimant is paid the full 1000.00 — the tax is the employer's, on top.
    expect(amountOf('CLAIMANT_PAYABLE', false)).toBe(100000);
    expect(amountOf('FRINGE_BENEFIT_INCOME_TAX_PAYABLE', false)).toBe(16923);
    expect(amountOf('SOCIAL_TAX_PAYABLE', false)).toBe(25385);
    expect(lines.find((l) => l.code === 'EXPENSE_SALARY')).toBeUndefined();

    const debits = lines
      .filter((l) => l.is_debit === 1)
      .reduce((s, l) => s + l.amount, 0);
    const credits = lines
      .filter((l) => l.is_debit === 0)
      .reduce((s, l) => s + l.amount, 0);
    expect(debits).toBe(142308);
    expect(credits).toBe(142308);

    // A health benefit carries no recoverable input VAT.
    expect(lines.every((l) => l.vat_code === 'NULL_STANDARD')).toBe(true);
    expect(lines.find((l) => l.code === 'VAT_RECEIVABLE')).toBeUndefined();

    // The declaration figures come back out of the same numbers.
    const report = await http()
      .get('/api/reports/fringe-benefits/health?year=2026')
      .set(auth())
      .expect(200);
    expect(report.body.tsdAnnex4.benefitCode).toBe('4120');
    expect(report.body.tsdAnnex4.months).toEqual([
      expect.objectContaining({
        month: '2026-09',
        benefitValue: 60000,
        ledgerTax: { incomeTax: 16923, socialTax: 25385 },
        declarationTax: { incomeTax: 16923, socialTax: 25385 },
        roundingAdjustment: { incomeTax: 0, socialTax: 0 },
        dueDate: '2026-10-10',
      }),
    ]);
    expect(report.body.tsdAnnex4.months[0].claims).toEqual([
      expect.objectContaining({ allowanceId, voucherId }),
    ]);
    expect(report.body.inf14PartIii).toMatchObject({
      exemptTotal: 40000,
      employees: 1,
      dueDate: '2027-02-01',
    });
    expect(report.body.readyToFile).toBe(true);
  });

  it('refuses a health claim that records no eligibility facts, creating nothing', async () => {
    const claimantId = await seedClaimant('Jaan');
    const res = await http()
      .post('/api/allowances')
      .set(auth())
      .send({
        type: 'health',
        claimant_id: claimantId,
        input_amount: 100000,
        period_start: '2026-09-01',
      })
      .expect(422);

    expect(res.body.code).toBe('health_eligibility_facts_missing');
    expect(res.body.missing_facts).toEqual(
      expect.arrayContaining(['health_category']),
    );
    expect(res.body.how_to_resolve).toContain('POST /api/allowances');

    const rows = await db.selectFrom('allowance').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('a second claim in the same year gets no exemption and is taxed in full', async () => {
    const claimantId = await seedClaimant('Mari');
    const first = await createHealthClaim(claimantId, 40000, '2026-03-01');
    await approve(await submitAndGetApprovalId(first)).expect(201);

    const second = await createHealthClaim(claimantId, 10000, '2026-10-01');
    await approve(await submitAndGetApprovalId(second)).expect(201);

    const row = await db
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', second)
      .executeTakeFirstOrThrow();
    expect(row.tax_free_amount).toBe(0);
    expect(row.taxable_amount).toBe(10000);
    expect(row.exemption_basis).toBe('limit_exhausted');
  });

  it('two approvals racing for the same remaining exemption cannot both take it', async () => {
    const claimantId = await seedClaimant('Mari');
    const a = await createHealthClaim(claimantId, 40000, '2026-05-01');
    const b = await createHealthClaim(claimantId, 40000, '2026-06-01');

    // Both drafts were previewed against an UNCONSUMED cap — each row says
    // 400 tax-free. The authoritative allocation happens at approval, and only
    // one of them can get it.
    const drafts = await db
      .selectFrom('allowance')
      .select(['id', 'tax_free_amount'])
      .where('id', 'in', [a, b])
      .execute();
    expect(drafts.every((d) => d.tax_free_amount === 40000)).toBe(true);

    const approvalA = await submitAndGetApprovalId(a);
    const approvalB = await submitAndGetApprovalId(b);
    const results = await Promise.allSettled([
      approve(approvalA),
      approve(approvalB),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

    const rows = await db
      .selectFrom('allowance')
      .select(['id', 'status', 'tax_free_amount', 'taxable_amount'])
      .where('id', 'in', [a, b])
      .orderBy('id')
      .execute();
    expect(rows.every((r) => r.status === 'posted')).toBe(true);

    const exempt = rows.reduce((s, r) => s + r.tax_free_amount, 0);
    expect(exempt).toBe(40000); // NOT 80000 — the cap was taken once.
    expect(rows.reduce((s, r) => s + r.taxable_amount, 0)).toBe(40000);

    // And the posted ledger says the same as the rows.
    const ledgerExempt = await db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .innerJoin('allowance', 'allowance.voucher_id', 'voucher_line.voucher_id')
      .select(({ fn }) => [
        fn.sum<number>('voucher_line.base_amount').as('total'),
      ])
      .where('account.code', '=', 'EXPENSE_OTHER')
      .where('allowance.id', 'in', [a, b])
      .executeTakeFirst();
    expect(Number(ledgerExempt?.total ?? 0)).toBe(40000);
  });

  it('a rejected claim releases nothing, because it never took anything', async () => {
    const claimantId = await seedClaimant('Mari');
    const rejected = await createHealthClaim(claimantId, 40000, '2026-02-01');
    const approvalId = await submitAndGetApprovalId(rejected);
    await http()
      .post(`/api/approvals/${approvalId}/reject`)
      .set(auth())
      .send({ rejected_reason: 'no receipt after all' })
      .expect(201);

    const next = await createHealthClaim(claimantId, 40000, '2026-07-01');
    await approve(await submitAndGetApprovalId(next)).expect(201);

    const row = await db
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', next)
      .executeTakeFirstOrThrow();
    expect(row.tax_free_amount).toBe(40000);
    expect(row.taxable_amount).toBe(0);
  });

  it('still posts a non-health allowance through the same approval path', async () => {
    // The allowance approval now runs inside one transaction. A daily allowance
    // reads its own accumulated days from that same handle; if any of those
    // reads went to the root connection it would hang here rather than post.
    const claimantId = await seedClaimant('Mari');
    const trip = await http()
      .post('/api/business-trips')
      .set(auth())
      .send({
        claimant_id: claimantId,
        departure_date: '2026-09-10',
        return_date: '2026-09-12',
        destination_country: 'FI',
        purpose: 'Conference',
      })
      .expect(201);

    const created = await http()
      .post('/api/allowances')
      .set(auth())
      .send({
        type: 'daily_allowance',
        claimant_id: claimantId,
        trip_id: trip.body.id,
      })
      .expect(201);

    const res = await approve(
      await submitAndGetApprovalId(created.body.id),
    ).expect(201);
    expect(res.body.voucher).not.toBeNull();

    const row = await db
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('posted');
    expect(row.tax_free_amount).toBe(22500); // 3 days at 75.00, all exempt
    expect(row.taxable_amount).toBe(0);
    expect(row.exemption_basis).toBeNull();
  });
});
