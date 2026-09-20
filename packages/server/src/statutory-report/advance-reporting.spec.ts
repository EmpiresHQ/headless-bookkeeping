import { PrepaymentAllocationRepository } from '../reconciliation/prepayment-allocation.repository';
import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { StatutoryReportService } from './statutory-report.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { AccountService } from '../ledger/account/account.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { CurrencyService } from '../currency/currency.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { buildInfPart } from '../plugins/estonia-kmd/kmd-inf';
import type { StatutoryDocLine } from '../plugins/statutory-report.types';

/**
 * Issue #213 — how advance documents are REPORTED, once they exist.
 *
 * Three things the ledger alone does not settle:
 *  - EMTA's KMD INF part A rule that a final invoice is reported LESS the
 *    advance already invoiced (2000 advance + 5000 transaction ⇒ one row of
 *    3000, not 5000 and a credit nobody issued);
 *  - a reversal is an event with a DATE: it belongs to the period it is
 *    posted in, and must not reach back and delete a document from a period
 *    whose boxes still contain it;
 *  - a counter-voucher that mirrors only part of a document proves nothing,
 *    so the affected filing is held rather than reported either way.
 */
describe('advance document reporting (#213)', () => {
  let db: Kysely<Database>;
  let statutory: StatutoryReportService;
  let periods: ReportingPeriodsService;
  let organization: OrganizationService;
  let posting: PostingService;
  let advances: PrepaymentAllocationRepository;
  let vatReports: VatReportService;

  const FEB = { name: '2026-02', start: '2026-02-01', end: '2026-02-28' };
  const MAR = { name: '2026-03', start: '2026-03-01', end: '2026-03-31' };

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        OrgContextResolver,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        LedgerBalanceService,
        AccountService,
        CurrencyService,
        VoucherRepository,
        VoucherLineRepository,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        VoucherProjectionService,
        SalesInvoicesService,
        AuditFindingsService,
        AuditLogService,
        VatReportService,
        PrepaymentAllocationRepository,
        StatutorySubmissionService,
        StatutoryReportService,
        ReportingPeriodsService,
      ],
    }).compile();

    statutory = module.get(StatutoryReportService);
    periods = module.get(ReportingPeriodsService);
    organization = module.get(OrganizationService);
    posting = module.get(PostingService);
    advances = module.get(PrepaymentAllocationRepository);
    vatReports = module.get(VatReportService);

    await organization.updateOrganization({
      country: 'EE',
      vat_registered: true,
      vat_registration_number: 'EE100000001',
      registry_code: '17499653',
      name: 'Test OÜ',
    });
    for (const p of [FEB, MAR]) {
      await periods.create({
        name: p.name,
        start_date: p.start,
        end_date: p.end,
      });
    }
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── helpers ────────────────────────────────────────────────────────

  async function seedCustomer(regKey: string): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'EE',
        name: 'Klient OÜ',
        goods_vs_services: 'services',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('entity_identifier')
      .values({
        entity_id: entity.id,
        kind: 'registration_key',
        value: regKey,
        confirmed: 1,
      })
      .execute();
    return entity.id;
  }

  /** A taxable advance receipt: Dr bank gross / Cr prepayments net / Cr VAT. */
  async function postAdvance(
    gross: number,
    date: string,
    customerId: number,
    documentNumber: string | null,
  ): Promise<{ voucherId: number; advanceId: number }> {
    const vat = Math.round((gross * 240) / 1240);
    const net = gross - vat;
    const voucher = await posting.postVoucher({
      tax_point_date: date,
      lines: [
        {
          account_code: 'BANK_EUR',
          amount: gross,
          currency: 'EUR',
          base_amount: gross,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: net,
          currency: 'EUR',
          base_amount: net,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: vat,
          currency: 'EUR',
          base_amount: vat,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
      ],
    });
    const advanceId = await advances.insertAdvance(
      {
        voucherId: voucher.id,
        kind: 'customer',
        accountCode: 'CUSTOMER_PREPAYMENTS',
        entityId: customerId,
        bankTransactionId: null,
        originalBaseAmount: net,
        currency: 'EUR',
        needsReview: false,
        origin: 'service',
        tax: {
          treatment: 'taxable_supply',
          vatCode: 'EE_OUTPUT_24',
          vatRatePermille: 240,
          grossBaseAmount: gross,
          vatBaseAmount: vat,
          supplyDescription: 'Website build',
          advanceDocumentNumber: documentNumber,
          advanceTaxPointDate: date,
          supersededByAdvanceId: null,
        },
      },
      db,
    );
    return { voucherId: voucher.id, advanceId };
  }

  /** A posted 24% sales invoice bound to the customer. */
  async function postInvoice(
    gross: number,
    date: string,
    customerId: number,
    invoiceNumber: string,
  ): Promise<number> {
    const vat = Math.round((gross * 240) / 1240);
    const net = gross - vat;
    const voucher = await posting.postVoucher({
      tax_point_date: date,
      lines: [
        {
          account_code: 'AR',
          amount: gross,
          currency: 'EUR',
          base_amount: gross,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'REVENUE',
          amount: net,
          currency: 'EUR',
          base_amount: net,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: vat,
          currency: 'EUR',
          base_amount: vat,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
      ],
    });
    const now = Math.floor(Date.now() / 1000);
    await db
      .insertInto('sales_invoice')
      .values({
        customer_id: customerId,
        invoice_number: invoiceNumber,
        gross_amount: gross,
        vat_amount: vat,
        currency: 'EUR',
        tax_point_date: date,
        due_date: null,
        status: 'posted',
        sent_at: null,
        voucher_id: voucher.id,
        document_vat_marking: null,
        document_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return voucher.id;
  }

  /** The draw-down voucher + allocation, as the service posts them. */
  async function postRelief(
    advanceId: number,
    invoiceVoucherId: number,
    net: number,
    vat: number,
    date: string,
    customerId: number,
  ): Promise<number> {
    const voucher = await posting.postVoucher({
      tax_point_date: date,
      lines: [
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: net,
          currency: 'EUR',
          base_amount: net,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: vat,
          currency: 'EUR',
          base_amount: vat,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
        {
          account_code: 'AR',
          amount: net + vat,
          currency: 'EUR',
          base_amount: net + vat,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    });
    await advances.insertAllocation(
      {
        advanceId,
        invoiceVoucherId,
        entityId: customerId,
        baseAmount: net,
        vatBaseAmount: vat,
        currency: 'EUR',
        allocationVoucherId: voucher.id,
        origin: 'service',
      },
      db,
    );
    return voucher.id;
  }

  const salesLines = (period: { start: string; end: string }) =>
    statutory.assembleSalesLines(period.start, period.end);

  // ── EMTA's own example ─────────────────────────────────────────────

  it('reports the final invoice LESS the advance already invoiced', async () => {
    const customerId = await seedCustomer('12345678');
    // Advance invoice of 2000 net (2480 gross) in the previous month.
    const advance = await postAdvance(2480, '2026-02-10', customerId, 'ETTE-1');
    // The transaction is 5000 net (6200 gross), invoiced in March.
    const invoiceVoucherId = await postInvoice(
      6200,
      '2026-03-05',
      customerId,
      'INV-1',
    );
    await postRelief(
      advance.advanceId,
      invoiceVoucherId,
      2000,
      480,
      '2026-03-05',
      customerId,
    );

    const march = await salesLines(MAR);
    const invoiceLine = march.find((l) => l.invoiceNumber === 'INV-1')!;
    // 5000 − 2000 = 3000 net, and the VAT with it. NOT 5000 plus a credit.
    expect(invoiceLine.netAmount).toBe(3000);
    expect(invoiceLine.vatAmount).toBe(720);
    expect(march.filter((l) => l.documentKind === 'advance_relief')).toEqual(
      [],
    );

    // February reports the advance document on its own, in its own period.
    const february = await salesLines(FEB);
    const advanceLine = february.find((l) => l.invoiceNumber === 'ETTE-1')!;
    expect(advanceLine.documentKind).toBe('advance_receipt');
    expect(advanceLine.netAmount).toBe(2000);
  });

  it('drops a 1500 invoice below the INF threshold once a 600 advance is netted into it', async () => {
    const customerId = await seedCustomer('12345678');
    const advance = await postAdvance(744, '2026-02-10', customerId, 'ETTE-2');
    const invoiceVoucherId = await postInvoice(
      1860,
      '2026-03-05',
      customerId,
      'INV-2',
    );
    await postRelief(
      advance.advanceId,
      invoiceVoucherId,
      600,
      144,
      '2026-03-05',
      customerId,
    );

    const march = await salesLines(MAR);
    const { rows } = buildInfPart(march, 'sales');
    // 1500 − 600 = 900 net, below the €1000 per-partner threshold, so the
    // partner has no INF row at all in March.
    expect(rows).toEqual([]);
  });

  // ── a reversal is an event with a date ─────────────────────────────

  it('keeps an advance in its own period when it is reversed in a LATER one, and reports the removal there', async () => {
    const customerId = await seedCustomer('12345678');
    const advance = await postAdvance(
      12400,
      '2026-02-10',
      customerId,
      'ETTE-3',
    );

    // A full mirror, posted in March.
    await posting.postVoucher({
      tax_point_date: '2026-03-04',
      reverses_id: advance.voucherId,
      lines: [
        {
          account_code: 'BANK_EUR',
          amount: 12400,
          currency: 'EUR',
          base_amount: 12400,
          fx_rate: 1,
          is_debit: false,
        },
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: 2400,
          currency: 'EUR',
          base_amount: 2400,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
      ],
    });

    // February's boxes still declare the advance, so February's documents
    // must still contain it — the reversal did not un-receive the money.
    const feb = await vatReports.buildDeclaration(
      (await periods.list()).find((p) => p.name === FEB.name)!.id,
    );
    expect(feb.row4_output_vat).toBe(2400);
    const february = await salesLines(FEB);
    expect(february.find((l) => l.invoiceNumber === 'ETTE-3')?.netAmount).toBe(
      10000,
    );

    // March's boxes carry the removal — but no cancellation document was
    // issued for it, and the advance invoice is not its own credit note. So
    // March reports no advance document at all and is HELD.
    const marchId = (await periods.list()).find((p) => p.name === MAR.name)!.id;
    const mar = await vatReports.buildDeclaration(marchId);
    expect(mar.row4_output_vat).toBe(-2400);
    const march = await salesLines(MAR);
    expect(march.filter((l) => l.documentKind.startsWith('advance_'))).toEqual(
      [],
    );
    expect(mar.unsupported_advance_reversals).toHaveLength(1);
    const snapshot = await vatReports.generate(marchId);
    await expect(
      statutory.freezeFilingSnapshot(marchId, snapshot.id, 'lock'),
    ).rejects.toThrow(/cannot show as documents/);
  });

  it('holds a third period when a reversal is itself reversed there', async () => {
    const customerId = await seedCustomer('12345678');
    const advance = await postAdvance(
      12400,
      '2026-02-10',
      customerId,
      'ETTE-9',
    );
    const mirror = (date: string, reversesId: number, flip: boolean) =>
      posting.postVoucher({
        tax_point_date: date,
        reverses_id: reversesId,
        lines: [
          {
            account_code: 'BANK_EUR',
            amount: 12400,
            currency: 'EUR',
            base_amount: 12400,
            fx_rate: 1,
            is_debit: flip,
          },
          {
            account_code: 'CUSTOMER_PREPAYMENTS',
            amount: 10000,
            currency: 'EUR',
            base_amount: 10000,
            fx_rate: 1,
            vat_code: 'EE_OUTPUT_24',
            is_debit: !flip,
          },
          {
            account_code: 'VAT_PAYABLE',
            amount: 2400,
            currency: 'EUR',
            base_amount: 2400,
            fx_rate: 1,
            vat_code: 'EE_OUTPUT_24',
            is_debit: !flip,
          },
        ],
      });

    const reversal = await mirror('2026-03-04', advance.voucherId, false);
    // A third period undoes the reversal itself — the amount comes back into
    // April's boxes, with nothing documented there either.
    await periods.create({
      name: '2026-04',
      start_date: '2026-04-01',
      end_date: '2026-04-30',
    });
    await mirror('2026-04-03', reversal.id, true);

    const aprilId = (await periods.list()).find(
      (p) => p.name === '2026-04',
    )!.id;
    const april = await vatReports.buildDeclaration(aprilId);
    expect(april.row4_output_vat).toBe(2400);
    expect(april.unsupported_advance_reversals).toHaveLength(1);
    const snapshot = await vatReports.generate(aprilId);
    await expect(
      statutory.freezeFilingSnapshot(aprilId, snapshot.id, 'lock'),
    ).rejects.toThrow(/cannot show as documents/);
  });

  it('nets an advance out of its own period when the mirror is dated in it', async () => {
    const customerId = await seedCustomer('12345678');
    const advance = await postAdvance(
      12400,
      '2026-02-10',
      customerId,
      'ETTE-4',
    );
    await posting.postVoucher({
      tax_point_date: '2026-02-20',
      reverses_id: advance.voucherId,
      lines: [
        {
          account_code: 'BANK_EUR',
          amount: 12400,
          currency: 'EUR',
          base_amount: 12400,
          fx_rate: 1,
          is_debit: false,
        },
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: 2400,
          currency: 'EUR',
          base_amount: 2400,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
      ],
    });

    // Both legs are in February and cancel: the boxes are zero, and so are
    // the documents.
    const feb = await vatReports.buildDeclaration(
      (await periods.list()).find((p) => p.name === FEB.name)!.id,
    );
    expect(feb.row4_output_vat).toBe(0);
    const february = await salesLines(FEB);
    expect(february.filter((l) => l.invoiceNumber === 'ETTE-4')).toEqual([]);
  });

  it('holds the filing when a counter-voucher mirrors an advance only in part', async () => {
    const customerId = await seedCustomer('12345678');
    const advance = await postAdvance(
      12400,
      '2026-02-10',
      customerId,
      'ETTE-5',
    );
    await posting.postVoucher({
      tax_point_date: '2026-02-20',
      reverses_id: advance.voucherId,
      lines: [
        {
          account_code: 'BANK_EUR',
          amount: 5000,
          currency: 'EUR',
          base_amount: 5000,
          fx_rate: 1,
          is_debit: false,
        },
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: 5000,
          currency: 'EUR',
          base_amount: 5000,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
      ],
    });

    const periodId = (await periods.list()).find(
      (p) => p.name === FEB.name,
    )!.id;
    const declaration = await vatReports.buildDeclaration(periodId);
    expect(declaration.unsupported_advance_reversals).toHaveLength(1);
    expect(declaration.review_flags.join(' ')).toContain(
      'does not mirror them completely',
    );

    // The document is NOT dropped — the period still shows what it declared.
    const february = await salesLines(FEB);
    expect(february.find((l) => l.invoiceNumber === 'ETTE-5')).toBeDefined();

    // A draft renders, and names the shape as blocking a final return.
    const drafted = await statutory.generate(periodId, { formats: ['xml'] });
    expect(
      drafted.warnings.find((w) => w.code === 'unsupported_advance_reversal')
        ?.blocksFinal,
    ).toBe(true);

    // And no filing payload is FROZEN on a shape nobody can reconcile.
    const snapshot = await vatReports.generate(periodId);
    await expect(
      statutory.freezeFilingSnapshot(periodId, snapshot.id, 'lock'),
    ).rejects.toThrow(/cannot show as documents/);
  });

  it('holds the later period when a draw-down is reversed in it', async () => {
    const customerId = await seedCustomer('12345678');
    const advance = await postAdvance(
      12400,
      '2026-02-10',
      customerId,
      'ETTE-7',
    );
    const invoiceVoucherId = await postInvoice(
      12400,
      '2026-02-20',
      customerId,
      'INV-7',
    );
    const reliefVoucherId = await postRelief(
      advance.advanceId,
      invoiceVoucherId,
      10000,
      2400,
      '2026-02-20',
      customerId,
    );

    // The draw-down is undone in MARCH: its legs put the advance's VAT back
    // into March's boxes, while the invoice it was netted out of is in
    // February — very likely already filed.
    await posting.postVoucher({
      tax_point_date: '2026-03-04',
      reverses_id: reliefVoucherId,
      lines: [
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: 2400,
          currency: 'EUR',
          base_amount: 2400,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
        {
          account_code: 'AR',
          amount: 12400,
          currency: 'EUR',
          base_amount: 12400,
          fx_rate: 1,
          is_debit: true,
        },
      ],
    });

    const marchId = (await periods.list()).find((p) => p.name === MAR.name)!.id;
    const mar = await vatReports.buildDeclaration(marchId);
    // The boxes really do carry it back...
    expect(mar.row4_output_vat).toBe(2400);
    // ...and there is no document for that, so the period is held rather
    // than filed with a paper nobody issued.
    expect(mar.unsupported_advance_reversals).toHaveLength(1);
    const snapshot = await vatReports.generate(marchId);
    await expect(
      statutory.freezeFilingSnapshot(marchId, snapshot.id, 'lock'),
    ).rejects.toThrow(/cannot show as documents/);

    // February is untouched: its own documents still net as they were filed.
    const february = await salesLines(FEB);
    expect(february.find((l) => l.invoiceNumber === 'INV-7')?.netAmount).toBe(
      0,
    );
  });

  it('holds the later period when a refund is reversed in it', async () => {
    const customerId = await seedCustomer('12345678');
    const advance = await postAdvance(
      12400,
      '2026-02-10',
      customerId,
      'ETTE-8',
    );
    const refundVoucher = await posting.postVoucher({
      tax_point_date: '2026-02-20',
      lines: [
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: 2400,
          currency: 'EUR',
          base_amount: 2400,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: true,
        },
        {
          account_code: 'BANK_EUR',
          amount: 12400,
          currency: 'EUR',
          base_amount: 12400,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    });
    const statement = await db
      .insertInto('bank_statement')
      .values({
        account_id: 1,
        start_date: '2026-02-01',
        end_date: '2026-02-28',
        uploaded_at: 1,
        file_path: null,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const bankTxn = await db
      .insertInto('bank_transaction')
      .values({
        statement_id: statement.id,
        transaction_date: '2026-02-20',
        description: 'Refund',
        amount: -12400,
        currency: 'EUR',
        status: 'prepayment',
        created_at: 1,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    await advances.insertRefund(
      {
        advanceId: advance.advanceId,
        voucherId: refundVoucher.id,
        bankTransactionId: bankTxn.id,
        netBaseAmount: 10000,
        vatBaseAmount: 2400,
        currency: 'EUR',
        creditReference: 'KREEDIT-8',
        reason: 'Order cancelled',
        refundDate: '2026-02-20',
      },
      db,
    );

    // The refund is undone in MARCH.
    await posting.postVoucher({
      tax_point_date: '2026-03-04',
      reverses_id: refundVoucher.id,
      lines: [
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: 2400,
          currency: 'EUR',
          base_amount: 2400,
          fx_rate: 1,
          vat_code: 'EE_OUTPUT_24',
          is_debit: false,
        },
        {
          account_code: 'BANK_EUR',
          amount: 12400,
          currency: 'EUR',
          base_amount: 12400,
          fx_rate: 1,
          is_debit: true,
        },
      ],
    });

    const marchId = (await periods.list()).find((p) => p.name === MAR.name)!.id;
    const mar = await vatReports.buildDeclaration(marchId);
    expect(mar.row4_output_vat).toBe(2400);
    expect(mar.unsupported_advance_reversals).toHaveLength(1);
    const snapshot = await vatReports.generate(marchId);
    await expect(
      statutory.freezeFilingSnapshot(marchId, snapshot.id, 'lock'),
    ).rejects.toThrow(/cannot show as documents/);
  });

  it('never files a relief that could not be netted into an invoice row', async () => {
    // A relief whose target is not a sales invoice of the period: the row
    // that reaches INF assembly must not become a credit invoice nobody
    // issued — it blocks the final return instead.
    const line: StatutoryDocLine = {
      documentKind: 'advance_relief',
      counterpartyName: 'Klient OÜ',
      counterpartyRegNumber: '12345678',
      invoiceNumber: null,
      creditsInvoiceNumber: 'ETTE-6',
      date: '2026-03-05',
      vatCode: 'EE_OUTPUT_24',
      netAmount: -200000,
      vatAmount: -48000,
    };
    const { rows, warnings } = buildInfPart([line], 'sales');
    expect(rows).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('advance_relief_unmatched_invoice');
    expect(warnings[0].blocksFinal).toBe(true);
  });

  it('blocks a final return for an INF-reportable advance with no document number', async () => {
    const line: StatutoryDocLine = {
      documentKind: 'advance_receipt',
      counterpartyName: 'Klient OÜ',
      counterpartyRegNumber: '12345678',
      invoiceNumber: null,
      creditsInvoiceNumber: null,
      date: '2026-02-10',
      vatCode: 'EE_OUTPUT_24',
      netAmount: 200000,
      vatAmount: 48000,
    };
    const { rows, warnings } = buildInfPart([line], 'sales');
    expect(rows).toHaveLength(1);
    const blocking = warnings.find(
      (w) => w.code === 'advance_missing_document_number',
    )!;
    expect(blocking.blocksFinal).toBe(true);
    expect(blocking.message).toContain('/advance-document');
  });
});
