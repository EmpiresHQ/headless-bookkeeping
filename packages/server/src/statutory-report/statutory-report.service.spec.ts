import { fxTestProviders } from '../../test/fx-fixtures';
import { DraftVoucherLine } from '../ledger/voucher/types';
import { validateAgainstKmdXsd } from '../plugins/estonia-kmd/xsd-validate';
import { readFileSync } from 'fs';
import { join } from 'path';
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
import { CreditNotesService } from '../credit-notes/credit-notes.service';

/**
 * Integration test for Task 19: StatutoryReportService.generate — assemble the
 * neutral StatutoryReportInput and delegate rendering to the active country
 * plugin (ADR-0002). Real-DI against in-memory SQLite.
 *
 * The migration seeds reporting_period 1 = 2024-Q1 (open). We exercise the real
 * EE plugin by setting org.country = 'EE'.
 */
describe('StatutoryReportService.generate (integration)', () => {
  let db: Kysely<Database>;
  let service: StatutoryReportService;
  let organization: OrganizationService;
  let salesInvoices: SalesInvoicesService;
  let creditNotes: CreditNotesService;
  let posting: PostingService;
  let auditFindings: AuditFindingsService;
  let vatReports: VatReportService;
  let periods: ReportingPeriodsService;

  const PERIOD_ID = 1; // seeded 2024-Q1

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
        CreditNotesService,
        AuditFindingsService,
        VatReportService,
        StatutoryReportService,
        StatutorySubmissionService,
        AuditLogService,
        ReportingPeriodsService,
      ],
    }).compile();

    service = module.get(StatutoryReportService);
    vatReports = module.get(VatReportService);
    organization = module.get(OrganizationService);
    salesInvoices = module.get(SalesInvoicesService);
    creditNotes = module.get(CreditNotesService);
    posting = module.get(PostingService);
    auditFindings = module.get(AuditFindingsService);
    periods = module.get(ReportingPeriodsService);

    // Make EE the active plugin and give the declarant a valid reg number.
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

  /** Create a customer entity carrying a registration_key (B2B). */
  async function createRegisteredCustomer(
    regNumber: string,
    name = 'Acme Buyer OÜ',
  ): Promise<number> {
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'EE',
        name,
        goods_vs_services: 'goods',
        created_at: 0,
        updated_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('entity_identifier')
      .values({
        entity_id: entity.id,
        kind: 'registration_key',
        value: regNumber,
        confirmed: 1,
      })
      .execute();
    return entity.id;
  }

  /** Post a domestic sales invoice (Dr AR / Cr REVENUE / Cr VAT_PAYABLE @24%). */
  async function postSalesInvoice({
    customerId,
    invoiceNumber,
    net,
    taxPointDate = '2024-02-15',
  }: {
    customerId: number | null;
    invoiceNumber: string;
    net: number;
    taxPointDate?: string;
  }): Promise<number> {
    const vat = Math.round(net * 0.24);
    const inv = await salesInvoices.createInvoice({
      customer_id: customerId,
      invoice_number: invoiceNumber,
      gross_amount: net + vat,
      vat_amount: vat,
      currency: 'EUR',
      tax_point_date: taxPointDate,
      due_date: null,
    });
    const draft = await salesInvoices.generateDraftVoucher(inv.id);
    const posted = await posting.postVoucher(draft);
    await salesInvoices.updateInvoiceStatus(inv.id, 'posted', posted.id);
    return inv.id;
  }

  it('produces artifacts for a period with a posted sales invoice', async () => {
    const customerId = await createRegisteredCustomer('EE200000002');
    await postSalesInvoice({
      customerId,
      invoiceNumber: 'INV-100',
      net: 200000, // €2000 net, above the INF €1000 threshold
    });

    const result = await service.generate(PERIOD_ID, { formats: ['xml'] });

    expect(
      result.artifacts.find((a) => a.filename.endsWith('.xml')),
    ).toBeDefined();
  });

  it('includes a credit note as a credit_note line in the output', async () => {
    const customerId = await createRegisteredCustomer('EE200000002');
    const invId = await postSalesInvoice({
      customerId,
      invoiceNumber: 'INV-200',
      net: 200000, // €2000 net
    });

    // A sales credit note against that invoice, in the same period.
    await creditNotes.create({
      credits_object_type: 'sales_invoice',
      credits_object_id: invId,
      credit_note_number: 'CN-200',
      gross_amount: 124000, // €1240 gross (€1000 net + €240 VAT)
      vat_amount: 24000,
      tax_point_date: '2024-02-20',
    });

    const result = await service.generate(PERIOD_ID, { formats: ['xml'] });
    const xml = result.artifacts[0].content;
    // The credit note number surfaces as an invoiceNumber on its INF line.
    expect(xml).toContain('CN-');
    // A sales credit note must carry a NEGATIVE invoiceSum (mirror voucher, net < 0).
    expect(xml).toMatch(/<invoiceSum>-/);
    expect(xml).toContain('<transactions24>1000.00</transactions24>');
  });

  it('hard-blocks final generation when the declarant reg number is missing', async () => {
    // File the period with no declarant reg number: the gap is FROZEN into the
    // filing payload, so the final export blocks on what was filed rather than
    // on whatever the organization record happens to say now.
    await organization.updateOrganization({ registry_code: null });
    await periods.lock(PERIOD_ID);

    await expect(
      service.generate(PERIOD_ID, { formats: ['xml'] }),
    ).rejects.toThrow(/registry code/i);
  });

  it('refuses a final export for a period locked before any filing state was frozen', async () => {
    // A period filed before issue #200 was fixed: locked, but nothing frozen.
    await db
      .updateTable('reporting_period')
      .set({ status: 'locked' })
      .where('id', '=', PERIOD_ID)
      .execute();

    // No artifact is handed out at all: the formats carry no marker that would
    // distinguish a rebuild from a real filing.
    await expect(
      service.generate(PERIOD_ID, { formats: ['xml'] }),
    ).rejects.toThrow(/no frozen filing state/i);
  });

  it('exports the July issue figures from signed ledger bases, including reversals', async () => {
    const period = await db
      .insertInto('reporting_period')
      .values({
        name: '2026-07',
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        status: 'open',
        created_at: 0,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const line = (
      account_code: string,
      base_amount: number,
      is_debit: boolean,
      vat_code: string | null,
    ): DraftVoucherLine => ({
      account_code,
      base_amount,
      amount: base_amount,
      is_debit,
      vat_code,
      currency: 'EUR',
      fx_rate: 1,
    });
    for (const [base, reverse] of [
      [920, true],
      [920, false],
      [5320, true],
      [5320, false], // Synthetic retained base matching the issue's total; omitted from its line list.
      [1472, false],
      [12900, false],
    ] as const) {
      const vat = Math.round(base * 0.24);
      const lines = [
        line('EXPENSE_SOFTWARE', base, true, 'EE_REVERSE_CHARGE_3RD_COUNTRY'),
        line('AP', base, false, null),
        line('VAT_RECEIVABLE', vat, true, 'EE_REVERSE_CHARGE_3RD_COUNTRY'),
        line('VAT_PAYABLE', vat, false, 'EE_REVERSE_CHARGE_3RD_COUNTRY'),
      ];
      const original = await posting.postVoucher({
        tax_point_date: '2026-07-10',
        lines,
      });
      if (reverse)
        await posting.postVoucher({
          tax_point_date: '2026-07-11',
          reverses_id: original.id,
          lines: lines.map((l) => ({ ...l, is_debit: !l.is_debit })),
        });
    }
    await posting.postVoucher({
      tax_point_date: '2026-07-12',
      lines: [
        line('AR', 800000, true, null),
        line('REVENUE', 800000, false, 'EE_OUTPUT_0_EU'),
      ],
    });
    const d = await vatReports.buildDeclaration(period.id);
    expect(d).toMatchObject({
      row1_base_24: 20612,
      row7_other_acquisition: 20612,
      row3_base_zero: 800000,
      vd_intra_eu_services: 800000,
      row4_output_vat: 4947,
      row5_input_vat: 4947,
    });
    const result = await service.generate(period.id, {
      formats: ['xml', 'csv'],
    });
    const xml = result.artifacts.find(
      (a) => a.mimeType === 'application/xml',
    )!.content;
    expect(xml).toContain('<taxPayerRegCode>17499653</taxPayerRegCode>');
    expect(xml).not.toContain('<taxPayerRegCode>EE');
    for (const [tag, amount] of [
      ['transactions24', d.row1_base_24],
      ['transactionsZeroVat', d.row3_base_zero],
      ['euSupplyInclGoodsAndServicesZeroVat', d.vd_intra_eu_services],
      ['inputVatTotal', d.row5_input_vat],
      ['acquisitionOtherGoodsAndServicesTotal', d.row7_other_acquisition],
    ] as const) {
      expect(xml).toContain(
        '<' + tag + '>' + (amount / 100).toFixed(2) + '</' + tag + '>',
      );
    }
    const xsd = readFileSync(
      join(__dirname, '../../test/fixtures/vatdeclaration.xsd'),
      'utf8',
    );
    expect(validateAgainstKmdXsd(xml, xsd)).toEqual({
      valid: true,
      errors: [],
    });
    const csv = result.artifacts.find(
      (a) => a.mimeType === 'text/csv',
    )!.content;
    const cols = csv.split('\r\n')[0].split(';');
    expect(cols[5]).toBe('206.12');
    expect(cols[11]).toBe('8000.00');
    expect(cols[12]).toBe('8000.00');
    expect(cols[25]).toBe('206.12');
  });

  it('rejects a VAT number used as registry code for a final declaration', async () => {
    await organization.updateOrganization({ registry_code: 'EE100000001' });
    await periods.lock(PERIOD_ID);
    await expect(
      service.generate(PERIOD_ID, { formats: ['xml'] }),
    ).rejects.toThrow('8-digit commercial registry code');
  });

  it('creates a statutory_report_incomplete audit finding for each plugin warning', async () => {
    // A qualifying ≥€1000 sale to a registered partner but with NO invoice
    // number → the EE plugin emits an inf_missing_invoice_number warning.
    const customerId = await createRegisteredCustomer('EE200000002');
    await postSalesInvoice({
      customerId,
      invoiceNumber: '', // empty → assembled as a null invoice number
      net: 200000,
    });

    const createSpy = jest.spyOn(auditFindings, 'create');
    await service.generate(PERIOD_ID, { formats: ['xml'] });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        finding_type: 'statutory_report_incomplete',
        severity: 'medium',
      }),
    );
  });
});
