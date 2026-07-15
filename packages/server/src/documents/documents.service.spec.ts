import { NotFoundException, ConflictException, Logger } from '@nestjs/common';
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
import { PreviewRenderer } from './preview-renderer';
import type { DocumentStatus } from './types';
import { promises as fs } from 'fs';
import { join } from 'path';

describe('DocumentsService (unit)', () => {
  let service: DocumentsService;
  let db: Kysely<Database>;
  let storageRoot: string;
  // Stub returned by default: render returns null (no-op, non-fatal).
  // Individual tests can override renderMock.mockResolvedValueOnce().
  let renderMock: jest.Mock;

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

    renderMock = jest.fn().mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: DOCUMENT_STORAGE_ROOT, useValue: storageRoot },
        DocumentStorageService,
        {
          provide: PreviewRenderer,
          useValue: { render: renderMock },
        },
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

    it('sets preview_path when renderer returns a path (new document)', async () => {
      renderMock.mockResolvedValueOnce('1/previews/abc123.png');

      const result = await service.upload({
        buffer: Buffer.from('pdf bytes'),
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });

      expect(result.deduplicated).toBe(false);
      expect(result.document.preview_path).toBe('1/previews/abc123.png');
      expect(renderMock).toHaveBeenCalledTimes(1);

      // Verify DB row was actually updated.
      const row = await db
        .selectFrom('document')
        .select('preview_path')
        .where('id', '=', result.document.id)
        .executeTakeFirstOrThrow();
      expect(row.preview_path).toBe('1/previews/abc123.png');
    });

    it('leaves preview_path NULL when renderer returns null (unsupported/failed), upload still succeeds', async () => {
      // renderMock already returns null by default.
      const result = await service.upload({
        buffer: Buffer.from('unknown bytes'),
        filename: 'weird.xyz',
        mimeType: 'application/octet-stream',
        channel: 'upload',
        sourceIdentifier: null,
      });

      expect(result.deduplicated).toBe(false);
      expect(result.document.preview_path).toBeNull();
      expect(renderMock).toHaveBeenCalledTimes(1);
    });

    it('upload succeeds and preview_path is null when renderer rejects', async () => {
      renderMock.mockRejectedValueOnce(new Error('boom'));

      const result = await service.upload({
        buffer: Buffer.from('renderer-throw bytes'),
        filename: 'throw.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });

      expect(result.deduplicated).toBe(false);
      expect(result.document.preview_path).toBeNull();
      // Upload must succeed despite the renderer rejection.
      await expect(service.getById(result.document.id)).resolves.toBeTruthy();
    });

    it('does NOT call renderer on dedup hit (existing preview preserved)', async () => {
      const buffer = Buffer.from('dedup preview bytes');

      // First upload: renderer returns a preview path.
      renderMock.mockResolvedValueOnce('1/previews/deadbeef.png');
      const first = await service.upload({
        buffer,
        filename: 'orig.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      expect(first.document.preview_path).toBe('1/previews/deadbeef.png');
      expect(renderMock).toHaveBeenCalledTimes(1);

      renderMock.mockClear();

      // Second upload (dedup): renderer must NOT be called again.
      const second = await service.upload({
        buffer,
        filename: 'orig.pdf',
        mimeType: 'application/pdf',
        channel: 'email',
        sourceIdentifier: null,
      });
      expect(second.deduplicated).toBe(true);
      expect(second.document.preview_path).toBe('1/previews/deadbeef.png');
      expect(renderMock).not.toHaveBeenCalled();
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

    it('refuses (409) when the linked expense is posted — row and file survive', async () => {
      const { document } = await upload();
      const path = document.storage_path!;
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
          status: 'posted',
          voucher_id: null,
          document_vat_marking: null,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await expect(service.deleteDocument(document.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Row survives.
      await expect(service.getById(document.id)).resolves.toBeTruthy();
      // File survives.
      await expect(fs.readFile(join(storageRoot, path))).resolves.toBeTruthy();
    });

    it('refuses (409) when the linked expense is reversed — row and file survive', async () => {
      const { document } = await upload();
      const path = document.storage_path!;
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
          status: 'reversed',
          voucher_id: null,
          document_vat_marking: null,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await expect(service.deleteDocument(document.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Row survives.
      await expect(service.getById(document.id)).resolves.toBeTruthy();
      // File survives.
      await expect(fs.readFile(join(storageRoot, path))).resolves.toBeTruthy();
    });

    it('allows deletion when the linked expense is draft (row and file removed)', async () => {
      const { document } = await upload();
      const path = document.storage_path!;
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

      await expect(
        service.deleteDocument(document.id),
      ).resolves.toBeUndefined();
      // Row gone.
      await expect(service.getById(document.id)).rejects.toThrow(
        NotFoundException,
      );
      // File gone.
      await expect(fs.readFile(join(storageRoot, path))).rejects.toThrow();
    });

    it('allows deletion when the linked expense is pending (row and file removed)', async () => {
      const { document } = await upload();
      const path = document.storage_path!;
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
          status: 'pending',
          voucher_id: null,
          document_vat_marking: null,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await expect(
        service.deleteDocument(document.id),
      ).resolves.toBeUndefined();
      // Row gone.
      await expect(service.getById(document.id)).rejects.toThrow(
        NotFoundException,
      );
      // File gone.
      await expect(fs.readFile(join(storageRoot, path))).rejects.toThrow();
    });

    it('allows deletion when no expense exists (row and file removed)', async () => {
      const { document } = await upload();
      const path = document.storage_path!;

      await expect(
        service.deleteDocument(document.id),
      ).resolves.toBeUndefined();
      // Row gone.
      await expect(service.getById(document.id)).rejects.toThrow(
        NotFoundException,
      );
      // File gone.
      await expect(fs.readFile(join(storageRoot, path))).rejects.toThrow();
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
        outgoing_signals: {
          org_name_is_issuer: false,
          org_vat_is_issuer: false,
          has_buyer_block: false,
          self_identifies_as_invoice: false,
        },
      };
      const enrichment = {
        summary: 'Observed supplier evidence: Acme OÜ / EE100200300',
      };

      await service.setPendingTriageResult(doc.id, triage, enrichment);
      expect(await service.getPendingTriageResult(doc.id)).toEqual(triage);
      expect(await service.getPendingTriageReplay(doc.id)).toEqual({
        triageResult: triage,
        enrichment,
      });

      await service.setPendingTriageResult(doc.id, null);
      expect(await service.getPendingTriageResult(doc.id)).toBeNull();
      expect(await service.getPendingTriageReplay(doc.id)).toBeNull();
    });

    it('strips unknown fields when replaying the stored triage blob', async () => {
      const now = Math.floor(Date.now() / 1000);
      const doc = await db
        .insertInto('document')
        .values({
          hash: 'h-extra-fields',
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
        .set({
          pending_triage_result: JSON.stringify({
            kind: 'new_expense',
            gross_amount: 1525,
            vat_amount: 285,
            tax_point_date: '2026-03-15',
            category: 'software',
            document_type: 'invoice',
            currency: 'EUR',
            document_vat_marking: null,
            supplier_invoice_number: 'INV-7',
            confidence: 0.42,
            outgoing_signals: {
              org_name_is_issuer: false,
              org_vat_is_issuer: false,
              has_buyer_block: false,
              self_identifies_as_invoice: false,
            },
            enrichment: { summary: 'lost on parse' },
          }),
        })
        .where('id', '=', doc.id)
        .execute();

      expect(await service.getPendingTriageResult(doc.id)).toEqual({
        kind: 'new_expense',
        gross_amount: 1525,
        vat_amount: 285,
        tax_point_date: '2026-03-15',
        category: 'software',
        document_type: 'invoice',
        currency: 'EUR',
        document_vat_marking: null,
        supplier_invoice_number: 'INV-7',
        confidence: 0.42,
        outgoing_signals: {
          org_name_is_issuer: false,
          org_vat_is_issuer: false,
          has_buyer_block: false,
          self_identifies_as_invoice: false,
        },
      });
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

    it('returns enrichment: null when the stored enrichment blob is malformed', async () => {
      const now = Math.floor(Date.now() / 1000);
      const doc = await db
        .insertInto('document')
        .values({
          hash: 'h-bad-enrichment',
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
        .set({
          pending_triage_result: JSON.stringify({
            kind: 'new_expense',
            gross_amount: 1525,
            vat_amount: 285,
            tax_point_date: '2026-03-15',
            category: 'software',
            document_type: 'invoice',
            currency: 'EUR',
            document_vat_marking: null,
            supplier_invoice_number: 'INV-7',
            confidence: 0.42,
            outgoing_signals: {
              org_name_is_issuer: false,
              org_vat_is_issuer: false,
              has_buyer_block: false,
              self_identifies_as_invoice: false,
            },
          }),
          pending_triage_enrichment: '{not valid enrichment}',
        })
        .where('id', '=', doc.id)
        .execute();

      expect(await service.getPendingTriageReplay(doc.id)).toEqual({
        triageResult: {
          kind: 'new_expense',
          gross_amount: 1525,
          vat_amount: 285,
          tax_point_date: '2026-03-15',
          category: 'software',
          document_type: 'invoice',
          currency: 'EUR',
          document_vat_marking: null,
          supplier_invoice_number: 'INV-7',
          confidence: 0.42,
          outgoing_signals: {
            org_name_is_issuer: false,
            org_vat_is_issuer: false,
            has_buyer_block: false,
            self_identifies_as_invoice: false,
          },
        },
        enrichment: null,
      });
    });
  });

  describe('claimNextPending', () => {
    const STALE = 300;
    const MAX = 3;

    async function insertPending(
      hash: string,
      createdAt: number,
      opts: {
        processingSince?: number | null;
        attempts?: number;
        storagePath?: string | null;
      } = {},
    ): Promise<number> {
      const row = await db
        .insertInto('document')
        .values({
          hash,
          filename: `${hash}.png`,
          mime_type: 'image/png',
          size_bytes: 1,
          // A claimable document has its bytes stored. Default to a non-null
          // path so these tests model the post-upload steady state; the
          // storage_path-null case (the upload/worker race) is its own test.
          storage_path:
            opts.storagePath === undefined
              ? `${hash}/${hash}.png`
              : opts.storagePath,
          status: 'pending',
          created_at: createdAt,
          processing_since: opts.processingSince ?? null,
          processing_attempts: opts.attempts ?? 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row.id;
    }

    it('claims the oldest pending document (FIFO) and stamps it', async () => {
      const older = await insertPending('a', 1000);
      await insertPending('b', 2000);

      const claimed = await service.claimNextPending(STALE, MAX);
      expect(claimed).toEqual({ id: older, claimant_id: null });

      const row = await db
        .selectFrom('document')
        .select(['processing_since', 'processing_attempts'])
        .where('id', '=', older)
        .executeTakeFirstOrThrow();
      expect(row.processing_since).not.toBeNull();
      expect(row.processing_attempts).toBe(1);
    });

    it('returns null when nothing is claimable', async () => {
      const id = await service.claimNextPending(STALE, MAX);
      expect(id).toBeNull();
    });

    it('skips a document whose processing_since is still fresh', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertPending('fresh', 1000, { processingSince: now });
      const id = await service.claimNextPending(STALE, MAX);
      expect(id).toBeNull();
    });

    it('reclaims a document whose processing_since is stale', async () => {
      const now = Math.floor(Date.now() / 1000);
      const stuck = await insertPending('stuck', 1000, {
        processingSince: now - STALE - 1,
      });
      const claimed = await service.claimNextPending(STALE, MAX);
      expect(claimed).toEqual({ id: stuck, claimant_id: null });
    });

    it('excludes a document at the attempt cap', async () => {
      await insertPending('poison', 1000, { attempts: MAX });
      const id = await service.claimNextPending(STALE, MAX);
      expect(id).toBeNull();
    });

    it('claims the last attempt slot and then excludes the document at the cap', async () => {
      const id = await insertPending('cap-test', 1000, { attempts: MAX - 1 });

      // First call: one slot remaining — should claim it and bump attempts to MAX.
      const claimed = await service.claimNextPending(STALE, MAX);
      expect(claimed).toEqual({ id, claimant_id: null });

      const row = await db
        .selectFrom('document')
        .select('processing_attempts')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.processing_attempts).toBe(MAX);

      // Second call: document is now at the cap — must be excluded.
      const second = await service.claimNextPending(STALE, MAX);
      expect(second).toBeNull();
    });

    it('does not claim a pending document whose bytes are not yet stored (storage_path NULL)', async () => {
      // Reproduces the upload/worker race: upload() inserts the row as
      // status='pending' with storage_path=NULL and only sets storage_path
      // AFTER writing the file. The worker must not claim it in that window —
      // OCR would fail with "no stored file" and mislabel a good document
      // ocr_failed.
      await insertPending('no-bytes', 1000, { storagePath: null });
      const id = await service.claimNextPending(STALE, MAX);
      expect(id).toBeNull();
    });

    it('claims the document once its bytes are stored (storage_path set)', async () => {
      const withBytes = await insertPending('has-bytes', 1000, {
        storagePath: 'has-bytes/has-bytes.png',
      });
      const claimed = await service.claimNextPending(STALE, MAX);
      expect(claimed).toEqual({ id: withBytes, claimant_id: null });
    });

    it('skips the storage_path-null document and claims the next stored one', async () => {
      // FIFO order would pick the older no-bytes doc first, but it must be
      // skipped in favour of the younger doc whose bytes are stored.
      await insertPending('older-no-bytes', 1000, { storagePath: null });
      const younger = await insertPending('younger-stored', 2000);
      const claimed = await service.claimNextPending(STALE, MAX);
      expect(claimed).toEqual({ id: younger, claimant_id: null });
    });

    it('ignores non-pending documents', async () => {
      const row = await db
        .insertInto('document')
        .values({
          hash: 'done',
          filename: 'done.png',
          mime_type: 'image/png',
          size_bytes: 1,
          storage_path: null,
          status: 'processed',
          created_at: 1000,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('processed');
      const id = await service.claimNextPending(STALE, MAX);
      expect(id).toBeNull();
    });
  });

  describe('reprocessDocument', () => {
    async function insertWithStatus(
      hash: string,
      status: DocumentStatus,
    ): Promise<number> {
      const row = await db
        .insertInto('document')
        .values({
          hash,
          filename: `${hash}.png`,
          mime_type: 'image/png',
          size_bytes: 1,
          storage_path: null,
          status,
          created_at: 1000,
          processing_since: 999,
          processing_attempts: 2,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row.id;
    }

    it('resets a needs_triage document to pending with a fresh slate, reports requeued, and kicks the worker', async () => {
      const kicker = jest.fn();
      service.setReprocessKicker(kicker);
      const id = await insertWithStatus('nt', 'needs_triage');

      const result = await service.reprocessDocument(id);

      expect(result).toEqual({ requeued: true, priorStatus: 'needs_triage' });
      expect(kicker).toHaveBeenCalledTimes(1); // worker woken promptly

      const row = await db
        .selectFrom('document')
        .select(['status', 'processing_since', 'processing_attempts'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('pending');
      expect(row.processing_since).toBeNull();
      expect(row.processing_attempts).toBe(0);
    });

    it('is a no-op for a non-needs_triage document: reports the actual prior status, warns, and does NOT kick', async () => {
      const kicker = jest.fn();
      service.setReprocessKicker(kicker);
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const id = await insertWithStatus('done', 'processed');

      const result = await service.reprocessDocument(id);

      expect(result).toEqual({ requeued: false, priorStatus: 'processed' });
      expect(kicker).not.toHaveBeenCalled();

      // Row untouched — the guarded UPDATE matched zero rows.
      const row = await db
        .selectFrom('document')
        .select(['status', 'processing_since', 'processing_attempts'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('processed');
      expect(row.processing_attempts).toBe(2);

      // The silent no-op is now observable as a WARN naming the doc + status.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`reprocessDocument(${id})`),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('processed'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('upload with claimant_id', () => {
    let claimantEntityId: number;

    beforeEach(async () => {
      const now = Math.floor(Date.now() / 1000);
      const entity = await db
        .insertInto('entity')
        .values({
          role: 'employee',
          country: 'EE',
          name: 'Test Claimant',
          goods_vs_services: 'services',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      claimantEntityId = entity.id;
    });

    it('persists claimant_id on the document row when provided', async () => {
      const { document } = await service.upload({
        buffer: Buffer.from('pdf'),
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
        capturedAt: null,
        precheckJson: null,
        claimantId: claimantEntityId,
      });
      expect(document.claimant_id).toBe(claimantEntityId);
    });

    it('defaults claimant_id to null when not provided', async () => {
      const { document } = await service.upload({
        buffer: Buffer.from('pdf2'),
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
        capturedAt: null,
        precheckJson: null,
      });
      expect(document.claimant_id).toBeNull();
    });
  });

  describe('confirmPayment', () => {
    let claimantEntityId: number;

    beforeEach(async () => {
      const now = Math.floor(Date.now() / 1000);
      const entity = await db
        .insertInto('entity')
        .values({
          role: 'employee',
          country: 'EE',
          name: 'Confirm Claimant',
          goods_vs_services: 'services',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      claimantEntityId = entity.id;
    });

    it('clears claimant_id when paid_by_claimant is false', async () => {
      const { document: doc } = await service.upload({
        buffer: Buffer.from('r'),
        filename: 'r.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
        capturedAt: null,
        precheckJson: null,
        claimantId: claimantEntityId,
      });
      await service.confirmPayment(doc.id, false);
      const updated = await service.getById(doc.id);
      expect(updated.claimant_id).toBeNull();
    });

    it('keeps claimant_id when paid_by_claimant is true', async () => {
      const { document: doc } = await service.upload({
        buffer: Buffer.from('r2'),
        filename: 'r2.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
        capturedAt: null,
        precheckJson: null,
        claimantId: claimantEntityId,
      });
      await service.confirmPayment(doc.id, true);
      const updated = await service.getById(doc.id);
      expect(updated.claimant_id).toBe(claimantEntityId);
    });

    it('throws NotFoundException for unknown document', async () => {
      await expect(service.confirmPayment(9999, true)).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('getPreview', () => {
    let storageService: DocumentStorageService;

    beforeEach(() => {
      storageService = new DocumentStorageService(storageRoot);
    });

    it('(a) streams stored bytes without calling renderer when preview_path is set', async () => {
      const rawBuffer = Buffer.from('fake png bytes');
      const { document: doc } = await service.upload({
        buffer: Buffer.from('pdf content'),
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });

      // Write a preview file into storage and set preview_path.
      await storageService.saveFile(
        doc.id,
        `previews/${doc.hash}.png`,
        rawBuffer,
      );
      await db
        .updateTable('document')
        .set({ preview_path: `${doc.id}/previews/${doc.hash}.png` })
        .where('id', '=', doc.id)
        .execute();

      renderMock.mockClear();
      const result = await service.getPreview(doc.id);

      expect(result.buffer).toEqual(rawBuffer);
      expect(result.hash).toBe(doc.hash);
      expect(renderMock).not.toHaveBeenCalled();
    });

    it('(b) renders, persists path, and streams bytes when preview_path is NULL', async () => {
      const pngBytes = Buffer.from('rendered png');
      const { document: doc } = await service.upload({
        buffer: Buffer.from('pdf content 2'),
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });

      // Verify preview_path is NULL (default mock returns null at upload).
      const rowBefore = await db
        .selectFrom('document')
        .select('preview_path')
        .where('id', '=', doc.id)
        .executeTakeFirstOrThrow();
      expect(rowBefore.preview_path).toBeNull();

      // Clear calls accumulated during upload before testing getPreview.
      renderMock.mockClear();

      // Stub render: write file to storage and return relative path.
      const expectedPath = `${doc.id}/previews/${doc.hash}.png`;
      renderMock.mockImplementationOnce(
        async (d: { id: number; hash: string }) => {
          await storageService.saveFile(
            d.id,
            `previews/${d.hash}.png`,
            pngBytes,
          );
          return expectedPath;
        },
      );

      const result = await service.getPreview(doc.id);

      expect(result.buffer).toEqual(pngBytes);
      expect(result.hash).toBe(doc.hash);
      // Re-query to assert the DB row was persisted.
      const rowAfter = await db
        .selectFrom('document')
        .select('preview_path')
        .where('id', '=', doc.id)
        .executeTakeFirstOrThrow();
      expect(rowAfter.preview_path).toBe(expectedPath);
      expect(renderMock).toHaveBeenCalledTimes(1);
    });

    it('(c) throws NotFoundException when render returns null (non-visual file)', async () => {
      const { document: doc } = await service.upload({
        buffer: Buffer.from('binary blob'),
        filename: 'data.bin',
        mimeType: 'application/octet-stream',
        channel: 'upload',
        sourceIdentifier: null,
      });
      // renderMock returns null by default; preview_path stays NULL.

      await expect(service.getPreview(doc.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('(d) throws NotFoundException for a missing document id', async () => {
      await expect(service.getPreview(9999)).rejects.toThrow(NotFoundException);
    });

    it('(e) throws NotFoundException when preview_path is NULL and storage_path is NULL', async () => {
      // Insert a document with both paths null (e.g. a pre-existing doc that
      // never completed storage, or a row inserted before the storage write).
      const now = Math.floor(Date.now() / 1000);
      const doc = await db
        .insertInto('document')
        .values({
          hash: 'null-storage-hash',
          filename: 'orphan.pdf',
          mime_type: 'application/pdf',
          size_bytes: 0,
          storage_path: null,
          status: 'pending',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Ensure preview_path is also null (it is by default, but be explicit).
      await db
        .updateTable('document')
        .set({ preview_path: null })
        .where('id', '=', doc.id)
        .execute();

      await expect(service.getPreview(doc.id)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listArchiveRows — enriched archive view
  // ---------------------------------------------------------------------------
  describe('listArchiveRows', () => {
    async function insertEntity(
      name: string,
      role = 'supplier',
    ): Promise<number> {
      const now = Math.floor(Date.now() / 1000);
      const row = await db
        .insertInto('entity')
        .values({
          role,
          country: 'EE',
          name,
          goods_vs_services: 'services',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row.id;
    }

    async function insertExpense(
      documentId: number,
      opts: {
        supplierId?: number | null;
        claimantId?: number | null;
        status?: string;
      } = {},
    ): Promise<number> {
      const now = Math.floor(Date.now() / 1000);
      const row = await db
        .insertInto('expense')
        .values({
          document_id: documentId,
          supplier_id: opts.supplierId ?? null,
          claimant_id: opts.claimantId ?? null,
          category: 'transport',
          gross_amount: 1000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-05-01',
          status: opts.status ?? 'draft',
          voucher_id: null,
          document_vat_marking: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return row.id;
    }

    async function insertAuditFinding(
      documentId: number,
      description: string,
      reasonType: string | null = null,
    ): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      await db
        .insertInto('audit_finding')
        .values({
          severity: 'medium',
          finding_type: 'needs_triage',
          description,
          referenced_object_type: 'document',
          referenced_object_id: documentId,
          status: 'open',
          created_at: now,
          resolved_at: null,
          snoozed_at: null,
          transitioned_by: null,
          transition_reason: null,
          reason_type: reasonType,
        })
        .execute();
    }

    it('returns created_at and channel for a simple document', async () => {
      const { document: doc } = await service.upload({
        buffer: Buffer.from('simple doc'),
        filename: 'simple.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });

      const rows = await service.listArchiveRows();
      const row = rows.find((r) => r.id === doc.id);
      expect(row).toBeDefined();
      expect(row!.created_at).toBe(doc.created_at);
      expect(row!.channel).toBe('upload');
      expect(row!.reason).toBeNull();
      expect(row!.reason_type).toBeNull();
      expect(row!.expense_id).toBeNull();
      expect(row!.supplier_name).toBeNull();
      expect(row!.claimant_name).toBeNull();
      expect(row!.expense_status).toBeNull();
    });

    it('returns supplier_name and expense_id for a document linked to an expense', async () => {
      const supplierId = await insertEntity('Acme OÜ', 'supplier');
      const { document: doc } = await service.upload({
        buffer: Buffer.from('supplier doc'),
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        channel: 'email',
        sourceIdentifier: null,
      });
      const expId = await insertExpense(doc.id, {
        supplierId,
        status: 'posted',
      });

      const rows = await service.listArchiveRows();
      const row = rows.find((r) => r.id === doc.id);
      expect(row).toBeDefined();
      expect(row!.expense_id).toBe(expId);
      expect(row!.supplier_name).toBe('Acme OÜ');
      expect(row!.expense_status).toBe('posted');
      expect(row!.claimant_name).toBeNull();
    });

    it('returns claimant_name for a claimant-paid expense', async () => {
      const supplierId = await insertEntity('Shop OÜ', 'supplier');
      const claimantId = await insertEntity('Alice', 'employee');
      const { document: doc } = await service.upload({
        buffer: Buffer.from('claimant doc'),
        filename: 'receipt.pdf',
        mimeType: 'application/pdf',
        channel: 'telegram',
        sourceIdentifier: null,
      });
      await insertExpense(doc.id, {
        supplierId,
        claimantId,
        status: 'pending',
      });

      const rows = await service.listArchiveRows();
      const row = rows.find((r) => r.id === doc.id);
      expect(row).toBeDefined();
      expect(row!.supplier_name).toBe('Shop OÜ');
      expect(row!.claimant_name).toBe('Alice');
      expect(row!.expense_status).toBe('pending');
    });

    it('returns reason and reason_type for a needs_triage document', async () => {
      const now = Math.floor(Date.now() / 1000);
      const docRow = await db
        .insertInto('document')
        .values({
          hash: 'hash-needs-triage',
          filename: 'ocr-fail.pdf',
          mime_type: 'application/pdf',
          size_bytes: 100,
          storage_path: null,
          status: 'needs_triage',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto('document_source')
        .values({
          document_id: docRow.id,
          channel: 'upload',
          source_identifier: null,
          received_at: now,
          captured_at: null,
          precheck_json: null,
        })
        .execute();
      await insertAuditFinding(
        docRow.id,
        'OCR classification failed: low confidence',
      );

      const rows = await service.listArchiveRows();
      const row = rows.find((r) => r.id === docRow.id);
      expect(row).toBeDefined();
      expect(row!.reason).toBe('OCR classification failed: low confidence');
      expect(row!.reason_type).toBe('low_confidence');
    });

    it('the persisted reason_type wins over the legacy description-sniffing classifier', async () => {
      const now = Math.floor(Date.now() / 1000);
      const docRow = await db
        .insertInto('document')
        .values({
          hash: 'hash-persisted-wins',
          filename: 'pass2-fail.pdf',
          mime_type: 'application/pdf',
          size_bytes: 100,
          storage_path: null,
          status: 'needs_triage',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto('document_source')
        .values({
          document_id: docRow.id,
          channel: 'upload',
          source_identifier: null,
          received_at: now,
          captured_at: null,
          precheck_json: null,
        })
        .execute();
      // A description that mentions "OCR" — the legacy classifyReasonType()
      // string-sniffer would mis-bucket this as 'ocr_failed' (the exact bug
      // migration 065 fixes). The persisted reason_type must win.
      await insertAuditFinding(
        docRow.id,
        'AI classification failed during enrichment (enrichment-incomplete): OCR-ish text in the detail',
        'classification_failed',
      );

      const rows = await service.listArchiveRows();
      const row = rows.find((r) => r.id === docRow.id);
      expect(row).toBeDefined();
      expect(row!.reason_type).toBe('classification_failed');
    });

    it('falls back to the legacy classifier when reason_type is NULL (legacy row)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const docRow = await db
        .insertInto('document')
        .values({
          hash: 'hash-legacy-fallback',
          filename: 'legacy.pdf',
          mime_type: 'application/pdf',
          size_bytes: 100,
          storage_path: null,
          status: 'needs_triage',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto('document_source')
        .values({
          document_id: docRow.id,
          channel: 'upload',
          source_identifier: null,
          received_at: now,
          captured_at: null,
          precheck_json: null,
        })
        .execute();
      await insertAuditFinding(
        docRow.id,
        'OCR transcription failed (unreadable): file too blurry',
        null,
      );

      const rows = await service.listArchiveRows();
      const row = rows.find((r) => r.id === docRow.id);
      expect(row).toBeDefined();
      expect(row!.reason_type).toBe('ocr_failed');
    });

    it('returns null reason/reason_type for a non-needs_triage document', async () => {
      const { document: doc } = await service.upload({
        buffer: Buffer.from('normal doc'),
        filename: 'normal.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      // No audit_finding → reason should be null
      const rows = await service.listArchiveRows();
      const row = rows.find((r) => r.id === doc.id);
      expect(row).toBeDefined();
      expect(row!.reason).toBeNull();
      expect(row!.reason_type).toBeNull();
    });

    it('yields exactly one row per document when the document has multiple sources', async () => {
      const buffer = Buffer.from('multi-source');
      const first = await service.upload({
        buffer,
        filename: 'multi.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      // Second upload deduplicates → adds a second document_source row
      await service.upload({
        buffer,
        filename: 'multi.pdf',
        mimeType: 'application/pdf',
        channel: 'email',
        sourceIdentifier: 'msg-xyz',
      });

      const rows = await service.listArchiveRows();
      const docRows = rows.filter((r) => r.id === first.document.id);
      // Exactly ONE row despite two sources
      expect(docRows).toHaveLength(1);
      // Channel should be from the LATEST source (email, received_at is higher)
      expect(docRows[0].channel).toBe('email');
    });

    it('yields exactly one row when a second document_source is inserted directly (non-dedup path)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const docRow = await db
        .insertInto('document')
        .values({
          hash: 'hash-direct-multi',
          filename: 'direct-multi.pdf',
          mime_type: 'application/pdf',
          size_bytes: 100,
          storage_path: null,
          status: 'pending',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto('document_source')
        .values({
          document_id: docRow.id,
          channel: 'email',
          source_identifier: 'msg-1',
          received_at: now - 100,
          captured_at: null,
          precheck_json: null,
        })
        .execute();
      await db
        .insertInto('document_source')
        .values({
          document_id: docRow.id,
          channel: 'telegram',
          source_identifier: 'tg-1',
          received_at: now,
          captured_at: null,
          precheck_json: null,
        })
        .execute();

      const rows = await service.listArchiveRows();
      const docRows = rows.filter((r) => r.id === docRow.id);
      expect(docRows).toHaveLength(1);
      expect(docRows[0].channel).toBe('telegram'); // latest channel (highest received_at)
    });

    it('does not throw and returns channel=email_sync for a mailbox-harvested document', async () => {
      // Regression: validateChannel previously only accepted upload|telegram|email|drive|ios_photo_library
      // and would throw on email_sync / email_push, causing GET /api/documents to 500.
      const { document: doc } = await service.upload({
        buffer: Buffer.from('mailbox-harvested'),
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        channel: 'email_sync',
        sourceIdentifier: 'imap-uid-42',
      });

      // Must not throw — previously validateChannel threw on 'email_sync'
      const rows = await service.listArchiveRows();

      const row = rows.find((r) => r.id === doc.id);
      expect(row).toBeDefined();
      expect(row!.channel).toBe('email_sync');
    });
  });

  describe('ios_photo_library channel', () => {
    it('stores an upload from the ios_photo_library channel', async () => {
      const result = await service.upload({
        buffer: Buffer.from('ios-bytes'),
        filename: 'receipt.heic',
        mimeType: 'image/heic',
        channel: 'ios_photo_library',
        sourceIdentifier: 'ASSET-1',
      });
      const hydrated = await service.hydrate(
        await service.getById(result.document.id),
      );
      expect(hydrated.sources[0].channel).toBe('ios_photo_library');
      expect(hydrated.sources[0].source_identifier).toBe('ASSET-1');
    });
  });

  describe('upload — ios metadata persistence', () => {
    it('persists capturedAt and precheckJson on a new document source', async () => {
      const result = await service.upload({
        buffer: Buffer.from('m1'),
        filename: 'r1.heic',
        mimeType: 'image/heic',
        channel: 'ios_photo_library',
        sourceIdentifier: 'ASSET-M1',
        capturedAt: 1749990000,
        precheckJson: '{"decision":"upload","top":0.91}',
      });
      const hydrated = await service.hydrate(
        await service.getById(result.document.id),
      );
      expect(hydrated.sources[0].captured_at).toBe(1749990000);
      expect(hydrated.sources[0].precheck_json).toBe(
        '{"decision":"upload","top":0.91}',
      );
    });

    it('persists ios metadata on the dedup path (second arrival)', async () => {
      const first = await service.upload({
        buffer: Buffer.from('dupe-bytes'),
        filename: 'r2.heic',
        mimeType: 'image/heic',
        channel: 'ios_photo_library',
        sourceIdentifier: 'ASSET-FIRST',
        capturedAt: 1749990000,
        precheckJson: '{"decision":"upload"}',
      });
      const second = await service.upload({
        buffer: Buffer.from('dupe-bytes'),
        filename: 'r2.heic',
        mimeType: 'image/heic',
        channel: 'ios_photo_library',
        sourceIdentifier: 'ASSET-SECOND',
        capturedAt: 1749991111,
        precheckJson: '{"decision":"upload","again":true}',
      });
      expect(second.deduplicated).toBe(true);
      expect(second.document.id).toBe(first.document.id);

      const hydrated = await service.hydrate(
        await service.getById(first.document.id),
      );
      const secondSource = hydrated.sources.find(
        (s) => s.source_identifier === 'ASSET-SECOND',
      );
      expect(secondSource?.captured_at).toBe(1749991111);
      expect(secondSource?.precheck_json).toBe(
        '{"decision":"upload","again":true}',
      );
    });

    it('defaults ios metadata to null when omitted', async () => {
      const result = await service.upload({
        buffer: Buffer.from('plain'),
        filename: 'plain.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      const hydrated = await service.hydrate(
        await service.getById(result.document.id),
      );
      expect(hydrated.sources[0].captured_at).toBeNull();
      expect(hydrated.sources[0].precheck_json).toBeNull();
    });
  });
});
