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
import { SalesInvoicesService } from '../src/sales-invoices/sales-invoices.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { SalesInvoice } from '../src/sales-invoices/types';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

describe('Credit notes E2E (create/list/get)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let apiToken: string;

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

    root = mkdtempSync(join(tmpdir(), 'credit-notes-e2e-'));

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

    // Seed API token AFTER migrations have run.
    apiToken = 'test-token-e2e-12345';
    const tokenHash = createHash('sha256').update(apiToken).digest('hex');
    await db
      .insertInto('api_token')
      .values({ token_hash: tokenHash, label: 'e2e-test' })
      .execute();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Seed a posted sales invoice by resolving the real services from the Nest
   * container — same posting path as CreditNotesService.spec.ts uses.
   */
  async function seedPostedSalesInvoice({
    gross,
    vat,
  }: {
    gross: number;
    vat: number;
  }): Promise<SalesInvoice> {
    const salesInvoicesService = app.get(SalesInvoicesService);
    const postingService = app.get(PostingService);

    const invoice = await salesInvoicesService.createInvoice({
      customer_id: null,
      invoice_number: `INV-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      gross_amount: gross,
      vat_amount: vat,
      currency: 'EUR',
      tax_point_date: '2026-05-15',
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

  it('POST /api/credit-notes creates a posted credit note for a posted invoice', async () => {
    const inv = await seedPostedSalesInvoice({ gross: 100000, vat: 24000 });

    const res = await request(app.getHttpServer())
      .post('/api/credit-notes')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({
        credits_object_type: 'sales_invoice',
        credits_object_id: inv.id,
        credit_note_number: 'CN-1',
        gross_amount: 50000,
        vat_amount: 12000,
        tax_point_date: '2026-05-20',
      })
      .expect(201);

    const body = res.body as {
      id: number;
      status: string;
      credit_note_number: string;
      gross_amount: number;
      vat_amount: number;
      currency: string;
    };
    expect(body.status).toBe('posted');
    expect(body.credit_note_number).toBe('CN-1');
    expect(body.gross_amount).toBe(50000);
    expect(body.vat_amount).toBe(12000);
    expect(body.currency).toBe('EUR');
    expect(typeof body.id).toBe('number');
  });

  it('GET /api/credit-notes lists credit notes', async () => {
    const inv = await seedPostedSalesInvoice({ gross: 100000, vat: 24000 });

    // Create one first
    await request(app.getHttpServer())
      .post('/api/credit-notes')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({
        credits_object_type: 'sales_invoice',
        credits_object_id: inv.id,
        credit_note_number: 'CN-LIST-1',
        gross_amount: 10000,
        vat_amount: 2400,
        tax_point_date: '2026-05-20',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/credit-notes')
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200);

    const body = res.body as { credit_notes: unknown[] };
    expect(Array.isArray(body.credit_notes)).toBe(true);
    expect(body.credit_notes.length).toBeGreaterThanOrEqual(1);
    expect(body.credit_notes[0]).toHaveProperty('credit_note_number');
  });

  it('GET /api/credit-notes/:id returns a specific credit note', async () => {
    const inv = await seedPostedSalesInvoice({ gross: 100000, vat: 24000 });

    const created = await request(app.getHttpServer())
      .post('/api/credit-notes')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({
        credits_object_type: 'sales_invoice',
        credits_object_id: inv.id,
        credit_note_number: 'CN-GET-1',
        gross_amount: 20000,
        vat_amount: 4800,
        tax_point_date: '2026-05-20',
      })
      .expect(201);

    const id = (created.body as { id: number }).id;

    const res = await request(app.getHttpServer())
      .get(`/api/credit-notes/${id}`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200);

    const body = res.body as {
      id: number;
      credit_note_number: string;
      status: string;
    };
    expect(body.id).toBe(id);
    expect(body.credit_note_number).toBe('CN-GET-1');
    expect(body.status).toBe('posted');
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/api/credit-notes').expect(401);

    await request(app.getHttpServer())
      .post('/api/credit-notes')
      .send({})
      .expect(401);
  });
});
