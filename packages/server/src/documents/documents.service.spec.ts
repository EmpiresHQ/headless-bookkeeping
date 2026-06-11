import { NotFoundException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { DocumentsService, computeSha256 } from './documents.service';
import {
  DocumentStorageService,
  DOCUMENT_STORAGE_ROOT,
} from './document-storage.service';
import { promises as fs } from 'fs';
import { join } from 'path';

describe('DocumentsService (unit)', () => {
  let service: DocumentsService;
  let db: Kysely<Database>;
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = join('/tmp', 'doc-test', `${Date.now()}`);
    await fs.mkdir(storageRoot, { recursive: true });

    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });

    // Run real migrations (G4: schema only in migrations)
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
        { provide: DOCUMENT_STORAGE_ROOT, useValue: storageRoot },
        DocumentStorageService,
        DocumentsService,
      ],
    }).compile();

    service = module.get(DocumentsService);
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  describe('computeSha256', () => {
    it('returns the correct SHA-256 hex digest for a known buffer', () => {
      const buffer = Buffer.from('hello world');
      const hash = computeSha256(buffer);
      expect(hash).toBe(
        'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      );
    });

    it('returns different hashes for different content', () => {
      const h1 = computeSha256(Buffer.from('a'));
      const h2 = computeSha256(Buffer.from('b'));
      expect(h1).not.toBe(h2);
    });
  });

  describe('upload', () => {
    it('creates a new document and saves the file', async () => {
      const buffer = Buffer.from('new file content');
      const result = await service.upload({
        buffer,
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });

      expect(result.deduplicated).toBe(false);
      expect(result.document.filename).toBe('receipt.pdf');
      expect(result.document.mime_type).toBe('application/pdf');
      expect(result.document.size_bytes).toBe(buffer.length);
      expect(result.document.status).toBe('pending');
      expect(result.document.storage_path).toBeTruthy();

      const saved = await fs.readFile(
        join(storageRoot, result.document.storage_path!),
      );
      expect(saved).toEqual(buffer);
    });

    it('deduplicates on identical hash and appends a new source', async () => {
      const buffer = Buffer.from('duplicate content');

      const first = await service.upload({
        buffer,
        filename: 'first.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      expect(first.deduplicated).toBe(false);

      const second = await service.upload({
        buffer,
        filename: 'second.pdf',
        mimeType: 'application/pdf',
        channel: 'email',
        sourceIdentifier: 'msg-123',
      });
      expect(second.deduplicated).toBe(true);
      expect(second.document.id).toBe(first.document.id);

      const hydrated = await service.hydrate(second.document);
      expect(hydrated.sources.length).toBe(2);
      expect(hydrated.sources.map((s) => s.channel)).toContain('upload');
      expect(hydrated.sources.map((s) => s.channel)).toContain('email');
    });
  });

  describe('list / getById / setStatus', () => {
    it('lists documents in descending order', async () => {
      await service.upload({
        buffer: Buffer.from('doc1'),
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
      });
      await service.upload({
        buffer: Buffer.from('doc2'),
        filename: 'b.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
      });

      const docs = await service.list();
      expect(docs.length).toBe(2);
      expect(docs[0].filename).toBe('b.pdf');
      expect(docs[1].filename).toBe('a.pdf');
    });

    it('retrieves a document by id', async () => {
      const result = await service.upload({
        buffer: Buffer.from('find me'),
        filename: 'target.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
      });

      const found = await service.getById(result.document.id);
      expect(found.id).toBe(result.document.id);
      expect(found.filename).toBe('target.pdf');
    });

    it('throws NotFoundException for missing id', async () => {
      await expect(service.getById(9999)).rejects.toThrow(
        'Document 9999 not found',
      );
    });

    it('updates status', async () => {
      const result = await service.upload({
        buffer: Buffer.from('status test'),
        filename: 's.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
      });

      await service.setStatus(result.document.id, 'triaged');
      const updated = await service.getById(result.document.id);
      expect(updated.status).toBe('triaged');
    });
  });

  describe('getFile (D4)', () => {
    it('returns the stored bytes with filename and mime type', async () => {
      const buffer = Buffer.from('the original pdf bytes');
      const { document } = await service.upload({
        buffer,
        filename: 'orig.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
      });

      const file = await service.getFile(document.id);
      expect(file.filename).toBe('orig.pdf');
      expect(file.mimeType).toBe('application/pdf');
      expect(file.buffer).toEqual(buffer);
    });

    it('throws NotFoundException for a missing id', async () => {
      await expect(service.getFile(9999)).rejects.toThrow(
        'Document 9999 not found',
      );
    });
  });

  describe('deleteDocument', () => {
    const upload = () =>
      service.upload({
        buffer: Buffer.from('junk upload'),
        filename: 'junk.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });

    it('deletes the document, its sources and its file', async () => {
      const { document } = await upload();
      const path = document.storage_path!;
      await expect(fs.readFile(join(storageRoot, path))).resolves.toBeTruthy();

      await service.deleteDocument(document.id);

      await expect(service.getById(document.id)).rejects.toThrow(
        `Document ${document.id} not found`,
      );
      const sources = await db
        .selectFrom('document_source')
        .selectAll()
        .where('document_id', '=', document.id)
        .execute();
      expect(sources).toHaveLength(0);
      await expect(fs.readFile(join(storageRoot, path))).rejects.toThrow();
    });

    it('refuses (409) to delete a document attached to an expense', async () => {
      const { document } = await upload();
      const now = Math.floor(Date.now() / 1000);
      await db
        .insertInto('expense')
        .values({
          document_id: document.id,
          supplier_id: null,
          category: 'transport',
          gross_amount: 1000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-05-01',
          status: 'draft',
          voucher_id: null,
          document_vat_marking: null,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await expect(service.deleteDocument(document.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Still present.
      await expect(service.getById(document.id)).resolves.toBeTruthy();
    });

    it('throws NotFoundException for a missing document', async () => {
      await expect(service.deleteDocument(9999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cascades the internal OCR conversation and its artifact', async () => {
      const { document } = await upload();
      const now = Math.floor(Date.now() / 1000);
      const conv = await db
        .insertInto('conversation')
        .values({
          channel: 'api',
          thread_key: `ocr:${document.id}`,
          status: 'open',
          created_at: now,
          updated_at: now,
          closed_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('conversation_document')
        .values({ conversation_id: conv.id, document_id: document.id })
        .execute();
      await db
        .insertInto('artifact')
        .values({
          conversation_id: conv.id,
          kind: 'ocr_markdown',
          document_id: document.id,
          storage_path: `${document.id}/ocr.md`,
          crc32: null,
          created_at: now,
        })
        .execute();

      await service.deleteDocument(document.id);

      const remainingConv = await db
        .selectFrom('conversation')
        .selectAll()
        .where('id', '=', conv.id)
        .execute();
      const remainingLinks = await db
        .selectFrom('conversation_document')
        .selectAll()
        .where('document_id', '=', document.id)
        .execute();
      const remainingArtifacts = await db
        .selectFrom('artifact')
        .selectAll()
        .where('document_id', '=', document.id)
        .execute();
      expect(remainingConv).toHaveLength(0);
      expect(remainingLinks).toHaveLength(0);
      expect(remainingArtifacts).toHaveLength(0);
    });

    it('unlinks but preserves a real Telegram conversation', async () => {
      const { document } = await upload();
      const now = Math.floor(Date.now() / 1000);
      const conv = await db
        .insertInto('conversation')
        .values({
          channel: 'telegram',
          thread_key: 'tg:123',
          status: 'open',
          created_at: now,
          updated_at: now,
          closed_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('conversation_document')
        .values({ conversation_id: conv.id, document_id: document.id })
        .execute();

      await service.deleteDocument(document.id);

      // The thread survives; only the document attachment is removed.
      const survivingConv = await db
        .selectFrom('conversation')
        .selectAll()
        .where('id', '=', conv.id)
        .execute();
      const remainingLinks = await db
        .selectFrom('conversation_document')
        .selectAll()
        .where('document_id', '=', document.id)
        .execute();
      expect(survivingConv).toHaveLength(1);
      expect(remainingLinks).toHaveLength(0);
    });
  });

  describe('pending triage result', () => {
    it('persists and clears a pending triage result on the document', async () => {
      const now = Math.floor(Date.now() / 1000);
      const doc = await db
        .insertInto('document')
        .values({
          hash: 'h-pending-1',
          filename: 'f.pdf',
          mime_type: 'application/pdf',
          size_bytes: 1,
          storage_path: null,
          status: 'needs_triage',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      expect(await service.getPendingTriageResult(doc.id)).toBeNull();

      const triage = {
        kind: 'new_expense' as const,
        gross_amount: 1525,
        vat_amount: 285,
        tax_point_date: '2026-03-15',
        category: 'software',
        supplier_proposal: {
          mode: 'create' as const,
          create_name: 'Acme OÜ',
          create_country: 'EE',
          create_registration_key: 'EE100200300',
          create_email: null,
          create_phone: null,
          create_address: null,
        },
        document_type: 'invoice' as const,
        currency: 'EUR',
        document_vat_marking: null,
        supplier_invoice_number: 'INV-7',
        confidence: 0.42,
      };

      await service.setPendingTriageResult(doc.id, triage);
      expect(await service.getPendingTriageResult(doc.id)).toEqual(triage);

      await service.setPendingTriageResult(doc.id, null);
      expect(await service.getPendingTriageResult(doc.id)).toBeNull();
    });

    it('throws when the stored blob is malformed', async () => {
      const now = Math.floor(Date.now() / 1000);
      const doc = await db
        .insertInto('document')
        .values({
          hash: 'h-bad-blob',
          filename: 'f.pdf',
          mime_type: 'application/pdf',
          size_bytes: 1,
          storage_path: null,
          status: 'needs_triage',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await db
        .updateTable('document')
        .set({ pending_triage_result: '{not valid triage}' })
        .where('id', '=', doc.id)
        .execute();

      await expect(service.getPendingTriageResult(doc.id)).rejects.toThrow();
    });
  });
});
