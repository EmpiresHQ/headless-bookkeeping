import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 060: document.preview_path + expense AI classification fields', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
  });

  afterEach(() => db.destroy());

  it('adds nullable preview_path to document', async () => {
    const now = Math.floor(Date.now() / 1000);
    const doc = await db
      .insertInto('document')
      .values({
        hash: 'h1',
        filename: 'f.pdf',
        mime_type: 'application/pdf',
        size_bytes: 100,
        storage_path: null,
        status: 'pending',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(doc.preview_path).toBeNull();
  });

  it('stores a non-null preview_path on document', async () => {
    const now = Math.floor(Date.now() / 1000);
    const doc = await db
      .insertInto('document')
      .values({
        hash: 'h2',
        filename: 'g.pdf',
        mime_type: 'application/pdf',
        size_bytes: 200,
        storage_path: null,
        status: 'pending',
        created_at: now,
        preview_path: 'previews/h2.webp',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(doc.preview_path).toBe('previews/h2.webp');
  });

  it('adds nullable ai_confidence, ai_document_type, ai_kind to expense', async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('expense')
      .values({
        supplier_id: null,
        category: 'meals',
        gross_amount: 1000,
        vat_amount: 0,
        currency: 'EUR',
        tax_point_date: '2026-06-24',
        status: 'draft',
        voucher_id: null,
        document_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.ai_confidence).toBeNull();
    expect(row.ai_document_type).toBeNull();
    expect(row.ai_kind).toBeNull();
  });

  it('stores ai classification fields on expense', async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('expense')
      .values({
        supplier_id: null,
        category: 'meals',
        gross_amount: 1500,
        vat_amount: 250,
        currency: 'EUR',
        tax_point_date: '2026-06-24',
        status: 'draft',
        voucher_id: null,
        document_id: null,
        ai_confidence: 0.97,
        ai_document_type: 'receipt',
        ai_kind: 'expense',
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.ai_confidence).toBeCloseTo(0.97);
    expect(row.ai_document_type).toBe('receipt');
    expect(row.ai_kind).toBe('expense');
  });

  it('DOWN migration removes all four columns', async () => {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateTo(
      '059_widen_document_source_channel',
    );
    expect(error).toBeUndefined();

    const docCols = await sql<{
      name: string;
    }>`PRAGMA table_info(document)`.execute(db);
    const docColNames = docCols.rows.map((r) => r.name);
    expect(docColNames).not.toContain('preview_path');

    const expCols = await sql<{
      name: string;
    }>`PRAGMA table_info(expense)`.execute(db);
    const expColNames = expCols.rows.map((r) => r.name);
    expect(expColNames).not.toContain('ai_confidence');
    expect(expColNames).not.toContain('ai_document_type');
    expect(expColNames).not.toContain('ai_kind');
  });
});
