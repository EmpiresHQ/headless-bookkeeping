import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NotFoundException } from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OcrService } from './ocr.service';
import { DocumentsService } from '../documents/documents.service';
import {
  DocumentStorageService,
  DOCUMENT_STORAGE_ROOT,
} from '../documents/document-storage.service';
import { ConversationsService } from '../conversations/conversations.service';
import {
  DocumentTranscriber,
  type OcrOutcome,
  type TranscribableFile,
} from './document-transcriber.port';

/** Canned markdown the stub transcriber returns by default. */
const STUB_MARKDOWN = '# Transcribed\n\nSupplier: Acme Ltd\nTotal: €123.00';

/** A controllable in-process DocumentTranscriber: records the files it was
 *  handed and lets a test swap its result via `impl`. */
class StubTranscriber extends DocumentTranscriber {
  calls: TranscribableFile[] = [];
  impl: (file: TranscribableFile) => OcrOutcome = () => ({
    ok: true,
    markdown: STUB_MARKDOWN,
  });
  transcribe(file: TranscribableFile): Promise<OcrOutcome> {
    this.calls.push(file);
    return Promise.resolve(this.impl(file));
  }
}

describe('OcrService', () => {
  let db: Kysely<Database>;
  let module: TestingModule;
  let service: OcrService;
  let transcriber: StubTranscriber;
  let storageRoot: string;
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

    storageRoot = mkdtempSync(join(tmpdir(), 'ocr-spec-'));
    transcriber = new StubTranscriber();

    module = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: DOCUMENT_STORAGE_ROOT, useValue: storageRoot },
        DocumentStorageService,
        DocumentsService,
        ConversationsService,
        OcrService,
        { provide: DocumentTranscriber, useValue: transcriber },
      ],
    }).compile();

    service = module.get(OcrService);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(storageRoot, { recursive: true, force: true });
    // Clean up test artifacts.
    if (existsSync(testArtifactsDir)) {
      rmSync(testArtifactsDir, { recursive: true, force: true });
    }
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
          storage_path: null,
          status: 'pending',
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // Persist real bytes so OcrService.getFile can read them before transcribe.
      const storage = module.get(DocumentStorageService);
      const relPath = await storage.saveFile(
        doc.id,
        filename,
        Buffer.from(`%PDF-1.4 ${filename}`),
      );
      await db
        .updateTable('document')
        .set({ storage_path: relPath })
        .where('id', '=', doc.id)
        .execute();
      return doc.id;
    }

    it('returns the transcriber markdown for a document', async () => {
      const docId = await seedDocument('invoice-acme.pdf');
      const outcome = await service.transcribe(docId);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.markdown).toBe(STUB_MARKDOWN);
      // The transcriber received the seeded bytes + metadata.
      expect(transcriber.calls).toHaveLength(1);
      expect(transcriber.calls[0].filename).toBe('invoice-acme.pdf');
      expect(transcriber.calls[0].mimeType).toBe('application/pdf');
    });

    it('routes a typed transcriber failure straight through (no persistence)', async () => {
      const docId = await seedDocument('broken.pdf');
      transcriber.impl = () => ({
        ok: false,
        category: 'unreadable',
        detail: 'docling-serve produced no markdown',
      });

      const outcome = await service.transcribe(docId);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.category).toBe('unreadable');

      // No artifact was written for a failed transcription.
      const count = await db
        .selectFrom('artifact')
        .select(db.fn.count('id').as('cnt'))
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirst();
      expect(Number(count!.cnt)).toBe(0);
    });

    it('stores markdown as an ocr_markdown artifact with crc32', async () => {
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
      expect(artifact!.crc32).not.toBeNull();
      expect(typeof artifact!.crc32).toBe('number');
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

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.markdown).toBe(second.markdown);

      // The engine was hit once; the second call served from the stored artifact.
      expect(transcriber.calls).toHaveLength(1);

      // Only one artifact should exist (not duplicated).
      const count = await db
        .selectFrom('artifact')
        .select(db.fn.count('id').as('cnt'))
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirst();

      expect(Number(count!.cnt)).toBe(1);
    });

    it('detects content changes via crc32 mismatch and re-transcribes', async () => {
      const docId = await seedDocument('receipt-test.pdf');
      const first = await service.transcribe(docId);

      // Simulate an external modification of the stored markdown file.
      const artifact = await db
        .selectFrom('artifact')
        .selectAll()
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirstOrThrow();

      writeFileSync(artifact.storage_path, 'tampered content', 'utf-8');

      // Re-run: should detect CRC mismatch, overwrite the file with correct content.
      const second = await service.transcribe(docId);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.markdown).not.toBe('tampered content');
      expect(second.markdown).toBe(first.markdown);

      // The mismatch re-hit the engine (initial + after tamper).
      expect(transcriber.calls).toHaveLength(2);

      // Still only one artifact row.
      const count = await db
        .selectFrom('artifact')
        .select(db.fn.count('id').as('cnt'))
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirst();
      expect(Number(count!.cnt)).toBe(1);
    });

    it('throws NotFoundException for non-existent document', async () => {
      // A missing Document is a precondition violation (the caller handed a bad
      // id) — there is no object to route to a human, so this stays a throw,
      // NOT a typed OcrOutcome failure.
      await expect(service.transcribe(9999)).rejects.toThrow(NotFoundException);
    });

    it('returns an ok outcome carrying the markdown on success', async () => {
      const docId = await seedDocument('receipt-ok.pdf');
      const outcome = await service.transcribe(docId);

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.markdown).toBe(STUB_MARKDOWN);
      }
    });

    it('returns a transient failure (not a throw) when a stored artifact file is missing', async () => {
      const docId = await seedDocument('receipt-gone.pdf');

      // First pass writes the markdown file + artifact row.
      const first = await service.transcribe(docId);
      expect(first.ok).toBe(true);

      // The backing file disappears (e.g. data/ cleaned) but the artifact row
      // survives. A re-run hits the idempotent fast path, reads the missing
      // file, and must surface a typed transient failure rather than letting an
      // ENOENT escape uncaught.
      const artifact = await db
        .selectFrom('artifact')
        .select('storage_path')
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirstOrThrow();
      rmSync(artifact.storage_path, { force: true });

      const outcome = await service.transcribe(docId);

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.category).toBe('transient');
        expect(outcome.detail).toBeTruthy();
      }
    });

    it('is race/retry-safe — concurrent transcribe() calls create exactly one artifact', async () => {
      const docId = await seedDocument('race-receipt.pdf');

      // Fire two transcribe() calls concurrently. Both will see no artifact at
      // the fast-path check; the transactional re-check must ensure only one
      // artifact (and one conversation) is created.
      const [a, b] = await Promise.all([
        service.transcribe(docId),
        service.transcribe(docId),
      ]);

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.markdown).toBe(b.markdown);

      const artifactCount = await db
        .selectFrom('artifact')
        .select(db.fn.count('id').as('cnt'))
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', docId)
        .executeTakeFirst();
      expect(Number(artifactCount!.cnt)).toBe(1);

      // And exactly one OCR conversation for the document.
      const convCount = await db
        .selectFrom('conversation')
        .select(db.fn.count('id').as('cnt'))
        .where('thread_key', '=', `ocr:${docId}`)
        .executeTakeFirst();
      expect(Number(convCount!.cnt)).toBe(1);
    });
  });
});
