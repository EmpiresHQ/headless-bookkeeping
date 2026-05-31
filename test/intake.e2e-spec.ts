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
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * End-to-end test for the full intake pipeline:
 *   Document upload → dedup → triage (OCR stub) → posting pipeline → completion.
 *
 * Boots the full AppModule against an in-memory SQLite DB seeded by the real
 * migrations, with a temp directory for document storage.  Exercises the HTTP
 * layer via supertest.
 */
describe('Intake E2E (document → draft → pipeline)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;

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

    root = mkdtempSync(join(tmpdir(), 'intake-e2e-'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  const buf = (label: string) => Buffer.from(label);

  // ── scenario 1: full intake flow (odd id → Expense) ───────────

  it('scenario 1: full intake flow (odd id → Expense)', async () => {
    // 1. Upload — odd id → OCR stub returns receipt
    const doc = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', buf('receipt-content'), 'receipt.pdf')
      .expect(201)
      .then(
        (r) => r.body as { document: { id: number }; deduplicated: boolean },
      );
    expect(doc.deduplicated).toBe(false);
    const docId = doc.document.id;
    expect(docId % 2).toBe(1);

    // 2. Triage
    const triage = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/triage`)
      .then((r) => r.body as { kind: string; expense_id: number });
    expect(triage.kind).toBe('expense');
    const expenseId = triage.expense_id;
    expect(expenseId).toBeGreaterThan(0);

    // 3. Verify draft expense
    const expense = await request(app.getHttpServer())
      .get(`/api/expenses/${expenseId}`)
      .expect(200)
      .then(
        (r) =>
          r.body as {
            status: string;
            currency: string;
            category: string;
          },
      );
    expect(expense.status).toBe('draft');
    expect(expense.currency).toBe('EUR');
    expect(expense.category).toBe('transport');

    // 4. Post through pipeline. The OCR stub emits IE_INPUT_23 (resolved
    //    from category 'transport'), which NullCountryPlugin accepts, so the
    //    draft auto-posts with no override.
    const posted = await request(app.getHttpServer())
      .post(`/api/expenses/${expenseId}/post`)
      .expect(201)
      .then(
        (r) =>
          r.body as {
            expense: { status: string; voucher_id: number; currency: string };
            voucher: unknown;
            policy: { action: string };
          },
      );
    expect(posted.expense.status).toBe('posted');
    expect(posted.expense.voucher_id).toBeGreaterThan(0);
    expect(posted.expense.currency).toBe('EUR');
    expect(posted.voucher).toBeDefined();
    expect(posted.policy.action).toBe('auto-post');

    // 5. Mark document processed
    const completed = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/complete`)
      .expect(201)
      .then((r) => r.body as { id: number; status: string });
    expect(completed.id).toBe(docId);
    expect(completed.status).toBe('processed');

    // 6. Verify document status
    const finalDoc = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .expect(200)
      .then((r) => r.body as { status: string });
    expect(finalDoc.status).toBe('processed');
  });

  // ── scenario 2: dedup flow ─────────────────────────────────────

  it('scenario 2: dedup — same file twice yields one document with two sources', async () => {
    const fileBuffer = buf('same-content-dedup-test');

    // 1. First upload → new document
    const first = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', fileBuffer, 'receipt.pdf')
      .expect(201)
      .then(
        (r) => r.body as { document: { id: number }; deduplicated: boolean },
      );
    expect(first.deduplicated).toBe(false);
    const docId = first.document.id;

    // 2. Second upload → dedup
    const second = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', fileBuffer, 'receipt-copy.pdf')
      .expect(201)
      .then(
        (r) => r.body as { document: { id: number }; deduplicated: boolean },
      );
    expect(second.deduplicated).toBe(true);
    expect(second.document.id).toBe(docId);

    // 3. List → one document
    const list = await request(app.getHttpServer())
      .get('/api/documents')
      .expect(200)
      .then((r) => r.body as { documents: unknown[] });
    expect(list.documents).toHaveLength(1);

    // 4. Get with sources → two sources
    const hydrated = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .expect(200)
      .then((r) => r.body as { sources: unknown[] });
    expect(hydrated.sources).toHaveLength(2);

    // 5. Triage once
    await request(app.getHttpServer()).post(`/api/documents/${docId}/triage`);

    // 6. One expense only
    const expenses = await request(app.getHttpServer())
      .get('/api/expenses')
      .expect(200)
      .then((r) => r.body as { expenses: unknown[] });
    expect(expenses.expenses).toHaveLength(1);
  });

  // ── scenario 3: even id → SalesInvoice ────────────────────────

  it('scenario 3: even id → SalesInvoice', async () => {
    // 1. Consume odd id 1
    await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', buf('dummy'), 'dummy.pdf')
      .expect(201);

    // 2. Upload → even id 2 → OCR stub returns invoice
    const upload = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', buf('invoice-content'), 'invoice.pdf')
      .expect(201)
      .then((r) => r.body as { document: { id: number } });
    const docId = upload.document.id;
    expect(docId % 2).toBe(0);

    // 3. Triage → SalesInvoice
    const triage = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/triage`)
      .then((r) => r.body as { kind: string; invoice_id: number });
    expect(triage.kind).toBe('invoice');
    const invoiceId = triage.invoice_id;
    expect(invoiceId).toBeGreaterThan(0);

    // 4. Post through pipeline.'revenue' resolves to IE_OUTPUT_23, which
    //    NullCountryPlugin accepts, so the draft auto-posts with no override.
    const posted = await request(app.getHttpServer())
      .post(`/api/sales-invoices/${invoiceId}/post`)
      .expect(201)
      .then(
        (r) =>
          r.body as {
            invoice: { status: string; voucher_id: number };
            voucher: unknown;
            policy: { action: string };
          },
      );
    expect(posted.invoice.status).toBe('posted');
    expect(posted.invoice.voucher_id).toBeGreaterThan(0);
    expect(posted.voucher).toBeDefined();
    expect(posted.policy.action).toBe('auto-post');
  });
});
