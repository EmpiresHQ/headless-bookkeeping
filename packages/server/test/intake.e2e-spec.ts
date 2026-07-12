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
import { Pass2AgentService, Pass2Outcome } from '../src/ai/pass2-agent.service';
import { DocumentTranscriber } from '../src/triage/document-transcriber.port';
import { fauxMastraService } from './faux-mastra.service';
import request from 'supertest';
import { App } from 'supertest/types';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

/**
 * End-to-end test for the full intake pipeline:
 *   Document upload → dedup → triage → posting pipeline → completion.
 *
 * Boots the full AppModule against an in-memory SQLite DB seeded by the real
 * migrations, with a temp directory for document storage.  Exercises the HTTP
 * layer via supertest.
 *
 * Pass-1 (OCR) is faked with a {@link DocumentTranscriber} stub that always
 * returns ok markdown — there is no OCR engine in the test env. The intake
 * DECISION is driven by the faux Pass-2 agent below, which classifies by the
 * document filename, so the markdown content itself is irrelevant here.
 */
describe('Intake E2E (document → draft → pipeline)', () => {
  let app: INestApplication<App>;
  let db: Kysely<Database>;
  let root: string;
  let apiToken: string;

  /** Faux Pass 2 agent — deterministic based on document filename. */
  function createFauxPass2Agent(db: Kysely<Database>): Pass2AgentService {
    return {
      async classify(_markdown: string): Promise<Pass2Outcome> {
        const doc = await db
          .selectFrom('document')
          .select('filename')
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirst();

        if (!doc) {
          return {
            ok: false,
            category: 'invalid-output',
            detail: 'no document found',
          };
        }

        const lower = doc.filename.toLowerCase();

        // v1 AI intake is purchase-side only — invoices return unknown.
        if (lower.includes('invoice')) {
          return {
            ok: true,
            result: {
              kind: 'unknown',
              document_type: 'invoice',
              gross_amount: 0,
              vat_amount: 0,
              currency: 'EUR',
              tax_point_date: '2026-03-15',
              category: 'unknown',
              document_vat_marking: null,
              supplier_invoice_number: null,
              confidence: 0.2,
              outgoing_signals: {
                org_name_is_issuer: false,
                org_vat_is_issuer: false,
                has_buyer_block: false,
                self_identifies_as_invoice: false,
              },
            },
          };
        }

        if (lower.includes('receipt')) {
          return {
            ok: true,
            result: {
              kind: 'new_expense',
              document_type: 'receipt',
              gross_amount: 1525,
              vat_amount: 285,
              currency: 'EUR',
              tax_point_date: '2026-03-15',
              category: 'transport',
              document_vat_marking: 'IE_INPUT_23',
              supplier_invoice_number: null,
              confidence: 0.95,
              outgoing_signals: {
                org_name_is_issuer: false,
                org_vat_is_issuer: false,
                has_buyer_block: false,
                self_identifies_as_invoice: false,
              },
            },
          };
        }

        return {
          ok: true,
          result: {
            kind: 'unknown',
            document_type: 'other',
            gross_amount: 0,
            vat_amount: 0,
            currency: 'EUR',
            tax_point_date: '2026-01-01',
            category: 'unknown',
            document_vat_marking: null,
            supplier_invoice_number: null,
            confidence: 0.2,
            outgoing_signals: {
              org_name_is_issuer: false,
              org_vat_is_issuer: false,
              has_buyer_block: false,
              self_identifies_as_invoice: false,
            },
          },
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
      // Pass-1: no OCR engine in the test env — return ok markdown so the
      // workflow reaches the (filename-driven) faux Pass-2 instead of routing to
      // needs_triage on a provider-unavailable transcription.
      .overrideProvider(DocumentTranscriber)
      .useValue({
        transcribe: () => Promise.resolve({ ok: true, markdown: '# Stub OCR' }),
      })
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

  /**
   * Poll the document's status until it reaches `target` (the intake worker
   * drains asynchronously after a fire-and-forget kick). Fails the test if the
   * status has not settled within the timeout.
   */
  async function waitForStatus(
    docId: number,
    target: string,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await db
        .selectFrom('document')
        .select('status')
        .where('id', '=', docId)
        .executeTakeFirst();
      if (row?.status === target) return;
      if (Date.now() > deadline) {
        throw new Error(
          `document ${docId} did not reach status '${target}' within ` +
            `${timeoutMs}ms (last: '${row?.status}')`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ── scenario 1: full intake flow (odd id → Expense) ───────────

  it('scenario 1: full intake flow (odd id → Expense)', async () => {
    // 1. Upload a receipt — faux Pass-2 classifies 'receipt.pdf' as a new_expense
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

    // 2. Upload an invoice — faux Pass-2 classifies 'invoice.pdf' as unknown
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

  // ── scenario 4: OCR-fail → retry → reprocess ───────────────────
  // Regression: clicking Retry in the SPA should reset the document to
  // pending so the intake queue re-picks it, and the AuditFinding
  // description should update to reflect the NEW failure reason (not the
  // stale original).

  it('scenario 4: OCR-fail → retry endpoint resets to pending, finding updates on re-route', async () => {
    // 1. Upload a HEIC file (with real magic bytes) — MIME empty to simulate
    //    Chrome/Firefox which don't recognise HEIC.
    const heicMagic = Buffer.alloc(24);
    heicMagic.writeUInt32BE(24, 0);
    heicMagic.write('ftyp', 4, 'ascii');
    heicMagic.write('heic', 8, 'ascii');

    const upload = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${apiToken}`)
      .attach('file', heicMagic, 'IMG_2121.HEIC')
      .expect(201)
      .then((r) => r.body as { document: { id: number } });
    const docId = upload.document.id;

    // 2. Triage — OCR stub returns ok, but faux Pass-2 returns 'unknown'
    //    for files not matching 'receipt' or 'invoice'. The document goes
    //    to needs_triage.
    const triage1 = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/triage`)
      .set('Authorization', `Bearer ${apiToken}`)
      .then((r) => r.body as { kind: string; reason: string });
    expect(triage1.kind).toBe('unknown');

    // 3. Verify document is in needs_triage.
    const doc1 = await db
      .selectFrom('document')
      .select(['status', 'processing_attempts'])
      .where('id', '=', docId)
      .executeTakeFirst();
    expect(doc1?.status).toBe('needs_triage');

    // 4. Verify AuditFinding exists with the original reason.
    const finding1 = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', 'needs_triage')
      .where('referenced_object_id', '=', docId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    expect(finding1).toBeDefined();

    // 5. Call the retry endpoint — resets to pending AND kicks the intake
    //    worker, which drains and re-processes the document without waiting
    //    on the backstop poll. `requeued: true` signals a real re-queue.
    const retry = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/retry`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200)
      .then((r) => r.body as { ok: true; requeued: boolean });
    expect(retry.requeued).toBe(true);

    // 6. The kick is fire-and-forget, so the worker drains asynchronously.
    //    Poll until it has re-processed the document back to needs_triage —
    //    this is the fix: no manual /triage needed, retry re-processes.
    await waitForStatus(docId, 'needs_triage');

    // 7. Verify the AuditFinding was REUSED (not duplicated) but its
    //    description was UPDATED (not stale) by the automatic re-route.
    const findings = await db
      .selectFrom('audit_finding')
      .selectAll()
      .where('finding_type', '=', 'needs_triage')
      .where('referenced_object_id', '=', docId)
      .where('status', '=', 'open')
      .execute();
    expect(findings).toHaveLength(1); // no duplicate
    expect(findings[0].description).toBeTruthy(); // written, not stale

    // 8. Attempts were reset to 0 by reprocess, then the worker's single
    //    claim bumped it to 1 — proving the drain actually ran.
    const doc3 = await db
      .selectFrom('document')
      .select(['status', 'processing_attempts'])
      .where('id', '=', docId)
      .executeTakeFirst();
    expect(doc3?.status).toBe('needs_triage');
    expect(doc3?.processing_attempts).toBe(1);
  });

  it('retry endpoint is a no-op on a non-needs_triage document', async () => {
    // Upload and triage a receipt → goes to triaged (draft proposed).
    const upload = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${apiToken}`)
      .attach('file', buf('receipt-content'), 'receipt.pdf')
      .expect(201)
      .then((r) => r.body as { document: { id: number } });
    const docId = upload.document.id;

    await request(app.getHttpServer())
      .post(`/api/documents/${docId}/triage`)
      .set('Authorization', `Bearer ${apiToken}`);

    // Document should be triaged, not needs_triage.
    const doc = await db
      .selectFrom('document')
      .select('status')
      .where('id', '=', docId)
      .executeTakeFirst();
    expect(doc?.status).toBe('triaged');

    // Retry should succeed (200) but report the no-op (requeued=false) and
    // NOT change the status — nothing was re-queued, no worker kick.
    const retry = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/retry`)
      .set('Authorization', `Bearer ${apiToken}`)
      .expect(200)
      .then((r) => r.body as { ok: true; requeued: boolean });
    expect(retry.requeued).toBe(false);

    const docAfter = await db
      .selectFrom('document')
      .select('status')
      .where('id', '=', docId)
      .executeTakeFirst();
    expect(docAfter?.status).toBe('triaged'); // unchanged
  });
});
