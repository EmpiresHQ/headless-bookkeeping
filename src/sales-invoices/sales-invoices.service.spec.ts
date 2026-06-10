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
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { EntitiesService } from '../entities/entities.service';
import { SalesInvoicesService } from './sales-invoices.service';
import { CreateSalesInvoiceDto } from './types';

describe('SalesInvoicesService (integration)', () => {
  let db: Kysely<Database>;
  let service: SalesInvoicesService;
  let entitiesService: EntitiesService;
  let organizationService: OrganizationService;

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
        VoucherProjectionService,
        EntitiesService,
        SalesInvoicesService,
      ],
    }).compile();

    service = module.get(SalesInvoicesService);
    entitiesService = module.get(EntitiesService);
    organizationService = module.get(OrganizationService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  const createDto = (
    overrides?: Partial<CreateSalesInvoiceDto>,
  ): CreateSalesInvoiceDto => ({
    invoice_number: 'INV-2026-001',
    gross_amount: 12300,
    vat_amount: 2300,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
    ...overrides,
  });

  it('creates an invoice with status draft', async () => {
    const invoice = await service.createInvoice(createDto());
    expect(invoice.id).toBeGreaterThan(0);
    expect(invoice.status).toBe('draft');
    expect(invoice.sent_at).toBeNull();
    expect(invoice.voucher_id).toBeNull();
  });

  it('lists created invoices', async () => {
    await service.createInvoice(createDto({ invoice_number: 'INV-001' }));
    await service.createInvoice(createDto({ invoice_number: 'INV-002' }));
    const invoices = await service.getInvoices();
    expect(invoices).toHaveLength(2);
  });

  it('finds an invoice by id', async () => {
    const created = await service.createInvoice(createDto());
    const found = await service.getInvoiceById(created.id);
    expect(found).not.toBeNull();
    expect(found?.invoice_number).toBe('INV-2026-001');
  });

  it('throws NotFoundException for unknown invoice id', async () => {
    await expect(service.getInvoiceById(999)).rejects.toThrow(
      'SalesInvoice 999 not found',
    );
  });

  it('rejects duplicate invoice_number', async () => {
    await service.createInvoice(createDto());
    await expect(service.createInvoice(createDto())).rejects.toThrow(
      'UNIQUE constraint failed',
    );
  });

  it('generate-draft returns a transient balanced voucher (Dr AR / Cr Revenue / Cr VAT_PAYABLE)', async () => {
    const invoice = await service.createInvoice(createDto());
    const draft = await service.generateDraftVoucher(invoice.id);

    expect(draft.voucher_number).toBe('PENDING');
    expect(draft.tax_point_date).toBe('2026-03-15');
    expect(draft.lines).toHaveLength(3);

    const arLine = draft.lines.find((l) => l.account_code === 'AR');
    const revenueLine = draft.lines.find((l) => l.account_code === 'REVENUE');
    const vatLine = draft.lines.find((l) => l.account_code === 'VAT_PAYABLE');

    expect(arLine).toBeDefined();
    expect(arLine?.is_debit).toBe(true);
    expect(arLine?.amount).toBe(12300);
    expect(arLine?.vat_code).toBeNull();

    expect(revenueLine).toBeDefined();
    expect(revenueLine?.is_debit).toBe(false);
    expect(revenueLine?.amount).toBe(10000); // net
    expect(revenueLine?.vat_code).toBe('IE_OUTPUT_23');

    expect(vatLine).toBeDefined();
    expect(vatLine?.is_debit).toBe(false);
    expect(vatLine?.amount).toBe(2300);
    expect(vatLine?.vat_code).toBe('IE_OUTPUT_23');

    // Balanced in base currency
    const totalDebits = draft.lines
      .filter((l) => l.is_debit)
      .reduce((sum, l) => sum + l.base_amount, 0);
    const totalCredits = draft.lines
      .filter((l) => !l.is_debit)
      .reduce((sum, l) => sum + l.base_amount, 0);
    expect(totalDebits).toBe(totalCredits);

    // EUR: fx_rate=1, base_amount=amount
    draft.lines.forEach((line) => {
      expect(line.fx_rate).toBe(1);
      expect(line.base_amount).toBe(line.amount);
    });
  });

  it('generate-draft throws NotFoundException for missing invoice', async () => {
    await expect(service.generateDraftVoucher(999)).rejects.toThrow(
      'SalesInvoice 999 not found',
    );
  });

  it('send sets sent_at without changing status', async () => {
    const invoice = await service.createInvoice(createDto());
    expect(invoice.sent_at).toBeNull();

    const sent = await service.sendInvoice(invoice.id);
    expect(sent.sent_at).not.toBeNull();
    expect(sent.status).toBe('draft');
    expect(sent.sent_at).toBeGreaterThanOrEqual(invoice.created_at);
  });

  it('send throws NotFoundException for missing invoice', async () => {
    await expect(service.sendInvoice(999)).rejects.toThrow(
      'SalesInvoice 999 not found',
    );
  });

  it('generate-draft uses resolveCategoryMapping for revenue account + VAT code', async () => {
    const invoice = await service.createInvoice(createDto());
    const draft = await service.generateDraftVoucher(invoice.id);

    const revenueLine = draft.lines.find((l) => l.account_code === 'REVENUE');
    expect(revenueLine?.account_code).toBe('REVENUE');
    expect(revenueLine?.vat_code).toBe('IE_OUTPUT_23');
  });

  describe('deleteDraft', () => {
    it('removes a draft invoice', async () => {
      const invoice = await service.createInvoice(createDto());
      await service.deleteDraft(invoice.id);
      expect(await service.getInvoices()).toHaveLength(0);
    });

    it('refuses to delete a non-draft invoice', async () => {
      const invoice = await service.createInvoice(createDto());
      await db
        .updateTable('sales_invoice')
        .set({ status: 'pending' })
        .where('id', '=', invoice.id)
        .execute();
      await expect(service.deleteDraft(invoice.id)).rejects.toThrow(
        /only a draft/i,
      );
    });
  });

  describe('intra-EU B2B service sale (EE org)', () => {
    it('tags revenue 0% intra-EU (EE_OUTPUT_0_EU) for an EU customer of services', async () => {
      await organizationService.updateOrganization({ country: 'EE' });

      const customer = await entitiesService.onboard({
        role: 'customer',
        country: 'DK',
        name: 'VERIFI',
        registrationKey: 'DK45960617',
        goodsVsServices: 'services',
      });

      const invoice = await service.createInvoice({
        invoice_number: 'INV-EU-1',
        gross_amount: 615700,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-05-31',
        customer_id: customer.id,
      });

      const draft = await service.generateDraftVoucher(invoice.id);
      const revenue = draft.lines.find((l) => l.account_code === 'REVENUE');
      expect(revenue?.vat_code).toBe('EE_OUTPUT_0_EU');
      expect(revenue?.amount).toBe(615700); // whole gross is 0%-rated käive

      // No output VAT on a 0% supply — the VAT leg is dropped (a 0-amount line
      // cannot post).
      const vatLine = draft.lines.find((l) => l.account_code === 'VAT_PAYABLE');
      expect(vatLine).toBeUndefined();
    });
  });
});
