# Email Ingest Profile & Recipient Disposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make intake disposition a function of the **delivery channel** (ADR-0038): extract a 3-valued `recipient_match` in Pass-2, derive claimant's `company_addressed_receipt` boolean from it, and route an arriving document by a per-channel **Ingest profile** — silently `discarded` for firehose noise, `needs_triage` for a wrong-recipient invoice, normal pipeline otherwise — with the claimant check outranking all of it.

**Architecture:** Pass-2 emits both `recipient_match` (`ours | other_party | none`) and the derived `company_addressed_receipt` boolean (claimant's existing consumers read the boolean unchanged). A pure `decideDisposition(channel, recipientMatch, documentType, profile)` resolves the terminal; it is invoked inside `IntakeWorkflowService.process()` **after** the existing claimant short-circuit and **before** the normal confidence routing. A new `discarded` document status + `disposition_reason` column record quiet drops; a retention sweep purges discarded bytes after ~30 days.

**Tech Stack:** NestJS 11, Kysely (SQLite), Zod 4, Jest 30. Test command: `npx jest <path> --no-coverage`.

## Global Constraints

- **Depends on:** (1) `main` containing intake-queue + claimant (migrations ≤057); (2) **Plan 1** (`2026-06-23-email-mailbox-connector.md`) merged — it provides the `email_sync`/`email_push` channels (migration 059) and the harvest path. **This plan's migration is 060** (Plan 1 used 058–059). Execute Plan 1 first.
- SQLite cannot ALTER a CHECK — use the 12-step rebuild; when rebuilding `document`, copy **every** current column including `claimant_id`, `processing_attempts`, `pending_triage_result`.
- Timestamps are Unix **seconds**.
- The claimant short-circuit in `process()` (merged main, runs **after** Pass-2) is **not** modified — the Ingest-profile disposition is layered immediately after it.
- Ingest profile is **per-channel** for v1 (defaults by channel + optional setting override); per-connector override is deferred (YAGNI).
- `recipient_match` is **transient** (Pass-2 output, not a persisted column); only the derived boolean (on `expense`, claimant's migration 056) and the `disposition_reason` (on `document`) persist.

---

## File Map

| Action | File |
|--------|------|
| Create | `packages/server/src/database/migrations/060_add_document_disposition.ts` (+ `.spec.ts`) |
| Modify | `packages/server/src/database/migrations/index.ts` — register 060 |
| Modify | `packages/server/src/database/types.ts` — `DocumentTable` (+ `disposition_reason`, `discarded_bytes_purged_at`) |
| Modify | `packages/server/src/documents/types.ts` — `DocumentStatus` (+ `discarded`), `Document` interface |
| Modify | `packages/server/src/triage/types.ts` — add `recipient_match` to `triageResultSchema` |
| Modify | `packages/server/src/ai/pass2-agent.service.ts` — derive `company_addressed_receipt` from `recipient_match`; prompt update |
| Create | `packages/server/src/triage/ingest-profile.ts` (+ `.spec.ts`) |
| Modify | `packages/server/src/documents/documents.service.ts` — `markDiscarded`, `getChannel`, retention helpers |
| Modify | `packages/server/src/ai/intake-workflow.service.ts` — invoke disposition after claimant check |
| Modify | `packages/server/src/ai/intake-workflow.service.spec.ts` — disposition routing tests |
| Modify | `packages/server/src/interaction/interaction-router.service.ts` — resolve `claimant_id` from email sender |
| Create | `packages/server/src/mailbox/discarded.controller.ts` — discarded view + retention sweep |

---

## Task 1: Migration 060 — document.disposition_reason + discarded status

**Files:**
- Create: `packages/server/src/database/migrations/060_add_document_disposition.ts` (+ `.spec.ts`)
- Modify: `index.ts`, `database/types.ts`, `documents/types.ts`

**Interfaces:**
- Produces: `document.status` CHECK accepts `'discarded'`; `document.disposition_reason TEXT` and `document.discarded_bytes_purged_at INTEGER` columns; `DocumentStatus` union includes `'discarded'`.

- [ ] **Step 1: Write the failing spec**

```typescript
// 060_add_document_disposition.spec.ts
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 060: document disposition', () => {
  it('allows discarded status with a disposition_reason', async () => {
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }) });
    const migrator = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
    const now = Math.floor(Date.now() / 1000);
    const doc = await db.insertInto('document').values({
      hash: 'h', filename: 'f.pdf', mime_type: 'application/pdf', size_bytes: 1, storage_path: '/x',
      status: 'discarded', disposition_reason: 'not_invoice', created_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    expect(doc.status).toBe('discarded');
    expect(doc.disposition_reason).toBe('not_invoice');
    expect(doc.discarded_bytes_purged_at).toBeNull();
    expect(doc.claimant_id).toBeNull(); // column preserved through rebuild
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run spec — verify it fails** (`npx jest 060_add_document_disposition.spec --no-coverage`).

- [ ] **Step 3: Write the migration**

Before writing, open the latest migration that rebuilt `document` (search `CREATE TABLE document_new` across migrations, or read `055_add_document_claimant_id.ts`) to copy the **exact current column set**. As of merged main the `document` columns are: `id, hash, filename, mime_type, size_bytes, storage_path, status, pending_triage_result, processing_since, processing_attempts, claimant_id, created_at`. The rebuild adds `disposition_reason` and `discarded_bytes_purged_at` and widens the `status` CHECK.

```typescript
// 060_add_document_disposition.ts
import { Kysely, sql } from 'kysely';
import { Database } from '../types';

const COLS = `id, hash, filename, mime_type, size_bytes, storage_path, status, pending_triage_result, processing_since, processing_attempts, claimant_id, created_at`;

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE document_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'triaged', 'needs_triage', 'processed', 'error', 'discarded')),
      pending_triage_result TEXT,
      processing_since INTEGER,
      processing_attempts INTEGER NOT NULL DEFAULT 0,
      claimant_id INTEGER REFERENCES entity(id),
      disposition_reason TEXT,
      discarded_bytes_purged_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `.execute(db);
  await sql`INSERT INTO document_new (${sql.raw(COLS)}) SELECT ${sql.raw(COLS)} FROM document`.execute(db);
  await sql`DROP TABLE document`.execute(db);
  await sql`ALTER TABLE document_new RENAME TO document`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  await sql`
    CREATE TABLE document_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'triaged', 'needs_triage', 'processed', 'error')),
      pending_triage_result TEXT,
      processing_since INTEGER,
      processing_attempts INTEGER NOT NULL DEFAULT 0,
      claimant_id INTEGER REFERENCES entity(id),
      created_at INTEGER NOT NULL
    )
  `.execute(db);
  await sql`INSERT INTO document_new (${sql.raw(COLS)}) SELECT ${sql.raw(COLS)} FROM document WHERE status != 'discarded'`.execute(db);
  await sql`DROP TABLE document`.execute(db);
  await sql`ALTER TABLE document_new RENAME TO document`.execute(db);
  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
```

- [ ] **Step 4: Register in index.ts** (`'060_add_document_disposition': m060,`).

- [ ] **Step 5: Update types**

In `database/types.ts` `DocumentTable`, add after `claimant_id`:
```typescript
disposition_reason: string | null;
discarded_bytes_purged_at: number | null;
```
In `documents/types.ts`, extend `DocumentStatus` with `| 'discarded'`, and add to the `Document` interface:
```typescript
disposition_reason: string | null;
```

- [ ] **Step 6: Run spec (PASS), full suite, commit**

```bash
git add packages/server/src/database/migrations/060_add_document_disposition.ts \
        packages/server/src/database/migrations/060_add_document_disposition.spec.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/database/types.ts \
        packages/server/src/documents/types.ts
git commit -m "feat(intake): migration 060 — discarded status + disposition_reason on document"
```

---

## Task 2: Pass-2 — recipient_match (3-valued) + derived company_addressed_receipt

**Files:**
- Modify: `packages/server/src/triage/types.ts`
- Modify: `packages/server/src/ai/pass2-agent.service.ts`
- Modify: the corresponding `.spec.ts` for the pass-2 agent / triage types

**Interfaces:**
- Consumes: existing `triageResultSchema`.
- Produces: `triageResultSchema.recipient_match: 'ours' | 'other_party' | 'none'` (default `'none'`); Pass-2 sets `company_addressed_receipt = recipient_match === 'ours'` so claimant's existing consumers (proposeDraft, projection) light up. The Pass-2 prompt is updated to extract the recipient/bill-to block.

- [ ] **Step 1: Write the failing schema test**

```typescript
// in triage/types.spec.ts (create if absent)
import { triageResultSchema } from './types';

describe('triageResultSchema recipient_match', () => {
  it('defaults recipient_match to none', () => {
    const r = triageResultSchema.parse({ kind: 'new_expense', gross_amount: 100, vat_amount: 0, tax_point_date: '2026-06-01', category: 'meals' });
    expect(r.recipient_match).toBe('none');
  });
  it('accepts the three recipient_match values', () => {
    for (const v of ['ours', 'other_party', 'none'] as const) {
      const r = triageResultSchema.parse({ kind: 'new_expense', gross_amount: 1, vat_amount: 0, tax_point_date: '2026-06-01', category: 'x', recipient_match: v });
      expect(r.recipient_match).toBe(v);
    }
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

- [ ] **Step 3: Add the field to the schema**

In `packages/server/src/triage/types.ts`, inside `triageResultSchema` (after `company_addressed_receipt`):

```typescript
// 3-valued recipient identity vs our Organization (email-sync owns this extraction,
// ADR-0038): 'ours' = our name/VAT in the bill-to; 'other_party' = a different
// party named; 'none' = no recipient block (e.g. a shop receipt).
recipient_match: z.enum(['ours', 'other_party', 'none']).default('none'),
```

- [ ] **Step 4: Derive the boolean in Pass-2 output**

In `packages/server/src/ai/pass2-agent.service.ts`, where the validated `TriageResult` is assembled/returned, set the claimant boolean from the 3-valued field (single source of truth) when the model did not set it explicitly:

```typescript
// company_addressed_receipt is claimant's VAT-reclaim boolean; derive it from
// the 3-valued recipient_match so both consumers read one fact (ADR-0038 / spec).
result.company_addressed_receipt = result.recipient_match === 'ours';
```

(If the agent returns a frozen object, build a new object with this field overridden. Match the existing return shape in that file.)

- [ ] **Step 5: Prompt update**

In the Pass-2 system prompt (in `pass2-agent.service.ts` or the prompt constant it loads), add an instruction to extract the recipient/bill-to block and set `recipient_match`:
- `ours` if our Organization's name or VAT-registration number appears as the addressee/bill-to;
- `other_party` if a *different* company is named as the addressee;
- `none` if there is no addressee block (a plain receipt).

(Use the `OrgIdentityContext` already passed to Pass-2 — name + `vat_registration_number` — as the comparison basis.)

- [ ] **Step 6: Run tests (PASS), full suite, commit**

```bash
git add packages/server/src/triage/types.ts packages/server/src/triage/types.spec.ts packages/server/src/ai/pass2-agent.service.ts
git commit -m "feat(intake): Pass-2 emits 3-valued recipient_match, derives company_addressed_receipt"
```

---

## Task 3: Ingest profile + decideDisposition (pure)

**Files:**
- Create: `packages/server/src/triage/ingest-profile.ts`
- Create: `packages/server/src/triage/ingest-profile.spec.ts`

**Interfaces:**
- Consumes: `Channel` (documents/types), `TriageResult` field types.
- Produces:
  - `IngestProfile = { acceptWithoutRecipient: boolean; nonMatchDisposition: 'discard' | 'needs_triage' }`.
  - `defaultProfileFor(channel: Channel): IngestProfile` — `email_sync` strict (`false`, `'discard'`), everything else permissive (`true`, `'needs_triage'`).
  - `decideDisposition(input: { recipientMatch: 'ours'|'other_party'|'none'; documentType: string; profile: IngestProfile }): { terminal: 'normal' | 'needs_triage' | 'discarded'; reason: string | null }`.

Disposition rules (spec / grilled decisions): `other_party` → always `needs_triage` (positive conflict — outranks the profile). Not-invoice (`document_type` ∈ `{'other','bank_statement'}`) → `profile.nonMatchDisposition`. `none` (receipt) → `normal` if `acceptWithoutRecipient` else `profile.nonMatchDisposition`. `ours` → `normal`.

- [ ] **Step 1: Write the failing test**

```typescript
// ingest-profile.spec.ts
import { defaultProfileFor, decideDisposition } from './ingest-profile';

describe('defaultProfileFor', () => {
  it('email_sync is strict', () => {
    expect(defaultProfileFor('email_sync')).toEqual({ acceptWithoutRecipient: false, nonMatchDisposition: 'discard' });
  });
  it('email_push is permissive', () => {
    expect(defaultProfileFor('email_push')).toEqual({ acceptWithoutRecipient: true, nonMatchDisposition: 'needs_triage' });
  });
});

describe('decideDisposition', () => {
  const sync = defaultProfileFor('email_sync');
  const push = defaultProfileFor('email_push');

  it('our invoice → normal', () => {
    expect(decideDisposition({ recipientMatch: 'ours', documentType: 'invoice', profile: sync }).terminal).toBe('normal');
  });
  it('other-party invoice → needs_triage even under strict profile (positive conflict)', () => {
    expect(decideDisposition({ recipientMatch: 'other_party', documentType: 'invoice', profile: sync })).toEqual({ terminal: 'needs_triage', reason: 'other_party' });
  });
  it('non-invoice on email_sync → discarded', () => {
    expect(decideDisposition({ recipientMatch: 'none', documentType: 'other', profile: sync })).toEqual({ terminal: 'discarded', reason: 'not_invoice' });
  });
  it('non-invoice on email_push → needs_triage', () => {
    expect(decideDisposition({ recipientMatch: 'none', documentType: 'other', profile: push })).toEqual({ terminal: 'needs_triage', reason: 'not_invoice' });
  });
  it('no-recipient receipt on email_sync (strict) → discarded, not normal', () => {
    expect(decideDisposition({ recipientMatch: 'none', documentType: 'receipt', profile: sync })).toEqual({ terminal: 'discarded', reason: 'no_recipient' });
  });
  it('no-recipient receipt on email_push (accepts) → normal', () => {
    expect(decideDisposition({ recipientMatch: 'none', documentType: 'receipt', profile: push }).terminal).toBe('normal');
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

- [ ] **Step 3: Implement**

```typescript
// ingest-profile.ts
import { Channel } from '../documents/types';

export interface IngestProfile {
  acceptWithoutRecipient: boolean;
  nonMatchDisposition: 'discard' | 'needs_triage';
}

export function defaultProfileFor(channel: Channel): IngestProfile {
  // Ambient firehose is strict; deliberate channels are permissive (ADR-0038).
  if (channel === 'email_sync') return { acceptWithoutRecipient: false, nonMatchDisposition: 'discard' };
  return { acceptWithoutRecipient: true, nonMatchDisposition: 'needs_triage' };
}

const INVOICE_LIKE = new Set(['invoice', 'receipt', 'credit_note']);

export function decideDisposition(input: {
  recipientMatch: 'ours' | 'other_party' | 'none';
  documentType: string;
  profile: IngestProfile;
}): { terminal: 'normal' | 'needs_triage' | 'discarded'; reason: string | null } {
  const { recipientMatch, documentType, profile } = input;
  const nonMatch = profile.nonMatchDisposition === 'discard' ? 'discarded' : 'needs_triage';

  // Positive conflict: a different party is named — always surface, outranks the profile.
  if (recipientMatch === 'other_party') return { terminal: 'needs_triage', reason: 'other_party' };

  // Confidently not an invoice (firehose noise).
  if (!INVOICE_LIKE.has(documentType)) return { terminal: nonMatch, reason: 'not_invoice' };

  // Receipt with no addressee: accept per profile, else dispose (do NOT divert on absence
  // unless the profile is strict — losing receipts is the failure mode we guard against).
  if (recipientMatch === 'none') {
    return profile.acceptWithoutRecipient
      ? { terminal: 'normal', reason: null }
      : { terminal: nonMatch, reason: 'no_recipient' };
  }

  // recipientMatch === 'ours'
  return { terminal: 'normal', reason: null };
}
```

- [ ] **Step 4: Run test (8) — PASS, commit.**

```bash
git add packages/server/src/triage/ingest-profile.ts packages/server/src/triage/ingest-profile.spec.ts
git commit -m "feat(intake): Ingest profile defaults + decideDisposition pure function"
```

---

## Task 4: Wire disposition into IntakeWorkflowService (after claimant check)

**Files:**
- Modify: `packages/server/src/documents/documents.service.ts` — add `getEmailChannel`, `markDiscarded`
- Modify: `packages/server/src/ai/intake-workflow.service.ts`
- Modify: `packages/server/src/ai/intake-workflow.service.spec.ts`

**Interfaces:**
- Consumes: `decideDisposition`/`defaultProfileFor` (Task 3), the validated `TriageResult` already computed in `process()`, the claimant short-circuit (existing).
- Produces:
  - `DocumentsService.getEmailChannel(documentId): Promise<'email_sync' | 'email_push' | null>` — returns the email delivery channel if any `document_source` is one, else null.
  - `DocumentsService.markDiscarded(documentId, reason): Promise<void>` — sets `status='discarded'`, `disposition_reason=reason`, clears `processing_since`.
  - In `process()`, immediately after the claimant short-circuit: if the document is from an email channel, run `decideDisposition`; `discarded` → `markDiscarded` and return a `needs_triage`-shaped result with the discard reason logged; `needs_triage` → `routeNeedsTriage` with the reason; `normal` → fall through to existing routing.

- [ ] **Step 1: Add DocumentsService helpers (with tests)**

In `documents.service.ts`:

```typescript
async getEmailChannel(documentId: number): Promise<'email_sync' | 'email_push' | null> {
  const rows = await this.db.selectFrom('document_source').select('channel')
    .where('document_id', '=', documentId).execute();
  const email = rows.map((r) => r.channel).find((c) => c === 'email_sync' || c === 'email_push');
  return (email as 'email_sync' | 'email_push' | undefined) ?? null;
}

async markDiscarded(documentId: number, reason: string): Promise<void> {
  await this.db.updateTable('document')
    .set({ status: 'discarded', disposition_reason: reason, processing_since: null })
    .where('id', '=', documentId).execute();
}
```

Add a spec to `documents.service.spec.ts`:

```typescript
it('getEmailChannel returns the email source channel, else null', async () => {
  const { document } = await service.upload({ buffer: Buffer.from('a'), filename: 'a.pdf', mimeType: 'application/pdf', channel: 'email_sync', sourceIdentifier: 'uid:1' });
  expect(await service.getEmailChannel(document.id)).toBe('email_sync');
  const { document: d2 } = await service.upload({ buffer: Buffer.from('b'), filename: 'b.pdf', mimeType: 'application/pdf', channel: 'upload' });
  expect(await service.getEmailChannel(d2.id)).toBeNull();
});

it('markDiscarded sets status and reason', async () => {
  const { document } = await service.upload({ buffer: Buffer.from('c'), filename: 'c.pdf', mimeType: 'application/pdf', channel: 'email_sync', sourceIdentifier: 'uid:2' });
  await service.markDiscarded(document.id, 'not_invoice');
  const row = await service.getById(document.id);
  expect(row.status).toBe('discarded');
  expect(row.disposition_reason).toBe('not_invoice');
});
```

- [ ] **Step 2: Write the failing workflow test**

In `intake-workflow.service.spec.ts`, add (follow the file's existing `createTestDocument`/setup helpers; here shown schematically):

```typescript
describe('email Ingest-profile disposition', () => {
  it('discards a non-invoice harvested from email_sync (no finding)', async () => {
    const docId = await createEmailDocument(db, 'email_sync'); // pending doc + email_sync source
    stubPass2(/* document_type */ 'other', /* recipient_match */ 'none');
    const result = await service.process(docId); // no claimantId
    const row = await getDocument(db, docId);
    expect(row.status).toBe('discarded');
    expect(row.disposition_reason).toBe('not_invoice');
    const findings = await db.selectFrom('audit_finding').selectAll().execute();
    expect(findings).toHaveLength(0); // discarded never nags
  });

  it('needs_triage for an other-party invoice from email_sync', async () => {
    const docId = await createEmailDocument(db, 'email_sync');
    stubPass2('invoice', 'other_party');
    await service.process(docId);
    const row = await getDocument(db, docId);
    expect(row.status).toBe('needs_triage');
  });

  it('claimant short-circuit outranks the profile (never discarded)', async () => {
    const docId = await createEmailDocument(db, 'email_push');
    stubPass2('other', 'other_party');
    await service.process(docId, /* claimantId */ 5);
    const row = await getDocument(db, docId);
    expect(row.status).toBe('needs_triage'); // claimant wins, not discarded
  });
});
```

- [ ] **Step 3: Run test — verify it fails.**

- [ ] **Step 4: Insert the disposition step in process()**

In `intake-workflow.service.ts`, locate the claimant short-circuit block (the `if (claimantId != null) { return this.routeNeedsTriage(...); }` that runs after Pass-2). **Immediately after** that block, before the normal routing, insert:

```typescript
// Email Ingest-profile disposition (ADR-0038). Runs only for email channels;
// other channels keep their existing routing. Claimant already short-circuited above.
const emailChannel = await this.documents.getEmailChannel(documentId);
if (emailChannel) {
  const profile = defaultProfileFor(emailChannel);
  const { terminal, reason } = decideDisposition({
    recipientMatch: triageResult.recipient_match,
    documentType: triageResult.document_type,
    profile,
  });
  if (terminal === 'discarded') {
    await this.documents.markDiscarded(documentId, reason ?? 'discarded');
    return { status: 'needs_triage', reason: `discarded:${reason}` } as IntakeWorkflowResult;
    // NB: returns a terminal result; the document is 'discarded', not surfaced.
  }
  if (terminal === 'needs_triage') {
    return this.routeNeedsTriage(documentId, `Email disposition: ${reason}`);
  }
  // terminal === 'normal' → fall through to the existing confidence routing.
}
```

Add the imports at the top: `import { decideDisposition, defaultProfileFor } from '../triage/ingest-profile';`. Confirm the variable holding the validated Pass-2 result is named `triageResult` at that point (rename in the snippet to match the actual local).

Note on the discarded return shape: `IntakeWorkflowResult` is a discriminated union without a `discarded` variant; returning a `needs_triage`-kinded object with a `discarded:` reason keeps the type intact while the **document row** is the source of truth (`status='discarded'`). If a cleaner `DiscardedOutcome` variant is preferred, add it to the union in `intake-workflow.service.ts` and return `{ status: 'discarded', reason }` — both are acceptable; pick one and keep the worker tolerant (the worker ignores the result body).

- [ ] **Step 5: Run tests (PASS), full suite, commit.**

```bash
git add packages/server/src/documents/documents.service.ts \
        packages/server/src/documents/documents.service.spec.ts \
        packages/server/src/ai/intake-workflow.service.ts \
        packages/server/src/ai/intake-workflow.service.spec.ts
git commit -m "feat(intake): channel-aware disposition layer (discard/needs_triage) after claimant check"
```

---

## Task 5: Resolve claimant_id from the email_push sender

**Files:**
- Modify: `packages/server/src/interaction/interaction-router.service.ts` (or the email harvest path that calls `upload`)
- Modify: its `.spec.ts`

**Interfaces:**
- Consumes: `EntitiesService.resolveByIdentifier('email', sender)` (claimant lookup added by the claimant branch — verify its exact name), the email sender from the envelope/message.
- Produces: on the **email** ingest path, resolve `email → Entity(role: employee|director)` and pass `claimantId` into `upload(...)`. Only for deliberate email (`email_push`); `email_sync` never resolves a claimant (no Principal).

This closes the verified gap (merged main does not resolve claimant_id for email). Without it the claimant short-circuit never fires for emailed receipts.

- [ ] **Step 1: Write the failing test**

```typescript
it('sets claimant_id when an email_push sender matches an employee/director', async () => {
  // seed an employee entity with identifier email = claimant@acme.ee
  // feed an inbound email_push envelope from claimant@acme.ee with a pdf attachment
  // assert the uploaded document row has claimant_id set to that entity
});
it('does not set claimant_id for an email_sync harvest (no Principal)', async () => {
  // harvest from email_sync by a supplier address → document.claimant_id is null
});
```

(Flesh these out against the actual router/harvest seam — the router test harness already exists for Telegram; mirror it for email.)

- [ ] **Step 2: Implement the resolution**

At the email ingest call site, before `upload(...)`:

```typescript
// Deliberate email (email_push) may carry an employee/director claim; resolve
// the claimant deterministically from the sender. email_sync never does this.
let claimantId: number | null = null;
if (channel === 'email_push') {
  const entity = await this.entities.resolveByIdentifier('email', senderEmail);
  if (entity && (entity.role === 'employee' || entity.role === 'director')) {
    claimantId = entity.id;
  }
}
await this.documents.upload({ /* ...existing... */, claimantId });
```

Verify `resolveByIdentifier`'s exact signature/return (the claimant branch added it for `tg_user_id`/`email`); adapt the property names to match.

- [ ] **Step 3: Run tests (PASS), full suite, commit.**

```bash
git add packages/server/src/interaction/interaction-router.service.ts packages/server/src/interaction/interaction-router.service.spec.ts
git commit -m "feat(intake): resolve claimant_id from email_push sender at ingest"
```

---

## Task 6: Discarded view + byte-retention sweep

**Files:**
- Create: `packages/server/src/mailbox/discarded.controller.ts`
- Modify: `packages/server/src/mailbox/mailbox.module.ts` (register controller + a retention service/cron)
- Modify: `packages/server/src/documents/documents.service.ts` — `listDiscarded`, `purgeDiscardedBytesOlderThan`

**Interfaces:**
- Produces:
  - `GET /api/mailbox/discarded` → discarded documents (id, filename, disposition_reason, created_at) — retrievable, never nags.
  - A `@Cron` daily sweep purging the stored **bytes** of discarded documents older than ~30 days (keeps the row + hash for anti-re-harvest; stamps `discarded_bytes_purged_at`).

- [ ] **Step 1: Add DocumentsService methods (with tests)**

```typescript
async listDiscarded(): Promise<Array<{ id: number; filename: string; disposition_reason: string | null; created_at: number }>> {
  return this.db.selectFrom('document')
    .select(['id', 'filename', 'disposition_reason', 'created_at'])
    .where('status', '=', 'discarded').orderBy('created_at', 'desc').execute();
}

async purgeDiscardedBytesOlderThan(cutoffSeconds: number): Promise<number> {
  const rows = await this.db.selectFrom('document').select(['id', 'storage_path'])
    .where('status', '=', 'discarded')
    .where('discarded_bytes_purged_at', 'is', null)
    .where('created_at', '<', cutoffSeconds).execute();
  for (const r of rows) {
    if (r.storage_path) await this.storage.delete(r.storage_path); // use the existing DocumentStorageService API
    await this.db.updateTable('document')
      .set({ storage_path: null, discarded_bytes_purged_at: Math.floor(Date.now() / 1000) })
      .where('id', '=', r.id).execute();
  }
  return rows.length;
}
```

Test: insert two discarded docs (one old, one fresh), run `purgeDiscardedBytesOlderThan(now - 30d)`, assert only the old one is purged (storage_path null, timestamp set) and `listDiscarded` returns both.

- [ ] **Step 2: Write the controller + cron**

```typescript
// discarded.controller.ts
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DocumentsService } from '../documents/documents.service';

const THIRTY_DAYS = 30 * 24 * 60 * 60;

@ApiTags('mailbox')
@Controller('api/mailbox')
export class DiscardedController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('discarded')
  @ApiOperation({ summary: 'List silently-discarded documents (retrievable, not nagged)' })
  list() {
    return this.documents.listDiscarded();
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async retentionSweep(): Promise<void> {
    await this.documents.purgeDiscardedBytesOlderThan(Math.floor(Date.now() / 1000) - THIRTY_DAYS);
  }
}
```

Register `DiscardedController` in `MailboxModule` (`controllers: [MailboxController, DiscardedController]`).

- [ ] **Step 3: Run tests (PASS), full suite, commit.**

```bash
git add packages/server/src/mailbox/discarded.controller.ts \
        packages/server/src/mailbox/mailbox.module.ts \
        packages/server/src/documents/documents.service.ts \
        packages/server/src/documents/documents.service.spec.ts
git commit -m "feat(intake): discarded view endpoint + 30-day byte-retention sweep"
```

---

## Self-Review

### Spec coverage (Plan 2 scope = recipient signal + disposition)

| spec / ADR-0038 item | Task |
|---|---|
| 3-valued `recipient_match`, email-sync owns extraction | 2 |
| `company_addressed_receipt` derived (option A — claimant consumers unchanged) | 2 |
| `discarded` status + `disposition_reason` persisted on document | 1 |
| Ingest profile per-channel defaults (strict ambient / permissive deliberate) | 3 |
| Disposition: other_party → triage; not-invoice → discard/triage; receipt absent ≠ conflict | 3 |
| Disposition precedence claimant > Ingest-profile > Policy | 4 (runs after claimant short-circuit; falls through to Policy routing) |
| Discard never nags (no AuditFinding) | 4 (markDiscarded, not routeNeedsTriage) |
| Claimant resolution from email_push sender (verified gap) | 5 |
| Discarded retrievable view; bytes purged ~30d | 6 |

### Out of scope (Plan 2)

- `accept_photos` knob enforcement (lives at the Plan 1 harvest filter; gating images per-channel is a small follow-up there).
- Per-connector Ingest-profile override (v1 is per-channel; deferred).
- Settings-based runtime override of the per-channel profile (defaults are code; a settings hook is additive later).
- SPA UI for the discarded view / profile toggles (REST contract delivered; frontend PR separate).

### Placeholder scan

Task 5's test bodies are intentionally schematic (the email router test harness must mirror the existing Telegram one); every other step carries full code. Flagged inline.

### Type consistency

`recipient_match` values (`ours|other_party|none`) are identical across Task 2 (schema), Task 3 (`decideDisposition`), and Task 4 (call site). `IngestProfile` shape matches between Task 3 and Task 4. `markDiscarded`/`getEmailChannel` signatures match between Task 4's definition and its call site. `DocumentStatus` `'discarded'` (Task 1) is used by Tasks 4 and 6.
