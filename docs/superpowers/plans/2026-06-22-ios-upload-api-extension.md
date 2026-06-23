# iOS Upload API Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `POST /api/documents` so the iOS app can attach provenance + on-device pre-check metadata (`channel`, `assetLocalId`, `capturedAt`, `precheck`) to each upload, reusing the existing `document` / `document_source` storage and dedup.

**Architecture:** No new tables. The iOS upload routes through the existing `document_source` provenance row using a new `'ios_photo_library'` channel and `source_identifier = assetLocalId`. Two new nullable columns (`captured_at`, `precheck_json`) are added to `document_source` via migration 052 to persist capture time and the model's pre-check JSON. The upload service and controller are widened to accept and persist these fields; everything stays backward-compatible (all new inputs optional).

**Tech Stack:** NestJS 11, Kysely + better-sqlite3, nestjs-zod, Jest (unit), Jest + supertest (e2e).

## Global Constraints

- Server unit tests: `cd packages/server && npx jest -c jest.config.cjs <path>`.
- Server e2e tests: `cd packages/server && npx jest --config ./test/jest-e2e.json <name>`.
- Migration number is **052** (050 is the latest on `main`; 051 is reserved by the enrollment branch, which merges first — do not reuse it).
- New columns are nullable; existing upload callers (`'upload'`/`'telegram'`/`'email'`/`'drive'`) must keep working unchanged.
- `precheck` is stored as the raw JSON **string** in `precheck_json`; the server validates it parses but does not interpret it.
- `capturedAt` crosses the wire as an ISO-8601 string and is persisted as unix **seconds** (matching `received_at`).
- New HTTP behaviour stays on the existing route `POST /api/documents` (the controller declares its full path in `@Controller('api/documents')`; there is no global prefix).
- No plaintext mutation of existing rows: migration only `addColumn`.

---

### Task 1: Migration 052 — `captured_at` + `precheck_json` on `document_source`

**Files:**
- Create: `packages/server/src/database/migrations/052_add_document_source_ios_metadata.ts`
- Modify: `packages/server/src/database/migrations/index.ts` (import + register `m052`)
- Modify: `packages/server/src/database/types.ts:198-204` (`DocumentSourceTable`)
- Test: `packages/server/src/database/migrations/052_add_document_source_ios_metadata.spec.ts`

**Interfaces:**
- Produces: `document_source` rows gain `captured_at: number | null` and `precheck_json: string | null`. `DocumentSourceTable` gains `captured_at: number | null` and `precheck_json: string | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/database/migrations/052_add_document_source_ios_metadata.spec.ts`:

```typescript
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('migration 052 — document_source ios metadata', () => {
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
    if (error) throw error;
  });

  afterEach(async () => db.destroy());

  it('defaults captured_at and precheck_json to null', async () => {
    const doc = await db
      .insertInto('document')
      .values({
        hash: 'h1',
        filename: 'a.heic',
        mime_type: 'image/heic',
        size_bytes: 10,
        storage_path: null,
        status: 'pending',
        created_at: 1750000000,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto('document_source')
      .values({
        document_id: doc.id,
        channel: 'upload',
        source_identifier: null,
        received_at: 1750000000,
      })
      .execute();

    const row = await db
      .selectFrom('document_source')
      .select(['captured_at', 'precheck_json'])
      .executeTakeFirstOrThrow();
    expect(row.captured_at).toBeNull();
    expect(row.precheck_json).toBeNull();
  });

  it('accepts ios metadata values', async () => {
    const doc = await db
      .insertInto('document')
      .values({
        hash: 'h2',
        filename: 'b.heic',
        mime_type: 'image/heic',
        size_bytes: 10,
        storage_path: null,
        status: 'pending',
        created_at: 1750000000,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto('document_source')
      .values({
        document_id: doc.id,
        channel: 'ios_photo_library',
        source_identifier: 'ABC-123/L0/001',
        received_at: 1750000000,
        captured_at: 1749990000,
        precheck_json: '{"decision":"upload"}',
      })
      .execute();

    const row = await db
      .selectFrom('document_source')
      .select(['captured_at', 'precheck_json'])
      .where('source_identifier', '=', 'ABC-123/L0/001')
      .executeTakeFirstOrThrow();
    expect(row.captured_at).toBe(1749990000);
    expect(row.precheck_json).toBe('{"decision":"upload"}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/database/migrations/052_add_document_source_ios_metadata.spec.ts`
Expected: FAIL — `captured_at`/`precheck_json` columns do not exist (SQLite error) or type errors.

- [ ] **Step 3: Create the migration**

Create `packages/server/src/database/migrations/052_add_document_source_ios_metadata.ts`:

```typescript
import { Kysely } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document_source')
    .addColumn('captured_at', 'integer')
    .execute();
  await db.schema
    .alterTable('document_source')
    .addColumn('precheck_json', 'text')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document_source')
    .dropColumn('precheck_json')
    .execute();
  await db.schema
    .alterTable('document_source')
    .dropColumn('captured_at')
    .execute();
}
```

- [ ] **Step 4: Register the migration**

In `packages/server/src/database/migrations/index.ts`, add the import after the `m051` line (the enrollment branch's migration; if it is not yet present in this branch, add `m052` after `m050` instead):

```typescript
import * as m052 from './052_add_document_source_ios_metadata';
```

and add to the `migrations` record after the previous entry:

```typescript
  '052_add_document_source_ios_metadata': m052,
```

- [ ] **Step 5: Update the table type**

In `packages/server/src/database/types.ts`, replace the `DocumentSourceTable` interface (currently lines 198-204) with:

```typescript
export interface DocumentSourceTable {
  id: Generated<number>;
  document_id: number;
  channel: string;
  source_identifier: string | null;
  received_at: number;
  // Unix seconds the asset was captured on-device (iOS). NULL for non-mobile channels.
  captured_at: number | null;
  // Raw JSON string of the on-device pre-check result (scores + decision). NULL otherwise.
  precheck_json: string | null;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/database/migrations/052_add_document_source_ios_metadata.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/database/migrations/052_add_document_source_ios_metadata.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/database/types.ts \
        packages/server/src/database/migrations/052_add_document_source_ios_metadata.spec.ts
git commit -m "feat(documents): add captured_at/precheck_json to document_source (migration 052)"
```

---

### Task 2: Add `'ios_photo_library'` channel

**Files:**
- Modify: `packages/server/src/documents/types.ts:22` (`Channel` union)
- Modify: `packages/server/src/documents/documents.service.ts:382-391` (`validateChannel`)
- Test: `packages/server/src/documents/documents.service.spec.ts` (add a case)

**Interfaces:**
- Produces: `Channel = 'upload' | 'telegram' | 'email' | 'drive' | 'ios_photo_library'`. `validateChannel('ios_photo_library')` returns it instead of throwing.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/documents/documents.service.spec.ts` (inside the existing top-level `describe`; reuse the file's `db`/`service` setup — match its existing `beforeEach`):

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/documents/documents.service.spec.ts -t "ios_photo_library channel"`
Expected: FAIL — `validateChannel` throws `Invalid channel: ios_photo_library` during `hydrate`, or the `Channel` type rejects the literal.

- [ ] **Step 3: Widen the `Channel` type**

In `packages/server/src/documents/types.ts`, replace line 22:

```typescript
export type Channel =
  | 'upload'
  | 'telegram'
  | 'email'
  | 'drive'
  | 'ios_photo_library';
```

- [ ] **Step 4: Widen `validateChannel`**

In `packages/server/src/documents/documents.service.ts`, replace the `validateChannel` condition (lines 383-388) with:

```typescript
    if (
      channel === 'upload' ||
      channel === 'telegram' ||
      channel === 'email' ||
      channel === 'drive' ||
      channel === 'ios_photo_library'
    ) {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/documents/documents.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/documents/types.ts packages/server/src/documents/documents.service.ts packages/server/src/documents/documents.service.spec.ts
git commit -m "feat(documents): add ios_photo_library channel"
```

---

### Task 3: Persist `capturedAt` + `precheck` in `upload()`

**Files:**
- Modify: `packages/server/src/documents/types.ts:50-56` (`UploadDocumentInput`) and `38-44` (`DocumentSource`)
- Modify: `packages/server/src/documents/documents.service.ts` (both `document_source` inserts + `mapDocumentSource`/row select)
- Test: `packages/server/src/documents/documents.service.spec.ts` (add cases)

**Interfaces:**
- Consumes: `Channel` (Task 2), the columns from Task 1.
- Produces:
  - `UploadDocumentInput` gains `capturedAt?: number | null` (unix seconds) and `precheckJson?: string | null`.
  - `DocumentSource` gains `captured_at: number | null` and `precheck_json: string | null`.
  - `upload()` writes both fields onto the `document_source` row in **both** the deduplicated and the new-document paths.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/documents/documents.service.spec.ts`:

```typescript
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
    expect(secondSource?.precheck_json).toBe('{"decision":"upload","again":true}');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest -c jest.config.cjs src/documents/documents.service.spec.ts -t "ios metadata persistence"`
Expected: FAIL — `capturedAt`/`precheckJson` not accepted by `UploadDocumentInput`; `captured_at`/`precheck_json` missing from the hydrated `DocumentSource`.

- [ ] **Step 3: Widen the input + output types**

In `packages/server/src/documents/types.ts`, replace `UploadDocumentInput` (lines 50-56) with:

```typescript
export interface UploadDocumentInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  channel: Channel;
  sourceIdentifier?: string | null;
  // Unix seconds the asset was captured on-device (iOS). Optional.
  capturedAt?: number | null;
  // Raw JSON string of the on-device pre-check result. Optional.
  precheckJson?: string | null;
}
```

and replace `DocumentSource` (lines 38-44) with:

```typescript
export interface DocumentSource {
  id: number;
  document_id: number;
  channel: Channel;
  source_identifier: string | null;
  received_at: number;
  captured_at: number | null;
  precheck_json: string | null;
}
```

- [ ] **Step 4: Write both inserts and the row mapping**

In `packages/server/src/documents/documents.service.ts`, in the **dedup branch** insert, replace:

```typescript
      const { channel, sourceIdentifier } = input;
      await this.db
        .insertInto('document_source')
        .values({
          document_id: existing.id,
          channel,
          source_identifier: sourceIdentifier ?? null,
          received_at: now,
        })
        .execute();
```

with:

```typescript
      const { channel, sourceIdentifier } = input;
      await this.db
        .insertInto('document_source')
        .values({
          document_id: existing.id,
          channel,
          source_identifier: sourceIdentifier ?? null,
          received_at: now,
          captured_at: input.capturedAt ?? null,
          precheck_json: input.precheckJson ?? null,
        })
        .execute();
```

In the **new-document branch**, replace:

```typescript
    const { channel, sourceIdentifier } = input;
    await this.db
      .insertInto('document_source')
      .values({
        document_id: docRow.id,
        channel,
        source_identifier: sourceIdentifier ?? null,
        received_at: now,
      })
      .execute();
```

with:

```typescript
    const { channel, sourceIdentifier } = input;
    await this.db
      .insertInto('document_source')
      .values({
        document_id: docRow.id,
        channel,
        source_identifier: sourceIdentifier ?? null,
        received_at: now,
        captured_at: input.capturedAt ?? null,
        precheck_json: input.precheckJson ?? null,
      })
      .execute();
```

Then update the `document_source` row mapper. Find the object that builds a `DocumentSource` (the block around `documents.service.ts:356-363` that does `channel: this.validateChannel(row.channel)`), and add the two fields:

```typescript
      channel: this.validateChannel(row.channel),
      source_identifier: row.source_identifier,
      received_at: row.received_at,
      captured_at: row.captured_at,
      precheck_json: row.precheck_json,
```

(If the hydrate path uses `selectAll()` on `document_source`, the new columns are already selected; if it uses an explicit `select([...])`, add `'captured_at'` and `'precheck_json'` to that list.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/server && npx jest -c jest.config.cjs src/documents/documents.service.spec.ts`
Expected: PASS (existing cases + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/documents/types.ts packages/server/src/documents/documents.service.ts packages/server/src/documents/documents.service.spec.ts
git commit -m "feat(documents): persist capturedAt + precheck on document_source"
```

---

### Task 4: Controller accepts iOS multipart fields

**Files:**
- Modify: `packages/server/src/documents/documents.controller.ts:25-58` (`uploadDocument`)
- Test: `packages/server/test/documents-ios-upload.e2e-spec.ts`

**Interfaces:**
- Consumes: `DocumentsService.upload` widened in Task 3; `Channel` (Task 2).
- Produces: `POST /api/documents` now reads optional multipart text fields alongside `file`:
  - `channel` (default `'upload'`)
  - `assetLocalId` → `sourceIdentifier`
  - `capturedAt` (ISO-8601 string) → unix seconds
  - `precheck` (JSON string) → stored verbatim in `precheck_json`; rejected with 400 if present but not valid JSON.
  - Response shape unchanged: `{ document, deduplicated }`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/documents-ios-upload.e2e-spec.ts` (model the bootstrap on `app.e2e-spec.ts`; seed a static token with `seedApiToken`):

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../src/database/types';
import { seedApiToken } from './e2e-auth';

describe('iOS document upload (e2e)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    db = app.get<Kysely<Database>>(KYSELY_MODULE_CONNECTION_TOKEN());
    token = await seedApiToken(db);
  });

  afterAll(async () => app.close());

  it('stores channel, assetLocalId, capturedAt and precheck', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('channel', 'ios_photo_library')
      .field('assetLocalId', 'E2E-ASSET-1')
      .field('capturedAt', '2026-06-22T10:00:00.000Z')
      .field('precheck', '{"decision":"upload","top":0.9}')
      .attach('file', Buffer.from('heic-bytes-1'), {
        filename: 'r.heic',
        contentType: 'image/heic',
      })
      .expect(201);

    const docId = res.body.document.id as number;
    const source = await db
      .selectFrom('document_source')
      .selectAll()
      .where('document_id', '=', docId)
      .executeTakeFirstOrThrow();

    expect(source.channel).toBe('ios_photo_library');
    expect(source.source_identifier).toBe('E2E-ASSET-1');
    expect(source.captured_at).toBe(
      Math.floor(Date.parse('2026-06-22T10:00:00.000Z') / 1000),
    );
    expect(source.precheck_json).toBe('{"decision":"upload","top":0.9}');
  });

  it('still accepts a plain file upload with no extra fields', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('plain-bytes'), {
        filename: 'plain.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    const source = await db
      .selectFrom('document_source')
      .selectAll()
      .where('document_id', '=', res.body.document.id as number)
      .executeTakeFirstOrThrow();
    expect(source.channel).toBe('upload');
    expect(source.captured_at).toBeNull();
    expect(source.precheck_json).toBeNull();
  });

  it('rejects malformed precheck JSON with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('precheck', 'not-json')
      .attach('file', Buffer.from('x'), {
        filename: 'x.heic',
        contentType: 'image/heic',
      })
      .expect(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx jest --config ./test/jest-e2e.json documents-ios-upload`
Expected: FAIL — extra fields ignored, `captured_at`/`precheck_json` come back `null`, and malformed JSON is accepted (no 400).

- [ ] **Step 3: Add a DTO + body handling to the controller**

In `packages/server/src/documents/documents.controller.ts`, add to the imports:

```typescript
import { Body, BadRequestException } from '@nestjs/common';
```

(merge `Body` and `BadRequestException` into the existing `@nestjs/common` import list rather than duplicating it).

Replace the `uploadDocument` method (lines 38-58) with:

```typescript
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
    }),
  )
  @HttpCode(HttpStatus.CREATED)
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: {
      channel?: string;
      assetLocalId?: string;
      capturedAt?: string;
      precheck?: string;
    },
  ): Promise<{ document: Document; deduplicated: boolean }> {
    let precheckJson: string | null = null;
    if (body.precheck !== undefined && body.precheck !== '') {
      try {
        JSON.parse(body.precheck);
      } catch {
        throw new BadRequestException('precheck must be valid JSON');
      }
      precheckJson = body.precheck;
    }

    let capturedAt: number | null = null;
    if (body.capturedAt !== undefined && body.capturedAt !== '') {
      const parsed = Date.parse(body.capturedAt);
      if (Number.isNaN(parsed)) {
        throw new BadRequestException('capturedAt must be an ISO-8601 date');
      }
      capturedAt = Math.floor(parsed / 1000);
    }

    const result = await this.documentsService.upload({
      buffer: file.buffer,
      filename: file.originalname,
      mimeType: file.mimetype,
      channel: (body.channel as Channel) ?? 'upload',
      sourceIdentifier: body.assetLocalId ?? null,
      capturedAt,
      precheckJson,
    });

    return { document: result.document, deduplicated: result.deduplicated };
  }
```

Add `Channel` to the type import from `./types`:

```typescript
import { Document, DocumentWithSources, Channel } from './types';
```

Note: an unknown `channel` value falls through to `DocumentsService` and is rejected by `validateChannel` when the document is later hydrated; the supported values are enforced there (Task 2). The happy-path mobile value `'ios_photo_library'` is now valid.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && npx jest --config ./test/jest-e2e.json documents-ios-upload`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/documents/documents.controller.ts packages/server/test/documents-ios-upload.e2e-spec.ts
git commit -m "feat(documents): accept ios upload metadata fields on POST /api/documents"
```

---

### Task 5: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Server unit + e2e + lint**

Run each and confirm green:

```bash
cd packages/server && npx jest -c jest.config.cjs
cd packages/server && npx jest --config ./test/jest-e2e.json
cd packages/server && npm run lint
```

Expected: all suites pass, lint clean. If anything fails, fix before claiming completion (invoke superpowers:systematic-debugging if a failure is non-obvious).

- [ ] **Step 2: Commit any lint fixups**

```bash
git add -A && git commit -m "chore(documents): lint/format fixups for ios upload metadata"
```

---

## Self-Review

**Spec coverage:**
- Reuse existing storage (no new table) → Tasks 2-4 route through `document_source`. ✅
- `source` → `channel='ios_photo_library'` → Task 2. ✅
- `assetLocalId` → `source_identifier` → Tasks 3-4. ✅
- `capturedAt` persisted (ISO→unix) → migration 052 (Task 1) + service (Task 3) + controller parse (Task 4). ✅
- `precheck` stored as raw JSON, validated-parseable, not interpreted → Task 1 column, Task 3 persistence, Task 4 validation + 400. ✅
- Backward compatibility (plain `'upload'` still works, new fields default null) → Task 3 "defaults to null" case + Task 4 "plain file upload" case. ✅
- Dedup unchanged, metadata also recorded on dedup arrivals → Task 3 dedup-path case. ✅
- Migration number 052 (avoid 051 collision with enrollment branch) → Global Constraints + Task 1. ✅

**Placeholder scan:** no TBD/TODO; every code step shows complete code. The only conditional instruction (where to import `m052` relative to `m051`) is explicit about both cases. ✅

**Type consistency:** `UploadDocumentInput.capturedAt`/`precheckJson` (Task 3) are produced by the controller (Task 4) and consumed by `upload()` (Task 3). `DocumentSource.captured_at`/`precheck_json` (Task 3) match `DocumentSourceTable` columns (Task 1). `Channel` union (Task 2) is used by `validateChannel` (Task 2) and the controller cast (Task 4). The controller sends `precheckJson`/`capturedAt` keys matching `UploadDocumentInput`. ✅
