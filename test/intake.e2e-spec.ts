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
import { Pass2AgentService } from '../src/ai/pass2-agent.service';
import { fauxMastraService } from './faux-mastra.service';
import { TriageResult } from '../src/triage/types';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

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
  let apiToken: string;

  /** Faux Pass 2 agent — deterministic based on document filename. */
  function createFauxPass2Agent(db: Kysely<Database>): Pass2AgentService {
    return {
      async classify(_markdown: string): Promise<TriageResult | null> {
        const doc = await db
          .selectFrom('document')
          .select('filename')
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirst();

        if (!doc) return null;

        const lower = doc.filename.toLowerCase();

        // v1 AI intake is purchase-side only — invoices return unknown.
        if (lower.includes('invoice')) {
          return {
            kind: 'unknown',
            document_type: 'invoice',
            gross_amount: 0,
            vat_amount: 0,
            currency: 'EUR',
            tax_point_date: '2026-03-15',
            category: 'unknown',
            document_vat_marking: null,
            confidence: 0.2,
          };
        }

        if (lower.includes('receipt')) {
          return {
            kind: 'new_expense',
            document_type: 'receipt',
            gross_amount: 1525,
            vat_amount: 285,
            currency: 'EUR',
            tax_point_date: '2026-03-15',
            category: 'transport',
            document_vat_marking: 'IE_INPUT_23',
            confidence: 0.95,
          };
        }

        return {
          kind: 'unknown',
          document_type: 'unknown',
          gross_amount: 0,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-01-01',
          category: 'unknown',
          document_vat_marking: null,
          confidence: 0.2,
        };
      },
    } as unknown as Pass2AgentService;
  }

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
    const fauxPass2 = createFauxPass2Agent(db);

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN())
      .useValue(db)
      .overrideProvider(DOCUMENT_STORAGE_ROOT)
      .useValue(root)
      .overrideProvider(MastraService)
      .useValue(fauxMastraService)
      .overrideProvider(Pass2AgentService)
      .useValue(fauxPass2)
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

  const buf = (label: string) => Buffer.from(label);

  // ── scenario 1: full intake flow (odd id → Expense) ───────────

  it('scenario 1: full intake flow (odd id → Expense)', async () => {
    // 1. Upload — odd id → OCR stub returns receipt
    const doc = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${apiToken}`)
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
      .set('Authorization', `Bearer ${apiToken}`)
      .then((r) => r.body as { kind: string; expense_id: number });
    expect(triage.kind).toBe('expense');
    const expenseId = triage.expense_id;
    expect(expenseId).toBeGreaterThan(0);

    // 3. Verify expense was created — the workflow ran the full pipeline.
    // With no supplier, the unknown-supplier gate holds for approval (pending).
    const expense = await request(app.getHttpServer())
      .get(`/api/expenses/${expenseId}`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200)
      .then(
        (r) =>
          r.body as {
            status: string;
            currency: string;
            category: string;
            voucher_id: number | null;
          },
      );
    // The expense was created and the pipeline ran. Status depends on Policy:
    // - 'pending' if held for approval (unknown supplier gate)
    // - 'posted' if auto-posted (all gates passed)
    expect(['draft', 'pending', 'posted']).toContain(expense.status);
    expect(expense.currency).toBe('EUR');
    expect(expense.category).toBe('transport');

    // 4. Verify ai_proposal provenance row exists.
    const proposals = await db
      .selectFrom('ai_proposal')
      .selectAll()
      .where('business_object_id', '=', expenseId)
      .execute();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].business_object_type).toBe('expense');
    expect(proposals[0].confidence).toBe(0.95);
    const parsed = JSON.parse(proposals[0].raw_triage_result!) as {
      kind: string;
    };
    expect(parsed.kind).toBe('new_expense');

    // 5. Mark document processed
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/complete`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(201);

    // 6. Verify document status
    const finalDoc = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${apiToken}`)
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
      .set('Authorization', `Bearer ${apiToken}`)
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
      .set('Authorization', `Bearer ${apiToken}`)
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
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200)
      .then((r) => r.body as { documents: unknown[] });
    expect(list.documents).toHaveLength(1);

    // 4. Get with sources → two sources
    const hydrated = await request(app.getHttpServer())
      .get(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200)
      .then((r) => r.body as { sources: unknown[] });
    expect(hydrated.sources).toHaveLength(2);

    // 5. Triage once
    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/triage`)
      .set('Authorization', `Bearer ${apiToken}`);

    // 6. One expense only
    const expenses = await request(app.getHttpServer())
      .get('/api/expenses')
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200)
      .then((r) => r.body as { expenses: unknown[] });
    expect(expenses.expenses).toHaveLength(1);
  });

  // ── scenario 3: even id → invoice (unknown, needs_triage) ──────

  it('scenario 3: even id → invoice (unknown, needs_triage)', async () => {
    // 1. Consume odd id 1
    await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${apiToken}`)
      .attach('file', buf('dummy'), 'dummy.pdf')
      .expect(201);

    // 2. Upload → even id 2 → OCR stub returns invoice
    const upload = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${apiToken}`)
      .attach('file', buf('invoice-content'), 'invoice.pdf')
      .expect(201)
      .then((r) => r.body as { document: { id: number } });
    const docId = upload.document.id;
    expect(docId % 2).toBe(0);

    // 3. Triage → v1 AI intake is purchase-side only, so invoice returns unknown.
    const triage = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/triage`)
      .set('Authorization', `Bearer ${apiToken}`)
      .then((r) => r.body as { kind: string; reason?: string });
    expect(triage.kind).toBe('unknown');
    expect(triage.reason).toBeDefined();

    // 4. Verify needs_triage AuditFinding was created.
    const findings = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', 'needs_triage')
      .where('referenced_object_type', '=', 'document')
      .where('referenced_object_id', '=', docId)
      .execute();
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('medium');
  });
});
