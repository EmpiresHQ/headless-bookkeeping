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
});
