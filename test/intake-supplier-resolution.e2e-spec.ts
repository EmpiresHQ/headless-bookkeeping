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
import { OcrService } from '../src/triage/ocr.service';
import { Pass2AgentService } from '../src/ai/pass2-agent.service';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

/**
 * E2E for the supplier-unresolved resolution flow.
 *
 * A confident `new_expense` whose `supplier_proposal.mode === 'create'` cannot
 * be auto-resolved (the kernel never silently creates a supplier), so the
 * document parks on `needs_triage` with the blocking TriageResult stored on
 * `document.pending_triage_result`. The operator reads the pending draft,
 * creates the supplier, and resolves — replaying the parked result through
 * proposeDraft into a draft Expense bound to the chosen supplier.
 *
 * Pass-1 (OcrService) and Pass-2 (Pass2AgentService) are overridden with
 * deterministic stubs so triage always classifies a confident create-supplier
 * new_expense — there is no OCR engine or LLM in the test env.
 */
describe('intake supplier-unresolved resolution (e2e)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let apiToken: string;

  /** Deterministic Pass-2: confident create-supplier new_expense. */
  const fauxPass2 = {
    classify: () =>
      Promise.resolve({
        ok: true,
        result: {
          kind: 'new_expense',
          gross_amount: 1525,
          vat_amount: 285,
          tax_point_date: '2026-03-15',
          category: 'software',
          supplier_proposal: {
            mode: 'create',
            create_name: 'Acme OÜ',
            create_country: 'EE',
          },
          document_type: 'invoice',
          currency: 'EUR',
          document_vat_marking: null,
          supplier_invoice_number: 'INV-7',
          confidence: 0.99,
        },
      }),
  };

  /** Pass-1 stub — no OCR engine in the test env. */
  const fauxOcr = {
    transcribe: () =>
      Promise.resolve({ ok: true, markdown: 'INVOICE Acme OÜ 15.25 EUR' }),
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

    root = mkdtempSync(join(tmpdir(), 'intake-supplier-resolution-e2e-'));

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(OcrService)
      .useValue(fauxOcr)
      .overrideProvider(Pass2AgentService)
      .useValue(fauxPass2)
      .compile();

    app = module.createNestApplication();
    // resolve-supplier / onboard bodies are validated by ZodDtos — register the
    // same global pipe main.ts applies so DTO validation runs in the e2e app.
    app.useGlobalPipes(new ZodValidationPipe());
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

  const authed = () => {
    const base = request(app.getHttpServer());
    return {
      get: (url: string) =>
        base.get(url).set('Authorization', `Bearer ${apiToken}`),
      post: (url: string) =>
        base.post(url).set('Authorization', `Bearer ${apiToken}`),
    };
  };

  /** Upload a fresh doc and triage it to needs_triage; returns its id. */
  async function uploadAndPark(filename: string): Promise<number> {
    const http = authed();
    const up = await http
      .post('/api/documents')
      .attach('file', Buffer.from(`%PDF-1.4 ${filename}`), filename)
      .expect(201);
    const documentId = (up.body as { document: { id: number } }).document.id;

    const triaged = await http
      .post(`/api/documents/${documentId}/triage`)
      .expect(201);
    expect((triaged.body as { kind: string }).kind).toBe('unknown');
    return documentId;
  }

  it('parks on needs_triage, then resolves into a draft expense', async () => {
    const http = authed();

    // 1 + 2. Upload → pending; triage → needs_triage (unknown).
    const documentId = await uploadAndPark('inv.pdf');

    // 3. pending-draft is readable and carries the create proposal + draft.
    const pd = await http
      .get(`/api/documents/${documentId}/pending-draft`)
      .expect(200);
    expect(pd.body.supplier_proposal).toEqual({
      create_name: 'Acme OÜ',
      create_country: 'EE',
    });
    expect(pd.body.draft.gross_amount).toBe(1525);
    expect(pd.body.draft.vat_amount).toBe(285);
    expect(pd.body.draft.category).toBe('software');
    expect(pd.body.draft.currency).toBe('EUR');
    expect(pd.body.draft.supplier_invoice_number).toBe('INV-7');

    // 4. Operator creates the proposed supplier.
    const sup = await http
      .post('/api/entities')
      .send({
        role: 'supplier',
        name: 'Acme OÜ',
        country: 'EE',
        registrationKey: 'EE100200300',
      })
      .expect(201);
    const supplierId = (sup.body as { id: number }).id;
    expect(typeof supplierId).toBe('number');

    // 5. Resolve → replays through proposeDraft into a draft expense.
    const resolved = await http
      .post(`/api/documents/${documentId}/resolve-supplier`)
      .send({ supplier_entity_id: supplierId })
      .expect(201);
    expect((resolved.body as { kind: string }).kind).toBe('expense');
    const expenseId = (resolved.body as { expense_id: number }).expense_id;
    expect(expenseId).toBeGreaterThan(0);

    // 6. The expense exists, bound to the chosen supplier; the proposal is
    //    cleared so pending-draft now 404s.
    const exp = await http.get(`/api/expenses/${expenseId}`).expect(200);
    expect((exp.body as { supplier_id: number }).supplier_id).toBe(supplierId);

    await http.get(`/api/documents/${documentId}/pending-draft`).expect(404);
  });

  it('complete clears a parked proposal', async () => {
    const http = authed();

    const documentId = await uploadAndPark('inv2.pdf');

    // Parked → pending-draft is readable.
    await http.get(`/api/documents/${documentId}/pending-draft`).expect(200);

    // Completing the document clears the parked proposal.
    await http.post(`/api/documents/${documentId}/complete`).expect(201);

    await http.get(`/api/documents/${documentId}/pending-draft`).expect(404);
  });
});
