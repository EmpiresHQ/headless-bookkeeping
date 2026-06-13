# Statutory-filing submission lifecycle tracked as an append-only event log over the immutable snapshot

## Status
Proposed (2026-06-13).

## Context
Locking a reporting period (ADR-0015) freezes an **immutable VAT report
snapshot** (Merkle root, ADR-0013), flips the period to `locked`, and stamps
`filed_at`. That captures the **internal** act — we closed the books for the
period and consider it filed. It says **nothing** about what happened with the
tax authority:

- Was the KMD XML actually uploaded to e-MTA, and when?
- Did e-MTA **accept** or **reject** it? Under what confirmation reference?
- Was a correction declaration (**parandusdeklaratsioon**) later filed?

open-accounting models a **stored** declaration with `DRAFT / SUBMITTED /
ACCEPTED` status. We deliberately **derive** the declaration on read (ADR-0033;
no stored copy of the form) and freeze only the VAT report — so we have nowhere
today to record "submitted" or "accepted". The snapshot is immutable (triggers,
ADR-0009) and the period is no-break-glass (ADR-0012): submission status must
**not** live on either, must never mutate them, and must never unlock the period.

## Decision

**1. A new kernel append-only table `statutory_submission_event`** —
jurisdiction-neutral. Recording *what we filed and what happened* is kernel
bookkeeping; XML/artifact generation stays behind the country-plugin seam
(ADR-0033). Columns: `id`, `reporting_period_id` (FK), `report_kind`
(e.g. `EE_KMD`), `source_snapshot_type` + `source_snapshot_id` (the exact frozen
artifact filed — `vat_report` in v1), `event_kind`, `external_ref` (e-MTA
confirmation id, nullable), `occurred_at`, `actor`, `note`. Append-only via
`BEFORE UPDATE/DELETE` triggers, reusing the ADR-0009 immutability pattern.

**2. Event kinds form the lifecycle, and current state is a fold.**
`prepared` (snapshot generated at lock) → `submitted` (operator uploaded to
e-MTA) → `accepted` | `rejected`; plus `correction_submitted` /
`correction_accepted` for a parandusdeklaratsioon. A period's **filing state is
derived by folding its events** — mirroring how the VAT report itself is derived,
not stored. No mutable status column (which would need its own immutability
story); the log *is* the truth.

**3. Operator-attested, not an integration.** We do **not** call an e-MTA API
(consistent with ADR-0034 §5 — the operator uploads the file). The operator
reports back what happened ("submitted on X, ref Y"; "accepted"; "rejected
because Z") through a service that writes the event and an audit-log entry
(ADR-0026). Auto-submission stays out of scope.

**4. Orthogonal to open/locked; never unlocks.** A `rejected` event does not
reopen the period. Two rejection paths:
- **Format/schema rejection** (numbers correct, XML malformed): regenerate the
  XML from the **same** frozen snapshot and resubmit — a new `submitted` event
  against the **same** `source_snapshot_id`. No books change.
- **Substantive error** (a figure was wrong): the books are corrected **forward**
  via the existing no-break-glass path (reversal + new voucher in the current
  open period, ADR-0012/0015) — never by editing the locked period.

**5. Every `submitted` event pins the exact `source_snapshot_id`** (and thus the
Merkle root) that was filed, so "what we told the tax authority" is always
reconstructable byte-for-byte and provable against the hash chain.

**6. `reporting_period.filed_at` keeps its current meaning** — the internal
lock/close timestamp — and corresponds to the `prepared` event. The external
lifecycle lives entirely in the event log; the period row is **not** extended.

## Consequences
- We can answer "is this period filed and accepted by e-MTA?" without touching any
  frozen artifact, and show the full history (resubmissions after a format
  rejection, confirmation refs, dates) — tamper-evident and queryable.
- A new jurisdiction reuses the same table; only `report_kind` and the plugin's
  artifact differ. The **annual accounts** (ADR-0034) become the second consumer
  once they have a frozen snapshot (`source_snapshot_type = annual_accounts`).
- **Known gap:** an Estonian *parandusdeklaratsioon* amends the **original**
  period's declaration at e-MTA, while our books correct **forward** into the open
  period. v1 records the correction as events (`correction_submitted/accepted`)
  and relies on the forward-correction for the ledger; reconciling a
  period-scoped corrected declaration against forward-corrected books is deferred
  to a future ADR.
- This adds external-lifecycle visibility — the one thing open-accounting's stored
  `SUBMITTED/ACCEPTED` status had over us — **without** giving up derive-on-read,
  the immutable snapshot, or no-break-glass.
