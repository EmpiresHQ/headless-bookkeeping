import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OcrService } from './ocr.service';
import { DocumentsService } from '../documents/documents.service';
import { DocumentStorageService } from '../documents/document-storage.service';
import { ConversationsService } from '../conversations/conversations.service';

describe('OcrService', () => {
  let db: Kysely<Database>;
  let service: OcrService;
  let documentsService: DocumentsService;
  let conversationsService: ConversationsService;
  const testArtifactsDir = join(process.cwd(), 'data', 'artifacts', 'ocr');

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
        DocumentStorageService,
        DocumentsService,
        ConversationsService,
        OcrService,
      ],
    }).compile();

    service = module.get(OcrService);
    documentsService = module.get(DocumentsService);
    conversationsService = module.get(ConversationsService);
  });

  afterEach(async () => {
    await db.destroy();
    // Clean up test artifacts.
    if (existsSync(testArtifactsDir)) {
      rmSync(testArtifactsDir, { recursive: true, force: true });
    }
  });

  describe('extract', () => {
    it('returns receipt for odd document ids', () => {
      const result = service.extract(1);
      expect(result.kind).toBe('new_expense');
      expect(result.document_type).toBe('receipt');
      expect(result.gross_amount).toBe(1525);
      expect(result.vat_amount).toBe(285);
      expect(result.currency).toBe('EUR');
      expect(result.tax_point_date).toBe('2025-01-15');
      expect(result.category).toBe('transport');
      expect(result.document_vat_marking).toBe('IE_INPUT_23');
      expect(result.confidence).toBe(0.94);
    });

    it('returns invoice for even document ids', () => {
      const result = service.extract(2);
      expect(result.kind).toBe('new_expense');
      expect(result.document_type).toBe('invoice');
      expect(result.gross_amount).toBe(12300);
      expect(result.vat_amount).toBe(2300);
      expect(result.currency).toBe('EUR');
      expect(result.tax_point_date).toBe('2025-01-20');
      expect(result.category).toBe('revenue');
      expect(result.document_vat_marking).toBe('IE_OUTPUT_23');
      expect(result.confidence).toBe(0.98);
    });

    it('is deterministic for the same id', () => {
      const r1 = service.extract(3);
      const r2 = service.extract(3);
      expect(r1).toEqual(r2);
    });
  });

  describe('transcribe', () => {
    async function seedDocument(filename: string) {
      const now = Math.floor(Date.now() / 1000);
      const doc = await db
        .insertInto('document')
        .values({
          hash: `hash-${filename}`,
          filename,
          mime_type: 'application/pdf',
          size_bytes: 1000,
          storage_path: `/tmp/${filename}`,
          status: 'pending',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return doc.id;
    }

    it('returns markdown for a receipt-like document (odd id)', async () => {
      const docId = await seedDocument('receipt-bolt.pdf');
      const markdown = await service.transcribe(docId);

      expect(markdown).toContain('# Receipt');
      expect(markdown).toContain('Bolt');
      expect(markdown).toContain('€15.25');
    });

    it('returns markdown for an invoice-like document (even id)', async () => {
      const docId = await seedDocument('invoice-acme.pdf');
      const markdown = await service.transcribe(docId);

      expect(markdown).toContain('# Invoice');
      expect(markdown).toContain('Acme Ltd');
      expect(markdown).toContain('€123.00');
    });

    it('stores markdown as an ocr_markdown artifact', async () => {
      const docId = await seedDocument('receipt-test.pdf');
      await service.transcribe(docId);

      const artifact = await db
        .selectFrom('artifact')
        .selectAll()
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirst();

      expect(artifact).toBeDefined();
      expect(artifact!.kind).toBe('ocr_markdown');
      expect(artifact!.document_id).toBe(docId);
      expect(artifact!.storage_path).toContain('ocr');
      expect(artifact!.storage_path).toContain(`${docId}.md`);
    });

    it('creates a conversation for the OCR transcription', async () => {
      const docId = await seedDocument('test.pdf');
      await service.transcribe(docId);

      const conv = await db
        .selectFrom('conversation')
        .selectAll()
        .where('thread_key', '=', `ocr:${docId}`)
        .executeTakeFirst();

      expect(conv).toBeDefined();
      expect(conv!.channel).toBe('api');
    });

    it('associates the conversation with the document', async () => {
      const docId = await seedDocument('test.pdf');
      await service.transcribe(docId);

      const conv = await db
        .selectFrom('conversation')
        .select('id')
        .where('thread_key', '=', `ocr:${docId}`)
        .executeTakeFirstOrThrow();

      const assoc = await db
        .selectFrom('conversation_document')
        .selectAll()
        .where('conversation_id', '=', conv.id)
        .where('document_id', '=', docId)
        .executeTakeFirst();

      expect(assoc).toBeDefined();
    });

    it('is idempotent — re-running reads stored markdown without re-calling model', async () => {
      const docId = await seedDocument('receipt-test.pdf');

      const first = await service.transcribe(docId);
      const second = await service.transcribe(docId);

      expect(first).toBe(second);

      // Only one artifact should exist (not duplicated).
      const count = await db
        .selectFrom('artifact')
        .select(db.fn.count('id').as('cnt'))
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirst();

      expect(Number(count!.cnt)).toBe(1);
    });

    it('throws NotFoundException for non-existent document', async () => {
      await expect(service.transcribe(9999)).rejects.toThrow(NotFoundException);
    });
  });
});
