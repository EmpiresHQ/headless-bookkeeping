import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { DocumentsService } from './documents.service';
import {
  DocumentStorageService,
  DOCUMENT_STORAGE_ROOT,
} from './document-storage.service';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Integration test for the document intake pipeline:
 *   DocumentsService + DocumentStorageService + real SQLite + real migrations.
 *
 * Proves:
 *   (a) Deduplication collapses byte-identical uploads into one Document with
 *       multiple DocumentSources.
 *   (b) The DB-level UNIQUE constraint on document.hash rejects a raw duplicate
 *       INSERT (G6 integrity).
 */
describe('Document intake (integration)', () => {
  let db: Kysely<Database>;
  let service: DocumentsService;
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = join('/tmp', 'doc-intake-test', `${Date.now()}`);
    await fs.mkdir(storageRoot, { recursive: true });

    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
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

  it('(a) deduplicates byte-identical uploads into one document with two sources', async () => {
    const buffer = Buffer.from('same bytes');

    const first = await service.upload({
      buffer,
      filename: 'receipt1.pdf',
      mimeType: 'application/pdf',
      channel: 'upload',
      sourceIdentifier: null,
    });
    expect(first.deduplicated).toBe(false);

    const second = await service.upload({
      buffer,
      filename: 'receipt2.pdf',
      mimeType: 'application/pdf',
      channel: 'email',
      sourceIdentifier: 'msg-456',
    });
    expect(second.deduplicated).toBe(true);
    expect(second.document.id).toBe(first.document.id);

    const hydrated = await service.hydrate(second.document);
    expect(hydrated.sources.length).toBe(2);
    expect(hydrated.sources.map((s) => s.channel)).toEqual(
      expect.arrayContaining(['upload', 'email']),
    );

    // Only one document row exists
    const allDocs = await service.list();
    expect(allDocs.length).toBe(1);
  });

  it('(b) DB UNIQUE constraint rejects a raw duplicate hash insert', async () => {
    const buffer = Buffer.from('unique test');
    const hash =
      'a' +
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'.slice(
        1,
      );

    // Verify the table exists and has the unique constraint
    const tables = await db.introspection.getTables();
    const docTable = tables.find((t) => t.name === 'document');
    expect(docTable).toBeDefined();

    // Verify the table exists and has the unique constraint
    const indexes = await (
      db as unknown as {
        selectFrom: (table: string) => {
          select: (cols: string[]) => {
            where: (
              col: string,
              op: string,
              val: string,
            ) => {
              execute: () => Promise<
                Array<{ name: string; sql: string | null }>
              >;
            };
          };
        };
      }
    )
      .selectFrom('sqlite_master')
      .select(['name', 'sql'])
      .where('type', '=', 'index')
      .execute();
    expect(indexes.some((i) => i.name?.includes('autoindex'))).toBe(true);

    await db
      .insertInto('document')
      .values({
        hash,
        filename: 'first.pdf',
        mime_type: 'application/pdf',
        size_bytes: buffer.length,
        storage_path: null,
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
      })
      .execute();

    let threw = false;
    try {
      await db
        .insertInto('document')
        .values({
          hash,
          filename: 'second.pdf',
          mime_type: 'application/pdf',
          size_bytes: buffer.length,
          storage_path: null,
          status: 'pending',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
