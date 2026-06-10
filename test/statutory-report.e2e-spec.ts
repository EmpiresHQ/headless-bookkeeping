import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../src/database/types';
import { migrations } from '../src/database/migrations';
import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';
import { AppModule } from '../src/app.module';
import { MastraService } from '../src/ai/mastra.service';
import { fauxMastraService } from './faux-mastra.service';
import { OrganizationService } from '../src/organization/organization.service';
import { SalesInvoicesService } from '../src/sales-invoices/sales-invoices.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

describe('Statutory Report download endpoint (E2E)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let token: string;

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

    root = mkdtempSync(join(tmpdir(), 'statutory-report-e2e-'));

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

    token = 'test-token-statutory-12345';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label: 'e2e-statutory' })
      .execute();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Seed an EE org with a posted sales invoice in reporting period 1 (2024-Q1).
   * Returns the period id (always 1 — seeded by migration).
   * Copied from statutory-report.service.spec.ts.
   */
  async function seedPeriodWithEeInvoice(
    nestApp: INestApplication<App>,
  ): Promise<number> {
    const orgService = nestApp.get(OrganizationService);
    const salesInvoicesService = nestApp.get(SalesInvoicesService);
    const postingService = nestApp.get(PostingService);

    // Make EE the active plugin and give the declarant a valid reg number.
    await orgService.updateOrganization({
      country: 'EE',
      vat_registered: true,
      vat_registration_number: 'EE100000001',
      name: 'Test OÜ',
    });

    // Create a customer entity with a registration_key (B2B — qualifies for INF).
    const entity = await db
      .insertInto('entity')
      .values({
        role: 'customer',
        country: 'EE',
        name: 'Acme Buyer OÜ',
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
        value: 'EE200000002',
        confirmed: 1,
      })
      .execute();

    // Post a sales invoice inside 2024-Q1 (period id = 1).
    const net = 200000; // €2000 net — above KMD INF €1000 threshold
    const vat = Math.round(net * 0.24);
    const inv = await salesInvoicesService.createInvoice({
      customer_id: entity.id,
      invoice_number: 'INV-STAT-001',
      gross_amount: net + vat,
      vat_amount: vat,
      currency: 'EUR',
      tax_point_date: '2024-02-15',
      due_date: null,
    });
    const draft = await salesInvoicesService.generateDraftVoucher(inv.id);
    const posted = await postingService.postVoucher(draft);
    await salesInvoicesService.updateInvoiceStatus(inv.id, 'posted', posted.id);

    return 1; // reporting_period id seeded by migration 011
  }

  it('GET …/statutory-report?format=xml returns an XML attachment', async () => {
    const periodId = await seedPeriodWithEeInvoice(app);
    const res = await request(app.getHttpServer())
      .get(`/api/reporting-periods/${periodId}/statutory-report?format=xml`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toContain('.xml');
    expect(res.text).toContain('<vatDeclaration>');
  });

  it('format=all returns a zip', async () => {
    const periodId = await seedPeriodWithEeInvoice(app);
    const res = await request(app.getHttpServer())
      .get(`/api/reporting-periods/${periodId}/statutory-report?format=all`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .expect(200);
    expect(res.headers['content-type']).toContain('application/zip');
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer())
      .get('/api/reporting-periods/1/statutory-report')
      .expect(401);
  });
});
