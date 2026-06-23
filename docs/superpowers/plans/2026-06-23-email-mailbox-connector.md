# Email Mailbox Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect external mailboxes (Gmail/Outlook via OAuth, any IMAP via app-password) read-only, sync them on an IMAP-IDLE + cursor engine, and harvest invoice-like attachments into the existing intake pipeline as `pending` documents.

**Architecture:** A new `mailbox` NestJS module. A `MailboxConnector` row holds the (encrypted) credential, sync cursor and health. One IMAP transport (imapflow + XOAUTH2 or password) behind a port. A `MailSyncWorker` keeps a live IDLE connection per connector, fetches forward from the durable UID cursor on every signal (and on reconnect/cron-sweep), and a `HarvestService` filters attachments and feeds each through `DocumentsService.upload(...)` then `IntakeQueueWorker.kick()`. The connector is ingestion-only; OCR/triage is the existing queue's job (ADR-0038, email-intake spec).

**Tech Stack:** NestJS 11, Kysely (SQLite), Zod 4, Jest 30, Node ≥22 ESM. New deps: `imapflow` (IMAP client with IDLE + XOAUTH2), `mailparser` (MIME/attachment parsing). OAuth token exchange uses global `fetch` (no SDK). Test command: `npx jest <path> --no-coverage`.

## Global Constraints

- **Base:** this worktree is rebased on `main` containing the intake-queue (migration 053, `IntakeQueueWorker`, `claimNextPending → {id, claimant_id}`) and claimant (migrations 054–057). **Latest existing migration is 057; this plan uses 058–059.**
- SQLite cannot ALTER a CHECK constraint — use the 12-step rebuild (rename → create new → copy → drop old → rename new).
- Dates/timestamps are Unix **seconds** (`Math.floor(Date.now()/1000)`), matching existing tables.
- Every migration ships with a paired `.spec.ts`.
- Secrets (IMAP password, OAuth refresh-token) are **encrypted at rest** with AES-256-GCM; the key comes from env `MAILBOX_SECRET_KEY` (32-byte hex). Never store a credential in plaintext or in the `setting` table.
- OAuth is **BYO app**: the operator supplies `google_oauth_client_id`/`secret` (and Microsoft equivalents) via settings. Scope is **read-only** (`https://www.googleapis.com/auth/gmail.readonly`, Microsoft `https://outlook.office365.com/IMAP.AccessAsUser.All offline_access`).
- `email_push` connector is **singleton** (≤1); `email_sync` may be many. Enforced by a partial unique index.
- The connector is **read-only / ingestion-only**: never APPEND/STORE/DELETE on the remote mailbox.
- Single Node process (inherits the intake-queue assumption); an in-process worker is sufficient.

---

## File Map

| Action | File |
|--------|------|
| Create | `packages/server/src/database/migrations/058_create_mailbox_connector.ts` (+ `.spec.ts`) |
| Create | `packages/server/src/database/migrations/059_widen_document_source_channel.ts` (+ `.spec.ts`) |
| Modify | `packages/server/src/database/migrations/index.ts` — register 058, 059 |
| Modify | `packages/server/src/database/types.ts` — add `MailboxConnectorTable` |
| Modify | `packages/server/src/documents/types.ts` — add `email_sync`/`email_push` to `Channel` |
| Create | `packages/server/src/mailbox/types.ts` |
| Create | `packages/server/src/mailbox/secret-cipher.ts` (+ `.spec.ts`) |
| Create | `packages/server/src/mailbox/attachment-filter.ts` (+ `.spec.ts`) |
| Create | `packages/server/src/mailbox/mailbox-connector.service.ts` (+ `.spec.ts`) |
| Create | `packages/server/src/mailbox/oauth.service.ts` (+ `.spec.ts`) |
| Create | `packages/server/src/mailbox/imap-client.port.ts` |
| Create | `packages/server/src/mailbox/imapflow-imap-client.ts` |
| Create | `packages/server/src/mailbox/harvest.service.ts` (+ `.spec.ts`) |
| Create | `packages/server/src/mailbox/mail-sync.worker.ts` (+ `.spec.ts`) |
| Create | `packages/server/src/mailbox/mailbox.controller.ts` |
| Create | `packages/server/src/mailbox/mailbox.module.ts` |
| Modify | `packages/server/src/admin/settings.registry.ts` — add OAuth client keys |
| Modify | `packages/server/src/app.module.ts` — import `MailboxModule` |

---

## Task 1: Migration 058 — mailbox_connector table + DB types

**Files:**
- Create: `packages/server/src/database/migrations/058_create_mailbox_connector.ts`
- Create: `packages/server/src/database/migrations/058_create_mailbox_connector.spec.ts`
- Modify: `packages/server/src/database/migrations/index.ts`
- Modify: `packages/server/src/database/types.ts`

**Interfaces:**
- Produces: `mailbox_connector` table; `MailboxConnectorTable` in the Kysely `Database` interface.

- [ ] **Step 1: Write the failing spec**

```typescript
// 058_create_mailbox_connector.spec.ts
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 058: mailbox_connector', () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
    const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
  });
  afterEach(() => db.destroy());

  it('inserts an email_sync connector with cursor defaults', async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = await db.insertInto('mailbox_connector').values({
      channel: 'email_sync', auth_mode: 'oauth', provider: 'gmail',
      host: 'imap.gmail.com', port: 993, username: 'me@gmail.com',
      secret_cipher: 'x', folder: 'INBOX', status: 'connected',
      created_at: now, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    expect(row.last_uid).toBe(0);
    expect(row.uidvalidity).toBeNull();
    expect(row.status).toBe('connected');
  });

  it('enforces a single email_push connector', async () => {
    const now = Math.floor(Date.now() / 1000);
    const base = { auth_mode: 'password' as const, provider: 'imap' as const, host: 'h', port: 993, secret_cipher: 'x', folder: 'INBOX', status: 'connected' as const, created_at: now, updated_at: now };
    await db.insertInto('mailbox_connector').values({ ...base, channel: 'email_push', username: 'a@x' }).execute();
    await expect(
      db.insertInto('mailbox_connector').values({ ...base, channel: 'email_push', username: 'b@x' }).execute(),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run spec — verify it fails**

Run: `npx jest 058_create_mailbox_connector.spec --no-coverage`
Expected: FAIL — table `mailbox_connector` does not exist.

- [ ] **Step 3: Write the migration**

```typescript
// 058_create_mailbox_connector.ts
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE mailbox_connector (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL CHECK (channel IN ('email_sync', 'email_push')),
      auth_mode TEXT NOT NULL CHECK (auth_mode IN ('password', 'oauth')),
      provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook', 'imap')),
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      secret_cipher TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'INBOX',
      uidvalidity INTEGER,
      last_uid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'connected'
        CHECK (status IN ('connected', 'auth_failed', 'disconnected', 'error')),
      last_synced_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `.execute(db);
  // email_push is singleton; email_sync may be many.
  await sql`
    CREATE UNIQUE INDEX idx_mailbox_connector_single_push
      ON mailbox_connector (channel) WHERE channel = 'email_push'
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TABLE mailbox_connector`.execute(db);
}
```

- [ ] **Step 4: Register in index.ts**

In `packages/server/src/database/migrations/index.ts`: add `import * as m058 from './058_create_mailbox_connector';` with the others, and `'058_create_mailbox_connector': m058,` in the `migrations` object (after `'057_seed_claimant_payable_account': m057,`).

- [ ] **Step 5: Add DB types**

In `packages/server/src/database/types.ts`, add to the `Database` interface `mailbox_connector: MailboxConnectorTable;` and define:

```typescript
export interface MailboxConnectorTable {
  id: Generated<number>;
  channel: 'email_sync' | 'email_push';
  auth_mode: 'password' | 'oauth';
  provider: 'gmail' | 'outlook' | 'imap';
  host: string;
  port: number;
  username: string;
  secret_cipher: string;          // AES-256-GCM, base64 "iv:tag:ciphertext"
  folder: Generated<string>;      // default 'INBOX'
  uidvalidity: number | null;
  last_uid: Generated<number>;    // default 0
  status: Generated<'connected' | 'auth_failed' | 'disconnected' | 'error'>;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
```

- [ ] **Step 6: Run spec — verify it passes**

Run: `npx jest 058_create_mailbox_connector.spec --no-coverage`
Expected: PASS (2 tests).

- [ ] **Step 7: Run full suite & commit**

Run: `npm test -- --no-coverage` (expect no regressions).
```bash
git add packages/server/src/database/migrations/058_create_mailbox_connector.ts \
        packages/server/src/database/migrations/058_create_mailbox_connector.spec.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/database/types.ts
git commit -m "feat(mailbox): migration 058 — mailbox_connector table + types"
```

---

## Task 2: Migration 059 — widen document_source.channel + Channel type

**Files:**
- Create: `packages/server/src/database/migrations/059_widen_document_source_channel.ts` (+ `.spec.ts`)
- Modify: `packages/server/src/database/migrations/index.ts`
- Modify: `packages/server/src/documents/types.ts` — extend `Channel`

**Interfaces:**
- Produces: `document_source.channel` CHECK accepts `'email_sync' | 'email_push'`; the `Channel` TS union includes them so `upload({ channel: 'email_sync' })` typechecks.

- [ ] **Step 1: Write the failing spec**

```typescript
// 059_widen_document_source_channel.spec.ts
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 059: widen document_source.channel', () => {
  it('accepts email_sync and email_push channels', async () => {
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
    const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
    const now = Math.floor(Date.now() / 1000);
    const doc = await db.insertInto('document').values({
      hash: 'h1', filename: 'f.pdf', mime_type: 'application/pdf', size_bytes: 1, storage_path: null, status: 'pending', created_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    for (const channel of ['email_sync', 'email_push'] as const) {
      await db.insertInto('document_source').values({
        document_id: doc.id, channel, source_identifier: 'msg-1', received_at: now,
      }).execute();
    }
    const rows = await db.selectFrom('document_source').selectAll().where('document_id', '=', doc.id).execute();
    expect(rows.map((r) => r.channel).sort()).toEqual(['email_push', 'email_sync']);
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run spec — verify it fails**

Run: `npx jest 059_widen_document_source_channel.spec --no-coverage`
Expected: FAIL — CHECK constraint rejects `email_sync`.

- [ ] **Step 3: Write the migration**

First open `packages/server/src/database/migrations/052_add_document_source_ios_metadata.ts` to copy the exact current column list of `document_source` (it last rebuilt that table). Use that column list verbatim in the rebuild below; the only change is the widened `channel` CHECK.

```typescript
// 059_widen_document_source_channel.ts
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

// Columns as of migration 052 (verify against 052 before running).
const COLS = `id, document_id, channel, source_identifier, received_at, captured_at, precheck_json`;

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE document_source_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN (
        'upload', 'telegram', 'email', 'drive', 'ios_photo_library',
        'email_sync', 'email_push'
      )),
      source_identifier TEXT,
      received_at INTEGER NOT NULL,
      captured_at INTEGER,
      precheck_json TEXT
    )
  `.execute(db);
  await sql`INSERT INTO document_source_new (${sql.raw(COLS)}) SELECT ${sql.raw(COLS)} FROM document_source`.execute(db);
  await sql`DROP TABLE document_source`.execute(db);
  await sql`ALTER TABLE document_source_new RENAME TO document_source`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE document_source_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('upload', 'telegram', 'email', 'drive', 'ios_photo_library')),
      source_identifier TEXT,
      received_at INTEGER NOT NULL,
      captured_at INTEGER,
      precheck_json TEXT
    )
  `.execute(db);
  await sql`INSERT INTO document_source_new (${sql.raw(COLS)}) SELECT ${sql.raw(COLS)} FROM document_source WHERE channel IN ('upload','telegram','email','drive','ios_photo_library')`.execute(db);
  await sql`DROP TABLE document_source`.execute(db);
  await sql`ALTER TABLE document_source_new RENAME TO document_source`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
```

- [ ] **Step 4: Register in index.ts** (`'059_widen_document_source_channel': m059,`).

- [ ] **Step 5: Extend the `Channel` type**

In `packages/server/src/documents/types.ts`, find the `Channel` union and add the two values:

```typescript
export type Channel =
  | 'upload' | 'telegram' | 'email' | 'drive' | 'ios_photo_library'
  | 'email_sync' | 'email_push';
```

- [ ] **Step 6: Run spec & full suite, commit**

Run: `npx jest 059_widen_document_source_channel.spec --no-coverage` (PASS), then `npm test -- --no-coverage`.
```bash
git add packages/server/src/database/migrations/059_widen_document_source_channel.ts \
        packages/server/src/database/migrations/059_widen_document_source_channel.spec.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/documents/types.ts
git commit -m "feat(mailbox): migration 059 — widen document_source.channel for email_sync/email_push"
```

---

## Task 3: Secret cipher (AES-256-GCM at rest)

**Files:**
- Create: `packages/server/src/mailbox/secret-cipher.ts`
- Create: `packages/server/src/mailbox/secret-cipher.spec.ts`

**Interfaces:**
- Produces: `encryptSecret(plain: string, keyHex: string): string` and `decryptSecret(cipher: string, keyHex: string): string`. Format: base64url `iv.tag.ciphertext` joined by `.`.

- [ ] **Step 1: Write the failing test**

```typescript
// secret-cipher.spec.ts
import { encryptSecret, decryptSecret } from './secret-cipher';

const KEY = '0'.repeat(64); // 32 bytes hex

describe('secret-cipher', () => {
  it('round-trips a secret', () => {
    const c = encryptSecret('hunter2-refresh-token', KEY);
    expect(c).not.toContain('hunter2');
    expect(decryptSecret(c, KEY)).toBe('hunter2-refresh-token');
  });

  it('produces a fresh IV each call (ciphertext differs)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('throws on a tampered ciphertext', () => {
    const c = encryptSecret('x', KEY);
    const tampered = c.slice(0, -2) + (c.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('throws on a wrong-length key', () => {
    expect(() => encryptSecret('x', 'abcd')).toThrow(/32-byte/);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx jest secret-cipher.spec --no-coverage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// secret-cipher.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function keyBuf(keyHex: string): Buffer {
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== 32) throw new Error('MAILBOX_SECRET_KEY must be a 32-byte hex string (64 hex chars)');
  return buf;
}

export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(cipher: string, keyHex: string): string {
  const [ivB, tagB, ctB] = cipher.split('.');
  if (!ivB || !tagB || !ctB) throw new Error('malformed cipher');
  const decipher = createDecipheriv('aes-256-gcm', keyBuf(keyHex), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run test — verify it passes** (`npx jest secret-cipher.spec --no-coverage`, expect PASS, 4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mailbox/secret-cipher.ts packages/server/src/mailbox/secret-cipher.spec.ts
git commit -m "feat(mailbox): AES-256-GCM secret cipher for connector credentials"
```

---

## Task 4: Attachment filter (candidate gate + hygiene)

**Files:**
- Create: `packages/server/src/mailbox/types.ts`
- Create: `packages/server/src/mailbox/attachment-filter.ts`
- Create: `packages/server/src/mailbox/attachment-filter.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ParsedAttachment` type and `isHarvestable(att: ParsedAttachment): boolean` — true only for a real document-like attachment (PDF or image), excluding inline/cid parts, logos/tiny images (< 20 KB), and non-document MIME (`.ics`, `.vcf`, calendar, etc.). Per the email-intake spec: attachment is mandatory; invoice-mention is a soft signal handled later (not here).

- [ ] **Step 1: Define types**

```typescript
// types.ts
export type MailboxChannel = 'email_sync' | 'email_push';

export interface ParsedAttachment {
  filename: string;
  contentType: string;          // MIME, lower-case
  size: number;                 // bytes
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;     // set for cid: inline parts
  content: Buffer;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// attachment-filter.spec.ts
import { isHarvestable } from './attachment-filter';
import { ParsedAttachment } from './types';

const base: ParsedAttachment = {
  filename: 'invoice.pdf', contentType: 'application/pdf', size: 50_000,
  disposition: 'attachment', contentId: null, content: Buffer.alloc(50_000),
};

describe('isHarvestable', () => {
  it('accepts a real PDF attachment', () => {
    expect(isHarvestable(base)).toBe(true);
  });
  it('accepts a real photo attachment', () => {
    expect(isHarvestable({ ...base, filename: 'receipt.jpg', contentType: 'image/jpeg' })).toBe(true);
  });
  it('rejects an inline cid image (email signature/logo)', () => {
    expect(isHarvestable({ ...base, filename: 'logo.png', contentType: 'image/png', disposition: 'inline', contentId: '<logo@x>' })).toBe(false);
  });
  it('rejects a tiny image (< 20 KB)', () => {
    expect(isHarvestable({ ...base, filename: 'sig.png', contentType: 'image/png', size: 4_000, content: Buffer.alloc(4_000) })).toBe(false);
  });
  it('rejects a calendar invite', () => {
    expect(isHarvestable({ ...base, filename: 'meeting.ics', contentType: 'text/calendar' })).toBe(false);
  });
  it('rejects a vcard', () => {
    expect(isHarvestable({ ...base, filename: 'card.vcf', contentType: 'text/vcard' })).toBe(false);
  });
  it('keeps a large PDF even if disposition header is missing', () => {
    expect(isHarvestable({ ...base, disposition: null })).toBe(true);
  });
});
```

- [ ] **Step 3: Run test — verify it fails** (`npx jest attachment-filter.spec --no-coverage`).

- [ ] **Step 4: Implement**

```typescript
// attachment-filter.ts
import { ParsedAttachment } from './types';

const DOC_MIME = /^(application\/pdf|image\/(jpeg|png|heic|heif|tiff|webp))$/;
const MIN_IMAGE_BYTES = 20_000; // drop logos / signatures / tiny images

export function isHarvestable(att: ParsedAttachment): boolean {
  const mime = att.contentType.toLowerCase();
  if (!DOC_MIME.test(mime)) return false;        // only PDFs and photos
  if (att.disposition === 'inline' || att.contentId) return false; // cid logos/signatures
  if (mime.startsWith('image/') && att.size < MIN_IMAGE_BYTES) return false; // tiny image
  return true;
}
```

- [ ] **Step 5: Run test — verify it passes** (7 tests), then commit.

```bash
git add packages/server/src/mailbox/types.ts packages/server/src/mailbox/attachment-filter.ts packages/server/src/mailbox/attachment-filter.spec.ts
git commit -m "feat(mailbox): attachment candidate-gate + hygiene filter"
```

---

## Task 5: MailboxConnectorService (CRUD, cursor, status)

**Files:**
- Create: `packages/server/src/mailbox/mailbox-connector.service.ts`
- Create: `packages/server/src/mailbox/mailbox-connector.service.spec.ts`

**Interfaces:**
- Consumes: `MailboxConnectorTable` (Task 1), `encryptSecret`/`decryptSecret` (Task 3), `KYSELY_MODULE_CONNECTION_TOKEN()`.
- Produces:
  - `create(input: CreateConnectorInput): Promise<MailboxConnector>` — encrypts `secret`, inserts; throws on a second `email_push`.
  - `list(): Promise<MailboxConnector[]>` (secret never returned).
  - `remove(id: number): Promise<void>`.
  - `getDecryptedSecret(id: number): Promise<string>`.
  - `advanceCursor(id: number, uidvalidity: number, lastUid: number): Promise<void>`.
  - `markStatus(id: number, status: ConnectorStatus, error?: string | null): Promise<void>`.
  - Types `MailboxConnector` (no secret), `CreateConnectorInput`, `ConnectorStatus`.

- [ ] **Step 1: Write the failing test**

```typescript
// mailbox-connector.service.spec.ts
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Test } from '@nestjs/testing';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { KYSELY_MODULE_CONNECTION_TOKEN } from '../database/kysely.tokens';
import { MailboxConnectorService } from './mailbox-connector.service';

const KEY = '0'.repeat(64);

describe('MailboxConnectorService', () => {
  let db: Kysely<Database>;
  let service: MailboxConnectorService;

  beforeEach(async () => {
    process.env.MAILBOX_SECRET_KEY = KEY;
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
    const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db }, MailboxConnectorService],
    }).compile();
    service = moduleRef.get(MailboxConnectorService);
  });
  afterEach(() => db.destroy());

  const input = {
    channel: 'email_sync' as const, authMode: 'password' as const, provider: 'imap' as const,
    host: 'imap.x', port: 993, username: 'me@x', secret: 'app-pass', folder: 'INBOX',
  };

  it('creates a connector and never returns the secret', async () => {
    const c = await service.create(input);
    expect(c).not.toHaveProperty('secret_cipher');
    expect(c).not.toHaveProperty('secret');
    expect(await service.getDecryptedSecret(c.id)).toBe('app-pass');
  });

  it('rejects a second email_push connector', async () => {
    await service.create({ ...input, channel: 'email_push' });
    await expect(service.create({ ...input, channel: 'email_push', username: 'b@x' })).rejects.toThrow();
  });

  it('advances the cursor and marks status', async () => {
    const c = await service.create(input);
    await service.advanceCursor(c.id, 42, 17);
    await service.markStatus(c.id, 'auth_failed', 'token revoked');
    const [row] = await service.list();
    expect(row.uidvalidity).toBe(42);
    expect(row.last_uid).toBe(17);
    expect(row.status).toBe('auth_failed');
    expect(row.last_error).toBe('token revoked');
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// mailbox-connector.service.ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { KYSELY_MODULE_CONNECTION_TOKEN } from '../database/kysely.tokens';
import { decryptSecret, encryptSecret } from './secret-cipher';
import { MailboxChannel } from './types';

export type ConnectorStatus = 'connected' | 'auth_failed' | 'disconnected' | 'error';
export type AuthMode = 'password' | 'oauth';
export type Provider = 'gmail' | 'outlook' | 'imap';

export interface CreateConnectorInput {
  channel: MailboxChannel;
  authMode: AuthMode;
  provider: Provider;
  host: string;
  port: number;
  username: string;
  secret: string;          // plaintext password or OAuth refresh-token; encrypted here
  folder?: string;
}

export interface MailboxConnector {
  id: number;
  channel: MailboxChannel;
  auth_mode: AuthMode;
  provider: Provider;
  host: string;
  port: number;
  username: string;
  folder: string;
  uidvalidity: number | null;
  last_uid: number;
  status: ConnectorStatus;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function key(): string {
  const k = process.env.MAILBOX_SECRET_KEY;
  if (!k) throw new Error('MAILBOX_SECRET_KEY is not set');
  return k;
}
const now = () => Math.floor(Date.now() / 1000);
const PUBLIC = [
  'id', 'channel', 'auth_mode', 'provider', 'host', 'port', 'username', 'folder',
  'uidvalidity', 'last_uid', 'status', 'last_synced_at', 'last_error', 'created_at', 'updated_at',
] as const;

@Injectable()
export class MailboxConnectorService {
  constructor(@Inject(KYSELY_MODULE_CONNECTION_TOKEN()) private readonly db: Kysely<Database>) {}

  async create(input: CreateConnectorInput): Promise<MailboxConnector> {
    const ts = now();
    const row = await this.db.insertInto('mailbox_connector').values({
      channel: input.channel, auth_mode: input.authMode, provider: input.provider,
      host: input.host, port: input.port, username: input.username,
      secret_cipher: encryptSecret(input.secret, key()),
      folder: input.folder ?? 'INBOX', status: 'connected', created_at: ts, updated_at: ts,
    }).returning(PUBLIC).executeTakeFirstOrThrow();
    return row as MailboxConnector;
  }

  async list(): Promise<MailboxConnector[]> {
    return (await this.db.selectFrom('mailbox_connector').select(PUBLIC).orderBy('id').execute()) as MailboxConnector[];
  }

  async remove(id: number): Promise<void> {
    await this.db.deleteFrom('mailbox_connector').where('id', '=', id).execute();
  }

  async getDecryptedSecret(id: number): Promise<string> {
    const row = await this.db.selectFrom('mailbox_connector').select('secret_cipher').where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException(`Connector ${id} not found`);
    return decryptSecret(row.secret_cipher, key());
  }

  async advanceCursor(id: number, uidvalidity: number, lastUid: number): Promise<void> {
    await this.db.updateTable('mailbox_connector')
      .set({ uidvalidity, last_uid: lastUid, last_synced_at: now(), status: 'connected', last_error: null, updated_at: now() })
      .where('id', '=', id).execute();
  }

  async markStatus(id: number, status: ConnectorStatus, error: string | null = null): Promise<void> {
    await this.db.updateTable('mailbox_connector')
      .set({ status, last_error: error, updated_at: now() })
      .where('id', '=', id).execute();
  }
}
```

Note: confirm the kysely connection token import path by grepping `KYSELY_MODULE_CONNECTION_TOKEN` in the repo; use whatever path `organization.service.ts` uses.

- [ ] **Step 4: Run test — verify it passes** (3 tests), full suite, commit.

```bash
git add packages/server/src/mailbox/mailbox-connector.service.ts packages/server/src/mailbox/mailbox-connector.service.spec.ts
git commit -m "feat(mailbox): MailboxConnectorService — CRUD, encrypted secret, cursor, status"
```

---

## Task 6: OAuth service (BYO app — authURL, exchange, refresh)

**Files:**
- Modify: `packages/server/src/admin/settings.registry.ts`
- Create: `packages/server/src/mailbox/oauth.service.ts`
- Create: `packages/server/src/mailbox/oauth.service.spec.ts`

**Interfaces:**
- Consumes: `SettingsService` (read `google_oauth_client_id`/`secret`, `microsoft_oauth_client_id`/`secret`, `public_api_url`), global `fetch`.
- Produces:
  - `authUrl(provider: 'gmail' | 'outlook', state: string): Promise<string>`.
  - `exchangeCode(provider, code: string): Promise<{ refreshToken: string }>`.
  - `accessToken(provider, refreshToken: string): Promise<string>` — exchanges refresh-token for a short-lived access token (used as the XOAUTH2 credential).

- [ ] **Step 1: Add OAuth settings keys**

In `packages/server/src/admin/settings.registry.ts`, inside `KNOWN_SETTINGS`, add (using the existing `nonEmpty` validator):

```typescript
google_oauth_client_id: { description: 'BYO Google OAuth client id for Gmail mailbox connectors', validate: nonEmpty },
google_oauth_client_secret: { description: 'BYO Google OAuth client secret', validate: nonEmpty },
microsoft_oauth_client_id: { description: 'BYO Microsoft OAuth client id for Outlook mailbox connectors', validate: nonEmpty },
microsoft_oauth_client_secret: { description: 'BYO Microsoft OAuth client secret', validate: nonEmpty },
```

- [ ] **Step 2: Write the failing test** (mock `fetch`)

```typescript
// oauth.service.spec.ts
import { OAuthService } from './oauth.service';

const settings = {
  get: jest.fn(async (k: string) => ({
    google_oauth_client_id: 'cid', google_oauth_client_secret: 'csec', public_api_url: 'https://app.example',
  } as Record<string, string>)[k] ?? null),
} as any;

describe('OAuthService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds a Gmail read-only consent URL with the callback redirect', async () => {
    const url = await new OAuthService(settings).authUrl('gmail', 'state123');
    expect(url).toContain('accounts.google.com');
    expect(url).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example%2Fapi%2Fmailbox%2Foauth%2Fcallback');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('state=state123');
  });

  it('exchanges an auth code for a refresh token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ refresh_token: 'rt-1' }) } as any);
    const { refreshToken } = await new OAuthService(settings).exchangeCode('gmail', 'authcode');
    expect(refreshToken).toBe('rt-1');
  });

  it('mints an access token from a refresh token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at-1' }) } as any);
    const at = await new OAuthService(settings).accessToken('gmail', 'rt-1');
    expect(at).toBe('at-1');
  });

  it('throws when the client id is not configured', async () => {
    const empty = { get: jest.fn(async () => null) } as any;
    await expect(new OAuthService(empty).authUrl('gmail', 's')).rejects.toThrow(/client id/i);
  });
});
```

- [ ] **Step 3: Run test — verify it fails.**

- [ ] **Step 4: Implement**

```typescript
// oauth.service.ts
import { Injectable } from '@nestjs/common';
import { SettingsService } from '../admin/settings.service';

type Prov = 'gmail' | 'outlook';

const CFG = {
  gmail: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    idKey: 'google_oauth_client_id', secretKey: 'google_oauth_client_secret',
  },
  outlook: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'https://outlook.office365.com/IMAP.AccessAsUser.All offline_access',
    idKey: 'microsoft_oauth_client_id', secretKey: 'microsoft_oauth_client_secret',
  },
} as const;

@Injectable()
export class OAuthService {
  constructor(private readonly settings: SettingsService) {}

  private async cfg(provider: Prov) {
    const c = CFG[provider];
    const clientId = await this.settings.get(c.idKey);
    const clientSecret = await this.settings.get(c.secretKey);
    if (!clientId) throw new Error(`OAuth client id for ${provider} is not configured`);
    const base = (await this.settings.get('public_api_url')) ?? '';
    return { ...c, clientId, clientSecret: clientSecret ?? '', redirect: `${base}/api/mailbox/oauth/callback` };
  }

  async authUrl(provider: Prov, state: string): Promise<string> {
    const c = await this.cfg(provider);
    const p = new URLSearchParams({
      client_id: c.clientId, redirect_uri: c.redirect, response_type: 'code',
      scope: c.scope, access_type: 'offline', prompt: 'consent', state,
    });
    return `${c.auth}?${p.toString()}`;
  }

  async exchangeCode(provider: Prov, code: string): Promise<{ refreshToken: string }> {
    const c = await this.cfg(provider);
    const res = await fetch(c.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirect, grant_type: 'authorization_code' }),
    });
    if (!res.ok) throw new Error(`OAuth code exchange failed: ${res.status}`);
    const j = (await res.json()) as { refresh_token?: string };
    if (!j.refresh_token) throw new Error('OAuth response missing refresh_token');
    return { refreshToken: j.refresh_token };
  }

  async accessToken(provider: Prov, refreshToken: string): Promise<string> {
    const c = await this.cfg(provider);
    const res = await fetch(c.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' }),
    });
    if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status}`);
    const j = (await res.json()) as { access_token?: string };
    if (!j.access_token) throw new Error('OAuth response missing access_token');
    return j.access_token;
  }
}
```

- [ ] **Step 5: Run test (4) — PASS, then full suite, commit.**

```bash
git add packages/server/src/admin/settings.registry.ts packages/server/src/mailbox/oauth.service.ts packages/server/src/mailbox/oauth.service.spec.ts
git commit -m "feat(mailbox): BYO OAuth service (Gmail/Outlook read-only) + settings keys"
```

---

## Task 7: IMAP client port + imapflow implementation

**Files:**
- Create: `packages/server/src/mailbox/imap-client.port.ts`
- Create: `packages/server/src/mailbox/imapflow-imap-client.ts`

**Interfaces:**
- Consumes: `imapflow`, `mailparser`, `ParsedAttachment` (Task 4).
- Produces: abstract `ImapClient` with:
  - `fetchSince(conn: ImapConnectionConfig, folder: string, sinceUid: number): Promise<{ uidvalidity: number; messages: FetchedMessage[] }>` — returns messages with UID > `sinceUid`, each parsed into subject/body-text + attachments.
  - `idle(conn, folder, onNew: () => void): Promise<IdleHandle>` — opens a live IDLE connection; calls `onNew` on each new-mail signal; `IdleHandle.close()` stops it.
  - `FetchedMessage` type `{ uid, subject, bodyText, attachments: ParsedAttachment[] }`, `ImapConnectionConfig`, `IdleHandle`.

This task introduces the dependency boundary. The port has **no I/O in tests**; the worker (Task 9) is tested against a fake `ImapClient`. The imapflow impl below is not unit-tested (it is the live edge), matching the Telegram transport-port convention.

- [ ] **Step 1: Define the port**

```typescript
// imap-client.port.ts
import { ParsedAttachment } from './types';

export interface ImapConnectionConfig {
  host: string;
  port: number;
  username: string;
  // exactly one is set:
  password?: string;
  accessToken?: string; // XOAUTH2
}

export interface FetchedMessage {
  uid: number;
  subject: string;
  bodyText: string;
  attachments: ParsedAttachment[];
}

export interface IdleHandle {
  close(): Promise<void>;
}

export abstract class ImapClient {
  abstract fetchSince(
    conn: ImapConnectionConfig,
    folder: string,
    sinceUid: number,
  ): Promise<{ uidvalidity: number; messages: FetchedMessage[] }>;

  abstract idle(conn: ImapConnectionConfig, folder: string, onNew: () => void): Promise<IdleHandle>;
}
```

- [ ] **Step 2: Install deps**

Run: `npm install imapflow mailparser` and `npm install -D @types/mailparser` (from `packages/server` or repo root per the workspace layout — check where other deps are declared).

- [ ] **Step 3: Implement the imapflow client**

```typescript
// imapflow-imap-client.ts
import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ImapClient, ImapConnectionConfig, FetchedMessage, IdleHandle } from './imap-client.port';
import { ParsedAttachment } from './types';

function client(conn: ImapConnectionConfig): ImapFlow {
  const auth = conn.accessToken
    ? { user: conn.username, accessToken: conn.accessToken }
    : { user: conn.username, pass: conn.password! };
  return new ImapFlow({ host: conn.host, port: conn.port, secure: true, auth, logger: false });
}

async function parseAttachments(source: Buffer): Promise<{ subject: string; bodyText: string; attachments: ParsedAttachment[] }> {
  const mail = await simpleParser(source);
  const attachments: ParsedAttachment[] = (mail.attachments ?? []).map((a) => ({
    filename: a.filename ?? 'unnamed',
    contentType: (a.contentType ?? 'application/octet-stream').toLowerCase(),
    size: a.size ?? a.content.length,
    disposition: (a.contentDisposition as 'attachment' | 'inline' | undefined) ?? null,
    contentId: a.contentId ?? (a.cid ? `<${a.cid}>` : null),
    content: a.content,
  }));
  return { subject: mail.subject ?? '', bodyText: mail.text ?? '', attachments };
}

@Injectable()
export class ImapflowImapClient extends ImapClient {
  async fetchSince(conn: ImapConnectionConfig, folder: string, sinceUid: number) {
    const c = client(conn);
    await c.connect();
    try {
      const lock = await c.getMailboxLock(folder);
      try {
        const uidvalidity = Number((c.mailbox as { uidValidity: bigint }).uidValidity);
        const messages: FetchedMessage[] = [];
        // UID range strictly greater than the cursor.
        for await (const msg of c.fetch({ uid: `${sinceUid + 1}:*` }, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= sinceUid) continue; // '*' can echo the last message; guard it
          const parsed = await parseAttachments(msg.source as Buffer);
          messages.push({ uid: msg.uid, ...parsed });
        }
        return { uidvalidity, messages };
      } finally {
        lock.release();
      }
    } finally {
      await c.logout();
    }
  }

  async idle(conn: ImapConnectionConfig, folder: string, onNew: () => void): Promise<IdleHandle> {
    const c = client(conn);
    await c.connect();
    await c.mailboxOpen(folder);
    c.on('exists', () => onNew());
    // imapflow auto-renews IDLE; kick once.
    void c.idle();
    return { close: async () => { try { await c.logout(); } catch { /* already closed */ } } };
  }
}
```

- [ ] **Step 4: Typecheck & commit**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json` (or the repo's typecheck script) — expect no errors. No unit test for the live client (port convention).

```bash
git add packages/server/src/mailbox/imap-client.port.ts packages/server/src/mailbox/imapflow-imap-client.ts package.json package-lock.json
git commit -m "feat(mailbox): IMAP client port + imapflow implementation (IDLE + XOAUTH2)"
```

---

## Task 8: HarvestService (message → filter → upload → kick)

**Files:**
- Create: `packages/server/src/mailbox/harvest.service.ts`
- Create: `packages/server/src/mailbox/harvest.service.spec.ts`

**Interfaces:**
- Consumes: `DocumentsService.upload(input: UploadDocumentInput): Promise<{ document; deduplicated }>` (existing), `IntakeQueueWorker.kick(): Promise<void>` (existing), `isHarvestable` (Task 4), `FetchedMessage` (Task 7).
- Produces: `harvestMessage(channel: MailboxChannel, msg: FetchedMessage): Promise<number>` — uploads each harvestable attachment (mandatory attachment gate; per the email-intake spec invoice-mention is a *soft* signal, not a gate here), kicks the queue once if anything was enqueued, and returns the count harvested. Idempotent via the existing SHA-256 dedup in `upload()`.

- [ ] **Step 1: Write the failing test**

```typescript
// harvest.service.spec.ts
import { HarvestService } from './harvest.service';
import { FetchedMessage } from './imap-client.port';

const pdf = (name: string, size = 50_000) => ({
  filename: name, contentType: 'application/pdf', size, disposition: 'attachment' as const, contentId: null, content: Buffer.alloc(size),
});

describe('HarvestService', () => {
  let documents: { upload: jest.Mock };
  let queue: { kick: jest.Mock };
  let service: HarvestService;

  beforeEach(() => {
    documents = { upload: jest.fn().mockResolvedValue({ document: { id: 1 }, deduplicated: false }) };
    queue = { kick: jest.fn().mockResolvedValue(undefined) };
    service = new HarvestService(documents as any, queue as any);
  });

  it('uploads each harvestable attachment with the connector channel and kicks once', async () => {
    const msg: FetchedMessage = { uid: 5, subject: 'Invoice 7', bodyText: 'see attached',
      attachments: [pdf('invoice.pdf'), pdf('terms.pdf')] };
    const n = await service.harvestMessage('email_sync', msg);
    expect(n).toBe(2);
    expect(documents.upload).toHaveBeenCalledTimes(2);
    expect(documents.upload.mock.calls[0][0]).toMatchObject({ channel: 'email_sync', filename: 'invoice.pdf', sourceIdentifier: 'uid:5' });
    expect(queue.kick).toHaveBeenCalledTimes(1);
  });

  it('skips non-harvestable attachments and does not kick when nothing harvested', async () => {
    const msg: FetchedMessage = { uid: 6, subject: 'hi', bodyText: 'logo only',
      attachments: [{ filename: 'logo.png', contentType: 'image/png', size: 2000, disposition: 'inline', contentId: '<l>', content: Buffer.alloc(2000) }] };
    const n = await service.harvestMessage('email_sync', msg);
    expect(n).toBe(0);
    expect(documents.upload).not.toHaveBeenCalled();
    expect(queue.kick).not.toHaveBeenCalled();
  });

  it('still kicks once even when uploads dedup (deduplicated=true)', async () => {
    documents.upload.mockResolvedValue({ document: { id: 1 }, deduplicated: true });
    const msg: FetchedMessage = { uid: 7, subject: 'dup', bodyText: '', attachments: [pdf('invoice.pdf')] };
    const n = await service.harvestMessage('email_push', msg);
    expect(n).toBe(1);
    expect(queue.kick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// harvest.service.ts
import { Injectable } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { IntakeQueueWorker } from '../intake-queue/intake-queue.worker';
import { isHarvestable } from './attachment-filter';
import { MailboxChannel } from './types';
import { FetchedMessage } from './imap-client.port';

@Injectable()
export class HarvestService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly queue: IntakeQueueWorker,
  ) {}

  async harvestMessage(channel: MailboxChannel, msg: FetchedMessage): Promise<number> {
    let harvested = 0;
    for (const att of msg.attachments) {
      if (!isHarvestable(att)) continue;
      await this.documents.upload({
        buffer: att.content,
        filename: att.filename,
        mimeType: att.contentType,
        channel,
        sourceIdentifier: `uid:${msg.uid}`,
      });
      harvested += 1;
    }
    if (harvested > 0) {
      // upload() does NOT auto-enqueue (verified against merged main); kick the
      // serialized queue so OCR/triage starts promptly instead of at the next sweep.
      await this.queue.kick();
    }
    return harvested;
  }
}
```

- [ ] **Step 4: Run test (3) — PASS, full suite, commit.**

```bash
git add packages/server/src/mailbox/harvest.service.ts packages/server/src/mailbox/harvest.service.spec.ts
git commit -m "feat(mailbox): HarvestService — filter attachments, upload into intake, kick queue"
```

---

## Task 9: MailSyncWorker (cursor catch-up + IDLE + reconnect + sweep)

**Files:**
- Create: `packages/server/src/mailbox/mail-sync.worker.ts`
- Create: `packages/server/src/mailbox/mail-sync.worker.spec.ts`

**Interfaces:**
- Consumes: `MailboxConnectorService` (Task 5), `OAuthService` (Task 6), `ImapClient` (Task 7), `HarvestService` (Task 8).
- Produces:
  - `syncOnce(connectorId: number): Promise<void>` — builds the connection (password or fresh OAuth access token), `fetchSince(cursor)`, harvests each message in UID order, advances the cursor to the max UID, marks status; on `uidvalidity` change re-baselines the cursor to the new max UID **without** harvesting history (going-forward). On auth error → `markStatus('auth_failed', …)`. This is the unit-tested core.
  - `@Cron` safety sweep calling `syncOnce` for every connector.
  - `onModuleInit` opens IDLE per connector (best-effort; the live edge is not unit-tested).

- [ ] **Step 1: Write the failing test (fake ImapClient, in-memory DB)**

```typescript
// mail-sync.worker.spec.ts
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { KYSELY_MODULE_CONNECTION_TOKEN } from '../database/kysely.tokens';
import { Test } from '@nestjs/testing';
import { MailboxConnectorService } from './mailbox-connector.service';
import { MailSyncWorker } from './mail-sync.worker';
import { ImapClient } from './imap-client.port';

const KEY = '0'.repeat(64);

describe('MailSyncWorker.syncOnce', () => {
  let db: Kysely<Database>;
  let connectors: MailboxConnectorService;
  let worker: MailSyncWorker;
  let imap: { fetchSince: jest.Mock; idle: jest.Mock };
  let harvested: number[];

  beforeEach(async () => {
    process.env.MAILBOX_SECRET_KEY = KEY;
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
    const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    harvested = [];
    imap = { fetchSince: jest.fn(), idle: jest.fn() };
    const harvest = { harvestMessage: jest.fn(async (_ch: string, m: { uid: number }) => { harvested.push(m.uid); return 1; }) };
    const oauth = { accessToken: jest.fn(async () => 'at') };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        MailboxConnectorService,
        { provide: ImapClient, useValue: imap },
        { provide: 'HARVEST', useValue: harvest },
        { provide: 'OAUTH', useValue: oauth },
        MailSyncWorker,
      ],
    }).compile();
    connectors = moduleRef.get(MailboxConnectorService);
    worker = moduleRef.get(MailSyncWorker);
  });
  afterEach(() => db.destroy());

  const mk = () => connectors.create({ channel: 'email_sync', authMode: 'password', provider: 'imap', host: 'h', port: 993, username: 'u', secret: 'p' });

  it('harvests new messages in order and advances the cursor', async () => {
    const c = await mk();
    imap.fetchSince.mockResolvedValue({ uidvalidity: 100, messages: [{ uid: 4, subject: '', bodyText: '', attachments: [] }, { uid: 5, subject: '', bodyText: '', attachments: [] }] });
    await worker.syncOnce(c.id);
    expect(harvested).toEqual([4, 5]);
    const [row] = await connectors.list();
    expect(row.uidvalidity).toBe(100);
    expect(row.last_uid).toBe(5);
    expect(row.status).toBe('connected');
  });

  it('re-baselines (no harvest) when uidvalidity changes', async () => {
    const c = await mk();
    await connectors.advanceCursor(c.id, 100, 5);
    imap.fetchSince.mockResolvedValue({ uidvalidity: 999, messages: [{ uid: 1, subject: '', bodyText: '', attachments: [] }] });
    await worker.syncOnce(c.id);
    expect(harvested).toEqual([]);                 // history not re-harvested
    const [row] = await connectors.list();
    expect(row.uidvalidity).toBe(999);
    expect(row.last_uid).toBe(1);                  // cursor rebased to current max
  });

  it('marks auth_failed when the transport throws an auth error', async () => {
    const c = await mk();
    imap.fetchSince.mockRejectedValue(new Error('AUTHENTICATIONFAILED bad token'));
    await worker.syncOnce(c.id);
    const [row] = await connectors.list();
    expect(row.status).toBe('auth_failed');
    expect(row.last_error).toContain('AUTHENTICATION');
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// mail-sync.worker.ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailboxConnectorService } from './mailbox-connector.service';
import { ImapClient, ImapConnectionConfig, IdleHandle } from './imap-client.port';
import { HarvestService } from './harvest.service';
import { OAuthService } from './oauth.service';

@Injectable()
export class MailSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(MailSyncWorker.name);
  private readonly idleHandles = new Map<number, IdleHandle>();
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly connectors: MailboxConnectorService,
    private readonly imap: ImapClient,
    @Inject('HARVEST') private readonly harvest: HarvestService,
    @Inject('OAUTH') private readonly oauth: OAuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Best-effort: catch-up + open IDLE per connector. Skipped cleanly under test
    // if no connectors exist. Live IDLE is the unit-untested edge.
    for (const c of await this.connectors.list()) {
      await this.syncOnce(c.id).catch((e) => this.logger.warn(`initial sync ${c.id}: ${e}`));
      await this.openIdle(c.id).catch((e) => this.logger.warn(`idle ${c.id}: ${e}`));
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep(): Promise<void> {
    for (const c of await this.connectors.list()) {
      await this.syncOnce(c.id).catch((e) => this.logger.warn(`sweep ${c.id}: ${e}`));
    }
  }

  async syncOnce(connectorId: number): Promise<void> {
    if (this.inFlight.has(connectorId)) return; // a single-flight guard per connector
    this.inFlight.add(connectorId);
    try {
      const [conn] = (await this.connectors.list()).filter((c) => c.id === connectorId);
      if (!conn) return;
      const cfg = await this.connection(connectorId);
      const { uidvalidity, messages } = await this.imap.fetchSince(cfg, conn.folder, conn.last_uid);

      if (conn.uidvalidity !== null && conn.uidvalidity !== uidvalidity) {
        // Mailbox renumbered — re-baseline forward, do NOT re-harvest history.
        const maxUid = messages.reduce((m, x) => Math.max(m, x.uid), conn.last_uid);
        await this.connectors.advanceCursor(connectorId, uidvalidity, maxUid);
        return;
      }

      let lastUid = conn.last_uid;
      for (const msg of messages.sort((a, b) => a.uid - b.uid)) {
        await this.harvest.harvestMessage(conn.channel, msg);
        lastUid = Math.max(lastUid, msg.uid);
      }
      await this.connectors.advanceCursor(connectorId, uidvalidity, lastUid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /AUTH|token|credential|login/i.test(msg) ? 'auth_failed' : 'error';
      await this.connectors.markStatus(connectorId, status, msg);
    } finally {
      this.inFlight.delete(connectorId);
    }
  }

  private async connection(connectorId: number): Promise<ImapConnectionConfig> {
    const [conn] = (await this.connectors.list()).filter((c) => c.id === connectorId);
    const secret = await this.connectors.getDecryptedSecret(connectorId);
    if (conn.auth_mode === 'oauth') {
      const provider = conn.provider === 'gmail' ? 'gmail' : 'outlook';
      const accessToken = await this.oauth.accessToken(provider, secret);
      return { host: conn.host, port: conn.port, username: conn.username, accessToken };
    }
    return { host: conn.host, port: conn.port, username: conn.username, password: secret };
  }

  private async openIdle(connectorId: number): Promise<void> {
    const [conn] = (await this.connectors.list()).filter((c) => c.id === connectorId);
    if (!conn) return;
    const existing = this.idleHandles.get(connectorId);
    if (existing) await existing.close().catch(() => undefined);
    const cfg = await this.connection(connectorId);
    const handle = await this.imap.idle(cfg, conn.folder, () => {
      void this.syncOnce(connectorId).catch((e) => this.logger.warn(`idle-sync ${connectorId}: ${e}`));
    });
    this.idleHandles.set(connectorId, handle);
  }
}
```

Note: `OAuthService` and `HarvestService` are injected by class in the real module (Task 11); the spec injects them by the `'HARVEST'`/`'OAUTH'` tokens for isolation. In the module, bind them with `{ provide: 'HARVEST', useExisting: HarvestService }` and `{ provide: 'OAUTH', useExisting: OAuthService }` so the same instances back both.

- [ ] **Step 4: Run test (3) — PASS, full suite, commit.**

```bash
git add packages/server/src/mailbox/mail-sync.worker.ts packages/server/src/mailbox/mail-sync.worker.spec.ts
git commit -m "feat(mailbox): MailSyncWorker — cursor catch-up, uidvalidity re-baseline, IDLE, cron sweep"
```

---

## Task 10: Mailbox admin controller + module wiring

**Files:**
- Create: `packages/server/src/mailbox/mailbox.controller.ts`
- Create: `packages/server/src/mailbox/mailbox.module.ts`
- Modify: `packages/server/src/app.module.ts`

**Interfaces:**
- Consumes: all services above; `DocumentsModule`, `IntakeQueueModule`, `AdminModule` (for `SettingsService`).
- Produces: HTTP API:
  - `GET /api/mailbox/connectors` → `MailboxConnector[]` (health view).
  - `POST /api/mailbox/connectors` (password mode) `{ channel, provider, host, port, username, secret, folder? }` → created connector.
  - `DELETE /api/mailbox/connectors/:id`.
  - `GET /api/mailbox/oauth/start?provider=gmail&channel=email_sync` → `{ url }` (consent URL; `state` carries channel+host).
  - `GET /api/mailbox/oauth/callback?code=…&state=…` → exchanges code, creates the OAuth connector.

- [ ] **Step 1: Write the controller**

```typescript
// mailbox.controller.ts
import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MailboxConnectorService, MailboxConnector } from './mailbox-connector.service';
import { OAuthService } from './oauth.service';

@ApiTags('mailbox')
@Controller('api/mailbox')
export class MailboxController {
  constructor(
    private readonly connectors: MailboxConnectorService,
    private readonly oauth: OAuthService,
  ) {}

  @Get('connectors')
  @ApiOperation({ summary: 'List mailbox connectors with health status' })
  list(): Promise<MailboxConnector[]> {
    return this.connectors.list();
  }

  @Post('connectors')
  @ApiOperation({ summary: 'Create an IMAP password connector' })
  create(@Body() dto: {
    channel: 'email_sync' | 'email_push'; provider: 'gmail' | 'outlook' | 'imap';
    host: string; port: number; username: string; secret: string; folder?: string;
  }): Promise<MailboxConnector> {
    return this.connectors.create({ ...dto, authMode: 'password' });
  }

  @Delete('connectors/:id')
  @ApiOperation({ summary: 'Remove a connector' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.connectors.remove(Number(id));
  }

  @Get('oauth/start')
  @ApiOperation({ summary: 'Begin BYO-OAuth consent for a mailbox connector' })
  async start(
    @Query('provider') provider: 'gmail' | 'outlook',
    @Query('channel') channel: 'email_sync' | 'email_push',
    @Query('host') host: string,
    @Query('username') username: string,
  ): Promise<{ url: string }> {
    const state = Buffer.from(JSON.stringify({ provider, channel, host, username })).toString('base64url');
    return { url: await this.oauth.authUrl(provider, state) };
  }

  @Get('oauth/callback')
  @ApiOperation({ summary: 'OAuth redirect target — exchanges the code and stores the connector' })
  async callback(@Query('code') code: string, @Query('state') state: string): Promise<MailboxConnector> {
    const s = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as {
      provider: 'gmail' | 'outlook'; channel: 'email_sync' | 'email_push'; host: string; username: string;
    };
    const { refreshToken } = await this.oauth.exchangeCode(s.provider, code);
    return this.connectors.create({
      channel: s.channel, authMode: 'oauth', provider: s.provider,
      host: s.host, port: 993, username: s.username, secret: refreshToken,
    });
  }
}
```

- [ ] **Step 2: Write the module**

```typescript
// mailbox.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsModule } from '../documents/documents.module';
import { IntakeQueueModule } from '../intake-queue/intake-queue.module';
import { AdminModule } from '../admin/admin.module';
import { MailboxConnectorService } from './mailbox-connector.service';
import { OAuthService } from './oauth.service';
import { HarvestService } from './harvest.service';
import { MailSyncWorker } from './mail-sync.worker';
import { ImapClient } from './imap-client.port';
import { ImapflowImapClient } from './imapflow-imap-client';
import { MailboxController } from './mailbox.controller';

@Module({
  imports: [DatabaseModule, DocumentsModule, IntakeQueueModule, AdminModule],
  controllers: [MailboxController],
  providers: [
    MailboxConnectorService,
    OAuthService,
    HarvestService,
    MailSyncWorker,
    { provide: ImapClient, useClass: ImapflowImapClient },
    { provide: 'HARVEST', useExisting: HarvestService },
    { provide: 'OAUTH', useExisting: OAuthService },
  ],
  exports: [MailboxConnectorService],
})
export class MailboxModule {}
```

Verify the exact module names/paths (`DatabaseModule`, `DocumentsModule`, `IntakeQueueModule`, `AdminModule`) by grepping their `@Module` declarations; `IntakeQueueModule` must `exports: [IntakeQueueWorker]` for `HarvestService` to inject it — if it does not yet, add the export in that module.

- [ ] **Step 3: Register in app.module.ts**

In `packages/server/src/app.module.ts`, add `MailboxModule` to the `imports` array (alongside the other feature modules).

- [ ] **Step 4: Run the full suite + boot check**

Run: `npm test -- --no-coverage` (no regressions), then `npx tsc --noEmit -p packages/server/tsconfig.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mailbox/mailbox.controller.ts \
        packages/server/src/mailbox/mailbox.module.ts \
        packages/server/src/app.module.ts \
        packages/server/src/intake-queue/intake-queue.module.ts
git commit -m "feat(mailbox): admin HTTP API (connectors + OAuth) and module wiring"
```

---

## Self-Review

### Spec coverage (Plan 1 scope = connector + sync + harvest)

| email-intake spec item | Task |
|---|---|
| `mailbox_connector` table (encrypted secret, cursor, status) | 1 |
| `email_sync`/`email_push` delivery channels in schema + type | 2 |
| Encrypted-at-rest secret (AES-256-GCM, env key) | 3 |
| Candidate gate: attachment mandatory, hygiene (inline/logo/tiny/non-doc) | 4 |
| Connector CRUD, cursor, health status | 5 |
| BYO OAuth (Gmail/Outlook, read-only scope), refresh→access | 6 |
| Unified IMAP transport (password + XOAUTH2) behind a port | 7 |
| Harvest → `upload()` → `kick()` (queue reuse; explicit kick per Delta A) | 8 |
| IDLE realtime + durable UID cursor + catch-up + uidvalidity re-baseline + cron sweep | 9 |
| Health view + connect/list/remove + OAuth start/callback API | 10 |
| First-connect = new-only (cursor baselined at current max UID) | 9 (re-baseline path; default cursor `last_uid=0` then advanced on first fetch) |

### Out of scope (Plan 1)

- Recipient extraction (`recipient_match`), `discarded` status, `disposition_reason`, Ingest-profile knobs, claimant-from-email resolution → **Plan 2** (`2026-06-23-email-ingest-profile-disposition.md`).
- Optional bounded **backfill** on first connect (default is new-only; backfill is a follow-up knob — set the initial cursor below current max).
- Re-IDLE timing / hourly OAuth reconnect refinements (imapflow auto-renews IDLE; the cron sweep + per-`syncOnce` fresh access-token cover correctness).
- SPA UI for connectors (separate frontend PR; the REST contract is delivered here).
- Inbound-parse webhook transport (IMAP only, per spec).

### Placeholder scan

No `TBD`/`handle errors`/"similar to" — every code step carries full code. Auth-error classification is an explicit regex in Task 9.

### Type consistency

`ParsedAttachment` (Task 4) is consumed verbatim by Tasks 7–8. `FetchedMessage`/`ImapConnectionConfig`/`ImapClient` (Task 7) are consumed by Tasks 8–9. `MailboxConnector`/`ConnectorStatus`/`CreateConnectorInput` (Task 5) are consumed by Tasks 9–10. `upload()` input matches the verified `UploadDocumentInput` (buffer/filename/mimeType/channel/sourceIdentifier). `IntakeQueueWorker.kick()` matches the merged signature.
