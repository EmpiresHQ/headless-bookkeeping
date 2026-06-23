# Intake Processing Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process intake documents one at a time so a burst of iOS uploads never fires concurrent OCR/LLM pipelines at the single vision endpoint.

**Architecture:** The DB `status='pending'` set is a durable backlog. A single in-process gate (concurrency = 1) wraps `IntakeWorkflowService.process()` so *all* processing — worker-driven and manual triage — is serialized. A new `IntakeQueueWorker` drains the backlog by claiming the oldest claimable `pending` document (atomic compare-and-set on `processing_since`), processing it, then taking the next. The worker is triggered by a startup drain plus a low-frequency poll (no event-emitter dependency, no documents↔triage module cycle).

**Tech Stack:** NestJS, Kysely (better-sqlite3), Jest, TypeScript.

## Global Constraints

- Server runs as a **single Node process** — an in-process mutex is a sufficient global serializer. Multi-instance / DB advisory locks are out of scope (YAGNI).
- No new runtime dependencies. `@nestjs/schedule` (already present) is **not** used here; the worker uses `setInterval` so it stays decoupled from `ScheduleModule.forRoot()` (registered only in `agents.module.ts`).
- Schema changes go in **migrations only** (repo rule G4); update `database/types.ts` to match.
- Migrations are append-only and registered in `database/migrations/index.ts`. Next free number is **053**.
- Document status enum: `'pending' | 'triaged' | 'needs_triage' | 'processed' | 'error'`. `processing_since` (Unix seconds) is set while in the pipeline, `NULL` when idle.
- Tests mirror the existing pattern in `documents/documents.service.spec.ts`: real migrations against an in-memory `better-sqlite3` via a `TestingModule`.

**Deviation from the design spec (intentional):** the spec proposed an event `kick()` from `DocumentsService.upload`. Wiring that from the HTTP layer couples `DocumentsModule` → the worker's module and creates a cycle (the worker depends on `DocumentsModule`). To avoid both a module cycle and adding `@nestjs/event-emitter`, the trigger is a startup drain + a ~1.5 s poll. Behaviour is identical; worst-case start latency for a freshly uploaded document is one poll interval. A public `kick()` is still exposed for tests and future event wiring.

---

### Task 1: Add `processing_attempts` column (poison-document guard)

A document that throws an *unexpected* exception in `process()` stays `pending` (its `finally` clears `processing_since`, status never advances). Without a bound, the worker would re-claim it forever. `processing_attempts` lets the claim query exclude a document after N failed attempts so one bad file cannot block the queue.

**Files:**
- Create: `packages/server/src/database/migrations/053_add_document_processing_attempts.ts`
- Create: `packages/server/src/database/migrations/053_add_document_processing_attempts.spec.ts`
- Modify: `packages/server/src/database/migrations/index.ts` (register migration 053)
- Modify: `packages/server/src/database/types.ts:180-196` (add column to `DocumentTable`)

**Interfaces:**
- Produces: `document.processing_attempts` column — `INTEGER NOT NULL DEFAULT 0`; typed `processing_attempts: Generated<number>` on `DocumentTable`.

- [ ] **Step 1: Write the failing migration spec**

Create `packages/server/src/database/migrations/053_add_document_processing_attempts.spec.ts`:

```typescript
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { Database } from '../types';
import { migrations } from './index';

describe('Migration 053: add document.processing_attempts', () => {
  it('adds processing_attempts defaulting to 0', async () => {
    const db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();

    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .insertInto('document')
      .values({
        hash: 'h1',
        filename: 'f.png',
        mime_type: 'image/png',
        size_bytes: 1,
        storage_path: null,
        status: 'pending',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(row.processing_attempts).toBe(0);
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/server && npx jest src/database/migrations/053_add_document_processing_attempts.spec.ts`
Expected: FAIL — migration `053_...` not found / `processing_attempts` undefined.

- [ ] **Step 3: Write the migration**

Create `packages/server/src/database/migrations/053_add_document_processing_attempts.ts`:

```typescript
import { Kysely } from 'kysely';
import { Database } from '../types';

/**
 * Migration 053: add document.processing_attempts.
 *
 * Counts how many times the intake worker has claimed a document for
 * processing. The claim query excludes documents whose attempts reached the
 * cap so a "poison" document that keeps throwing cannot block the queue.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .addColumn('processing_attempts', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('document')
    .dropColumn('processing_attempts')
    .execute();
}
```

- [ ] **Step 4: Register the migration**

In `packages/server/src/database/migrations/index.ts`, add the import after the `m052` line:

```typescript
import * as m053 from './053_add_document_processing_attempts';
```

and add to the `migrations` map after the `'052_...': m052,` line:

```typescript
  '053_add_document_processing_attempts': m053,
```

- [ ] **Step 5: Update the DB type**

In `packages/server/src/database/types.ts`, inside the `DocumentTable` interface, add immediately after the `processing_since: Generated<number | null>;` line:

```typescript
  // Number of times the intake worker has claimed this document for
  // processing (migration 053). The claim query excludes documents at the
  // attempt cap so a repeatedly-failing document cannot block the queue.
  processing_attempts: Generated<number>;
```

- [ ] **Step 6: Run the spec to verify it passes**

Run: `cd packages/server && npx jest src/database/migrations/053_add_document_processing_attempts.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/database/migrations/053_add_document_processing_attempts.ts \
        packages/server/src/database/migrations/053_add_document_processing_attempts.spec.ts \
        packages/server/src/database/migrations/index.ts \
        packages/server/src/database/types.ts
git commit -m "feat(intake): add document.processing_attempts column for queue poison guard"
```

---

### Task 2: `ProcessingGate` — global concurrency-1 serializer

A tiny injectable that runs submitted async functions strictly one at a time, in submission order, regardless of success/failure.

**Files:**
- Create: `packages/server/src/ai/processing-gate.ts`
- Create: `packages/server/src/ai/processing-gate.spec.ts`

**Interfaces:**
- Produces: `class ProcessingGate { run<T>(fn: () => Promise<T>): Promise<T> }` — `@Injectable()`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/ai/processing-gate.spec.ts`:

```typescript
import { ProcessingGate } from './processing-gate';

describe('ProcessingGate', () => {
  it('never runs two tasks concurrently', async () => {
    const gate = new ProcessingGate();
    let active = 0;
    let maxActive = 0;

    const task = () =>
      gate.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBe(1);
  });

  it('runs tasks in submission order', async () => {
    const gate = new ProcessingGate();
    const order: number[] = [];
    const mk = (n: number) =>
      gate.run(async () => {
        await new Promise((r) => setTimeout(r, 1));
        order.push(n);
      });
    await Promise.all([mk(1), mk(2), mk(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps serializing after a task rejects', async () => {
    const gate = new ProcessingGate();
    const order: string[] = [];
    const failing = gate
      .run(async () => {
        order.push('a');
        throw new Error('boom');
      })
      .catch(() => order.push('a-caught'));
    const next = gate.run(async () => {
      order.push('b');
    });
    await Promise.all([failing, next]);
    expect(order).toEqual(['a', 'a-caught', 'b']);
  });

  it('returns the task result', async () => {
    const gate = new ProcessingGate();
    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/server && npx jest src/ai/processing-gate.spec.ts`
Expected: FAIL — cannot find module `./processing-gate`.

- [ ] **Step 3: Implement `ProcessingGate`**

Create `packages/server/src/ai/processing-gate.ts`:

```typescript
import { Injectable } from '@nestjs/common';

/**
 * ProcessingGate — a single-process serializer (concurrency = 1).
 *
 * Submitted functions run strictly one at a time, in submission order. The
 * intake pipeline routes every `process()` through this gate so a burst of
 * uploads cannot fire concurrent OCR/LLM calls at the single vision endpoint
 * (one Node process => one in-memory mutex is enough; multi-instance is out of
 * scope by design).
 */
@Injectable()
export class ProcessingGate {
  // The tail of the run-chain. Always resolves (never rejects) so one failing
  // task cannot wedge the chain for the next caller.
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

Note: `this.tail.then(fn, fn)` runs `fn` after the previous task settles whether it resolved or rejected; `fn` ignores the settled value.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/server && npx jest src/ai/processing-gate.spec.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ai/processing-gate.ts packages/server/src/ai/processing-gate.spec.ts
git commit -m "feat(intake): add ProcessingGate concurrency-1 serializer"
```

---

### Task 3: Route `IntakeWorkflowService.process()` through the gate

Make serialization an invariant of the pipeline: every caller of `process()` (the worker and the manual `POST /triage`) is serialized without having to remember to wrap the call.

**Files:**
- Modify: `packages/server/src/ai/intake-workflow.service.ts` (constructor + `process()`)
- Modify: `packages/server/src/ai/ai.module.ts` (register + export `ProcessingGate`)
- Create: `packages/server/src/ai/intake-workflow.gate.spec.ts`

**Interfaces:**
- Consumes: `ProcessingGate` (Task 2).
- Produces: `IntakeWorkflowService.process(documentId: number): Promise<IntakeWorkflowResult>` — unchanged signature, now gated. The original body becomes a private `processInner(documentId: number)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/ai/intake-workflow.gate.spec.ts`:

```typescript
import { ProcessingGate } from './processing-gate';
import { IntakeWorkflowService } from './intake-workflow.service';

describe('IntakeWorkflowService.process gating', () => {
  it('runs the workflow body inside the ProcessingGate', async () => {
    const gate = new ProcessingGate();
    const runSpy = jest.spyOn(gate, 'run');

    // getById is the very first thing processInner does; reject it to prove
    // the body executed (inside the gate) without standing up the whole pipeline.
    const documents = {
      getById: jest.fn().mockRejectedValue(new Error('sentinel')),
    };

    const service = new IntakeWorkflowService(
      {} as never, // ocrService
      {} as never, // pass2Agent
      {} as never, // proposeDraft
      {} as never, // auditFindings
      {} as never, // policyService
      documents as never, // documents
      {} as never, // entities
      {} as never, // organizationService
      {} as never, // bankIngestion
      gate,
    );

    await expect(service.process(1)).rejects.toThrow('sentinel');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(documents.getById).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/server && npx jest src/ai/intake-workflow.gate.spec.ts`
Expected: FAIL — `IntakeWorkflowService` constructor takes 9 args (the 10th `gate` is not yet a parameter), so the call shape / `runSpy` assertion fails.

- [ ] **Step 3: Inject the gate and wrap `process()`**

In `packages/server/src/ai/intake-workflow.service.ts`:

a) Add the import after the existing local imports (near the `classifyDocumentClass` import):

```typescript
import { ProcessingGate } from './processing-gate';
```

b) Add `gate` as the final constructor parameter. Change the constructor tail from:

```typescript
    @Inject(forwardRef(() => BankIngestionService))
    private readonly bankIngestion: BankIngestionService,
  ) {}
```

to:

```typescript
    @Inject(forwardRef(() => BankIngestionService))
    private readonly bankIngestion: BankIngestionService,
    private readonly gate: ProcessingGate,
  ) {}
```

c) Rename the existing `async process(documentId: number): Promise<IntakeWorkflowResult> {` method header to `private async processInner(...)`, and add a new public `process` that delegates through the gate. Concretely, replace the line:

```typescript
  async process(documentId: number): Promise<IntakeWorkflowResult> {
```

with:

```typescript
  /**
   * Run the full intake pipeline for one document, serialized through the
   * ProcessingGate so only one OCR/LLM pipeline runs at a time across the whole
   * process (worker-driven and manual triage alike).
   */
  async process(documentId: number): Promise<IntakeWorkflowResult> {
    return this.gate.run(() => this.processInner(documentId));
  }

  private async processInner(
    documentId: number,
  ): Promise<IntakeWorkflowResult> {
```

(The body — the idempotency guard, `markProcessing`, Pass-1/Pass-2, routing, and the `finally { clearProcessing }` — is unchanged; it now lives in `processInner`.)

- [ ] **Step 4: Register `ProcessingGate` in `AiModule`**

In `packages/server/src/ai/ai.module.ts`:

a) Add the import near the other service imports:

```typescript
import { ProcessingGate } from './processing-gate';
```

b) Add `ProcessingGate` to both `providers` and `exports` arrays (it must be exported so the worker's module can inject the same singleton). The arrays become:

```typescript
  providers: [
    MastraService,
    ProposeDraftService,
    Pass2AgentService,
    IntakeWorkflowService,
    ProcessingGate,
  ],
  exports: [
    MastraService,
    ProposeDraftService,
    Pass2AgentService,
    IntakeWorkflowService,
    ProcessingGate,
  ],
```

- [ ] **Step 5: Run the gate test + the existing workflow tests**

Run: `cd packages/server && npx jest src/ai/intake-workflow.gate.spec.ts src/ai/intake-workflow.service.spec.ts`
Expected: PASS. (The existing workflow spec must still pass — gating is transparent. If the existing spec constructs `IntakeWorkflowService` by hand, add a `new ProcessingGate()` as the final constructor argument there.)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ai/intake-workflow.service.ts \
        packages/server/src/ai/ai.module.ts \
        packages/server/src/ai/intake-workflow.gate.spec.ts
git commit -m "feat(intake): serialize IntakeWorkflowService.process via ProcessingGate"
```

---

### Task 4: `DocumentsService.claimNextPending()` — atomic FIFO claim

The queue's pick-and-lock primitive: atomically claim the oldest claimable `pending` document, returning its id (or `null` when the queue is empty / everything is in flight or capped).

**Files:**
- Modify: `packages/server/src/documents/documents.service.ts` (add `claimNextPending`, import `sql`)
- Modify: `packages/server/src/documents/documents.service.spec.ts` (add a `describe('claimNextPending')` block)

**Interfaces:**
- Consumes: `document.processing_attempts` (Task 1).
- Produces: `DocumentsService.claimNextPending(staleSeconds: number, maxAttempts: number): Promise<number | null>`. Side effect on success: sets `processing_since = now` and increments `processing_attempts` on the claimed row.

- [ ] **Step 1: Write the failing tests**

In `packages/server/src/documents/documents.service.spec.ts`, add this block inside the top-level `describe('DocumentsService (unit)')` (it reuses the `service` and `db` set up in the file's `beforeEach`). Add a small local helper to insert a pending document directly:

```typescript
  describe('claimNextPending', () => {
    const STALE = 300;
    const MAX = 3;

    async function insertPending(
      hash: string,
      createdAt: number,
      opts: { processingSince?: number | null; attempts?: number } = {},
    ): Promise<number> {
      const row = await db
        .insertInto('document')
        .values({
          hash,
          filename: `${hash}.png`,
          mime_type: 'image/png',
          size_bytes: 1,
          storage_path: null,
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

      const id = await service.claimNextPending(STALE, MAX);
      expect(id).toBe(older);

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
      const id = await service.claimNextPending(STALE, MAX);
      expect(id).toBe(stuck);
    });

    it('excludes a document at the attempt cap', async () => {
      await insertPending('poison', 1000, { attempts: MAX });
      const id = await service.claimNextPending(STALE, MAX);
      expect(id).toBeNull();
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/server && npx jest src/documents/documents.service.spec.ts -t claimNextPending`
Expected: FAIL — `service.claimNextPending is not a function`.

- [ ] **Step 3: Implement `claimNextPending`**

In `packages/server/src/documents/documents.service.ts`:

a) Add `sql` to the existing kysely import. Change:

```typescript
import { Kysely } from 'kysely';
```

to:

```typescript
import { Kysely, sql } from 'kysely';
```

b) Add the method (place it right after `clearProcessing`):

```typescript
  /**
   * Atomically claim the oldest claimable 'pending' document for processing.
   *
   * Claimable = status 'pending', attempts below the cap, and not currently
   * in flight (processing_since NULL or older than `staleSeconds` — the latter
   * reclaims a document stranded by a crash). On a win it stamps
   * processing_since = now and increments processing_attempts, then returns the
   * id. Returns null when the queue is empty or another claimer won the race.
   */
  async claimNextPending(
    staleSeconds: number,
    maxAttempts: number,
  ): Promise<number | null> {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - staleSeconds;

    const candidate = await this.db
      .selectFrom('document')
      .select('id')
      .where('status', '=', 'pending')
      .where('processing_attempts', '<', maxAttempts)
      .where((eb) =>
        eb.or([
          eb('processing_since', 'is', null),
          eb('processing_since', '<', cutoff),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst();

    if (!candidate) {
      return null;
    }

    const res = await this.db
      .updateTable('document')
      .set({
        processing_since: now,
        processing_attempts: sql`processing_attempts + 1`,
      })
      .where('id', '=', candidate.id)
      .where('status', '=', 'pending')
      .where((eb) =>
        eb.or([
          eb('processing_since', 'is', null),
          eb('processing_since', '<', cutoff),
        ]),
      )
      .executeTakeFirst();

    return Number(res.numUpdatedRows) === 1 ? candidate.id : null;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/server && npx jest src/documents/documents.service.spec.ts -t claimNextPending`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/documents/documents.service.ts \
        packages/server/src/documents/documents.service.spec.ts
git commit -m "feat(intake): add DocumentsService.claimNextPending atomic FIFO claim"
```

---

### Task 5: `IntakeQueueWorker` + module wiring

The drain loop: a single-flight worker that claims and processes pending documents one at a time, recovers leftovers on startup, and polls as a backstop.

**Files:**
- Create: `packages/server/src/intake-queue/intake-queue.worker.ts`
- Create: `packages/server/src/intake-queue/intake-queue.module.ts`
- Create: `packages/server/src/intake-queue/intake-queue.worker.spec.ts`
- Modify: `packages/server/src/app.module.ts` (import + register `IntakeQueueModule`)

**Interfaces:**
- Consumes: `DocumentsService.claimNextPending(staleSeconds, maxAttempts)` (Task 4); `IntakeWorkflowService.process(documentId)` (Task 3).
- Produces: `IntakeQueueWorker` with `kick(): Promise<void>` and `drainLoop(): Promise<void>` (single-flight); lifecycle `onModuleInit()` / `onModuleDestroy()`. Module-level constants `POLL_INTERVAL_MS = 1500`, `STALE_SECONDS = 300`, `MAX_ATTEMPTS = 3`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/intake-queue/intake-queue.worker.spec.ts`:

```typescript
import { IntakeQueueWorker } from './intake-queue.worker';

type FakeDoc = { id: number; attempts: number; done: boolean };

function makeDeps(docs: FakeDoc[]) {
  let active = 0;
  let maxActive = 0;
  const processed: number[] = [];

  const documents = {
    claimNextPending: jest.fn(async (_stale: number, max: number) => {
      const next = docs.find((d) => !d.done && d.attempts < max);
      if (!next) return null;
      next.attempts += 1;
      return next.id;
    }),
  };

  const workflow = {
    process: jest.fn(async (id: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 3));
      active -= 1;
      const d = docs.find((x) => x.id === id)!;
      d.done = true; // success removes it from the pending set
      processed.push(id);
      return { status: 'needs_triage', reason: 'x' } as never;
    }),
  };

  return { documents, workflow, get maxActive() { return maxActive; }, processed };
}

describe('IntakeQueueWorker', () => {
  it('drains all pending documents, never two at once', async () => {
    const docs: FakeDoc[] = [1, 2, 3, 4, 5].map((id) => ({
      id,
      attempts: 0,
      done: false,
    }));
    const deps = makeDeps(docs);
    const worker = new IntakeQueueWorker(
      deps.documents as never,
      deps.workflow as never,
    );

    await worker.drainLoop();

    expect(deps.processed.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(deps.maxActive).toBe(1);
  });

  it('keeps draining after one document throws (failure isolation)', async () => {
    const docs: FakeDoc[] = [1, 2, 3].map((id) => ({
      id,
      attempts: 0,
      done: false,
    }));
    const deps = makeDeps(docs);
    deps.workflow.process.mockImplementationOnce(async () => {
      throw new Error('boom'); // document 1 throws, stays pending
    });
    const worker = new IntakeQueueWorker(
      deps.documents as never,
      deps.workflow as never,
    );

    await worker.drainLoop();

    // 2 and 3 still processed; the loop did not die on the throw.
    expect(deps.processed).toEqual(expect.arrayContaining([2, 3]));
  });

  it('stops re-claiming a document once it hits the attempt cap (poison guard)', async () => {
    const docs: FakeDoc[] = [{ id: 1, attempts: 0, done: false }];
    const deps = makeDeps(docs);
    deps.workflow.process.mockImplementation(async () => {
      throw new Error('always fails'); // never marks done
    });
    const worker = new IntakeQueueWorker(
      deps.documents as never,
      deps.workflow as never,
    );

    await worker.drainLoop();

    // claimNextPending excludes attempts >= MAX_ATTEMPTS, so the loop ends.
    expect(deps.workflow.process).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS
  });

  it('kick() is single-flight (one drain loop at a time)', async () => {
    const docs: FakeDoc[] = [{ id: 1, attempts: 0, done: false }];
    const deps = makeDeps(docs);
    const worker = new IntakeQueueWorker(
      deps.documents as never,
      deps.workflow as never,
    );

    await Promise.all([worker.kick(), worker.kick(), worker.kick()]);
    expect(deps.processed).toEqual([1]); // processed exactly once
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/server && npx jest src/intake-queue/intake-queue.worker.spec.ts`
Expected: FAIL — cannot find module `./intake-queue.worker`.

- [ ] **Step 3: Implement the worker**

Create `packages/server/src/intake-queue/intake-queue.worker.ts`:

```typescript
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { IntakeWorkflowService } from '../ai/intake-workflow.service';

/** Backstop poll interval (ms). The primary path is the startup drain plus
 *  this poll; processing itself is serialized inside IntakeWorkflowService. */
export const POLL_INTERVAL_MS = 1500;
/** A document in flight longer than this (seconds) is assumed crash-stranded
 *  and may be reclaimed. */
export const STALE_SECONDS = 300;
/** Give up auto-processing a document after this many failed claims so a
 *  poison document cannot block the queue. */
export const MAX_ATTEMPTS = 3;

/**
 * IntakeQueueWorker — drains the durable backlog (documents with
 * status='pending') one document at a time.
 *
 * Single-flight: only one drainLoop runs at a time; a kick() during a drain
 * sets a rerun flag so newly-arrived work is picked up without overlapping
 * loops. Processing is additionally serialized by the ProcessingGate inside
 * IntakeWorkflowService.process, which also guards against the manual triage
 * route running concurrently.
 */
@Injectable()
export class IntakeQueueWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntakeQueueWorker.name);
  private draining = false;
  private rerun = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly documents: DocumentsService,
    private readonly workflow: IntakeWorkflowService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.kick();
    }, POLL_INTERVAL_MS);
    // Startup drain: pick up anything left pending (or crash-stranded) while
    // the server was down.
    void this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Wake the worker. Single-flight: if a drain is running, mark for rerun. */
  kick(): Promise<void> {
    if (this.draining) {
      this.rerun = true;
      return Promise.resolve();
    }
    return this.drainLoop();
  }

  /** Claim-and-process until the queue is drained. */
  async drainLoop(): Promise<void> {
    this.draining = true;
    try {
      do {
        this.rerun = false;
        let id: number | null;
        while (
          (id = await this.documents.claimNextPending(
            STALE_SECONDS,
            MAX_ATTEMPTS,
          )) !== null
        ) {
          try {
            await this.workflow.process(id);
          } catch (err) {
            // process()'s own finally cleared processing_since; the attempt
            // counter (bumped at claim) bounds retries. Log and move on — one
            // bad document must not stop the queue.
            this.logger.error(
              `Intake processing failed for document ${id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } while (this.rerun);
    } finally {
      this.draining = false;
    }
  }
}
```

- [ ] **Step 4: Run the worker test to verify it passes**

Run: `cd packages/server && npx jest src/intake-queue/intake-queue.worker.spec.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Create the module**

Create `packages/server/src/intake-queue/intake-queue.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { AiModule } from '../ai/ai.module';
import { IntakeQueueWorker } from './intake-queue.worker';

/**
 * IntakeQueueModule — owns the background worker that serializes intake
 * processing. Depends only on DocumentsModule (claim primitive) and AiModule
 * (the gated intake pipeline); nothing depends back on it, so there is no
 * module cycle.
 */
@Module({
  imports: [DocumentsModule, AiModule],
  providers: [IntakeQueueWorker],
})
export class IntakeQueueModule {}
```

- [ ] **Step 6: Register the module in `AppModule`**

In `packages/server/src/app.module.ts`:

a) Add the import after the `AiModule` import line:

```typescript
import { IntakeQueueModule } from './intake-queue/intake-queue.module';
```

b) Add `IntakeQueueModule` to the `imports` array (e.g. right after `AiModule,`).

- [ ] **Step 7: Build and run the full server test suite**

Run: `cd packages/server && npx tsc --noEmit && npx jest`
Expected: PASS — type-check clean and all suites green (worker boots under DI via `IntakeQueueModule`).

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/intake-queue/ packages/server/src/app.module.ts
git commit -m "feat(intake): add IntakeQueueWorker draining pending documents one at a time"
```

---

## Self-Review

**Spec coverage:**
- Durable backlog (`pending` in DB) → unchanged `upload`; Task 4 claims from it. ✓
- Global serializer (concurrency 1) → Task 2 (`ProcessingGate`) + Task 3 (wraps `process()`); covers both worker and manual triage since both call `process()`. ✓
- Per-document in-flight marker (`processing_since`) → reused; CAS claim in Task 4. ✓
- Auto-process all channels → worker drains all `pending` regardless of channel (Task 5). ✓
- Manual triage stays → `TriageService.route` still calls `process()`, now gated; no endpoint removed. ✓
- Crash recovery → startup drain (`onModuleInit`) + stale reclaim in `claimNextPending` (Task 4/5). ✓
- Failure isolation + poison guard → Task 1 column + Task 4 exclusion + Task 5 try/catch and cap test. ✓
- Dedup no-op → unchanged `upload` dedup path; a non-`pending` document is simply never claimed (covered conceptually; the claim's `status='pending'` filter is tested in Task 4 "ignores non-pending"). ✓
- Single-instance assumption / no external queue → Global Constraints + `ProcessingGate` doc. ✓

**Deviation flagged:** event `kick()` from `upload` replaced by startup-drain + poll to avoid a module cycle and a new dependency — documented under the header. The worst-case added latency (one poll interval) is acceptable for intake.

**Placeholder scan:** no TBD/TODO; every code step has complete code; every command has expected output. ✓

**Type consistency:** `claimNextPending(staleSeconds, maxAttempts)` used identically in Tasks 4 and 5; `process(documentId)` signature unchanged across Tasks 3 and 5; `processing_attempts: Generated<number>` matches the migration default; worker constants `POLL_INTERVAL_MS`/`STALE_SECONDS`/`MAX_ATTEMPTS` defined once and reused. ✓
