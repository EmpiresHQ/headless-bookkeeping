# PRD: Statutory-filing submission lifecycle as an append-only event log over the immutable snapshot

> Source ADR: [ADR-0037](../adr/0037-statutory-submission-lifecycle-event-log.md). First consumer is the KMD VAT snapshot (ADR-0033); the [Annual Accounts PRD](./0034-annual-accounts.md) becomes the second consumer once it has a frozen snapshot.

## Problem Statement

Locking a reporting period (ADR-0015) freezes an immutable VAT report snapshot, flips the period to `locked`, and stamps `filed_at`. That captures the **internal** act — we closed the books and consider the period filed. It says **nothing** about what happened with the tax authority: was the KMD XML actually uploaded to e-MTA, and when? Did e-MTA accept or reject it, and under what confirmation reference? Was a correction declaration (parandusdeklaratsioon) later filed? Because we derive the declaration on read and freeze only the VAT report, there is nowhere today to record "submitted" or "accepted." The snapshot is immutable and the period is no-break-glass, so submission status must not live on either, must never mutate them, and must never unlock the period.

## Solution

A new append-only event log records what we filed and what happened to it. When a period is locked, a `prepared` event is recorded against the exact frozen snapshot. The operator then reports back what happened at the portal — "submitted on X with ref Y", "accepted", or "rejected because Z" — and each report appends an event; the system never calls an e-MTA API. The period's filing state is **derived by folding its events** (mirroring how the VAT report itself is derived, not stored), so there is no mutable status column to protect. Every `submitted` event pins the exact snapshot (and thus the Merkle root) that was filed, so "what we told the tax authority" is always reconstructable byte-for-byte and provable against the hash chain. A rejection never reopens the period: a format/schema rejection is fixed by regenerating the XML from the same frozen snapshot and resubmitting; a substantive error is corrected forward via the existing no-break-glass path.

## User Stories

1. As an operator, I want a `prepared` event recorded automatically when I lock a period, so that the filing lifecycle starts from the exact frozen snapshot.
2. As an operator, I want to record that I submitted the declaration to e-MTA with a date and confirmation reference, so that there is a durable record of when and what I filed.
3. As an operator, I want to record that e-MTA accepted the declaration, so that I can later answer "is this period accepted?" with confidence.
4. As an operator, I want to record that e-MTA rejected the declaration with a reason, so that the rejection and its cause are part of the history.
5. As an operator, I want to record a correction declaration (parandusdeklaratsioon) submitted and accepted, so that an amended filing is tracked.
6. As an operator, I want the period's filing state computed by folding its events, so that the state is always consistent with the recorded history and there is no separate status to fall out of sync.
7. As an operator, I want to see the full submission history of a period (resubmissions, refs, dates), so that I can audit exactly what happened.
8. As an operator, I want a rejection never to unlock or reopen the period, so that the locked, immutable books stay intact.
9. As an operator with a format/schema rejection, I want to regenerate the XML from the same frozen snapshot and record a new submission against the same snapshot, so that I can resubmit without changing any books.
10. As an operator with a substantive error, I want to correct the books forward in the open period and record the correction events, so that I follow no-break-glass rather than editing the locked period.
11. As an auditor, I want every `submitted` event to pin the exact snapshot id (and Merkle root) filed, so that the filed artifact is reconstructable and provable against the hash chain.
12. As an auditor, I want the event log to be append-only (no update, no delete), so that the filing history is tamper-evident.
13. As an operator, I want each submission event also written to the operational audit log, so that filing actions appear alongside other operator actions.
14. As a developer adding a new jurisdiction, I want the same event table to serve any `report_kind`, so that only the plugin artifact differs, not the lifecycle machinery.
15. As a maintainer, I want `reporting_period.filed_at` to keep its current meaning (the internal lock/close timestamp, corresponding to the `prepared` event), so that the external lifecycle lives entirely in the event log and the period row is not extended.
16. As a future consumer, I want the annual-accounts snapshot to plug into the same log (`source_snapshot_type = annual_accounts`), so that annual filings get the same lifecycle without new machinery.

## Implementation Decisions

- **New kernel append-only table `statutory_submission_event`** — jurisdiction-neutral. Columns: `id`, `reporting_period_id` (FK), `report_kind` (e.g. `EE_KMD`), `source_snapshot_type` + `source_snapshot_id` (the exact frozen artifact filed — `vat_report` in v1), `event_kind`, `external_ref` (e-MTA confirmation id, nullable), `occurred_at`, `actor`, `note`. Append-only via `BEFORE UPDATE`/`BEFORE DELETE` triggers, reusing the existing immutability pattern (as on `vat_report` / `audit_log`).
- **Event kinds form the lifecycle:** `prepared` → `submitted` → `accepted` | `rejected`; plus `correction_submitted` / `correction_accepted`. **No mutable status column** — current state is a fold over the events.
- **A `prepared` event is written when a period is locked**, against the frozen snapshot, by hooking the existing lock operation. `reporting_period.filed_at` keeps its meaning and corresponds to `prepared`; the period row is not extended.
- **Operator-attested, not an integration.** No e-MTA API call (consistent with ADR-0034 §5). A service writes the event **and** an operational audit-log entry (ADR-0026). Auto-submission stays out of scope.
- **A fold function derives filing state** from a period's events (pure, jurisdiction-neutral) — the single source of truth for "is this period submitted/accepted/rejected?".
- **Every `submitted` event pins `source_snapshot_id`** (and thus the Merkle root), so the filed artifact is reconstructable byte-for-byte and provable against the hash chain.
- **Rejection is orthogonal to open/locked and never unlocks.** Format/schema rejection → regenerate XML from the same frozen snapshot, record a new `submitted` against the **same** `source_snapshot_id`, no books change. Substantive error → correct forward via reversal + new voucher in the current open period (ADR-0012/0015), never by editing the locked period.
- **REST surface:** `POST /api/reporting-periods/:id/submission-events` to record an event (kind, optional external ref, optional note); a read that returns the folded filing state plus the full event history (e.g. `GET /api/reporting-periods/:id/submission-state`).
- **DTOs are Zod-backed** (`createZodDto`) for the record-event request, matching the existing convention.

## Testing Decisions

- **What makes a good test here**: assert external behavior — the events written, the folded state returned, the append-only guarantee, and the audit-log side effect — not internal storage shape.
- **Fold function — pure unit tests**: given event sequences, assert the derived state — `prepared` only; `prepared`→`submitted`; →`accepted`; →`rejected`; resubmission after a format rejection (two `submitted`, same snapshot); correction events. Deterministic, no DB.
- **Append-only — integration test** (in-memory SQLite, run migrations): inserting events works; an `UPDATE` or `DELETE` on `statutory_submission_event` is rejected by the triggers. Prior art: the `vat_report` immutability migration tests.
- **Lock hook — integration test**: locking a period writes exactly one `prepared` event pinned to the frozen VAT snapshot, and `filed_at` is stamped as before.
- **Snapshot pinning — integration test**: a `submitted` event records the exact `source_snapshot_id`; the folded history shows the pinned snapshot for each submission, including a resubmission against the same snapshot after a format rejection.
- **Audit-log side effect — integration test**: recording a submission event also writes an audit-log entry.
- **No-unlock invariant — test**: a `rejected` event leaves the period `locked` and the snapshot untouched.

## Out of Scope

- Calling any e-MTA API (auto-submission) — operator-attested only.
- Reconciling a period-scoped Estonian parandusdeklaratsioon (which amends the **original** period's declaration at e-MTA) against our forward-corrected books — v1 records the correction as events and relies on forward-correction for the ledger; the reconciliation is deferred to a future ADR.
- A mutable status column on the period or the snapshot.
- Extending the `reporting_period` row.

## Further Notes

- This adds the external-lifecycle visibility that a stored `SUBMITTED/ACCEPTED` status would give — **without** giving up derive-on-read, the immutable snapshot, or no-break-glass.
- **Known gap (carried from ADR-0037):** the parandusdeklaratsioon period-scoping vs forward-correction mismatch is explicitly deferred.
- The same table serves the annual accounts as a second consumer once that snapshot exists; only `report_kind` and the plugin artifact differ.
