import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { BankStatementService } from '../bank/bank-statement.service';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { EntitiesService } from '../entities/entities.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OutstandingVoucherService } from './outstanding-voucher.service';
import { PrepaymentAllocationRepository } from './prepayment-allocation.repository';
import { PrepaymentService } from './prepayment.service';
import { VatReportService } from '../vat-report/vat-report.service';

/**
 * Issue #213 — a customer advance on an identified taxable supply.
 *
 * EE VAT arises on the earlier of the supply and the payment for it (KMS §11
 * lg 1), so a 124.00 advance on a 24% domestic service declares 24.00 of
 * output VAT on the day the money arrives, and the final invoice must not
 * declare it a second time.
 */
describe('customer advance VAT (#213)', () => {
  let db: Kysely<Database>;
  let prepayments: PrepaymentService;
  let statements: BankStatementService;
  let organization: OrganizationService;
  let posting: PostingService;
  let vatReports: VatReportService;
  let voucherCounter = 0;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
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
        AccountService,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        BankTransactionRepository,
        BankStatementService,
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        CurrencyService,
        OrgContextResolver,
        EntitiesService,
        LedgerBalanceService,
        OutstandingVoucherService,
        PrepaymentAllocationRepository,
        PrepaymentService,
        VatReportService,
      ],
    }).compile();

    prepayments = module.get(PrepaymentService);
    statements = module.get(BankStatementService);
    organization = module.get(OrganizationService);
    posting = module.get(PostingService);
    vatReports = module.get(VatReportService);

    await organization.updateOrganization({
      country: 'EE',
      vat_registered: true,
      vat_registration_number: 'EE100000001',
      registry_code: '17499653',
      name: 'Test OÜ',
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ── helpers ────────────────────────────────────────────────────────

  async function seedBankTransaction(
    amount: number,
    date = '2026-02-10',
    counterpartyIban?: string,
  ) {
    const stmt = await statements.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      transactions: [
        {
          transaction_date: date,
          description: amount > 0 ? 'Advance received' : 'Advance refunded',
          amount,
          currency: 'EUR',
          counterparty_iban: counterpartyIban ?? null,
          status: 'open',
        },
      ],
    });
    return stmt.transactions[0];
  }

  async function seedCustomer(name: string, iban?: string): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'EE',
        name,
        goods_vs_services: 'services',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (iban) {
      await db
        .insertInto('entity_identifier')
        .values({
          entity_id: row.id,
          kind: 'iban',
          value: iban,
          confirmed: 1,
        })
        .execute();
    }
    return row.id;
  }

  /** A posted 24% domestic sales invoice: Dr AR / Cr REVENUE / Cr VAT_PAYABLE. */
  async function seedTaxedSalesInvoice(
    net: number,
    vat: number,
    taxPointDate: string,
    customerId: number,
    vatCode = 'EE_OUTPUT_24',
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    voucherCounter++;
    const posted = await posting.postVoucher({
      tax_point_date: taxPointDate,
      lines: [
        {
          account_code: 'AR',
          amount: net + vat,
          currency: 'EUR',
          base_amount: net + vat,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'REVENUE',
          amount: net,
          currency: 'EUR',
          base_amount: net,
          fx_rate: 1,
          vat_code: vatCode,
          is_debit: false,
        },
        {
          account_code: 'VAT_PAYABLE',
          amount: vat,
          currency: 'EUR',
          base_amount: vat,
          fx_rate: 1,
          vat_code: vatCode,
          is_debit: false,
        },
      ],
    });
    await db
      .insertInto('sales_invoice')
      .values({
        customer_id: customerId,
        invoice_number: `INV-${voucherCounter}`,
        gross_amount: net + vat,
        vat_amount: vat,
        currency: 'EUR',
        tax_point_date: taxPointDate,
        due_date: null,
        status: 'posted',
        sent_at: null,
        voucher_id: posted.id,
        document_vat_marking: null,
        document_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return posted.id;
  }

  async function seedPeriod(
    name: string,
    start: string,
    end: string,
  ): Promise<number> {
    const row = await db
      .insertInto('reporting_period')
      .values({
        name,
        start_date: start,
        end_date: end,
        status: 'open',
        kind: 'vat',
        created_at: Math.floor(Date.now() / 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Signed base on one account across a voucher: debits positive. */
  async function legOf(voucherId: number, code: string): Promise<number> {
    const rows = await db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select(['voucher_line.base_amount', 'voucher_line.is_debit'])
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', '=', code)
      .execute();
    return rows.reduce(
      (sum, r) => sum + (r.is_debit === 1 ? r.base_amount : -r.base_amount),
      0,
    );
  }

  const TAXABLE = {
    treatment: 'taxable_supply' as const,
    vatCode: 'EE_OUTPUT_24',
    supplyDescription: 'Website build, delivery March 2026',
    advanceDocumentNumber: 'ETTEMAKS-1',
  };

  // ── the issue's own case ───────────────────────────────────────────

  it('declares 24 EUR of VAT on a 124 EUR domestic taxable advance, at the receipt date', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');

    const voucher = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      TAXABLE,
    );

    // Dr bank 124 / Cr CUSTOMER_PREPAYMENTS 100 / Cr VAT_PAYABLE 24.
    expect(await legOf(voucher.id, 'BANK_EUR')).toBe(12400);
    expect(await legOf(voucher.id, 'CUSTOMER_PREPAYMENTS')).toBe(-10000);
    expect(await legOf(voucher.id, 'VAT_PAYABLE')).toBe(-2400);
    expect(voucher.tax_point_date).toBe('2026-02-10');

    // And it lands in the period's declaration: base 100 in row 1, VAT 24 in
    // row 4 — the figures the issue says were zero.
    const period = await seedPeriod('2026-02', '2026-02-01', '2026-02-28');
    const declaration = await vatReports.buildDeclaration(period);
    expect(declaration.row1_base_24).toBe(10000);
    expect(declaration.row4_output_vat).toBe(2400);
  });

  it('records the advance facts, and reports its remaining credit gross', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');
    await prepayments.createCustomerPrepayment(txn.id, customerId, TAXABLE);

    const [listed] = await prepayments.listOutstandingPrepayments();
    expect(listed.tax.treatment).toBe('taxable_supply');
    expect(listed.tax.vatCode).toBe('EE_OUTPUT_24');
    expect(listed.tax.vatRatePermille).toBe(240);
    expect(listed.tax.grossBaseAmount).toBe(12400);
    expect(listed.tax.vatBaseAmount).toBe(2400);
    expect(listed.tax.advanceTaxPointDate).toBe('2026-02-10');
    expect(listed.tax.supplyDescription).toBe(TAXABLE.supplyDescription);
    // The liability is the NET; the credit that can be applied is the gross.
    expect(listed.remaining).toBe(10000);
    expect(listed.remainingVat).toBe(2400);
    expect(listed.remainingGross).toBe(12400);
    expect(listed.allocatable).toBe(true);
  });

  // ── the three kinds of receipt ─────────────────────────────────────

  it('keeps a non-taxable deposit a gross liability that declares nothing', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');

    const voucher = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      {
        treatment: 'non_taxable_deposit',
        supplyDescription: 'Security deposit, returnable',
      },
    );

    expect(await legOf(voucher.id, 'CUSTOMER_PREPAYMENTS')).toBe(-12400);
    expect(await legOf(voucher.id, 'VAT_PAYABLE')).toBe(0);

    const period = await seedPeriod('2026-02', '2026-02-01', '2026-02-28');
    const declaration = await vatReports.buildDeclaration(period);
    expect(declaration.row1_base_24).toBe(0);
    expect(declaration.row4_output_vat).toBe(0);
    expect(declaration.unresolved_advance_receipts).toEqual([]);
  });

  it('records an unclassified receipt but HOLDS it, and names it in the declaration', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');

    // A bodyless create — the existing client's call.
    const voucher = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
    );
    expect(await legOf(voucher.id, 'CUSTOMER_PREPAYMENTS')).toBe(-12400);

    const [listed] = await prepayments.listOutstandingPrepayments();
    expect(listed.tax.treatment).toBe('unresolved');
    expect(listed.allocatable).toBe(false);
    expect(listed.unresolvedReason).toBe('unclassified_tax_treatment');

    const invoiceVoucherId = await seedTaxedSalesInvoice(
      10000,
      2400,
      '2026-03-05',
      customerId,
    );
    await expect(
      prepayments.drawDownPrepayment(voucher.id, invoiceVoucherId, 12400),
    ).rejects.toThrow('no tax treatment');

    const period = await seedPeriod('2026-02', '2026-02-01', '2026-02-28');
    const declaration = await vatReports.buildDeclaration(period);
    expect(declaration.unresolved_advance_receipts).toEqual([
      voucher.voucher_number,
    ]);
    expect(declaration.unresolved_advance_base).toBe(12400);
    expect(declaration.review_flags.join(' ')).toContain('tax-treatment');
  });

  it('leaves a supplier advance working with no tax classification at all', async () => {
    // The hold is an OUTPUT-VAT question. Money we pay a supplier declares no
    // output VAT, so the supplier workflow is untouched by #213.
    const now = Math.floor(Date.now() / 1000);
    const supplierId = (
      await db
        .insertInto('entity')
        .values({
          role: 'supplier',
          country: 'EE',
          name: 'Tarnija OÜ',
          goods_vs_services: 'services',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    ).id;
    const txn = await seedBankTransaction(-5000, '2026-02-10');

    const voucher = await prepayments.createSupplierPrepayment(
      txn.id,
      supplierId,
    );
    expect(await legOf(voucher.id, 'SUPPLIER_PREPAYMENTS')).toBe(5000);

    const [listed] = await prepayments.listOutstandingPrepayments();
    expect(listed.tax.treatment).toBe('unresolved');
    expect(listed.allocatable).toBe(true);
    expect(listed.unresolvedReason).toBeNull();
  });

  // ── final settlement ───────────────────────────────────────────────

  it('relieves the advance VAT exactly once, in the invoice period, across periods', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');
    const advance = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      TAXABLE,
    );

    // The supply is invoiced in the NEXT period, for the same 124.
    const invoiceVoucherId = await seedTaxedSalesInvoice(
      10000,
      2400,
      '2026-03-05',
      customerId,
    );
    const relief = await prepayments.drawDownPrepayment(
      advance.id,
      invoiceVoucherId,
      12400,
    );

    // Dr CUSTOMER_PREPAYMENTS 100 / Dr VAT_PAYABLE 24 / Cr AR 124, dated at
    // the INVOICE's tax point — not at today's date.
    expect(relief.tax_point_date).toBe('2026-03-05');
    expect(await legOf(relief.id, 'CUSTOMER_PREPAYMENTS')).toBe(10000);
    expect(await legOf(relief.id, 'VAT_PAYABLE')).toBe(2400);
    expect(await legOf(relief.id, 'AR')).toBe(-12400);

    const february = await seedPeriod('2026-02', '2026-02-01', '2026-02-28');
    const march = await seedPeriod('2026-03', '2026-03-01', '2026-03-31');

    // February declared the advance. March declares the supply and releases
    // the advance's VAT in the SAME period: 24 − 24 = 0, never 48.
    const feb = await vatReports.buildDeclaration(february);
    expect(feb.row4_output_vat).toBe(2400);
    expect(feb.row1_base_24).toBe(10000);
    const mar = await vatReports.buildDeclaration(march);
    expect(mar.row4_output_vat).toBe(0);
    expect(mar.row1_base_24).toBe(0);

    // The receivable is fully relieved, and the advance is spent.
    const remaining = await prepayments.listOutstandingPrepayments();
    expect(remaining.find((p) => p.voucherId === advance.id)).toBeUndefined();
  });

  it('splits partial draw-downs proportionally and gives the last slice the exact remaining cents', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    // 100.03 gross at 24% → 19.36 VAT, 80.67 net. Awkward on purpose.
    const txn = await seedBankTransaction(10003, '2026-02-10');
    const advance = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      TAXABLE,
    );
    const declared = (await prepayments.listOutstandingPrepayments())[0];
    expect(declared.tax.vatBaseAmount).toBe(1936);

    const firstInvoice = await seedTaxedSalesInvoice(
      2000,
      480,
      '2026-03-05',
      customerId,
    );
    const secondInvoice = await seedTaxedSalesInvoice(
      6455,
      1549,
      '2026-03-06',
      customerId,
    );

    const firstRelief = await prepayments.drawDownPrepayment(
      advance.id,
      firstInvoice,
      2480,
    );
    expect(await legOf(firstRelief.id, 'VAT_PAYABLE')).toBe(480);

    const secondRelief = await prepayments.drawDownPrepayment(
      advance.id,
      secondInvoice,
      8004,
    );
    // The remainder to the cent: 1936 − 480 = 1456.
    expect(await legOf(secondRelief.id, 'VAT_PAYABLE')).toBe(1456);

    const march = await seedPeriod('2026-03', '2026-03-01', '2026-03-31');
    const mar = await vatReports.buildDeclaration(march);
    // Both invoices declared their own VAT; both reliefs took the advance's
    // back. Nothing is left over on either side.
    expect(mar.row4_output_vat).toBe(480 + 1549 - 480 - 1456);
    const still = await prepayments.listOutstandingPrepayments();
    expect(still.find((p) => p.voucherId === advance.id)).toBeUndefined();
  });

  // ── explicitly unsupported combinations ────────────────────────────

  it('holds a draw-down whose invoice is taxed at a different rate than the advance', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    // Received under the 22% era: the advance keeps 22%.
    const txn = await seedBankTransaction(12200, '2025-05-10');
    const advance = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      TAXABLE,
    );
    const listed = (await prepayments.listOutstandingPrepayments())[0];
    expect(listed.tax.vatRatePermille).toBe(220);
    expect(listed.tax.vatBaseAmount).toBe(2200);

    // The supply is invoiced after 2025-07-01, at 24%.
    const invoiceVoucherId = await seedTaxedSalesInvoice(
      10000,
      2400,
      '2025-08-05',
      customerId,
    );

    await expect(
      prepayments.drawDownPrepayment(advance.id, invoiceVoucherId, 12200),
    ).rejects.toThrow(/taxed at 22% .* taxed at 24%/s);
  });

  it('refuses to declare an advance for a limited taxable person', async () => {
    await organization.updateOrganization({ vat_registration_kind: 'limited' });
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');

    await expect(
      prepayments.createCustomerPrepayment(txn.id, customerId, TAXABLE),
    ).rejects.toThrow(/limited taxable person/);

    // Nothing was posted, and the money is not on the books as an advance.
    const vouchers = await db
      .selectFrom('voucher')
      .select('id')
      .executeTakeFirst();
    expect(vouchers).toBeUndefined();
  });

  it('refuses to treat a payment for an intra-Community supply as an advance tax point', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');

    await expect(
      prepayments.createCustomerPrepayment(txn.id, customerId, {
        treatment: 'taxable_supply',
        vatCode: 'EE_OUTPUT_0_EU',
        supplyDescription: 'Consulting for a FI business',
      }),
    ).rejects.toThrow(/intra-Community supply is excluded/);
  });

  it('refuses a taxable advance that does not say which supply it pays for', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');

    await expect(
      prepayments.createCustomerPrepayment(txn.id, customerId, {
        treatment: 'taxable_supply',
        vatCode: 'EE_OUTPUT_24',
      }),
    ).rejects.toThrow('supply_description');
  });

  // ── refunds ────────────────────────────────────────────────────────

  it('takes the declared VAT back with a refund, once, and refuses a repeat', async () => {
    const iban = 'EE381700017000000001';
    const customerId = await seedCustomer('Klient OÜ', iban);
    const txn = await seedBankTransaction(12400, '2026-02-10', iban);
    const advance = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      TAXABLE,
    );

    const refundTxn = await seedBankTransaction(-12400, '2026-03-12', iban);
    const refund = await prepayments.refundAdvance(advance.id, {
      bankTransactionId: refundTxn.id,
      creditReference: 'KREEDIT-1',
      reason: 'Order cancelled by the customer',
    });

    expect(await legOf(refund.id, 'CUSTOMER_PREPAYMENTS')).toBe(10000);
    expect(await legOf(refund.id, 'VAT_PAYABLE')).toBe(2400);
    expect(await legOf(refund.id, 'BANK_EUR')).toBe(-12400);
    expect(refund.tax_point_date).toBe('2026-03-12');

    const march = await seedPeriod('2026-03', '2026-03-01', '2026-03-31');
    const mar = await vatReports.buildDeclaration(march);
    expect(mar.row4_output_vat).toBe(-2400);
    expect(mar.row1_base_24).toBe(-10000);

    // Nothing is left, and the same bank line cannot be refunded twice.
    const remaining = await prepayments.listOutstandingPrepayments();
    expect(remaining.find((p) => p.voucherId === advance.id)).toBeUndefined();
    await expect(
      prepayments.refundAdvance(advance.id, {
        bankTransactionId: refundTxn.id,
        creditReference: 'KREEDIT-1',
        reason: 'retry',
      }),
    ).rejects.toThrow('already recorded as refund voucher');
  });

  it('refuses a refund with no cancellation document, and one paid to somebody else', async () => {
    const iban = 'EE381700017000000001';
    const customerId = await seedCustomer('Klient OÜ', iban);
    const txn = await seedBankTransaction(12400, '2026-02-10', iban);
    const advance = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      TAXABLE,
    );

    const refundTxn = await seedBankTransaction(-12400, '2026-03-12', iban);
    await expect(
      prepayments.refundAdvance(advance.id, {
        bankTransactionId: refundTxn.id,
        creditReference: '  ',
        reason: 'Order cancelled',
      }),
    ).rejects.toThrow('credit_reference');

    // A payment to an unidentified counterparty is not this customer's refund.
    const strangerTxn = await seedBankTransaction(-12400, '2026-03-12');
    await expect(
      prepayments.refundAdvance(advance.id, {
        bankTransactionId: strangerTxn.id,
        creditReference: 'KREEDIT-2',
        reason: 'Order cancelled',
      }),
    ).rejects.toThrow('no deterministically identified counterparty');
  });

  it('refuses a foreign-currency refund rather than moving VAT with an exchange rate', async () => {
    const iban = 'EE381700017000000001';
    const customerId = await seedCustomer('Klient OÜ', iban);
    const txn = await seedBankTransaction(12400, '2026-02-10', iban);
    const advance = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      TAXABLE,
    );

    const stmt = await statements.createStatement({
      account_code: 'BANK_EUR',
      start_date: '2026-03-01',
      end_date: '2026-03-31',
      transactions: [
        {
          transaction_date: '2026-03-12',
          description: 'Advance refunded in USD',
          amount: -13000,
          currency: 'USD',
          counterparty_iban: iban,
          status: 'open',
        },
      ],
    });

    await expect(
      prepayments.refundAdvance(advance.id, {
        bankTransactionId: stmt.transactions[0].id,
        creditReference: 'KREEDIT-3',
        reason: 'Order cancelled',
      }),
    ).rejects.toThrow(/Refunding across currencies/);
  });

  // ── classification of a held receipt ───────────────────────────────

  it('reclassifies a held receipt as taxable by reversing and reposting it', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');
    const held = await prepayments.createCustomerPrepayment(txn.id, customerId);

    const classified = await prepayments.classifyAdvance(held.id, TAXABLE);
    expect(classified.tax.treatment).toBe('taxable_supply');
    expect(classified.tax.vatBaseAmount).toBe(2400);
    expect(classified.voucherId).not.toBe(held.id);

    // The original voucher is REVERSED, never edited, and the replacement is
    // dated at the same receipt.
    const reversal = await db
      .selectFrom('voucher')
      .select(['id', 'tax_point_date'])
      .where('reverses_id', '=', held.id)
      .executeTakeFirstOrThrow();
    expect(reversal.tax_point_date).toBe('2026-02-10');
    expect(await legOf(classified.voucherId, 'VAT_PAYABLE')).toBe(-2400);

    // And the period declares the advance exactly once.
    const period = await seedPeriod('2026-02', '2026-02-01', '2026-02-28');
    const declaration = await vatReports.buildDeclaration(period);
    expect(declaration.row4_output_vat).toBe(2400);
    expect(declaration.row1_base_24).toBe(10000);
    expect(declaration.unresolved_advance_receipts).toEqual([]);
  });

  it('refuses to reclassify a receipt that has already been used', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');
    const held = await prepayments.createCustomerPrepayment(txn.id, customerId);
    await prepayments.classifyAdvance(held.id, {
      treatment: 'non_taxable_deposit',
    });

    await expect(prepayments.classifyAdvance(held.id, TAXABLE)).rejects.toThrow(
      'already classified',
    );
  });

  it('lets only one of two concurrent classifications win, with no second history', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');
    const held = await prepayments.createCustomerPrepayment(txn.id, customerId);

    const results = await Promise.allSettled([
      prepayments.classifyAdvance(held.id, TAXABLE),
      prepayments.classifyAdvance(held.id, {
        treatment: 'non_taxable_deposit',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    // One receipt, one history: at most one reversal of the original and no
    // second bank leg for the same money.
    const reversals = await db
      .selectFrom('voucher')
      .select('id')
      .where('reverses_id', '=', held.id)
      .execute();
    expect(reversals.length).toBeLessThanOrEqual(1);

    const bankLegs = await db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select(['voucher_line.base_amount', 'voucher_line.is_debit'])
      .where('account.code', '=', 'BANK_EUR')
      .execute();
    const bankNet = bankLegs.reduce(
      (sum, r) => sum + (r.is_debit === 1 ? r.base_amount : -r.base_amount),
      0,
    );
    expect(bankNet).toBe(12400);
  });

  it('lets only one of two concurrent taxable reclassifications win', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');
    const held = await prepayments.createCustomerPrepayment(txn.id, customerId);

    const results = await Promise.allSettled([
      prepayments.classifyAdvance(held.id, TAXABLE),
      prepayments.classifyAdvance(held.id, TAXABLE),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const advances = await db
      .selectFrom('prepayment_advance')
      .select(['id', 'tax_treatment', 'superseded_by_advance_id'])
      .execute();
    // The original, superseded once, and exactly one replacement.
    expect(advances).toHaveLength(2);
    expect(
      advances.filter((a) => a.tax_treatment === 'taxable_supply'),
    ).toHaveLength(1);

    const period = await seedPeriod('2026-02', '2026-02-01', '2026-02-28');
    const declaration = await vatReports.buildDeclaration(period);
    expect(declaration.row4_output_vat).toBe(2400);
  });

  // ── proved reversals ───────────────────────────────────────────────

  it('holds an advance whose counter-voucher mirrors it only in part', async () => {
    const customerId = await seedCustomer('Klient OÜ');
    const txn = await seedBankTransaction(12400, '2026-02-10');
    const advance = await prepayments.createCustomerPrepayment(
      txn.id,
      customerId,
      TAXABLE,
    );
    const invoiceVoucherId = await seedTaxedSalesInvoice(
      10000,
      2400,
      '2026-03-05',
      customerId,
    );
    const relief = await prepayments.drawDownPrepayment(
      advance.id,
      invoiceVoucherId,
      12400,
    );

    // A hand-posted counter-voucher that takes back only part of the relief.
    await posting.postVoucher({
      tax_point_date: '2026-03-06',
      reverses_id: relief.id,
      lines: [
        {
          account_code: 'AR',
          amount: 5000,
          currency: 'EUR',
          base_amount: 5000,
          fx_rate: 1,
          is_debit: true,
        },
        {
          account_code: 'CUSTOMER_PREPAYMENTS',
          amount: 5000,
          currency: 'EUR',
          base_amount: 5000,
          fx_rate: 1,
          is_debit: false,
        },
      ],
    });

    const listed = (await prepayments.listOutstandingPrepayments()).find(
      (p) => p.voucherId === advance.id,
    );
    expect(listed?.allocatable).toBe(false);
    expect(listed?.unresolvedReason).toBe('vat_relief_unverified');
    await expect(
      prepayments.drawDownPrepayment(advance.id, invoiceVoucherId, 1000),
    ).rejects.toThrow('cannot be proved complete');
  });
});
