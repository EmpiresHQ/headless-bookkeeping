# Statutory-Submission Lifecycle Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the external statutory-filing lifecycle (prepared → submitted → accepted/rejected, plus corrections) as an append-only event log over the immutable VAT snapshot, deriving filing state by folding events — never mutating the locked period or its snapshot.

**Architecture:** A new jurisdiction-neutral append-only kernel table `statutory_submission_event` (immutable via BEFORE UPDATE/DELETE triggers, ADR-0009) stores one row per lifecycle event, each pinning the exact frozen `source_snapshot_id`. A pure fold function derives the current filing state from a period's ordered events (no status column). `StatutorySubmissionService` writes events plus an operational audit-log entry (ADR-0026) and reads back folded state + history; the existing `ReportingPeriodsService.lock` is hooked to emit exactly one `prepared` event against the frozen `vat_report` snapshot. A REST controller exposes record + read. v1 is operator-attested — no e-MTA API call.

**Tech Stack:** NestJS, TypeScript, Kysely, better-sqlite3, Jest, nestjs-zod

---

## File Structure

| File | Create/Modify | Responsibility |
| --- | --- | --- |
| `src/database/migrations/050_create_statutory_submission_event.ts` | Create | Append-only `statutory_submission_event` table + immutability triggers. |
| `src/database/migrations/index.ts` | Modify | Register migration 050. |
| `src/database/types.ts` | Modify | Add `StatutorySubmissionEventTable` row interface + `Database` key. |
| `src/statutory-submission/fold.ts` | Create | Pure fold: ordered events → derived filing state. |
| `src/statutory-submission/fold.spec.ts` | Create | Pure unit tests for the fold (no DB). |
| `src/statutory-submission/types.ts` | Create | Domain types, event-kind union, Zod DTO, `SubmissionState`/`SubmissionEvent` view types. |
| `src/statutory-submission/statutory-submission.service.ts` | Create | `recordEvent(...)` (writes event + audit-log entry), `getState(periodId)` (folded state + history). |
| `src/statutory-submission/statutory-submission.service.spec.ts` | Create | Integration: append works, audit-log side effect, snapshot pinning, no-unlock invariant. |
| `src/statutory-submission/statutory-submission.controller.ts` | Create | `POST /:id/submission-events`, `GET /:id/submission-state`. |
| `src/statutory-submission/statutory-submission.controller.spec.ts` | Create | Integration tests on the two routes. |
| `src/statutory-submission/statutory-submission.module.ts` | Create | Module wiring (DatabaseModule, AuditLogModule). |
| `src/reporting-periods/reporting-periods.service.ts` | Modify | Inject `StatutorySubmissionService`; emit `prepared` event after lock. |
| `src/reporting-periods/reporting-periods.module.ts` | Modify | Import `StatutorySubmissionModule`. |
| `src/reporting-periods/statutory-submission-lock.spec.ts` | Create | Integration: lock writes exactly one `prepared` event pinned to the snapshot; `filed_at` stamped. |
| `src/app.module.ts` | Modify | Register `StatutorySubmissionModule`. |

---

### Task 1 — Migration 050: append-only `statutory_submission_event` table

**Files:**
- `src/database/migrations/050_create_statutory_submission_event.ts` (create)
- `src/database/migrations/index.ts` (modify)
- `src/database/types.ts` (modify)
- `src/database/migrations/050_create_statutory_submission_event.spec.ts` (create)

- [ ] **Step 1 — Failing migration test.** Create `src/database/migrations/050_create_statutory_submission_event.spec.ts`:
  ```typescript
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../types';
  import { migrations } from './index';

  describe('050_create_statutory_submission_event (migration)', () => {
    let db: Kysely<Database>;

    beforeEach(async () => {
      const rawDb = new SqliteDb(':memory:');
      rawDb.pragma('foreign_keys = ON');
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });
      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-Q1',
          start_date: '2026-01-01',
          end_date: '2026-03-31',
          status: 'locked',
          filed_at: 1000,
          vat_report_snapshot_id: null,
          created_at: 1000,
        })
        .execute();
    });

    afterEach(async () => {
      await db.destroy();
    });

    const insertEvent = () =>
      db
        .insertInto('statutory_submission_event')
        .values({
          reporting_period_id: 1,
          report_kind: 'EE_KMD',
          source_snapshot_type: 'vat_report',
          source_snapshot_id: 42,
          event_kind: 'prepared',
          external_ref: null,
          occurred_at: 1234,
          actor: 'system',
          note: null,
        })
        .execute();

    it('inserts an event row', async () => {
      await insertEvent();
      const row = await db
        .selectFrom('statutory_submission_event')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(row.reporting_period_id).toBe(1);
      expect(row.report_kind).toBe('EE_KMD');
      expect(row.source_snapshot_type).toBe('vat_report');
      expect(row.source_snapshot_id).toBe(42);
      expect(row.event_kind).toBe('prepared');
      expect(row.external_ref).toBeNull();
      expect(row.actor).toBe('system');
    });

    it('is append-only — the DB rejects UPDATE', async () => {
      await insertEvent();
      await expect(
        db
          .updateTable('statutory_submission_event')
          .set({ event_kind: 'tampered' })
          .execute(),
      ).rejects.toThrow(/append-only/);
    });

    it('is append-only — the DB rejects DELETE', async () => {
      await insertEvent();
      await expect(
        db.deleteFrom('statutory_submission_event').execute(),
      ).rejects.toThrow(/append-only/);
    });
  });
  ```

- [ ] **Step 2 — Run (expect FAIL).** `npm test -- src/database/migrations/050_create_statutory_submission_event.spec.ts`. Fails: migration and table do not exist; `Database` has no `statutory_submission_event` key.

- [ ] **Step 3 — Add the row interface and `Database` key.** In `src/database/types.ts`, add `statutory_submission_event: StatutorySubmissionEventTable;` to the `Database` interface (after `credit_note: CreditNoteTable;`):
  ```typescript
    credit_note: CreditNoteTable;
    statutory_submission_event: StatutorySubmissionEventTable;
  ```
  Then append this interface at the end of the file:
  ```typescript
  // StatutorySubmissionEvent: append-only, jurisdiction-neutral log of the
  // external statutory-filing lifecycle over an immutable snapshot (ADR-0037).
  // One row per lifecycle event; filing state is a FOLD over the events (no
  // mutable status column). Immutable via BEFORE UPDATE/DELETE triggers
  // (ADR-0009). Every `submitted` pins the exact frozen source_snapshot_id.
  export interface StatutorySubmissionEventTable {
    id: Generated<number>;
    reporting_period_id: number;
    // Jurisdiction/report identifier, e.g. 'EE_KMD'.
    report_kind: string;
    // The frozen artifact filed — 'vat_report' in v1 (later 'annual_accounts').
    source_snapshot_type: string;
    source_snapshot_id: number;
    // 'prepared' | 'submitted' | 'accepted' | 'rejected'
    //   | 'correction_submitted' | 'correction_accepted'
    event_kind: string;
    // e-MTA confirmation id (nullable).
    external_ref: string | null;
    occurred_at: number;
    actor: string;
    note: string | null;
  }
  ```

- [ ] **Step 4 — Create the migration.** Create `src/database/migrations/050_create_statutory_submission_event.ts`:
  ```typescript
  import { Kysely, sql } from 'kysely';
  import { Database } from '../types';

  /**
   * ADR-0037: append-only statutory-submission event log.
   *
   * Jurisdiction-neutral log of the external statutory-filing lifecycle over an
   * immutable snapshot. One row per lifecycle event; the current filing state is
   * a fold over the events (no mutable status column). Every `submitted` event
   * pins the exact frozen source_snapshot_id (and thus the Merkle root).
   *
   * Immutability is enforced by BEFORE UPDATE/DELETE triggers (ADR-0009),
   * mirroring the vat_report and audit_log tables.
   */
  export async function up(db: Kysely<Database>): Promise<void> {
    await db.schema
      .createTable('statutory_submission_event')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('reporting_period_id', 'integer', (col) =>
        col.notNull().references('reporting_period.id'),
      )
      .addColumn('report_kind', 'text', (col) => col.notNull())
      .addColumn('source_snapshot_type', 'text', (col) => col.notNull())
      .addColumn('source_snapshot_id', 'integer', (col) => col.notNull())
      .addColumn('event_kind', 'text', (col) => col.notNull())
      .addColumn('external_ref', 'text')
      .addColumn('occurred_at', 'integer', (col) => col.notNull())
      .addColumn('actor', 'text', (col) => col.notNull())
      .addColumn('note', 'text')
      .execute();

    // Append-only (ADR-0009): block UPDATE.
    await sql`
      CREATE TRIGGER statutory_submission_event_block_update
      BEFORE UPDATE ON statutory_submission_event
      BEGIN
        SELECT RAISE(ABORT, 'statutory_submission_event is append-only');
      END;
    `.execute(db);

    // Append-only (ADR-0009): block DELETE.
    await sql`
      CREATE TRIGGER statutory_submission_event_block_delete
      BEFORE DELETE ON statutory_submission_event
      BEGIN
        SELECT RAISE(ABORT, 'statutory_submission_event is append-only');
      END;
    `.execute(db);
  }

  export async function down(db: Kysely<Database>): Promise<void> {
    await db.schema
      .dropTable('statutory_submission_event')
      .ifExists()
      .execute();
  }
  ```

- [ ] **Step 5 — Register the migration.** In `src/database/migrations/index.ts`, add the import alongside the others (namespace style, matching the file):
  ```typescript
  import * as m050 from './050_create_statutory_submission_event';
  ```
  and add the entry to the `migrations` record (after `'045_widen_entity_identifier_kind': m045,`):
  ```typescript
    '045_widen_entity_identifier_kind': m045,
    '050_create_statutory_submission_event': m050,
  ```

- [ ] **Step 6 — Run (expect PASS).** `npm test -- src/database/migrations/050_create_statutory_submission_event.spec.ts`. All three pass. Then `npm run typecheck`.

- [ ] **Step 7 — Commit.**
  ```bash
  git add src/database/migrations/050_create_statutory_submission_event.ts src/database/migrations/050_create_statutory_submission_event.spec.ts src/database/migrations/index.ts src/database/types.ts
  git commit -m "feat(statutory-submission): migration 050 append-only event log table"
  ```

---

### Task 2 — Pure fold function: events → derived filing state

**Files:**
- `src/statutory-submission/types.ts` (create)
- `src/statutory-submission/fold.ts` (create)
- `src/statutory-submission/fold.spec.ts` (create)

The fold is jurisdiction-neutral and pure. Filing state is derived: `prepared` → `submitted` → `accepted` | `rejected`; plus `correction_submitted` / `correction_accepted`. A format rejection is followed by a new `submitted` against the same snapshot. The derived `status` reflects the latest meaningful transition; `currentSnapshotId` is the snapshot of the most recent `submitted`/`correction_submitted` (or the `prepared` snapshot if none).

- [ ] **Step 1 — Failing fold test.** Create `src/statutory-submission/fold.spec.ts`:
  ```typescript
  import { foldSubmissionState, FoldEvent } from './fold';

  const ev = (over: Partial<FoldEvent>): FoldEvent => ({
    event_kind: 'prepared',
    source_snapshot_id: 1,
    occurred_at: 1000,
    external_ref: null,
    ...over,
  });

  describe('foldSubmissionState', () => {
    it('returns not_started for no events', () => {
      const state = foldSubmissionState([]);
      expect(state.status).toBe('not_started');
      expect(state.currentSnapshotId).toBeNull();
      expect(state.lastExternalRef).toBeNull();
    });

    it('prepared only → prepared', () => {
      const state = foldSubmissionState([
        ev({ event_kind: 'prepared', source_snapshot_id: 7 }),
      ]);
      expect(state.status).toBe('prepared');
      expect(state.currentSnapshotId).toBe(7);
    });

    it('prepared → submitted → submitted (pins snapshot + ref)', () => {
      const state = foldSubmissionState([
        ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
        ev({
          event_kind: 'submitted',
          source_snapshot_id: 7,
          occurred_at: 2000,
          external_ref: 'EMTA-1',
        }),
      ]);
      expect(state.status).toBe('submitted');
      expect(state.currentSnapshotId).toBe(7);
      expect(state.lastExternalRef).toBe('EMTA-1');
    });

    it('→ accepted', () => {
      const state = foldSubmissionState([
        ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
        ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
        ev({ event_kind: 'accepted', source_snapshot_id: 7, occurred_at: 3000, external_ref: 'EMTA-1' }),
      ]);
      expect(state.status).toBe('accepted');
      expect(state.currentSnapshotId).toBe(7);
    });

    it('→ rejected', () => {
      const state = foldSubmissionState([
        ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
        ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
        ev({ event_kind: 'rejected', source_snapshot_id: 7, occurred_at: 3000 }),
      ]);
      expect(state.status).toBe('rejected');
      expect(state.currentSnapshotId).toBe(7);
    });

    it('resubmission after a format rejection — two submitted, same snapshot', () => {
      const state = foldSubmissionState([
        ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
        ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
        ev({ event_kind: 'rejected', source_snapshot_id: 7, occurred_at: 3000 }),
        ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 4000, external_ref: 'EMTA-2' }),
      ]);
      expect(state.status).toBe('submitted');
      // Resubmission is against the SAME frozen snapshot.
      expect(state.currentSnapshotId).toBe(7);
      expect(state.lastExternalRef).toBe('EMTA-2');
      expect(state.submissionCount).toBe(2);
    });

    it('correction events → correction_accepted', () => {
      const state = foldSubmissionState([
        ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
        ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
        ev({ event_kind: 'accepted', source_snapshot_id: 7, occurred_at: 3000, external_ref: 'EMTA-1' }),
        ev({ event_kind: 'correction_submitted', source_snapshot_id: 7, occurred_at: 4000, external_ref: 'EMTA-C1' }),
        ev({ event_kind: 'correction_accepted', source_snapshot_id: 7, occurred_at: 5000, external_ref: 'EMTA-C1' }),
      ]);
      expect(state.status).toBe('correction_accepted');
      expect(state.lastExternalRef).toBe('EMTA-C1');
    });

    it('folds in occurred_at order regardless of input order', () => {
      const state = foldSubmissionState([
        ev({ event_kind: 'accepted', source_snapshot_id: 7, occurred_at: 3000 }),
        ev({ event_kind: 'prepared', source_snapshot_id: 7, occurred_at: 1000 }),
        ev({ event_kind: 'submitted', source_snapshot_id: 7, occurred_at: 2000, external_ref: 'EMTA-1' }),
      ]);
      expect(state.status).toBe('accepted');
    });
  });
  ```

- [ ] **Step 2 — Run (expect FAIL).** `npm test -- src/statutory-submission/fold.spec.ts`. Fails: `./fold` does not exist.

- [ ] **Step 3 — Create domain types.** Create `src/statutory-submission/types.ts`:
  ```typescript
  import { createZodDto } from 'nestjs-zod';
  import { z } from 'zod';

  /** The lifecycle events that can be recorded against a period (ADR-0037). */
  export const EVENT_KINDS = [
    'prepared',
    'submitted',
    'accepted',
    'rejected',
    'correction_submitted',
    'correction_accepted',
  ] as const;
  export type EventKind = (typeof EVENT_KINDS)[number];

  /** Operator-recordable kinds — `prepared` is system-emitted at lock only. */
  export const RECORDABLE_EVENT_KINDS = [
    'submitted',
    'accepted',
    'rejected',
    'correction_submitted',
    'correction_accepted',
  ] as const;

  /** The derived filing status (a fold output, never stored). */
  export type SubmissionStatus =
    | 'not_started'
    | 'prepared'
    | 'submitted'
    | 'accepted'
    | 'rejected'
    | 'correction_submitted'
    | 'correction_accepted';

  /** A persisted event, as returned in history. */
  export interface SubmissionEvent {
    id: number;
    reporting_period_id: number;
    report_kind: string;
    source_snapshot_type: string;
    source_snapshot_id: number;
    event_kind: EventKind;
    external_ref: string | null;
    occurred_at: number;
    actor: string;
    note: string | null;
  }

  /** Folded filing state + full ordered history for a period. */
  export interface SubmissionState {
    status: SubmissionStatus;
    currentSnapshotId: number | null;
    lastExternalRef: string | null;
    submissionCount: number;
    history: SubmissionEvent[];
  }

  export const recordSubmissionEventSchema = z.object({
    event_kind: z.enum(RECORDABLE_EVENT_KINDS),
    external_ref: z.string().optional(),
    note: z.string().optional(),
  });

  export class RecordSubmissionEventDto extends createZodDto(
    recordSubmissionEventSchema,
  ) {}
  ```

- [ ] **Step 4 — Create the fold.** Create `src/statutory-submission/fold.ts`:
  ```typescript
  import { EventKind, SubmissionStatus } from './types';

  /** Minimal event shape the fold needs — pure, jurisdiction-neutral. */
  export interface FoldEvent {
    event_kind: EventKind;
    source_snapshot_id: number;
    occurred_at: number;
    external_ref: string | null;
  }

  export interface FoldedState {
    status: SubmissionStatus;
    currentSnapshotId: number | null;
    lastExternalRef: string | null;
    submissionCount: number;
  }

  /**
   * Derive a period's filing state by folding its events (ADR-0037). Pure: no
   * DB, no clock. Events are folded in occurred_at order; the derived status is
   * the kind of the latest event, the current snapshot is the most recent
   * submission's snapshot (or the prepared snapshot if none), and the last
   * external ref is the most recent non-null ref. A format rejection followed
   * by a resubmission against the same snapshot is reflected as `submitted`
   * with submissionCount incremented and the snapshot unchanged.
   */
  export function foldSubmissionState(events: FoldEvent[]): FoldedState {
    if (events.length === 0) {
      return {
        status: 'not_started',
        currentSnapshotId: null,
        lastExternalRef: null,
        submissionCount: 0,
      };
    }

    const ordered = [...events].sort((a, b) => a.occurred_at - b.occurred_at);

    let status: SubmissionStatus = 'not_started';
    let currentSnapshotId: number | null = null;
    let lastExternalRef: string | null = null;
    let submissionCount = 0;

    for (const e of ordered) {
      status = e.event_kind;
      if (e.event_kind === 'prepared') {
        currentSnapshotId = e.source_snapshot_id;
      }
      if (
        e.event_kind === 'submitted' ||
        e.event_kind === 'correction_submitted'
      ) {
        currentSnapshotId = e.source_snapshot_id;
        submissionCount += 1;
      }
      if (e.external_ref !== null) {
        lastExternalRef = e.external_ref;
      }
    }

    return { status, currentSnapshotId, lastExternalRef, submissionCount };
  }
  ```

- [ ] **Step 5 — Run (expect PASS).** `npm test -- src/statutory-submission/fold.spec.ts`. All pass. Then `npm run typecheck`.

- [ ] **Step 6 — Commit.**
  ```bash
  git add src/statutory-submission/types.ts src/statutory-submission/fold.ts src/statutory-submission/fold.spec.ts
  git commit -m "feat(statutory-submission): pure fold of events to filing state"
  ```

---

### Task 3 — `StatutorySubmissionService`: recordEvent + getState (with audit-log side effect)

**Files:**
- `src/statutory-submission/statutory-submission.service.ts` (create)
- `src/statutory-submission/statutory-submission.module.ts` (create)
- `src/statutory-submission/statutory-submission.service.spec.ts` (create)

Note the **no-unlock invariant**: `recordEvent` only appends to the event log — it must never touch `reporting_period` or `vat_report`. A `rejected` event therefore leaves the period `locked` and the snapshot untouched.

- [ ] **Step 1 — Failing service test.** Create `src/statutory-submission/statutory-submission.service.spec.ts`:
  ```typescript
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { AuditLogService } from '../audit-log/audit-log.service';
  import { StatutorySubmissionService } from './statutory-submission.service';

  describe('StatutorySubmissionService (integration)', () => {
    let db: Kysely<Database>;
    let service: StatutorySubmissionService;

    const SNAPSHOT_ID = 1;

    beforeEach(async () => {
      const rawDb = new SqliteDb(':memory:');
      rawDb.pragma('foreign_keys = ON');
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });

      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      // A locked period with a frozen VAT snapshot.
      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-Q1',
          start_date: '2026-01-01',
          end_date: '2026-03-31',
          status: 'locked',
          filed_at: 1000,
          vat_report_snapshot_id: SNAPSHOT_ID,
          created_at: 1000,
        })
        .execute();
      await db
        .insertInto('vat_report')
        .values({
          reporting_period_id: 1,
          period_name: '2026-Q1',
          start_date: '2026-01-01',
          end_date: '2026-03-31',
          vat_summary: '[]',
          total_input_vat: 0,
          total_output_vat: 0,
          total_payable: 0,
          total_receivable: 0,
          voucher_ids: '[]',
          merkle_root: 'root-abc',
          generated_at: 1000,
        })
        .execute();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AuditLogService,
          StatutorySubmissionService,
        ],
      }).compile();
      service = module.get(StatutorySubmissionService);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('appends a submitted event pinning the snapshot, and folds to submitted', async () => {
      await service.recordEvent(1, {
        event_kind: 'submitted',
        external_ref: 'EMTA-1',
        note: 'uploaded KMD',
        actor: 'op-1',
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: SNAPSHOT_ID,
      });

      const state = await service.getState(1);
      expect(state.status).toBe('submitted');
      expect(state.currentSnapshotId).toBe(SNAPSHOT_ID);
      expect(state.lastExternalRef).toBe('EMTA-1');
      expect(state.history).toHaveLength(1);
      expect(state.history[0].event_kind).toBe('submitted');
      expect(state.history[0].source_snapshot_id).toBe(SNAPSHOT_ID);
      expect(state.history[0].actor).toBe('op-1');
    });

    it('writes an operational audit-log entry as a side effect', async () => {
      await service.recordEvent(1, {
        event_kind: 'submitted',
        external_ref: 'EMTA-1',
        actor: 'op-1',
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: SNAPSHOT_ID,
      });

      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(audit.actor).toBe('op-1');
      expect(audit.action).toBe('statutory_submission.event.submitted');
      expect(audit.target_type).toBe('reporting_period');
      expect(audit.target_id).toBe(1);
      expect(JSON.parse(audit.detail ?? '{}')).toMatchObject({
        event_kind: 'submitted',
        external_ref: 'EMTA-1',
        source_snapshot_id: SNAPSHOT_ID,
      });
    });

    it('records a resubmission against the SAME snapshot after a format rejection', async () => {
      const base = {
        actor: 'op-1',
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: SNAPSHOT_ID,
      };
      await service.recordEvent(1, { ...base, event_kind: 'submitted', external_ref: 'EMTA-1' });
      await service.recordEvent(1, { ...base, event_kind: 'rejected', note: 'schema error' });
      await service.recordEvent(1, { ...base, event_kind: 'submitted', external_ref: 'EMTA-2' });

      const state = await service.getState(1);
      expect(state.status).toBe('submitted');
      expect(state.submissionCount).toBe(2);
      expect(state.currentSnapshotId).toBe(SNAPSHOT_ID);
      expect(state.lastExternalRef).toBe('EMTA-2');
      // Both submissions pin the same frozen snapshot.
      const submitted = state.history.filter((h) => h.event_kind === 'submitted');
      expect(submitted.map((h) => h.source_snapshot_id)).toEqual([
        SNAPSHOT_ID,
        SNAPSHOT_ID,
      ]);
    });

    it('NO-UNLOCK INVARIANT: a rejected event leaves the period locked and the snapshot untouched', async () => {
      const snapBefore = await db
        .selectFrom('vat_report')
        .selectAll()
        .where('id', '=', SNAPSHOT_ID)
        .executeTakeFirstOrThrow();

      await service.recordEvent(1, {
        event_kind: 'rejected',
        note: 'rejected by e-MTA',
        actor: 'op-1',
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: SNAPSHOT_ID,
      });

      const period = await db
        .selectFrom('reporting_period')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      expect(period.status).toBe('locked');
      expect(period.vat_report_snapshot_id).toBe(SNAPSHOT_ID);

      const snapAfter = await db
        .selectFrom('vat_report')
        .selectAll()
        .where('id', '=', SNAPSHOT_ID)
        .executeTakeFirstOrThrow();
      expect(snapAfter).toEqual(snapBefore);

      const state = await service.getState(1);
      expect(state.status).toBe('rejected');
    });
  });
  ```

- [ ] **Step 2 — Run (expect FAIL).** `npm test -- src/statutory-submission/statutory-submission.service.spec.ts`. Fails: service does not exist.

- [ ] **Step 3 — Create the service.** Create `src/statutory-submission/statutory-submission.service.ts`:
  ```typescript
  import { Inject, Injectable } from '@nestjs/common';
  import { Kysely } from 'kysely';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import { Database } from '../database/types';
  import { AuditLogService } from '../audit-log/audit-log.service';
  import { foldSubmissionState } from './fold';
  import {
    EventKind,
    SubmissionEvent,
    SubmissionState,
  } from './types';

  /** Everything needed to append one lifecycle event. */
  export interface RecordEventInput {
    event_kind: EventKind;
    report_kind: string;
    source_snapshot_type: string;
    source_snapshot_id: number;
    actor: string;
    external_ref?: string | null;
    note?: string | null;
  }

  @Injectable()
  export class StatutorySubmissionService {
    constructor(
      @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
      private readonly db: Kysely<Database>,
      private readonly auditLog: AuditLogService,
    ) {}

    private now(): number {
      return Math.floor(Date.now() / 1000);
    }

    /**
     * Append one lifecycle event (ADR-0037) AND write an operational audit-log
     * entry (ADR-0026). Append-only: this never touches `reporting_period` or
     * `vat_report` — a `rejected` event therefore leaves the period locked and
     * the snapshot untouched (no-unlock invariant). v1 is operator-attested; no
     * e-MTA API is called.
     */
    async recordEvent(
      reportingPeriodId: number,
      input: RecordEventInput,
    ): Promise<SubmissionEvent> {
      const occurredAt = this.now();
      const externalRef = input.external_ref ?? null;
      const note = input.note ?? null;

      const row = await this.db
        .insertInto('statutory_submission_event')
        .values({
          reporting_period_id: reportingPeriodId,
          report_kind: input.report_kind,
          source_snapshot_type: input.source_snapshot_type,
          source_snapshot_id: input.source_snapshot_id,
          event_kind: input.event_kind,
          external_ref: externalRef,
          occurred_at: occurredAt,
          actor: input.actor,
          note,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.auditLog.record({
        actor: input.actor,
        action: `statutory_submission.event.${input.event_kind}`,
        outcome: 'recorded',
        target_type: 'reporting_period',
        target_id: reportingPeriodId,
        detail: {
          event_kind: input.event_kind,
          report_kind: input.report_kind,
          source_snapshot_type: input.source_snapshot_type,
          source_snapshot_id: input.source_snapshot_id,
          external_ref: externalRef,
        },
      });

      return this.mapRow(row);
    }

    /** Folded filing state + full ordered history for a period. */
    async getState(reportingPeriodId: number): Promise<SubmissionState> {
      const rows = await this.db
        .selectFrom('statutory_submission_event')
        .selectAll()
        .where('reporting_period_id', '=', reportingPeriodId)
        .orderBy('occurred_at', 'asc')
        .orderBy('id', 'asc')
        .execute();

      const history = rows.map((r) => this.mapRow(r));
      const folded = foldSubmissionState(
        history.map((h) => ({
          event_kind: h.event_kind,
          source_snapshot_id: h.source_snapshot_id,
          occurred_at: h.occurred_at,
          external_ref: h.external_ref,
        })),
      );

      return {
        status: folded.status,
        currentSnapshotId: folded.currentSnapshotId,
        lastExternalRef: folded.lastExternalRef,
        submissionCount: folded.submissionCount,
        history,
      };
    }

    private mapRow(row: {
      id: number;
      reporting_period_id: number;
      report_kind: string;
      source_snapshot_type: string;
      source_snapshot_id: number;
      event_kind: string;
      external_ref: string | null;
      occurred_at: number;
      actor: string;
      note: string | null;
    }): SubmissionEvent {
      return {
        id: row.id,
        reporting_period_id: row.reporting_period_id,
        report_kind: row.report_kind,
        source_snapshot_type: row.source_snapshot_type,
        source_snapshot_id: row.source_snapshot_id,
        event_kind: row.event_kind as EventKind,
        external_ref: row.external_ref,
        occurred_at: row.occurred_at,
        actor: row.actor,
        note: row.note,
      };
    }
  }
  ```

- [ ] **Step 4 — Create the module.** Create `src/statutory-submission/statutory-submission.module.ts`:
  ```typescript
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../database/database.module';
  import { AuditLogModule } from '../audit-log/audit-log.module';
  import { StatutorySubmissionService } from './statutory-submission.service';

  @Module({
    imports: [DatabaseModule, AuditLogModule],
    providers: [StatutorySubmissionService],
    exports: [StatutorySubmissionService],
  })
  export class StatutorySubmissionModule {}
  ```

- [ ] **Step 5 — Run (expect PASS).** `npm test -- src/statutory-submission/statutory-submission.service.spec.ts`. All four pass. Then `npm run typecheck`.

- [ ] **Step 6 — Commit.**
  ```bash
  git add src/statutory-submission/statutory-submission.service.ts src/statutory-submission/statutory-submission.module.ts src/statutory-submission/statutory-submission.service.spec.ts
  git commit -m "feat(statutory-submission): service recordEvent + getState with audit-log side effect"
  ```

---

### Task 4 — Lock hook: emit one `prepared` event pinned to the frozen snapshot

**Files:**
- `src/reporting-periods/reporting-periods.service.ts` (modify)
- `src/reporting-periods/reporting-periods.module.ts` (modify)
- `src/reporting-periods/statutory-submission-lock.spec.ts` (create)

**Seam justification:** the cleanest seam is to inject `StatutorySubmissionService` into `ReportingPeriodsService` and call `recordEvent` for the `prepared` event immediately after the existing lock transaction commits, using the snapshot id returned from the transaction. The lock transaction itself is left untouched (it must remain "snapshot + flip status, both or neither"); the `prepared` event is a derived consequence of a successful lock, so emitting it post-commit keeps the event log strictly downstream of the immutable artifact and avoids entangling the audit-log write with the ledger transaction. Idempotency is preserved: the early `return existing` for an already-locked period happens before the hook, so re-locking never emits a duplicate `prepared`.

- [ ] **Step 1 — Failing lock-hook test.** Create `src/reporting-periods/statutory-submission-lock.spec.ts`:
  ```typescript
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { ReportingPeriodsService } from './reporting-periods.service';
  import { VatReportService } from '../vat-report/vat-report.service';
  import { OrganizationService } from '../organization/organization.service';
  import { PluginLoader } from '../plugins/plugin-loader.service';
  import { NullCountryPlugin } from '../plugins/null-country.plugin';
  import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
  import { AuditLogService } from '../audit-log/audit-log.service';
  import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';

  describe('ReportingPeriod lock → prepared event (integration)', () => {
    let db: Kysely<Database>;
    let periods: ReportingPeriodsService;
    let submission: StatutorySubmissionService;

    beforeEach(async () => {
      const rawDb = new SqliteDb(':memory:');
      rawDb.pragma('foreign_keys = ON');
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });

      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      await db
        .insertInto('organization')
        .values({ country: 'EE', base_currency: null, vat_registered: 1, created_at: 1000 })
        .execute();
      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-Q1',
          start_date: '2026-01-01',
          end_date: '2026-03-31',
          status: 'open',
          filed_at: null,
          vat_report_snapshot_id: null,
          created_at: 1000,
        })
        .execute();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          ReportingPeriodsService,
          VatReportService,
          OrganizationService,
          PluginLoader,
          NullCountryPlugin,
          EstoniaCountryPlugin,
          AuditLogService,
          StatutorySubmissionService,
        ],
      }).compile();

      periods = module.get(ReportingPeriodsService);
      submission = module.get(StatutorySubmissionService);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('locking writes exactly one prepared event pinned to the frozen VAT snapshot, and stamps filed_at', async () => {
      const locked = await periods.lock(1);
      expect(locked.status).toBe('locked');
      expect(locked.filed_at).toBeGreaterThan(0);
      expect(locked.vat_report_snapshot_id).not.toBeNull();

      const state = await submission.getState(1);
      expect(state.status).toBe('prepared');
      expect(state.history).toHaveLength(1);
      const ev = state.history[0];
      expect(ev.event_kind).toBe('prepared');
      expect(ev.source_snapshot_type).toBe('vat_report');
      expect(ev.source_snapshot_id).toBe(locked.vat_report_snapshot_id);
      expect(ev.report_kind).toBe('EE_KMD');
    });

    it('re-locking is idempotent — no duplicate prepared event', async () => {
      await periods.lock(1);
      await periods.lock(1);
      const state = await submission.getState(1);
      expect(state.history).toHaveLength(1);
    });
  });
  ```

- [ ] **Step 2 — Run (expect FAIL).** `npm test -- src/reporting-periods/statutory-submission-lock.spec.ts`. Fails: `ReportingPeriodsService` does not depend on `StatutorySubmissionService` and emits no event.

- [ ] **Step 3 — Wire the dependency.** In `src/reporting-periods/reporting-periods.service.ts`, add the import after the existing plugin import:
  ```typescript
  import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
  ```
  Add the constructor parameter:
  ```typescript
    constructor(
      @InjectKysely() private readonly db: Kysely<Database>,
      private readonly vatReportService: VatReportService,
      private readonly organizationService: OrganizationService,
      private readonly pluginLoader: PluginLoader,
      private readonly statutorySubmissionService: StatutorySubmissionService,
    ) {}
  ```

- [ ] **Step 4 — Emit the prepared event after lock commits.** In the `lock` method, replace the final block:
  ```typescript
      const row = await this.db.transaction().execute(async (trx) => {
        // 1. Generate the immutable VAT snapshot inside the filing transaction.
        const snapshot = await this.vatReportService.generate(id, trx);

        // 2. Lock the period and bind it to the snapshot, atomically.
        return trx
          .updateTable('reporting_period')
          .set({
            status: 'locked',
            filed_at: filedAt,
            vat_report_snapshot_id: snapshot.id,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      });

      return this.mapRow(row);
  ```
  with:
  ```typescript
      const row = await this.db.transaction().execute(async (trx) => {
        // 1. Generate the immutable VAT snapshot inside the filing transaction.
        const snapshot = await this.vatReportService.generate(id, trx);

        // 2. Lock the period and bind it to the snapshot, atomically.
        return trx
          .updateTable('reporting_period')
          .set({
            status: 'locked',
            filed_at: filedAt,
            vat_report_snapshot_id: snapshot.id,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      });

      // 3. Start the external statutory-filing lifecycle (ADR-0037): record a
      //    `prepared` event pinned to the exact frozen snapshot. filed_at keeps
      //    its meaning (the internal lock/close timestamp) and corresponds to
      //    this event. Emitted post-commit so the event log is strictly
      //    downstream of the immutable artifact; the early idempotent return
      //    above ensures re-locking never emits a duplicate.
      await this.statutorySubmissionService.recordEvent(id, {
        event_kind: 'prepared',
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: row.vat_report_snapshot_id as number,
        actor: 'system',
      });

      return this.mapRow(row);
  ```

- [ ] **Step 5 — Wire the module.** In `src/reporting-periods/reporting-periods.module.ts`, add the import and include it in `imports`:
  ```typescript
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../database/database.module';
  import { VatReportModule } from '../vat-report/vat-report.module';
  import { OrganizationModule } from '../organization/organization.module';
  import { PluginsModule } from '../plugins/plugins.module';
  import { StatutorySubmissionModule } from '../statutory-submission/statutory-submission.module';
  import { ReportingPeriodsController } from './reporting-periods.controller';
  import { ReportingPeriodsService } from './reporting-periods.service';

  @Module({
    imports: [
      DatabaseModule,
      VatReportModule,
      OrganizationModule,
      PluginsModule,
      StatutorySubmissionModule,
    ],
    controllers: [ReportingPeriodsController],
    providers: [ReportingPeriodsService],
    exports: [ReportingPeriodsService],
  })
  export class ReportingPeriodsModule {}
  ```

- [ ] **Step 6 — Run (expect PASS).** `npm test -- src/reporting-periods/statutory-submission-lock.spec.ts`. Both pass. Then run the existing lock suite to confirm no regression: `npm test -- src/reporting-periods/reporting-periods-lock.spec.ts`. Then `npm run typecheck`.

- [ ] **Step 7 — Commit.**
  ```bash
  git add src/reporting-periods/reporting-periods.service.ts src/reporting-periods/reporting-periods.module.ts src/reporting-periods/statutory-submission-lock.spec.ts
  git commit -m "feat(reporting-periods): emit prepared submission event on lock"
  ```

---

### Task 5 — Controller: record event + read folded state, and app wiring

**Files:**
- `src/statutory-submission/statutory-submission.controller.ts` (create)
- `src/statutory-submission/statutory-submission.module.ts` (modify)
- `src/statutory-submission/statutory-submission.controller.spec.ts` (create)
- `src/app.module.ts` (modify)

The controller's `actor` for operator-recorded events comes from a fixed `'operator'` value in v1 (no auth-context plumbing in scope; matches the operator-attested model). `report_kind` / `source_snapshot_type` / `source_snapshot_id` are resolved from the period's frozen snapshot so the operator only supplies `event_kind` + optional `external_ref`/`note` — and every `submitted` is pinned to the exact frozen snapshot.

- [ ] **Step 1 — Failing controller test.** Create `src/statutory-submission/statutory-submission.controller.spec.ts`:
  ```typescript
  import { Test, TestingModule } from '@nestjs/testing';
  import { Kysely, SqliteDialect } from 'kysely';
  import { Migrator } from 'kysely/migration';
  import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
  import SqliteDb from 'better-sqlite3';
  import { NotFoundException } from '@nestjs/common';
  import { Database } from '../database/types';
  import { migrations } from '../database/migrations';
  import { AuditLogService } from '../audit-log/audit-log.service';
  import { StatutorySubmissionService } from './statutory-submission.service';
  import { StatutorySubmissionController } from './statutory-submission.controller';

  describe('StatutorySubmissionController (integration)', () => {
    let db: Kysely<Database>;
    let controller: StatutorySubmissionController;

    const SNAPSHOT_ID = 1;

    beforeEach(async () => {
      const rawDb = new SqliteDb(':memory:');
      rawDb.pragma('foreign_keys = ON');
      db = new Kysely<Database>({ dialect: new SqliteDialect({ database: rawDb }) });

      const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateToLatest();
      if (error) throw error instanceof Error ? error : new Error('Migration failed');

      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-Q1',
          start_date: '2026-01-01',
          end_date: '2026-03-31',
          status: 'locked',
          filed_at: 1000,
          vat_report_snapshot_id: SNAPSHOT_ID,
          created_at: 1000,
        })
        .execute();
      await db
        .insertInto('vat_report')
        .values({
          reporting_period_id: 1,
          period_name: '2026-Q1',
          start_date: '2026-01-01',
          end_date: '2026-03-31',
          vat_summary: '[]',
          total_input_vat: 0,
          total_output_vat: 0,
          total_payable: 0,
          total_receivable: 0,
          voucher_ids: '[]',
          merkle_root: 'root-abc',
          generated_at: 1000,
        })
        .execute();

      const module: TestingModule = await Test.createTestingModule({
        controllers: [StatutorySubmissionController],
        providers: [
          { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
          AuditLogService,
          StatutorySubmissionService,
        ],
      }).compile();
      controller = module.get(StatutorySubmissionController);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it('POST records an event pinned to the period snapshot and returns it', async () => {
      const ev = await controller.recordEvent(1, {
        event_kind: 'submitted',
        external_ref: 'EMTA-1',
      });
      expect(ev.event_kind).toBe('submitted');
      expect(ev.source_snapshot_type).toBe('vat_report');
      expect(ev.source_snapshot_id).toBe(SNAPSHOT_ID);
      expect(ev.external_ref).toBe('EMTA-1');
      expect(ev.actor).toBe('operator');
    });

    it('GET returns the folded state plus full history', async () => {
      await controller.recordEvent(1, { event_kind: 'submitted', external_ref: 'EMTA-1' });
      await controller.recordEvent(1, { event_kind: 'accepted', external_ref: 'EMTA-1' });

      const state = await controller.getState(1);
      expect(state.status).toBe('accepted');
      expect(state.currentSnapshotId).toBe(SNAPSHOT_ID);
      expect(state.history).toHaveLength(2);
      expect(state.history.map((h) => h.event_kind)).toEqual([
        'submitted',
        'accepted',
      ]);
    });

    it('POST 404s when the period has no frozen snapshot', async () => {
      await db
        .insertInto('reporting_period')
        .values({
          name: '2026-Q2',
          start_date: '2026-04-01',
          end_date: '2026-06-30',
          status: 'open',
          filed_at: null,
          vat_report_snapshot_id: null,
          created_at: 1000,
        })
        .execute();
      await expect(
        controller.recordEvent(2, { event_kind: 'submitted' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
  ```

- [ ] **Step 2 — Run (expect FAIL).** `npm test -- src/statutory-submission/statutory-submission.controller.spec.ts`. Fails: controller does not exist.

- [ ] **Step 3 — Add the snapshot-resolving record path to the service.** In `src/statutory-submission/statutory-submission.service.ts`, add the import of the DTO type at the top:
  ```typescript
  import { RecordSubmissionEventDto } from './types';
  ```
  and add this method to the class (it resolves the pinned snapshot from the period so the operator never supplies it — and 404s if the period was never locked):
  ```typescript
    /**
     * Operator-attested record path used by the REST surface. Resolves the
     * pinned snapshot from the period's frozen VAT report (the operator only
     * supplies event_kind + optional external_ref/note). Every `submitted` is
     * thus pinned to the exact frozen snapshot. 404s if the period has no
     * frozen snapshot (i.e. it was never locked).
     */
    async recordOperatorEvent(
      reportingPeriodId: number,
      dto: RecordSubmissionEventDto,
    ): Promise<SubmissionEvent> {
      const period = await this.db
        .selectFrom('reporting_period')
        .select(['id', 'vat_report_snapshot_id'])
        .where('id', '=', reportingPeriodId)
        .executeTakeFirst();

      if (!period || period.vat_report_snapshot_id === null) {
        throw new NotFoundException(
          `Reporting period ${reportingPeriodId} has no frozen VAT snapshot — lock it before recording submission events.`,
        );
      }

      return this.recordEvent(reportingPeriodId, {
        event_kind: dto.event_kind,
        report_kind: 'EE_KMD',
        source_snapshot_type: 'vat_report',
        source_snapshot_id: period.vat_report_snapshot_id,
        actor: 'operator',
        external_ref: dto.external_ref ?? null,
        note: dto.note ?? null,
      });
    }
  ```
  and add `NotFoundException` to the `@nestjs/common` import:
  ```typescript
  import { Inject, Injectable, NotFoundException } from '@nestjs/common';
  ```

- [ ] **Step 4 — Create the controller.** Create `src/statutory-submission/statutory-submission.controller.ts`:
  ```typescript
  import { Controller, Get, Post, Param, Body, ParseIntPipe } from '@nestjs/common';
  import { ApiTags } from '@nestjs/swagger';
  import { StatutorySubmissionService } from './statutory-submission.service';
  import { RecordSubmissionEventDto } from './types';
  import type { SubmissionEvent, SubmissionState } from './types';

  @ApiTags('statutory-submission')
  @Controller('api/reporting-periods')
  export class StatutorySubmissionController {
    constructor(private readonly service: StatutorySubmissionService) {}

    @Post(':id/submission-events')
    async recordEvent(
      @Param('id', ParseIntPipe) id: number,
      @Body() dto: RecordSubmissionEventDto,
    ): Promise<SubmissionEvent> {
      return this.service.recordOperatorEvent(id, dto);
    }

    @Get(':id/submission-state')
    async getState(
      @Param('id', ParseIntPipe) id: number,
    ): Promise<SubmissionState> {
      return this.service.getState(id);
    }
  }
  ```

- [ ] **Step 5 — Register the controller in the module.** In `src/statutory-submission/statutory-submission.module.ts`, add the controller import and the `controllers` array:
  ```typescript
  import { Module } from '@nestjs/common';
  import { DatabaseModule } from '../database/database.module';
  import { AuditLogModule } from '../audit-log/audit-log.module';
  import { StatutorySubmissionService } from './statutory-submission.service';
  import { StatutorySubmissionController } from './statutory-submission.controller';

  @Module({
    imports: [DatabaseModule, AuditLogModule],
    controllers: [StatutorySubmissionController],
    providers: [StatutorySubmissionService],
    exports: [StatutorySubmissionService],
  })
  export class StatutorySubmissionModule {}
  ```

- [ ] **Step 6 — Register the module in app.module.** In `src/app.module.ts`, add the import near the other module imports:
  ```typescript
  import { StatutorySubmissionModule } from './statutory-submission/statutory-submission.module';
  ```
  and add `StatutorySubmissionModule,` to the `imports` array (e.g. directly after `ReportingPeriodsModule,`):
  ```typescript
      ReportingPeriodsModule,
      StatutorySubmissionModule,
  ```

- [ ] **Step 7 — Run (expect PASS).** `npm test -- src/statutory-submission/statutory-submission.controller.spec.ts`. All three pass. Then re-run the service spec to confirm no regression from the new import: `npm test -- src/statutory-submission/statutory-submission.service.spec.ts`. Then `npm run typecheck` and `npm run lint`.

- [ ] **Step 8 — Commit.**
  ```bash
  git add src/statutory-submission/statutory-submission.controller.ts src/statutory-submission/statutory-submission.controller.spec.ts src/statutory-submission/statutory-submission.module.ts src/statutory-submission/statutory-submission.service.ts src/app.module.ts
  git commit -m "feat(statutory-submission): REST surface for recording events and reading folded state"
  ```

---

## Self-Review — PRD requirement coverage

- **Append-only kernel table `statutory_submission_event` with all PRD columns + immutability triggers** → Task 1 (migration 050, `types.ts`, trigger UPDATE/DELETE rejection tests).
- **Event kinds form the lifecycle; state is a fold; no mutable status column** → Task 2 (`fold.ts`, `EVENT_KINDS`, pure tests for prepared/submitted/accepted/rejected/resubmission/correction).
- **`prepared` written on lock, pinned to frozen snapshot; `filed_at` keeps its meaning** → Task 4 (lock hook; idempotency test; `filed_at` assertion).
- **Operator-attested service writing event + audit-log entry (ADR-0026); no e-MTA API** → Task 3 (`recordEvent` + `AuditLogService.record`; audit side-effect test).
- **Fold derives filing state (single source of truth)** → Task 2 + `getState` in Task 3.
- **Every `submitted` pins `source_snapshot_id`; history shows pinned snapshot incl. resubmission after format rejection** → Task 3 (resubmission test, same snapshot) + Task 5 (controller resolves pin from period snapshot).
- **No-unlock invariant: a `rejected` event leaves period locked + snapshot untouched** → Task 3 (explicit no-unlock test) and called out in the service doc + Task heading.
- **REST: `POST /:id/submission-events` (Zod DTO: event_kind, optional external_ref, optional note) + `GET /:id/submission-state` (folded state + history); module wiring + app.module** → Task 5.
- **Jurisdiction-neutral table reusable for annual accounts** → `source_snapshot_type` column is free-form text; `report_kind` parameterized (default `'EE_KMD'` in v1).

Consistency checks performed: service method names (`recordEvent`, `recordOperatorEvent`, `getState`) match across service, controller, and all specs; the fold input shape (`FoldEvent`) matches what `getState` maps; `Database` key `statutory_submission_event` matches the migration table name and every `insertInto`/`selectFrom`; the DTO enum `RECORDABLE_EVENT_KINDS` excludes `prepared` (system-only) while `EVENT_KINDS` includes it for the fold; `vat_report` snapshot insert columns in specs match the real `VatReportTable`; migration index uses `import * as` namespace style to match the existing file. No placeholders or TODOs remain. Migration number 050 sits in the allotted 050–051 range (fixed-assets owns 046–049, annual-accounts owns 052–053).
