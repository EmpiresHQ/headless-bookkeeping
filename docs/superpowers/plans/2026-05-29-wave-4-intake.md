# Wave 4 — Document Intake, Triage & Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring raw artifacts into the kernel as deduplicated `Document`s, triage them into `Expense`/`SalesInvoice` drafts, correct drafts and reverse posted vouchers, manage `ReportingPeriod`s, and wire the full upload → dedup → triage → draft → post intake flow.

**Architecture:** A `Document` is the SHA-256 deduplication anchor — byte-identical attachments arriving via any channel collapse into one `Document` row with many `document_source` rows, with file bytes on the filesystem (`data/documents/{id}/{filename}`) and never in SQLite. A stub `OCRService` produces deterministic triage data that `TriageService` routes into draft business objects; the correction flow either edits a draft and regenerates its draft voucher, or (for posted objects) posts a mirrored reversal voucher plus a corrected voucher via the existing Wave 3 pipeline, both carrying `reverses` / `corrects_object` back-references. `ReportingPeriod` is schema + CRUD only (lock enforcement is Wave 6). All schema lives in migrations; all cross-module behavior is proven by a real-DI integration test on in-memory SQLite.

**Tech Stack:** NestJS, Kysely, better-sqlite3, Jest, TypeScript

---

## Guardrails baked into every task (read once, apply always)

- **G1 — wave gate is CI parity.** The *final commit of every task* must be preceded by all four commands green, in this exact order: `npm run build && npm run lint && npm run test && npm run test:e2e`. `lint` runs `eslint --fix`; a task is not done until lint is clean. Never commit on red.
- **G2 — wiring needs a real integration test.** Every behavior crossing a DI / module boundary (a service reads the DB, calls the pipeline, resolves a plugin) gets a test that boots the **real DI graph against an in-memory SQLite DB** and runs the real migrations via `Migrator.migrateToLatest()`. Harness to copy verbatim: `src/currency/currency.resolution.spec.ts` (provide the Kysely instance under `KYSELY_MODULE_CONNECTION_TOKEN()`, run migrations, assemble real services, assert end-to-end). The dedup-by-hash behavior gets a dedicated real test.
- **G3 — acceptance criteria discriminate.** Assert against inputs that differ from seeds/defaults so a hardcoded stub cannot pass by coincidence (e.g. assert EUR `12000` after a correction from `10000`, not a default).
- **G4 — schema only in migrations.** No `createTable` / `CREATE TABLE` / `ALTER TABLE` / `db.schema.*` outside `src/database/migrations/` — not in services, not in `onModuleInit`. Every new table is added to `src/database/types.ts` (`Database` interface) and registered in `src/database/migrations/index.ts`. Grep gate (must be empty): `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"`.
- **G5 — "Must NOT do" is enforced.** Each task's forbidden patterns are grepped at task end (greps given inline). A present forbidden pattern fails the task.
- **G6 — stated DB invariants are real DB constraints.** `document.hash` UNIQUE is a real `unique` column constraint and a test proves the DB rejects a second raw insert of the same hash (not just that app code declined). FKs are real `references()` constraints.
- **EUR everywhere.** All example payloads and assertions use `currency: 'EUR'`; never hardcode currency in production code — read it from the business object / `CurrencyService`. Never use DKK in examples.
- **Money is integer cents.** All amounts are integers in minor units. Booleans persist as `integer` (0/1), timestamps as unix-seconds `integer`, dates as `text` (`YYYY-MM-DD`).

### Assumed prior-wave APIs (Wave 2 + Wave 3, treated as implemented)

These exist and are imported, not built here. If a signature differs at implementation time, adapt the call sites (do not reimplement these modules):

- **Wave 2 — `src/ledger/`**
  - `account` table + `AccountService.getAccountByCode(code: string): Promise<{ id: number; code: string; type: string }>`.
  - `voucher` table columns: `id, voucher_number, tax_point_date, posted_at, previous_hash, reverses_id, corrects_object_type, corrects_object_id, reason`.
  - `voucher_line` columns: `id, voucher_id, account_id, amount, currency, base_amount, fx_rate, vat_code, is_debit`.
  - `VoucherRepository.getVoucherById(id)`, `.getLinesByVoucherId(id)` (lines include `account_id`, `amount`, `currency`, `base_amount`, `fx_rate`, `vat_code`, `is_debit`).
  - `PostingService.postVoucher(draft: DraftVoucher): Promise<PostedVoucher>` — validates + inserts voucher + lines atomically, sets `posted_at`. `DraftVoucher = { voucher_number, tax_point_date, lines: DraftLine[], reverses_id?, corrects_object_type?, corrects_object_id?, reason? }`; `DraftLine = { account_id, amount, currency, base_amount, fx_rate, vat_code, is_debit }`. `PostedVoucher` includes `id, posted_at` and `lines`.
- **Wave 3 — `src/expenses/`, `src/sales-invoices/`, `src/rules/`, `src/policy/`**
  - `expense` table: `id, document_id, supplier_id, category, gross_amount, vat_amount, currency, tax_point_date, status ('draft'|'pending'|'posted'|'reversed'), voucher_id, created_at, updated_at`.
  - `sales_invoice` table: `id, customer_id, invoice_number, gross_amount, vat_amount, currency, tax_point_date, due_date, status, voucher_id, created_at, updated_at`.
  - `ExpensesService.createExpense(dto)`, `.getExpense(id)`, `.generateDraft(id)`, `.post(id)` (full pipeline: Rules → Policy → `PostingService`). Same shape on `SalesInvoicesService`.
  - `CountryPlugin.resolveCategoryMapping(category, supplierContext): { account: string; vatCode: VATCode }` and `getDefaultBaseCurrency(): string` (see `src/plugins/country-plugin.interface.ts`). `PluginLoader.resolve(country)`.

### Types Wave 5/6 will depend on (define cleanly here; do not gold-plate)

- `Document` + `DocumentSource` (Wave 5 channel adapters append new sources; Wave 6 audit reads `Document.status`).
- `TriageOutcome` discriminated union with `kind: 'new_expense' | 'new_sales_invoice' | 'correction' | 'duplicate'` (Wave 6 reconciliation/audit consumes outcomes).
- `voucher.reverses_id` / `corrects_object_type` / `corrects_object_id` linkage written by the correction flow (Wave 6 locked-period corrections and VAT-report amendments rely on these back-references already being populated).
- `ReportingPeriod` (`status: 'open' | 'locked'`, `filed_at`, `vat_report_snapshot_id`) — Wave 6 adds lock enforcement and VAT-report snapshots against this exact schema.

---

## File Structure

```
src/
  database/
    types.ts                                   # EXTEND: add Document/Source, ReportingPeriod tables (no other table here)
    migrations/
      index.ts                                 # EXTEND: register new migrations in order
      010_create_document.ts                   # NEW: document + document_source (Task 16)
      011_create_reporting_period.ts           # NEW: reporting_period + seed 2024-Q1 open (Task 19)
  documents/                                   # Task 16
    documents.module.ts
    documents.controller.ts                    # POST /api/documents (multipart), GET /api/documents, GET /api/documents/:id
    documents.service.ts                       # SHA-256 hash, dedup, filesystem write
    document-storage.service.ts                # filesystem read/write at data/documents/{id}/{filename}
    types.ts                                   # Document, DocumentSource, UploadDocumentResult, Channel
    documents.service.spec.ts                  # unit: hashing + storage path
    document-intake.integration.spec.ts        # G2: real-DI dedup-by-hash + DB UNIQUE constraint
  triage/                                      # Task 17
    triage.module.ts
    triage.controller.ts                       # POST /api/documents/:id/triage, GET /api/triage/pending
    triage.service.ts                          # route() -> creates Expense/SalesInvoice draft
    ocr.service.ts                             # stub extractData(documentId): TriageResult
    types.ts                                   # TriageResult, TriageOutcome
    ocr.service.spec.ts                        # unit: deterministic odd/even stub
    triage.integration.spec.ts                # G2: real-DI document -> draft business object
  corrections/                                 # Task 18
    corrections.module.ts
    corrections.service.ts                     # correctExpense(), correctSalesInvoice()
    types.ts                                   # CorrectionRequest, CorrectionResult, CorrectionKind
    corrections.service.spec.ts               # unit: branch selection
    corrections.integration.spec.ts          # G2: real-DI draft edit + posted reversal (mirror proven)
  reporting-periods/                           # Task 19
    reporting-periods.module.ts
    reporting-periods.controller.ts            # POST/GET /api/reporting-periods, GET /current, GET /:id
    reporting-periods.service.ts
    types.ts                                   # ReportingPeriod, CreateReportingPeriodDto, PeriodStatus
    reporting-periods.controller.spec.ts       # unit: CRUD + current selection
    reporting-periods.integration.spec.ts      # G2: real-DI seeded period + create/current over migrated DB
  app.module.ts                                # EXTEND: import the four new modules
test/
  intake.e2e-spec.ts                           # Task 20: upload -> triage -> post; dedup -> one expense
data/
  documents/                                   # filesystem store; .gitignore'd (already ignored via /data/*)
```

> **Multipart note:** controllers receive uploads via `@nestjs/platform-express` + `multer` (`FileInterceptor`). `@types/multer` is a dev dependency to add in Task 16 if not resolvable; the `Express.Multer.File` type is provided by `@types/express`/`@types/multer`. Use `memoryStorage` so `file.buffer` is available for hashing (the bytes are written to the filesystem by `DocumentStorageService`, never to SQLite).

---

## Task 16 — Document schema + filesystem storage + SHA-256 dedup

Creates the `Document` deduplication anchor: byte-identical uploads collapse into one `Document` with multiple `document_source` rows; bytes live on the filesystem, metadata + hash in SQLite. The `hash` UNIQUE constraint is a real DB constraint (G6).

**Files:**
- `src/database/migrations/010_create_document.ts` (NEW)
- `src/database/migrations/index.ts` (EXTEND)
- `src/database/types.ts` (EXTEND)
- `src/documents/types.ts` (NEW)
- `src/documents/document-storage.service.ts` (NEW)
- `src/documents/documents.service.ts` (NEW)
- `src/documents/documents.controller.ts` (NEW)
- `src/documents/documents.module.ts` (NEW)
- `src/documents/documents.service.spec.ts` (NEW)
- `src/documents/document-intake.integration.spec.ts` (NEW, G2)
- `src/app.module.ts` (EXTEND)

Steps:

- [ ] **Write the migration** `src/database/migrations/010_create_document.ts`. Copy the style of `001_create_organization.ts` (`Kysely<any>`, `up`/`down`, `references`, real constraints):
  ```ts
  import { Kysely } from 'kysely';

  export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('document')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      // hash is the deduplication anchor (ADR-0010). UNIQUE is a real DB
      // constraint, not a code-only check (G6).
      .addColumn('hash', 'text', (col) => col.notNull().unique())
      .addColumn('filename', 'text', (col) => col.notNull())
      .addColumn('content_type', 'text')
      .addColumn('size_bytes', 'integer')
      .addColumn('storage_path', 'text', (col) => col.notNull())
      // enum: received | triaged | processed | error
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('received'))
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('document_source')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('document_id', 'integer', (col) =>
        col.notNull().references('document.id'),
      )
      // enum: telegram | email | api | drive
      .addColumn('channel', 'text', (col) => col.notNull())
      .addColumn('sender', 'text')
      .addColumn('received_at', 'integer', (col) => col.notNull())
      .addColumn('metadata', 'text')
      .execute();
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('document_source').ifExists().execute();
    await db.schema.dropTable('document').ifExists().execute();
  }
  ```
- [ ] **Register the migration** in `src/database/migrations/index.ts` (keys are ordered lexicographically by the Migrator):
  ```ts
  import * as m010 from './010_create_document';
  // ...
  export const migrations: Record<string, Migration> = {
    '001_create_organization': m001,
    // ...existing waves 2/3 migrations...
    '010_create_document': m010,
  };
  ```
- [ ] **Extend `src/database/types.ts`** — add the two tables to the `Database` interface:
  ```ts
  export interface DocumentTable {
    id: Generated<number>;
    hash: string;
    filename: string;
    content_type: string | null;
    size_bytes: number | null;
    storage_path: string;
    status: string; // 'received' | 'triaged' | 'processed' | 'error'
    created_at: number;
  }
  export interface DocumentSourceTable {
    id: Generated<number>;
    document_id: number;
    channel: string; // 'telegram' | 'email' | 'api' | 'drive'
    sender: string | null;
    received_at: number;
    metadata: string | null;
  }
  ```
  and `document: DocumentTable; document_source: DocumentSourceTable;` on `Database`.
- [ ] **Write the FULL failing unit test** `src/documents/documents.service.spec.ts` covering hashing + storage path (pure, no DB):
  ```ts
  import { DocumentStorageService } from './document-storage.service';
  import { computeSha256 } from './documents.service';
  import { promises as fs } from 'fs';
  import { join } from 'path';
  import { tmpdir } from 'os';

  describe('Document hashing + storage', () => {
    it('computes a stable SHA-256 hex digest of file bytes', () => {
      const bytes = Buffer.from('test receipt data\n');
      const a = computeSha256(bytes);
      const b = computeSha256(Buffer.from('test receipt data\n'));
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(computeSha256(Buffer.from('different'))).not.toBe(a);
    });

    it('writes bytes to data/documents/{id}/{filename} and returns the path', async () => {
      const root = await fs.mkdtemp(join(tmpdir(), 'docs-'));
      const storage = new DocumentStorageService(root);
      const path = await storage.save(7, 'receipt.txt', Buffer.from('hi'));
      expect(path).toBe(join(root, '7', 'receipt.txt'));
      await expect(fs.readFile(path, 'utf8')).resolves.toBe('hi');
    });
  });
  ```
- [ ] **Run (expect FAIL):** `npm test -- documents.service.spec` → fails: `Cannot find module './document-storage.service'` / `'./documents.service'`.
- [ ] **Write `src/documents/types.ts`:**
  ```ts
  export type Channel = 'telegram' | 'email' | 'api' | 'drive';
  export type DocumentStatus = 'received' | 'triaged' | 'processed' | 'error';

  export interface DocumentSource {
    id: number;
    document_id: number;
    channel: Channel;
    sender: string | null;
    received_at: number;
    metadata: string | null;
  }
  export interface Document {
    id: number;
    hash: string;
    filename: string;
    content_type: string | null;
    size_bytes: number | null;
    storage_path: string;
    status: DocumentStatus;
    created_at: number;
    sources: DocumentSource[];
  }
  export interface UploadDocumentInput {
    filename: string;
    content_type: string | null;
    bytes: Buffer;
    channel: Channel;
    sender?: string | null;
    metadata?: Record<string, unknown> | null;
  }
  export interface UploadDocumentResult {
    document: Document;
    deduplicated: boolean; // true when an existing hash matched
  }
  ```
- [ ] **Write `src/documents/document-storage.service.ts`** (filesystem only — never SQLite):
  ```ts
  import { Injectable, Inject, Optional } from '@nestjs/common';
  import { promises as fs } from 'fs';
  import { join } from 'path';

  export const DOCUMENT_STORAGE_ROOT = 'DOCUMENT_STORAGE_ROOT';

  @Injectable()
  export class DocumentStorageService {
    private readonly root: string;
    constructor(@Optional() @Inject(DOCUMENT_STORAGE_ROOT) root?: string) {
      this.root = root ?? join(process.cwd(), 'data', 'documents');
    }
    async save(documentId: number, filename: string, bytes: Buffer): Promise<string> {
      const dir = join(this.root, String(documentId));
      await fs.mkdir(dir, { recursive: true });
      const path = join(dir, filename);
      await fs.writeFile(path, bytes);
      return path;
    }
  }
  ```
- [ ] **Write `src/documents/documents.service.ts`** — exported `computeSha256` + dedup logic. Insert document first (to get the id for the path), then write bytes, then update `storage_path`; on hash collision, append only a source and return the existing document with `deduplicated: true`:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { createHash } from 'crypto';
  import { Database } from '../database/types';
  import { DocumentStorageService } from './document-storage.service';
  import {
    Document, DocumentSource, UploadDocumentInput, UploadDocumentResult, Channel, DocumentStatus,
  } from './types';

  export function computeSha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  @Injectable()
  export class DocumentsService {
    constructor(
      @InjectKysely() private readonly db: Kysely<Database>,
      private readonly storage: DocumentStorageService,
    ) {}

    async upload(input: UploadDocumentInput): Promise<UploadDocumentResult> {
      const hash = computeSha256(input.bytes);
      const existing = await this.db
        .selectFrom('document').selectAll().where('hash', '=', hash).executeTakeFirst();
      const now = Math.floor(Date.now() / 1000);

      if (existing) {
        await this.insertSource(existing.id, input, now);
        return { document: await this.getById(existing.id), deduplicated: true };
      }

      const inserted = await this.db
        .insertInto('document')
        .values({
          hash, filename: input.filename, content_type: input.content_type,
          size_bytes: input.bytes.length, storage_path: '', status: 'received', created_at: now,
        })
        .returning('id').executeTakeFirstOrThrow();

      const path = await this.storage.save(inserted.id, input.filename, input.bytes);
      await this.db.updateTable('document').set({ storage_path: path })
        .where('id', '=', inserted.id).execute();
      await this.insertSource(inserted.id, input, now);
      return { document: await this.getById(inserted.id), deduplicated: false };
    }

    private async insertSource(documentId: number, input: UploadDocumentInput, now: number) {
      await this.db.insertInto('document_source').values({
        document_id: documentId, channel: input.channel, sender: input.sender ?? null,
        received_at: now, metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      }).execute();
    }

    async list(): Promise<Document[]> {
      const rows = await this.db.selectFrom('document').selectAll().orderBy('id').execute();
      return Promise.all(rows.map((r) => this.hydrate(r)));
    }
    async getById(id: number): Promise<Document> {
      const row = await this.db.selectFrom('document').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      return this.hydrate(row);
    }
    async setStatus(id: number, status: DocumentStatus): Promise<void> {
      await this.db.updateTable('document').set({ status }).where('id', '=', id).execute();
    }

    private async hydrate(row: Database['document']): Promise<Document> {
      const sources = await this.db.selectFrom('document_source')
        .selectAll().where('document_id', '=', row.id as unknown as number).orderBy('id').execute();
      return {
        id: row.id as unknown as number, hash: row.hash, filename: row.filename,
        content_type: row.content_type, size_bytes: row.size_bytes, storage_path: row.storage_path,
        status: row.status as DocumentStatus, created_at: row.created_at,
        sources: sources.map((s): DocumentSource => ({
          id: s.id as unknown as number, document_id: s.document_id, channel: s.channel as Channel,
          sender: s.sender, received_at: s.received_at, metadata: s.metadata,
        })),
      };
    }
  }
  ```
- [ ] **Run (expect PASS):** `npm test -- documents.service.spec` → 2 passing.
- [ ] **Write the FULL failing G2 integration test** `src/documents/document-intake.integration.spec.ts` — real DI + migrated in-memory SQLite (copy the harness from `currency.resolution.spec.ts`). Proves (a) dedup collapses to one document with two sources, (b) the DB UNIQUE constraint on `hash` is real (G6):
  ```ts
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import SqliteDb from 'better-sqlite3';
  import { promises as fs } from 'fs';
  import { join } from 'path';
  import { tmpdir } from 'os';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { DocumentStorageService } from './document-storage.service';
  import { DocumentsService } from './documents.service';

  describe('Document intake + dedup (integration)', () => {
    let db: Kysely<Database>;
    let service: DocumentsService;
    let root: string;

    beforeEach(async () => {
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');
      root = await fs.mkdtemp(join(tmpdir(), 'docint-'));
      service = new DocumentsService(db, new DocumentStorageService(root));
    });
    afterEach(async () => { await db.destroy(); });

    it('byte-identical uploads collapse into one Document with multiple sources', async () => {
      const bytes = Buffer.from('invoice EUR 12000\n');
      const first = await service.upload({ filename: 'inv.txt', content_type: 'text/plain', bytes, channel: 'api' });
      const second = await service.upload({ filename: 'inv.txt', content_type: 'text/plain', bytes, channel: 'email', sender: 'supplier@example.com' });
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.document.id).toBe(first.document.id);
      expect(second.document.sources).toHaveLength(2);
      const count = await db.selectFrom('document').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow();
      expect(Number(count.c)).toBe(1);
    });

    it('writes bytes to the filesystem, never the DB', async () => {
      const { document } = await service.upload({ filename: 'r.txt', content_type: 'text/plain', bytes: Buffer.from('hi'), channel: 'api' });
      expect(document.storage_path).toBe(join(root, String(document.id), 'r.txt'));
      await expect(fs.readFile(document.storage_path, 'utf8')).resolves.toBe('hi');
    });

    it('enforces hash uniqueness at the DB level (G6)', async () => {
      await service.upload({ filename: 'a.txt', content_type: 'text/plain', bytes: Buffer.from('dup'), channel: 'api' });
      const hash = (await db.selectFrom('document').select('hash').executeTakeFirstOrThrow()).hash;
      await expect(
        db.insertInto('document').values({
          hash, filename: 'b.txt', content_type: null, size_bytes: 1, storage_path: '/x', status: 'received', created_at: 0,
        }).execute(),
      ).rejects.toThrow(/UNIQUE/i);
    });
  });
  ```
- [ ] **Run (expect FAIL):** `npm test -- document-intake.integration` → fails (service not yet importable in this harness / migration not registered until prior steps land). After the service + migration steps above are in place, it should compile; run again.
- [ ] **Write `src/documents/documents.controller.ts`** — multipart upload (dedup → 200, new → 201), list, get:
  ```ts
  import {
    Controller, Post, Get, Param, ParseIntPipe, UploadedFile, UseInterceptors, HttpCode, Res,
  } from '@nestjs/common';
  import { FileInterceptor } from '@nestjs/platform-express';
  import { memoryStorage } from 'multer';
  import { Response } from 'express';
  import { DocumentsService } from './documents.service';

  @Controller('api/documents')
  export class DocumentsController {
    constructor(private readonly documents: DocumentsService) {}

    @Post()
    @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
    async upload(@UploadedFile() file: Express.Multer.File, @Res() res: Response) {
      const result = await this.documents.upload({
        filename: file.originalname, content_type: file.mimetype ?? null,
        bytes: file.buffer, channel: 'api',
      });
      // New document -> 201; deduplicated -> 200 (ADR-0010 auto-collapse).
      return res.status(result.deduplicated ? 200 : 201).json(result.document);
    }

    @Get()
    list() { return this.documents.list(); }

    @Get(':id')
    get(@Param('id', ParseIntPipe) id: number) { return this.documents.getById(id); }
  }
  ```
- [ ] **Write `src/documents/documents.module.ts`** (export `DocumentsService` so Tasks 17/18/20 can import it):
  ```ts
  import { Module } from '@nestjs/common';
  import { DocumentsController } from './documents.controller';
  import { DocumentsService } from './documents.service';
  import { DocumentStorageService } from './document-storage.service';

  @Module({
    controllers: [DocumentsController],
    providers: [DocumentsService, DocumentStorageService],
    exports: [DocumentsService],
  })
  export class DocumentsModule {}
  ```
- [ ] **Wire into `src/app.module.ts`** — add `DocumentsModule` to `imports`.
- [ ] **Add multer types if needed:** `npm i -D @types/multer` only if `Express.Multer.File` does not resolve under the existing `@types/express`. (Do not add a runtime multer dependency — it ships with `@nestjs/platform-express`.)
- [ ] **Run (expect PASS):** `npm test -- documents` → all document specs green; `npm run build` clean.
- [ ] **G4/G5 greps (expect empty):**
  - `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"`
  - Must-NOT-do: no file blobs in SQLite → `grep -rni "buffer\|blob" src/documents/documents.service.ts | grep -i insert` (expect empty); no OCR → `grep -rni "ocr\|tesseract\|textract" src/documents` (expect empty); no channel adapters → `grep -rni "telegram\|imap\|smtp" src/documents` (expect empty).
- [ ] **Run the full gate (G1):** `npm run build && npm run lint && npm run test && npm run test:e2e` → all green.
- [ ] **Commit:** `git add -A && git commit -m "feat(documents): document intake + filesystem storage + hash dedup"`

---

## Task 17 — OCR triage stub + intake routing

A deterministic stub `OCRService` produces triage data; `TriageService.route()` turns a `Document` into an `Expense` or `SalesInvoice` draft and returns a typed `TriageOutcome`. No real OCR, no entity matching, no correction logic (Task 18).

**Files:**
- `src/triage/types.ts` (NEW)
- `src/triage/ocr.service.ts` (NEW)
- `src/triage/triage.service.ts` (NEW)
- `src/triage/triage.controller.ts` (NEW)
- `src/triage/triage.module.ts` (NEW)
- `src/triage/ocr.service.spec.ts` (NEW)
- `src/triage/triage.integration.spec.ts` (NEW, G2)
- `src/app.module.ts` (EXTEND)

Steps:

- [ ] **Write the FULL failing unit test** `src/triage/ocr.service.spec.ts` (deterministic odd/even stub per spec — discriminating values, G3; EUR in the draft is supplied by triage, not OCR):
  ```ts
  import { OcrService } from './ocr.service';

  describe('OcrService (stub)', () => {
    const ocr = new OcrService();
    it('odd document id -> receipt / transport', () => {
      const r = ocr.extractData(1);
      expect(r).toEqual({
        document_type: 'receipt', entity_guess: 'Bolt', gross_amount: 1525, vat_amount: 275,
        suggested_category: 'transport', suggested_vat_code: 'DK_INPUT_25', confidence: 0.94,
      });
    });
    it('even document id -> invoice / software', () => {
      const r = ocr.extractData(2);
      expect(r).toEqual({
        document_type: 'invoice', entity_guess: 'OpenAI', gross_amount: 10000, vat_amount: 2500,
        suggested_category: 'software', suggested_vat_code: 'DK_INPUT_25', confidence: 0.98,
      });
    });
  });
  ```
- [ ] **Run (expect FAIL):** `npm test -- ocr.service.spec` → `Cannot find module './ocr.service'`.
- [ ] **Write `src/triage/types.ts`:**
  ```ts
  export interface TriageResult {
    document_type: 'receipt' | 'invoice';
    entity_guess: string;
    gross_amount: number; // cents
    vat_amount: number; // cents
    suggested_category: string;
    suggested_vat_code: string;
    confidence: number;
  }
  export type TriageOutcome =
    | { kind: 'new_expense'; document_id: number; expense_id: number }
    | { kind: 'new_sales_invoice'; document_id: number; sales_invoice_id: number }
    | { kind: 'correction'; document_id: number; original_id: number | null }
    | { kind: 'duplicate'; document_id: number };
  ```
- [ ] **Write `src/triage/ocr.service.ts`** (stub, deterministic by id parity):
  ```ts
  import { Injectable } from '@nestjs/common';
  import { TriageResult } from './types';

  @Injectable()
  export class OcrService {
    // STUB ONLY — no real OCR. Deterministic on document id parity so tests are
    // reproducible and acceptance criteria discriminate (G3).
    extractData(documentId: number): TriageResult {
      if (documentId % 2 === 1) {
        return { document_type: 'receipt', entity_guess: 'Bolt', gross_amount: 1525, vat_amount: 275,
          suggested_category: 'transport', suggested_vat_code: 'DK_INPUT_25', confidence: 0.94 };
      }
      return { document_type: 'invoice', entity_guess: 'OpenAI', gross_amount: 10000, vat_amount: 2500,
        suggested_category: 'software', suggested_vat_code: 'DK_INPUT_25', confidence: 0.98 };
    }
  }
  ```
- [ ] **Run (expect PASS):** `npm test -- ocr.service.spec` → 2 passing.
- [ ] **Write `src/triage/triage.service.ts`** — routes a document into a draft business object. Amounts are EUR (read base currency from the org's plugin via `CurrencyService` — never hardcode). `receipt` → Expense draft; `invoice` from a supplier → Expense, but per spec a `document_type: 'invoice'` with even-id mock represents an outgoing `SalesInvoice` (acceptance: even id → SalesInvoice). Mark the document `triaged`:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { OcrService } from './ocr.service';
  import { DocumentsService } from '../documents/documents.service';
  import { ExpensesService } from '../expenses/expenses.service';
  import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
  import { CurrencyService } from '../currency/currency.service';
  import { TriageOutcome } from './types';

  @Injectable()
  export class TriageService {
    constructor(
      private readonly ocr: OcrService,
      private readonly documents: DocumentsService,
      private readonly expenses: ExpensesService,
      private readonly salesInvoices: SalesInvoicesService,
      private readonly currency: CurrencyService,
    ) {}

    async route(documentId: number): Promise<TriageOutcome> {
      const doc = await this.documents.getById(documentId);
      const ocr = this.ocr.extractData(documentId);
      const currency = await this.currency.getBaseCurrency(); // EUR for the default Irish org
      const taxPointDate = new Date(doc.created_at * 1000).toISOString().slice(0, 10);

      if (ocr.document_type === 'receipt') {
        const expense = await this.expenses.createExpense({
          document_id: doc.id, category: ocr.suggested_category,
          gross_amount: ocr.gross_amount, vat_amount: ocr.vat_amount,
          currency, tax_point_date: taxPointDate,
        });
        await this.documents.setStatus(doc.id, 'triaged');
        return { kind: 'new_expense', document_id: doc.id, expense_id: expense.id };
      }

      const invoice = await this.salesInvoices.createSalesInvoice({
        invoice_number: `INV-${doc.id}`, gross_amount: ocr.gross_amount, vat_amount: ocr.vat_amount,
        currency, tax_point_date: taxPointDate,
      });
      await this.documents.setStatus(doc.id, 'triaged');
      return { kind: 'new_sales_invoice', document_id: doc.id, sales_invoice_id: invoice.id };
    }

    async pending(): Promise<{ id: number; filename: string; status: string }[]> {
      const docs = await this.documents.list();
      return docs.filter((d) => d.status === 'received')
        .map((d) => ({ id: d.id, filename: d.filename, status: d.status }));
    }
  }
  ```
  > If the Wave 3 `ExpensesService.createExpense` / `SalesInvoicesService.createSalesInvoice` DTO field names differ, adapt the object literals to match — do not change Wave 3.
- [ ] **Write `src/triage/triage.controller.ts`:**
  ```ts
  import { Controller, Post, Get, Param, ParseIntPipe } from '@nestjs/common';
  import { TriageService } from './triage.service';

  @Controller('api')
  export class TriageController {
    constructor(private readonly triage: TriageService) {}

    @Post('documents/:id/triage')
    route(@Param('id', ParseIntPipe) id: number) { return this.triage.route(id); }

    @Get('triage/pending')
    pending() { return this.triage.pending(); }
  }
  ```
- [ ] **Write `src/triage/triage.module.ts`** (imports Documents/Expenses/SalesInvoices/Currency modules):
  ```ts
  import { Module } from '@nestjs/common';
  import { TriageController } from './triage.controller';
  import { TriageService } from './triage.service';
  import { OcrService } from './ocr.service';
  import { DocumentsModule } from '../documents/documents.module';
  import { ExpensesModule } from '../expenses/expenses.module';
  import { SalesInvoicesModule } from '../sales-invoices/sales-invoices.module';
  import { CurrencyModule } from '../currency/currency.module';

  @Module({
    imports: [DocumentsModule, ExpensesModule, SalesInvoicesModule, CurrencyModule],
    controllers: [TriageController],
    providers: [TriageService, OcrService],
    exports: [TriageService],
  })
  export class TriageModule {}
  ```
  > Ensure Wave 3 `ExpensesModule` / `SalesInvoicesModule` `export` their services and `CurrencyModule` exports `CurrencyService`.
- [ ] **Wire into `src/app.module.ts`** — add `TriageModule`.
- [ ] **Write the FULL failing G2 integration test** `src/triage/triage.integration.spec.ts` — real DI + migrated DB; uploads two documents (id 1 odd, id 2 even), triages each, asserts a draft Expense (transport, 1525, EUR) and a draft SalesInvoice (10000, EUR). Use the `Test.createTestingModule` harness providing `KYSELY_MODULE_CONNECTION_TOKEN()` + the real services (DocumentsService, ExpensesService, SalesInvoicesService, CurrencyService, OrganizationService, PluginLoader, NullCountryPlugin, OcrService, TriageService) over an in-memory migrated DB:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { promises as fs } from 'fs';
  import { join } from 'path';
  import { tmpdir } from 'os';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { DocumentsService } from '../documents/documents.service';
  import { DocumentStorageService, DOCUMENT_STORAGE_ROOT } from '../documents/document-storage.service';
  import { ExpensesService } from '../expenses/expenses.service';
  import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
  import { CurrencyService } from '../currency/currency.service';
  import { OrganizationService } from '../organization/organization.service';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { NullCountryPlugin } from '../plugins/null-country.plugin';
  import { OcrService } from './ocr.service';
  import { TriageService } from './triage.service';
  // ...plus any Wave 2 providers Expenses/SalesInvoices services depend on (AccountService, repositories, PostingService, RulesService, PolicyService).

  describe('Triage routing (integration)', () => {
    let db: Kysely<Database>;
    let documents: DocumentsService;
    let triage: TriageService;
    let expenses: ExpensesService;
    let salesInvoices: SalesInvoicesService;
    let root: string;

    beforeEach(async () => {
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');
      root = await fs.mkdtemp(join(tmpdir(), 'triage-'));
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          { provide: DOCUMENT_STORAGE_ROOT, useValue: root },
          DocumentStorageService, DocumentsService,
          ExpensesService, SalesInvoicesService,
          CurrencyService, OrganizationService, PluginLoader, NullCountryPlugin,
          OcrService, TriageService,
          // ...add Wave 2 deps required by the Expenses/SalesInvoices services.
        ],
      }).compile();
      documents = module.get(DocumentsService);
      triage = module.get(TriageService);
      expenses = module.get(ExpensesService);
      salesInvoices = module.get(SalesInvoicesService);
    });
    afterEach(async () => { await db.destroy(); });

    it('odd-id document -> draft Expense (transport, 1525 EUR)', async () => {
      const { document } = await documents.upload({ filename: 'r1.txt', content_type: 'text/plain', bytes: Buffer.from('one'), channel: 'api' });
      expect(document.id).toBe(1);
      const outcome = await triage.route(document.id);
      expect(outcome.kind).toBe('new_expense');
      if (outcome.kind !== 'new_expense') throw new Error('unreachable');
      const expense = await expenses.getExpense(outcome.expense_id);
      expect(expense.category).toBe('transport');
      expect(expense.gross_amount).toBe(1525);
      expect(expense.currency).toBe('EUR');
      expect(expense.status).toBe('draft');
      expect((await documents.getById(document.id)).status).toBe('triaged');
    });

    it('even-id document -> draft SalesInvoice (10000 EUR)', async () => {
      await documents.upload({ filename: 'r1.txt', content_type: 'text/plain', bytes: Buffer.from('one'), channel: 'api' });
      const { document } = await documents.upload({ filename: 'r2.txt', content_type: 'text/plain', bytes: Buffer.from('two'), channel: 'api' });
      expect(document.id).toBe(2);
      const outcome = await triage.route(document.id);
      expect(outcome.kind).toBe('new_sales_invoice');
      if (outcome.kind !== 'new_sales_invoice') throw new Error('unreachable');
      const invoice = await salesInvoices.getSalesInvoice(outcome.sales_invoice_id);
      expect(invoice.gross_amount).toBe(10000);
      expect(invoice.currency).toBe('EUR');
      expect(invoice.status).toBe('draft');
    });
  });
  ```
  > Fill the provider list with whatever Wave 2/3 services `ExpensesService`/`SalesInvoicesService` inject. The harness must boot the REAL graph (G2) — no mocked collaborators.
- [ ] **Run (expect PASS):** `npm test -- triage` → all triage specs green; `npm run build` clean.
- [ ] **G4/G5 greps (expect empty):**
  - `grep -rn "createTable\|CREATE TABLE" src/triage --include=*.ts` (triage adds no schema).
  - Must-NOT-do: no real OCR → `grep -rni "tesseract\|textract\|vision\|sharp" src/triage` (empty); no Supplier entity matching → `grep -rni "supplier_id\|entity_match" src/triage` (empty; `entity_guess` stays a string); no correction logic → `grep -rni "reverse\|reverses_id\|correct" src/triage` (empty).
- [ ] **Run the full gate (G1):** `npm run build && npm run lint && npm run test && npm run test:e2e` → all green.
- [ ] **Commit:** `git add -A && git commit -m "feat(triage): OCR stub + intake routing"`

---

## Task 18 — Correction flow (draft edit + posted-voucher reversal)

Implements ADR-0010 correction branches 1–3 in full and 4–5 as structured stubs. A draft correction edits the business object and regenerates its draft voucher; a posted correction posts a **mirrored reversal voucher** (same accounts, debit/credit flipped) plus a **corrected voucher**, both carrying `reverses_id` / `corrects_object_*` back-references. Posted vouchers are never edited (Wave 2 immutability).

**Files:**
- `src/corrections/types.ts` (NEW)
- `src/corrections/corrections.service.ts` (NEW)
- `src/corrections/corrections.module.ts` (NEW)
- `src/corrections/corrections.service.spec.ts` (NEW)
- `src/corrections/corrections.integration.spec.ts` (NEW, G2)
- `src/expenses/expenses.controller.ts` (EXTEND: add `POST /api/expenses/:id/correct`)
- `src/sales-invoices/sales-invoices.controller.ts` (EXTEND: add `POST /api/sales-invoices/:id/correct`)
- `src/app.module.ts` (EXTEND, if CorrectionsModule isn't imported transitively)

Steps:

- [ ] **Write `src/corrections/types.ts`:**
  ```ts
  export type CorrectionType = 'cosmetic' | 'financial';
  export type CorrectionKind =
    | 'cosmetic_attachment_replaced'
    | 'draft_edited'
    | 'posted_reversed_and_corrected'
    | 'locked_period_not_implemented'   // ADR-0010 case 4 — structure ready, Wave 6
    | 'credit_note_not_implemented';    // ADR-0010 case 5 — Wave 5/6

  export interface CorrectionRequest {
    type: CorrectionType;
    new_amount?: number;     // cents, base currency
    new_vat_amount?: number; // cents
    new_category?: string;
    reason: string;
  }
  export interface CorrectionResult {
    kind: CorrectionKind;
    object_id: number;
    reversal_voucher_id?: number;
    corrected_voucher_id?: number;
    new_draft_voucher_id?: number;
    message?: string;
  }
  ```
- [ ] **Write the FULL failing G2 integration test** `src/corrections/corrections.integration.spec.ts` — real DI + migrated DB. Two cases: (a) correcting a **draft** Expense edits the object and regenerates a draft voucher; (b) correcting a **posted** Expense (gross 10000 EUR → 12000 EUR) creates a reversal voucher whose lines mirror the original (same `account_id`, flipped `is_debit`, equal amounts) and a corrected voucher, both linking back. Boot the real Expenses pipeline + PostingService + VoucherRepository:
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { ExpensesService } from '../expenses/expenses.service';
  import { VoucherRepository } from '../ledger/voucher/voucher.repository';
  import { CorrectionsService } from './corrections.service';
  // ...plus all Wave 2/3 providers the Expenses pipeline + PostingService need.

  describe('Correction flow (integration)', () => {
    let db: Kysely<Database>;
    let expenses: ExpensesService;
    let vouchers: VoucherRepository;
    let corrections: CorrectionsService;

    beforeEach(async () => {
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          ExpensesService, VoucherRepository, CorrectionsService,
          // ...AccountService, PostingService, LedgerValidationService, RulesService,
          //    PolicyService, CurrencyService, OrganizationService, PluginLoader, NullCountryPlugin
        ],
      }).compile();
      expenses = module.get(ExpensesService);
      vouchers = module.get(VoucherRepository);
      corrections = module.get(CorrectionsService);
    });
    afterEach(async () => { await db.destroy(); });

    it('financial correction on a DRAFT expense edits the object and regenerates a draft voucher', async () => {
      const e = await expenses.createExpense({ category: 'software', gross_amount: 10000, vat_amount: 2500, currency: 'EUR', tax_point_date: '2024-01-15' });
      await expenses.generateDraft(e.id);
      const result = await corrections.correctExpense(e.id, { type: 'financial', new_amount: 12000, new_category: 'software', reason: 'OCR misread the total' });
      expect(result.kind).toBe('draft_edited');
      const updated = await expenses.getExpense(e.id);
      expect(updated.gross_amount).toBe(12000);
      expect(updated.status).toBe('draft');
    });

    it('financial correction on a POSTED expense posts a mirrored reversal + a corrected voucher', async () => {
      const e = await expenses.createExpense({ category: 'software', gross_amount: 10000, vat_amount: 2500, currency: 'EUR', tax_point_date: '2024-01-15' });
      await expenses.post(e.id); // Wave 3 pipeline -> posted voucher
      const posted = await expenses.getExpense(e.id);
      expect(posted.status).toBe('posted');
      const originalVoucherId = posted.voucher_id!;
      const originalLines = await vouchers.getLinesByVoucherId(originalVoucherId);

      const result = await corrections.correctExpense(e.id, { type: 'financial', new_amount: 12000, new_category: 'software', reason: 'Amount was wrong' });
      expect(result.kind).toBe('posted_reversed_and_corrected');
      expect(result.reversal_voucher_id).toBeDefined();
      expect(result.corrected_voucher_id).toBeDefined();

      // Reversal mirrors original: same accounts, flipped debit/credit, equal amounts.
      const reversalLines = await vouchers.getLinesByVoucherId(result.reversal_voucher_id!);
      expect(reversalLines).toHaveLength(originalLines.length);
      for (const orig of originalLines) {
        const mirror = reversalLines.find((l) => l.account_id === orig.account_id && l.is_debit !== orig.is_debit);
        expect(mirror).toBeDefined();
        expect(mirror!.amount).toBe(orig.amount);
        expect(mirror!.base_amount).toBe(orig.base_amount);
      }
      const reversalVoucher = await vouchers.getVoucherById(result.reversal_voucher_id!);
      expect(reversalVoucher.reverses_id).toBe(originalVoucherId);
      const correctedVoucher = await vouchers.getVoucherById(result.corrected_voucher_id!);
      expect(correctedVoucher.corrects_object_type).toBe('expense');
      expect(correctedVoucher.corrects_object_id).toBe(e.id);

      // Business object re-points to the corrected voucher; original voucher untouched.
      const after = await expenses.getExpense(e.id);
      expect(after.status).toBe('reversed');
      expect(after.voucher_id).toBe(result.corrected_voucher_id);
    });
  });
  ```
- [ ] **Run (expect FAIL):** `npm test -- corrections.integration` → `Cannot find module './corrections.service'`.
- [ ] **Write the FULL failing unit test** `src/corrections/corrections.service.spec.ts` — branch selection given object status, using injected fakes for the collaborators (the *real* DB proof lives in the integration test; this unit test pins the branching logic):
  ```ts
  // Asserts: draft + financial -> 'draft_edited'; posted + financial -> 'posted_reversed_and_corrected';
  // cosmetic -> 'cosmetic_attachment_replaced'; (period locked path) -> 'locked_period_not_implemented'.
  // Build CorrectionsService with stub ExpensesService/PostingService/VoucherRepository that record calls.
  ```
  (Write concrete stub objects implementing the methods the service calls; assert the returned `kind` for each branch and that posted-path never edits the original voucher.)
- [ ] **Run (expect FAIL):** `npm test -- corrections.service.spec` → module not found.
- [ ] **Write `src/corrections/corrections.service.ts`** — the branch engine. Cosmetic → replace attachment, voucher untouched. Financial + draft → edit object + regenerate draft. Financial + posted → build a mirrored reversal `DraftVoucher` (`reverses_id = originalVoucherId`, lines = original lines with `is_debit` flipped), post it via `PostingService`; build a corrected `DraftVoucher` from the new amounts (reuse Expense draft generation, set `corrects_object_type='expense'`, `corrects_object_id=id`), post it; update the Expense to `reversed`, re-point `voucher_id` to the corrected voucher. Locked-period / credit-note → return the `*_not_implemented` kinds with structure ready:
  ```ts
  import { Injectable } from '@nestjs/common';
  import { ExpensesService } from '../expenses/expenses.service';
  import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
  import { PostingService } from '../ledger/posting/posting.service';
  import { VoucherRepository } from '../ledger/voucher/voucher.repository';
  import { CorrectionRequest, CorrectionResult } from './types';

  @Injectable()
  export class CorrectionsService {
    constructor(
      private readonly expenses: ExpensesService,
      private readonly salesInvoices: SalesInvoicesService,
      private readonly posting: PostingService,
      private readonly vouchers: VoucherRepository,
    ) {}

    async correctExpense(id: number, req: CorrectionRequest): Promise<CorrectionResult> {
      const expense = await this.expenses.getExpense(id);

      if (req.type === 'cosmetic') {
        // ADR-0010 case 1: replace the Document attachment; Voucher untouched.
        return { kind: 'cosmetic_attachment_replaced', object_id: id, message: 'Attachment updated; ledger unchanged' };
      }

      if (expense.status === 'draft' || expense.status === 'pending') {
        // ADR-0010 case 2: edit the draft, regenerate its draft voucher.
        await this.expenses.updateDraft(id, {
          gross_amount: req.new_amount ?? expense.gross_amount,
          vat_amount: req.new_vat_amount ?? expense.vat_amount,
          category: req.new_category ?? expense.category,
        });
        const draft = await this.expenses.generateDraft(id);
        return { kind: 'draft_edited', object_id: id, new_draft_voucher_id: draft.id };
      }

      // ADR-0010 case 3: posted, period open -> reversal + corrected voucher.
      const originalVoucherId = expense.voucher_id!;
      const original = await this.vouchers.getVoucherById(originalVoucherId);
      const originalLines = await this.vouchers.getLinesByVoucherId(originalVoucherId);

      const reversal = await this.posting.postVoucher({
        voucher_number: `${original.voucher_number}-REV`,
        tax_point_date: original.tax_point_date,
        reverses_id: originalVoucherId,
        corrects_object_type: 'expense',
        corrects_object_id: id,
        reason: req.reason,
        lines: originalLines.map((l) => ({
          account_id: l.account_id, amount: l.amount, currency: l.currency,
          base_amount: l.base_amount, fx_rate: l.fx_rate, vat_code: l.vat_code,
          is_debit: !l.is_debit, // mirror
        })),
      });

      await this.expenses.updateDraft(id, {
        gross_amount: req.new_amount ?? expense.gross_amount,
        vat_amount: req.new_vat_amount ?? expense.vat_amount,
        category: req.new_category ?? expense.category,
      });
      const correctedDraft = await this.expenses.generateDraft(id);
      const corrected = await this.posting.postVoucher({
        voucher_number: `${original.voucher_number}-COR`,
        tax_point_date: correctedDraft.tax_point_date,
        corrects_object_type: 'expense',
        corrects_object_id: id,
        reason: req.reason,
        lines: correctedDraft.lines.map((l) => ({
          account_id: l.account_id, amount: l.amount, currency: l.currency,
          base_amount: l.base_amount, fx_rate: l.fx_rate, vat_code: l.vat_code, is_debit: l.is_debit,
        })),
      });

      await this.expenses.markReversed(id, corrected.id);
      return {
        kind: 'posted_reversed_and_corrected', object_id: id,
        reversal_voucher_id: reversal.id, corrected_voucher_id: corrected.id,
      };
    }

    async correctSalesInvoice(id: number, req: CorrectionRequest): Promise<CorrectionResult> {
      // Same branch structure as correctExpense, against SalesInvoicesService.
      // (Mirror the implementation above; corrects_object_type = 'sales_invoice'.)
      const invoice = await this.salesInvoices.getSalesInvoice(id);
      if (req.type === 'cosmetic') return { kind: 'cosmetic_attachment_replaced', object_id: id };
      if (invoice.status === 'draft' || invoice.status === 'pending') {
        await this.salesInvoices.updateDraft(id, {
          gross_amount: req.new_amount ?? invoice.gross_amount,
          vat_amount: req.new_vat_amount ?? invoice.vat_amount,
        });
        const draft = await this.salesInvoices.generateDraft(id);
        return { kind: 'draft_edited', object_id: id, new_draft_voucher_id: draft.id };
      }
      const originalVoucherId = invoice.voucher_id!;
      const original = await this.vouchers.getVoucherById(originalVoucherId);
      const originalLines = await this.vouchers.getLinesByVoucherId(originalVoucherId);
      const reversal = await this.posting.postVoucher({
        voucher_number: `${original.voucher_number}-REV`, tax_point_date: original.tax_point_date,
        reverses_id: originalVoucherId, corrects_object_type: 'sales_invoice', corrects_object_id: id, reason: req.reason,
        lines: originalLines.map((l) => ({ account_id: l.account_id, amount: l.amount, currency: l.currency, base_amount: l.base_amount, fx_rate: l.fx_rate, vat_code: l.vat_code, is_debit: !l.is_debit })),
      });
      await this.salesInvoices.updateDraft(id, { gross_amount: req.new_amount ?? invoice.gross_amount, vat_amount: req.new_vat_amount ?? invoice.vat_amount });
      const correctedDraft = await this.salesInvoices.generateDraft(id);
      const corrected = await this.posting.postVoucher({
        voucher_number: `${original.voucher_number}-COR`, tax_point_date: correctedDraft.tax_point_date,
        corrects_object_type: 'sales_invoice', corrects_object_id: id, reason: req.reason,
        lines: correctedDraft.lines.map((l) => ({ account_id: l.account_id, amount: l.amount, currency: l.currency, base_amount: l.base_amount, fx_rate: l.fx_rate, vat_code: l.vat_code, is_debit: l.is_debit })),
      });
      await this.salesInvoices.markReversed(id, corrected.id);
      return { kind: 'posted_reversed_and_corrected', object_id: id, reversal_voucher_id: reversal.id, corrected_voucher_id: corrected.id };
    }
  }
  ```
  > **Wave 3 helper assumptions:** `ExpensesService.updateDraft(id, patch)` (edits a draft business object), `.markReversed(id, newVoucherId)` (sets status `reversed`, re-points `voucher_id`). If Wave 3 named these differently, adapt the calls or add the two thin methods to the Wave 3 services (they are pure business-object state transitions, no schema change). Same for `SalesInvoicesService`.
- [ ] **Run (expect PASS):** `npm test -- corrections.service.spec` → branch tests green.
- [ ] **Write `src/corrections/corrections.module.ts`:**
  ```ts
  import { Module } from '@nestjs/common';
  import { CorrectionsService } from './corrections.service';
  import { ExpensesModule } from '../expenses/expenses.module';
  import { SalesInvoicesModule } from '../sales-invoices/sales-invoices.module';
  import { LedgerModule } from '../ledger/ledger.module'; // exports PostingService + VoucherRepository

  @Module({
    imports: [ExpensesModule, SalesInvoicesModule, LedgerModule],
    providers: [CorrectionsService],
    exports: [CorrectionsService],
  })
  export class CorrectionsModule {}
  ```
  > If Wave 2 didn't expose a `LedgerModule` exporting `PostingService`/`VoucherRepository`, import the specific modules that do. Do not change Wave 2 wiring beyond adding `exports` if missing.
- [ ] **Extend `src/expenses/expenses.controller.ts`** — add the correct endpoint (controller stays in the Expenses module; inject `CorrectionsService`, so add `CorrectionsModule` to `ExpensesModule.imports`, or place the endpoint on a corrections controller — pick the option that avoids a circular module dep; recommended: a small `CorrectionsController` in `src/corrections/`):
  ```ts
  // src/corrections/corrections.controller.ts
  import { Controller, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
  import { CorrectionsService } from './corrections.service';
  import { CorrectionRequest } from './types';

  @Controller('api')
  export class CorrectionsController {
    constructor(private readonly corrections: CorrectionsService) {}
    @Post('expenses/:id/correct')
    correctExpense(@Param('id', ParseIntPipe) id: number, @Body() body: CorrectionRequest) {
      return this.corrections.correctExpense(id, body);
    }
    @Post('sales-invoices/:id/correct')
    correctSalesInvoice(@Param('id', ParseIntPipe) id: number, @Body() body: CorrectionRequest) {
      return this.corrections.correctSalesInvoice(id, body);
    }
  }
  ```
  Register `CorrectionsController` in `CorrectionsModule.controllers` and add `CorrectionsModule` to `src/app.module.ts`. (This avoids editing Wave 3 controllers and the circular dep.)
- [ ] **Run (expect PASS):** `npm test -- corrections` → unit + integration green; `npm run build` clean.
- [ ] **G4/G5 greps (expect empty):**
  - `grep -rn "createTable\|CREATE TABLE" src/corrections --include=*.ts` (corrections add no schema).
  - Must-NOT-do: never edit posted vouchers → `grep -rni "updateTable('voucher')\|update.*voucher_line" src/corrections` (expect empty — only `postVoucher` is used); no period-lock enforcement → `grep -rni "locked\|lock" src/corrections/corrections.service.ts` (only the `locked_period_not_implemented` constant kind, no enforcement); no real credit notes sent → `grep -rni "email\|send\|smtp" src/corrections` (empty).
- [ ] **Run the full gate (G1):** `npm run build && npm run lint && npm run test && npm run test:e2e` → all green.
- [ ] **Commit:** `git add -A && git commit -m "feat(corrections): correction flow with reversal + repost"`

---

## Task 19 — ReportingPeriod schema + CRUD

Schema + CRUD only. A seeded open `2024-Q1` period; `GET /current` returns the latest open period by `start_date`. No lock enforcement, no auto-generation, no VAT computation (all Wave 6). The seed lives in the migration (G4).

**Files:**
- `src/database/migrations/011_create_reporting_period.ts` (NEW)
- `src/database/migrations/index.ts` (EXTEND)
- `src/database/types.ts` (EXTEND)
- `src/reporting-periods/types.ts` (NEW)
- `src/reporting-periods/reporting-periods.service.ts` (NEW)
- `src/reporting-periods/reporting-periods.controller.ts` (NEW)
- `src/reporting-periods/reporting-periods.module.ts` (NEW)
- `src/reporting-periods/reporting-periods.controller.spec.ts` (NEW)
- `src/reporting-periods/reporting-periods.integration.spec.ts` (NEW, G2)
- `src/app.module.ts` (EXTEND)

Steps:

- [ ] **Write the migration** `src/database/migrations/011_create_reporting_period.ts` (schema + seed in the migration — never in a service, G4):
  ```ts
  import { Kysely } from 'kysely';

  export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
      .createTable('reporting_period')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('start_date', 'text', (col) => col.notNull()) // YYYY-MM-DD
      .addColumn('end_date', 'text', (col) => col.notNull())
      // enum: open | locked. Lock ENFORCEMENT is Wave 6; this column only records state.
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('open'))
      .addColumn('filed_at', 'integer')
      .addColumn('vat_report_snapshot_id', 'integer') // FK to vat_report deferred to Wave 6
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .execute();

    // Seed one open period so /current resolves on a fresh deployment (ADR-0009).
    await db.insertInto('reporting_period').values({
      name: '2024-Q1', start_date: '2024-01-01', end_date: '2024-03-31',
      status: 'open', filed_at: null, vat_report_snapshot_id: null,
      created_at: Math.floor(Date.now() / 1000),
    }).execute();
  }

  export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('reporting_period').ifExists().execute();
  }
  ```
- [ ] **Register** in `src/database/migrations/index.ts`: `import * as m011 ...; '011_create_reporting_period': m011,`.
- [ ] **Extend `src/database/types.ts`:**
  ```ts
  export interface ReportingPeriodTable {
    id: Generated<number>;
    name: string;
    start_date: string;
    end_date: string;
    status: string; // 'open' | 'locked'
    filed_at: number | null;
    vat_report_snapshot_id: number | null;
    created_at: number;
  }
  ```
  and `reporting_period: ReportingPeriodTable;` on `Database`.
- [ ] **Write `src/reporting-periods/types.ts`:**
  ```ts
  export type PeriodStatus = 'open' | 'locked';
  export interface ReportingPeriod {
    id: number; name: string; start_date: string; end_date: string;
    status: PeriodStatus; filed_at: number | null; vat_report_snapshot_id: number | null; created_at: number;
  }
  export interface CreateReportingPeriodDto {
    name: string; start_date: string; end_date: string; status?: PeriodStatus;
  }
  ```
- [ ] **Write the FULL failing G2 integration test** `src/reporting-periods/reporting-periods.integration.spec.ts` — real service over the migrated in-memory DB; asserts the seeded `2024-Q1` exists, `getCurrent()` returns it, and a created `2024-Q2` becomes current (latest open by `start_date` — discriminating value, G3):
  ```ts
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { ReportingPeriodsService } from './reporting-periods.service';

  describe('ReportingPeriods (integration)', () => {
    let db: Kysely<Database>;
    let service: ReportingPeriodsService;
    beforeEach(async () => {
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');
      service = new ReportingPeriodsService(db);
    });
    afterEach(async () => { await db.destroy(); });

    it('lists the seeded 2024-Q1 open period', async () => {
      const list = await service.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ name: '2024-Q1', status: 'open', start_date: '2024-01-01' });
    });
    it('getCurrent returns the latest open period by start_date', async () => {
      await service.create({ name: '2024-Q2', start_date: '2024-04-01', end_date: '2024-06-30' });
      const current = await service.getCurrent();
      expect(current.name).toBe('2024-Q2'); // later start_date than seeded Q1
      expect(current.status).toBe('open');
    });
    it('ignores locked periods when resolving current', async () => {
      await service.create({ name: '2024-Q2', start_date: '2024-04-01', end_date: '2024-06-30', status: 'locked' });
      const current = await service.getCurrent();
      expect(current.name).toBe('2024-Q1'); // Q2 is locked, falls back to Q1
    });
  });
  ```
- [ ] **Run (expect FAIL):** `npm test -- reporting-periods.integration` → `Cannot find module './reporting-periods.service'`.
- [ ] **Write `src/reporting-periods/reporting-periods.service.ts`:**
  ```ts
  import { Injectable, NotFoundException } from '@nestjs/common';
  import { InjectKysely } from 'nestjs-kysely';
  import { Kysely } from 'kysely';
  import { Database } from '../database/types';
  import { ReportingPeriod, CreateReportingPeriodDto, PeriodStatus } from './types';

  @Injectable()
  export class ReportingPeriodsService {
    constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

    async list(): Promise<ReportingPeriod[]> {
      const rows = await this.db.selectFrom('reporting_period').selectAll().orderBy('start_date').execute();
      return rows.map((r) => this.mapRow(r));
    }
    async getById(id: number): Promise<ReportingPeriod> {
      const row = await this.db.selectFrom('reporting_period').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw new NotFoundException(`Reporting period ${id} not found`);
      return this.mapRow(row);
    }
    async getCurrent(): Promise<ReportingPeriod> {
      const row = await this.db.selectFrom('reporting_period').selectAll()
        .where('status', '=', 'open').orderBy('start_date', 'desc').executeTakeFirst();
      if (!row) throw new NotFoundException('No open reporting period');
      return this.mapRow(row);
    }
    async create(dto: CreateReportingPeriodDto): Promise<ReportingPeriod> {
      const inserted = await this.db.insertInto('reporting_period').values({
        name: dto.name, start_date: dto.start_date, end_date: dto.end_date,
        status: dto.status ?? 'open', filed_at: null, vat_report_snapshot_id: null,
        created_at: Math.floor(Date.now() / 1000),
      }).returning('id').executeTakeFirstOrThrow();
      return this.getById(inserted.id);
    }

    private mapRow(row: Database['reporting_period']): ReportingPeriod {
      return {
        id: row.id as unknown as number, name: row.name, start_date: row.start_date, end_date: row.end_date,
        status: row.status as PeriodStatus, filed_at: row.filed_at,
        vat_report_snapshot_id: row.vat_report_snapshot_id, created_at: row.created_at,
      };
    }
  }
  ```
- [ ] **Run (expect PASS):** `npm test -- reporting-periods.integration` → green.
- [ ] **Write the FULL failing controller test** `src/reporting-periods/reporting-periods.controller.spec.ts` (NestJS testing module with the service mocked — proves routing + the `/current` ordering of route declarations so `:id` does not shadow `current`):
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { ReportingPeriodsController } from './reporting-periods.controller';
  import { ReportingPeriodsService } from './reporting-periods.service';

  describe('ReportingPeriodsController', () => {
    let controller: ReportingPeriodsController;
    const svc = {
      list: jest.fn().mockResolvedValue([{ id: 1, name: '2024-Q1', status: 'open' }]),
      getCurrent: jest.fn().mockResolvedValue({ id: 1, name: '2024-Q1', status: 'open' }),
      getById: jest.fn().mockResolvedValue({ id: 1, name: '2024-Q1', status: 'open' }),
      create: jest.fn().mockResolvedValue({ id: 2, name: '2024-Q2', status: 'open' }),
    };
    beforeEach(async () => {
      const m: TestingModule = await Test.createTestingModule({
        controllers: [ReportingPeriodsController],
        providers: [{ provide: ReportingPeriodsService, useValue: svc }],
      }).compile();
      controller = m.get(ReportingPeriodsController);
    });
    it('GET / lists periods', async () => { expect(await controller.list()).toHaveLength(1); });
    it('GET /current returns the current period', async () => { expect((await controller.current()).name).toBe('2024-Q1'); expect(svc.getCurrent).toHaveBeenCalled(); });
    it('POST / creates a period', async () => { expect((await controller.create({ name: '2024-Q2', start_date: '2024-04-01', end_date: '2024-06-30' })).name).toBe('2024-Q2'); });
  });
  ```
- [ ] **Run (expect FAIL):** `npm test -- reporting-periods.controller` → controller not found.
- [ ] **Write `src/reporting-periods/reporting-periods.controller.ts`** (declare `/current` BEFORE `/:id`):
  ```ts
  import { Controller, Get, Post, Body, Param, ParseIntPipe } from '@nestjs/common';
  import { ReportingPeriodsService } from './reporting-periods.service';
  import { CreateReportingPeriodDto } from './types';

  @Controller('api/reporting-periods')
  export class ReportingPeriodsController {
    constructor(private readonly periods: ReportingPeriodsService) {}
    @Get() list() { return this.periods.list(); }
    @Get('current') current() { return this.periods.getCurrent(); }
    @Get(':id') get(@Param('id', ParseIntPipe) id: number) { return this.periods.getById(id); }
    @Post() create(@Body() dto: CreateReportingPeriodDto) { return this.periods.create(dto); }
  }
  ```
- [ ] **Write `src/reporting-periods/reporting-periods.module.ts`** and add it to `src/app.module.ts`:
  ```ts
  import { Module } from '@nestjs/common';
  import { ReportingPeriodsController } from './reporting-periods.controller';
  import { ReportingPeriodsService } from './reporting-periods.service';

  @Module({
    controllers: [ReportingPeriodsController],
    providers: [ReportingPeriodsService],
    exports: [ReportingPeriodsService],
  })
  export class ReportingPeriodsModule {}
  ```
- [ ] **Run (expect PASS):** `npm test -- reporting-periods` → all green; `npm run build` clean.
- [ ] **G4/G5 greps (expect empty):**
  - `grep -rn "createTable\|CREATE TABLE" src/reporting-periods --include=*.ts` (no schema outside migration).
  - Must-NOT-do: no lock enforcement → `grep -rni "throw.*lock\|reject.*lock" src/reporting-periods` (empty); no auto-generation → `grep -rni "frequency\|generatePeriods\|cron" src/reporting-periods` (empty); no VAT computation → `grep -rni "vat.*compute\|box\|merkle" src/reporting-periods` (empty).
- [ ] **Run the full gate (G1):** `npm run build && npm run lint && npm run test && npm run test:e2e` → all green.
- [ ] **Commit:** `git add -A && git commit -m "feat(periods): reporting period schema + CRUD"`

---

## Task 20 — Intake integration (document → triage → draft → post)

The capstone: a real HTTP e2e test (`test/intake.e2e-spec.ts`) booting the full `AppModule` over a migrated in-memory SQLite DB. No new business logic — pure wiring. Covers the happy path (upload → triage → post → posted voucher, `Document.status='processed'`) and the dedup path (same bytes twice → one Expense, two sources).

**Files:**
- `test/intake.e2e-spec.ts` (NEW)
- `src/triage/triage.service.ts` (EXTEND, only if needed: set `Document.status='processed'` after the linked object posts — see note)

Steps:

- [ ] **Decide where `processed` is set.** The triage service sets `Document.status='triaged'` on draft creation (Task 17). After the business object posts via the pipeline, the document should reach `processed`. Wire this in the e2e flow by having the test post the expense and then assert `processed` — set it in `ExpensesService.post` (Wave 3) only if a hook already exists; otherwise add a tiny `DocumentsService.setStatus(documentId, 'processed')` call in a thin `TriageService.markProcessed(documentId)` invoked by the e2e flow endpoint. **Do not add new business logic to the pipeline** — keep the status transition in the documents/triage layer. Simplest compliant choice: expose `POST /api/documents/:id/complete` on the triage controller that calls `documents.setStatus(id, 'processed')`, called after posting. (Document this choice in the test.)
- [ ] **Write the FULL failing e2e test** `test/intake.e2e-spec.ts` — boot `AppModule` with the Kysely connection overridden to in-memory + migrated (override `KYSELY_MODULE_CONNECTION_TOKEN()` and `DOCUMENT_STORAGE_ROOT` in the testing module; copy the supertest boot from `test/health.e2e-spec.ts` and the migration boot from `currency.resolution.spec.ts`):
  ```ts
  import { Test, TestingModule } from '@nestjs/testing';
  import { INestApplication } from '@nestjs/common';
  import request from 'supertest';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { promises as fs } from 'fs';
  import { join } from 'path';
  import { tmpdir } from 'os';
  import { AppModule } from '../src/app.module';
  import { Database } from '../src/database/types';
  import { migrations } from '../src/database/migrations';
  import { DOCUMENT_STORAGE_ROOT } from '../src/documents/document-storage.service';

  describe('Intake e2e (upload -> triage -> post)', () => {
    let app: INestApplication;
    let db: Kysely<Database>;
    let root: string;

    beforeEach(async () => {
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
      const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');
      root = await fs.mkdtemp(join(tmpdir(), 'intake-e2e-'));
      const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(KYSELY_MODULE_CONNECTION_TOKEN()).useValue(db)
        .overrideProvider(DOCUMENT_STORAGE_ROOT).useValue(root)
        .compile();
      app = moduleFixture.createNestApplication();
      await app.init();
    });
    afterEach(async () => { await app.close(); await db.destroy(); });

    it('full intake: upload (odd id) -> triage -> post -> posted voucher + processed document', async () => {
      const upload = await request(app.getHttpServer())
        .post('/api/documents').attach('file', Buffer.from('receipt EUR 1525\n'), 'receipt.txt')
        .expect(201);
      const documentId = upload.body.id;
      expect(documentId).toBe(1);

      const triage = await request(app.getHttpServer())
        .post(`/api/documents/${documentId}/triage`).expect(201);
      expect(triage.body.kind).toBe('new_expense');
      const expenseId = triage.body.expense_id;

      await request(app.getHttpServer()).post(`/api/expenses/${expenseId}/post`).expect(201);

      const expense = await request(app.getHttpServer()).get(`/api/expenses/${expenseId}`).expect(200);
      expect(expense.body.status).toBe('posted');
      expect(expense.body.voucher_id).toBeTruthy();
      expect(expense.body.currency).toBe('EUR');

      // document reaches processed (transition lives in the documents/triage layer)
      await request(app.getHttpServer()).post(`/api/documents/${documentId}/complete`).expect(201);
      const doc = await request(app.getHttpServer()).get(`/api/documents/${documentId}`).expect(200);
      expect(doc.body.status).toBe('processed');
    });

    it('dedup: same bytes uploaded twice -> one Document with two sources, one Expense', async () => {
      const bytes = Buffer.from('same receipt bytes\n');
      const first = await request(app.getHttpServer())
        .post('/api/documents').attach('file', bytes, 'r.txt').expect(201);
      const second = await request(app.getHttpServer())
        .post('/api/documents').attach('file', bytes, 'r.txt').expect(200); // dedup -> 200
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.sources).toHaveLength(2);

      // triage once on the single deduped document -> exactly one Expense
      const triage = await request(app.getHttpServer())
        .post(`/api/documents/${first.body.id}/triage`).expect(201);
      expect(triage.body.kind).toBe('new_expense');
      const list = await request(app.getHttpServer()).get('/api/expenses').expect(200);
      const expenses = Array.isArray(list.body) ? list.body : list.body.expenses;
      expect(expenses).toHaveLength(1);
    });
  });
  ```
  > Adjust `GET /api/expenses` response shape (`body.expenses` vs array) to match the Wave 3 controller. The status codes (201 new / 200 dedup) come from Task 16's controller.
- [ ] **Run (expect FAIL):** `npm run test:e2e -- intake` → fails until the `/complete` endpoint (or chosen `processed` transition) exists and modules are wired.
- [ ] **Add the `processed` transition** chosen above (thin `POST /api/documents/:id/complete` on `TriageController` calling `documents.setStatus(id, 'processed')`, or equivalent). No new business logic.
- [ ] **Run (expect PASS):** `npm run test:e2e -- intake` → both scenarios green.
- [ ] **G5 greps (expect empty):** no new business logic in integration → the only files touched are `test/intake.e2e-spec.ts` and the thin status transition; no channels → `grep -rni "telegram\|imap\|smtp" test/intake.e2e-spec.ts` (empty); correction flow not exercised here → `grep -rni "correct\|reversal" test/intake.e2e-spec.ts` (empty).
- [ ] **Run the full gate (G1):** `npm run build && npm run lint && npm run test && npm run test:e2e` → all green.
- [ ] **Commit:** `git add -A && git commit -m "feat(intake): end-to-end document to voucher integration"`

---

## Wave 4 close-out (G8 — per-wave verification before the final wave commit)

- [ ] **Plan-compliance:** all five tasks (16–20) committed; every Must-Have endpoint exists (`POST/GET /api/documents`, `GET /api/documents/:id`, `POST /api/documents/:id/triage`, `GET /api/triage/pending`, `POST /api/expenses/:id/correct`, `POST /api/sales-invoices/:id/correct`, `GET/POST /api/reporting-periods`, `GET /api/reporting-periods/current|:id`).
- [ ] **Code-quality:** no `as any` slop beyond the localized `as unknown as number` row-mapping helpers; no empty catches; no dead code; `npm run lint` clean.
- [ ] **Scope-fidelity greps (all expect empty):**
  - `grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"`
  - file-blobs-in-SQLite, real-OCR, channel-adapters, posted-voucher-edits, period-lock-enforcement, auto-period-generation, VAT-computation, real-credit-note-send — per the inline Must-NOT-do greps in each task.
- [ ] **DB-invariant proof:** the `document.hash` UNIQUE test (Task 16 integration) asserts the DB rejects a duplicate raw insert (G6).
- [ ] **Real-DI coverage:** Tasks 16–19 each have a real-DI integration test on migrated in-memory SQLite; Task 20 has the full-`AppModule` e2e (G2).
- [ ] **Final wave gate (G1):** `npm run build && npm run lint && npm run test && npm run test:e2e` → all green, then the per-task commits above already record the wave (no extra squash needed unless the executor prefers a wave-summary commit).
