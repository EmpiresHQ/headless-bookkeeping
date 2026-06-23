# Intake processing queue — design

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Author:** brainstorming session (aleksei@verifi.finance)

## Problem

The iOS app can flood intake with images (e.g. a batch of 50 photos uploaded
back-to-back). Today each `POST /api/documents` only stores the file as
`status='pending'` and returns immediately; the heavy work — Pass-1 OCR via the
external vision endpoint (LiteLLM → dots.ocr, a single inference endpoint) plus
Pass-2 LLM classification — runs in a separate `POST /api/documents/:id/triage`
call.

We want intake documents **processed one at a time, not simultaneously**, so a
burst of uploads does not fire N concurrent OCR/LLM pipelines at the single
vision endpoint. The intent is to **auto-process on upload** (the operator
should not have to manually trigger triage for every iOS photo), but serialized.

## Approach

Three layers, each largely already present:

1. **Durable backlog** — documents with `status='pending'` in the DB. `upload`
   stores `pending` and returns `201` immediately (iOS never waits for OCR). A
   burst of 50 photos is simply 50 `pending` rows. No new storage.

2. **Global serializer (concurrency = 1)** — a single in-process gate
   (mutex / promise-chain of size 1) in the Node process. **All processing
   passes through it** — both the queue worker and the manual `POST /triage`.
   This is the "one at a time" guarantee: at most one OCR+LLM pipeline runs at
   any instant, so the vision endpoint is never hit concurrently.

3. **Per-document in-flight marker** — the existing `processing_since` column.
   Set atomically on claim, cleared in `finally`. Powers the "Processing…" view
   in the SPA and serves as the crash-recovery marker.

**Key assumption:** the server runs as a single Node (NestJS) process, so an
in-process mutex is a sufficient global serializer. Multi-instance deployment
(which would need a DB advisory lock) is explicitly out of scope (YAGNI for a
self-hosted single-instance bookkeeping system).

## Scope decisions

- Auto-processing applies to **all channels** (iOS, web, CLI), not just iOS.
- The manual `POST /api/documents/:id/triage` endpoint **stays** as a re-run /
  debug path. It is idempotent and now acquires the same global gate, so an
  operator cannot run OCR concurrently with the worker.
- The web SPA no longer needs to drive triage itself after upload — it just
  shows status. (Exact SPA changes are an implementation-plan detail.)

## Components

### `IntakeQueueWorker` (new NestJS singleton, in the `triage`/`intake` module)

- **`kick()` / `enqueue(documentId)`** — non-blocking "there is work" signal.
  Called from `DocumentsService.upload` after a successful save (all channels).
  Does not await processing.
- **Drain loop (single-flight)** — while a claimable document exists:
  claim → `process()` → repeat. When the queue is empty, it sleeps until the
  next `kick()`. A "draining" flag prevents concurrent `kick()`s from starting
  two drain loops.
- **`onModuleInit()`** — one `kick()` at startup: picks up `pending` documents
  accumulated while the server was down and reclaims stuck in-flight rows.
- **`@Cron` safety sweep** (every N minutes) — a backstop `kick()` in case a
  signal was lost. Cheap: an empty queue costs a single `SELECT`.

### Global gate

A small in-process mutex (concurrency = 1) — e.g. a promise-chain or
`async-mutex` — wrapping the call to `IntakeWorkflowService.process()`. The
manual triage route acquires the **same** gate.

### Atomic claim

`markProcessing` changes from an unconditional stamp to a **compare-and-set**:

```sql
UPDATE document
   SET processing_since = :now
 WHERE id = :id
   AND status = 'pending'
   AND (processing_since IS NULL OR processing_since < :staleThreshold)
```

One row affected → claim won; otherwise the document is already claimed (or no
longer `pending`). This makes `processing_since` a real lock and simultaneously
enables reclaim of stuck rows (`processing_since` older than `staleThreshold`,
e.g. 5 minutes).

### Next-document selection

`status='pending' AND (processing_since IS NULL OR processing_since < :stale)`,
`ORDER BY created_at ASC` (FIFO), `LIMIT 1`.

`IntakeWorkflowService.process()` itself is essentially unchanged: it is already
idempotent (status guard + reuse of existing finding/draft) and already
sets/clears `processing_since`. The worker only orchestrates *which* document
and *when*, under the global gate.

## Data flow

```
iOS uploads 50 photos  ──>  50 × POST /api/documents
   each: upload() stores pending  ──> 201 immediately  ──> kick()
                                                    │
                          IntakeQueueWorker (single drain loop)
                                                    │
   while claimable:
     ┌─ claim oldest pending (CAS on processing_since)
     ├─ via GLOBAL GATE: workflow.process(id)   ← exactly one at a time
     │     Pass-1 OCR (dots.ocr) → Pass-2 LLM → routing
     ├─ status → triaged / needs_triage  (drops out of pending)
     └─ next
```

The vision endpoint sees a strictly sequential stream, not 50 parallel requests.

## Crash recovery

- Documents stay `pending`. In-flight ones carry a stale `processing_since`.
- `onModuleInit` fires `kick()`; the CAS claim reclaims both unmarked `pending`
  and stale in-flight rows (marker older than `staleThreshold`).
- `process()` is idempotent, so re-running a partially processed document is
  safe.

## Failure handling

- OCR / Pass-2 failure → existing logic routes the document to `needs_triage`
  (a human). It **leaves `pending`**, so there is no retry loop and the worker
  moves on.
- Unexpected exception in `process()` → `finally` clears `processing_since`; the
  worker catches, logs, **does not crash**, and takes the next document. The row
  stays `pending` and is retried on the next `kick`/sweep (guarded by
  `staleThreshold`).
- **Poison-document guard:** if the CAS keeps re-claiming the same `pending`
  document that throws (without routing to `needs_triage`), bound retries with
  an attempt counter and force `needs_triage` (or an `error` status) after N
  failures, so one bad file cannot block the queue forever.

## Edge cases

- **Dedup (both layers):** iOS does a CRC32 precheck to avoid re-uploading at
  all; the server additionally dedups by SHA-256 in `upload` and returns
  `deduplicated: true` without creating a new `pending` row. `kick()` is a safe
  no-op in that case — if the document is no longer `pending`, the CAS claim
  simply does not win.
- **Manual triage during a drain:** both take the same gate → serialized; the
  CAS prevents processing one document twice.
- **Empty queue:** the drain loop exits after a single `SELECT` — cheap.

## Testing

- **Serialization:** with a fake/slow vision transcriber, enqueue many documents
  and assert the gate never has >1 concurrent `process()` in flight.
- **FIFO ordering:** documents are claimed oldest-first.
- **Crash recovery:** a row with a stale `processing_since` is reclaimed on
  startup; a fresh `processing_since` (within `staleThreshold`) is not stolen.
- **Idempotent re-run:** re-processing a `triaged`/`needs_triage` document does
  not create a duplicate finding/draft.
- **Failure isolation:** a throwing document does not stop the worker; after N
  attempts it is parked (poison guard).
- **Dedup no-op:** a duplicate upload does not create a second `pending` row and
  the `kick()` claims nothing.
- **Manual + worker mutual exclusion:** a manual triage and a worker drain on
  the same document do not both run `process()`.

## Out of scope

- Multi-instance / horizontal scaling (would require a DB advisory lock).
- External queue infrastructure (Redis/BullMQ).
- Configurable concurrency > 1 (the whole point is concurrency = 1).
