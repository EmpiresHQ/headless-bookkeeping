import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { AccountService } from '../ledger/account/account.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { SalesInvoice } from '../sales-invoices/types';
import { CreditNotesService } from './credit-notes.service';

describe('CreditNotesService (integration)', () => {
  let db: Kysely<Database>;
  let service: CreditNotesService;
  let salesInvoicesService: SalesInvoicesService;
  let postingService: PostingService;
  let lineRepo: VoucherLineRepository;

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
        NullCountryPlugin,
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        AccountService,
        VoucherRepository,
        VoucherLineRepository,
        LedgerValidationService,
        PostingService,
        PeriodLockService,
        VoucherProjectionService,
        SalesInvoicesService,
        CreditNotesService,
      ],
    }).compile();

    service = module.get(CreditNotesService);
    salesInvoicesService = module.get(SalesInvoicesService);
    postingService = module.get(PostingService);
    lineRepo = module.get(VoucherLineRepository);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedPostedSalesInvoice({
    gross,
    vat,
    currency = 'EUR',
    taxPointDate = '2026-05-15',
  }: {
    gross: number;
    vat: number;
    currency?: string;
    taxPointDate?: string;
  }): Promise<SalesInvoice> {
    const invoice = await salesInvoicesService.createInvoice({
      customer_id: null,
      invoice_number: `INV-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      gross_amount: gross,
      vat_amount: vat,
      currency,
      tax_point_date: taxPointDate,
      due_date: null,
    });
    const draft = await salesInvoicesService.generateDraftVoucher(invoice.id);
    const posted = await postingService.postVoucher(draft);
    await salesInvoicesService.updateInvoiceStatus(
      invoice.id,
      'posted',
      posted.id,
    );
    return salesInvoicesService.getInvoiceById(invoice.id);
  }

  it('rejects a credit note that exceeds the original gross (cap guard)', async () => {
    const inv = await seedPostedSalesInvoice({ gross: 100000, vat: 24000 });
    await expect(
      service.create({
        credits_object_type: 'sales_invoice',
        credits_object_id: inv.id,
        credit_note_number: 'CN-1',
        gross_amount: 120000,
        vat_amount: 28800,
        tax_point_date: '2026-05-20',
      }),
    ).rejects.toThrow(/exceed/i);
  });

  it('rejects crediting a non-posted document', async () => {
    const invoice = await salesInvoicesService.createInvoice({
      customer_id: null,
      invoice_number: 'INV-DRAFT-1',
      gross_amount: 100000,
      vat_amount: 24000,
      currency: 'EUR',
      tax_point_date: '2026-05-15',
      due_date: null,
    });
    await expect(
      service.create({
        credits_object_type: 'sales_invoice',
        credits_object_id: invoice.id,
        credit_note_number: 'CN-X',
        gross_amount: 1000,
        vat_amount: 240,
        tax_point_date: '2026-05-20',
      }),
    ).rejects.toThrow();
  });

  it('rejects when the original document does not exist', async () => {
    await expect(
      service.create({
        credits_object_type: 'sales_invoice',
        credits_object_id: 99999,
        credit_note_number: 'CN-NX',
        gross_amount: 1000,
        vat_amount: 240,
        tax_point_date: '2026-05-20',
      }),
    ).rejects.toThrow();
  });

  it('allows multiple partial credit notes up to the cap, inherits currency, posts a balanced voucher', async () => {
    const inv = await seedPostedSalesInvoice({ gross: 100000, vat: 24000 });
    const first = await service.create({
      credits_object_type: 'sales_invoice',
      credits_object_id: inv.id,
      credit_note_number: 'CN-1',
      gross_amount: 60000,
      vat_amount: 14400,
      tax_point_date: '2026-05-20',
    });
    expect(first.status).toBe('posted');
    expect(first.kind).toBe('sales');
    expect(first.voucher_id).not.toBeNull();

    // the posted voucher balances in base_amount
    const firstLines = await lineRepo.getLinesByVoucherId(
      first.voucher_id as number,
    );
    const dr = firstLines
      .filter((l) => l.is_debit)
      .reduce((s, l) => s + l.base_amount, 0);
    const cr = firstLines
      .filter((l) => !l.is_debit)
      .reduce((s, l) => s + l.base_amount, 0);
    expect(dr).toBe(cr);

    const second = await service.create({
      credits_object_type: 'sales_invoice',
      credits_object_id: inv.id,
      credit_note_number: 'CN-2',
      gross_amount: 40000,
      vat_amount: 9600,
      tax_point_date: '2026-05-20',
    });
    expect(second.status).toBe('posted');
    expect(second.currency).toBe(inv.currency);

    // a third that would exceed the remaining 0 must fail
    await expect(
      service.create({
        credits_object_type: 'sales_invoice',
        credits_object_id: inv.id,
        credit_note_number: 'CN-3',
        gross_amount: 1,
        vat_amount: 0,
        tax_point_date: '2026-05-20',
      }),
    ).rejects.toThrow(/exceed/i);
  });

  it('redirects the credit note into the current open period when the tax-point date is locked', async () => {
    const inv = await seedPostedSalesInvoice({
      gross: 100000,
      vat: 24000,
      taxPointDate: '2026-02-15',
    });

    await db
      .insertInto('reporting_period')
      .values({
        name: '2026-Q1',
        start_date: '2026-01-01',
        end_date: '2026-03-31',
        status: 'locked',
        filed_at: 0,
        created_at: 0,
      })
      .execute();
    const openPeriod = await db
      .insertInto('reporting_period')
      .values({
        name: '2026-Q2',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
        status: 'open',
        filed_at: null,
        created_at: 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const cn = await service.create({
      credits_object_type: 'sales_invoice',
      credits_object_id: inv.id,
      credit_note_number: 'CN-LOCK',
      gross_amount: 50000,
      vat_amount: 12000,
      tax_point_date: '2026-02-20', // inside the locked Q1
    });

    expect(cn.status).toBe('posted');
    expect(cn.tax_point_date).toBe(openPeriod.start_date);
  });

  it('list and getById return posted credit notes', async () => {
    const inv = await seedPostedSalesInvoice({ gross: 100000, vat: 24000 });
    const cn = await service.create({
      credits_object_type: 'sales_invoice',
      credits_object_id: inv.id,
      credit_note_number: 'CN-LIST',
      gross_amount: 50000,
      vat_amount: 12000,
      tax_point_date: '2026-05-20',
    });

    const all = await service.list();
    expect(all).toHaveLength(1);

    const fetched = await service.getById(cn.id);
    expect(fetched.id).toBe(cn.id);
    expect(fetched.credit_note_number).toBe('CN-LIST');
  });
});
