# Runbook — reconciling a period's filing state (issue #200)

Applies to periods **locked before this fix shipped**. Until then, downloading a
draft KMD for an open period called the permanent `VatReportService.generate`,
which froze a `vat_report` snapshot; `lock` later reused that snapshot as-is even
though more vouchers had been posted since. Such a period can be **bound to an
incomplete snapshot**, while its XML was rendered from live ledger data — the
three figures (frozen VAT, live VAT, XML base) could all disagree.

Nothing below edits or deletes a filed artifact. `vat_report`,
`statutory_filing_snapshot` and `statutory_submission_event` are append-only at
the database level; a period is never unlocked (ADR-0012). The repair works by
**appending** the correct state and moving the period's filing state onto it.

## 1. Find affected periods

A locked period is suspect if either holds:

- its final export fails with *"locked but has no frozen filing state"* — it was
  filed before the filing payload existed, so there is nothing to reproduce and
  no artifact is produced at all (the formats carry no marker that would
  distinguish a rebuild from a real filing); or
- its final export returns a `filing_snapshot_drift` warning — the bound
  snapshot does not describe the period's posted vouchers.

```
GET /api/reporting-periods
GET /api/reporting-periods/{id}/vat-report/preview     # live figures + frozen_snapshot_id
GET /api/reporting-periods/{id}/statutory-report?format=xml
```

`preview` is read-only and freezes nothing. Compare its `total_output_vat` /
`voucher_ids` against the bound snapshot (`GET /api/vat-reports/{snapshotId}`).

## 2. Reconcile

```
POST /api/reporting-periods/{id}/filing/reconcile
```

In one transaction this:

1. recomputes the period and, if the bound snapshot has drifted, **appends** a
   complete new `vat_report` (the stale row is retained, unmodified, and is
   still readable at `GET /api/vat-reports/{staleId}`);
2. rebinds `reporting_period.vat_report_snapshot_id` to the correct snapshot —
   including the case of a locked period bound to nothing;
3. **appends** a `statutory_filing_snapshot` payload version freezing the
   declarant identity, the rendering jurisdiction, the declaration bases and the
   INF detail;
4. **appends** a `prepared` submission event pinning both, so the period's
   filing state points at the corrected version.

It is **idempotent**: a healthy period writes nothing and returns
`changed: false`. If any step fails, everything rolls back — just retry.

Response fields worth reading: `snapshot_superseded`, `previous_payload_id` →
`current_payload_id`, `correction_declaration_required`, `notes`.

## 3. Check what changed

```
GET /api/reporting-periods/{id}/statutory-report?format=xml     # the corrected filing
GET /api/reporting-periods/{id}/submission-state                # folded state + full history
```

Every earlier `submitted` / `accepted` event still names the exact snapshot and
payload version it identified, and that version is still renderable byte for
byte:

```
GET /api/reporting-periods/{id}/statutory-report?format=xml&filing_version={oldPayloadId}
```

Use that to produce the "as filed" document when comparing against e-MTA.

## 4. If the period had already been filed with the tax authority

`correction_declaration_required: true` means e-MTA still holds a version we
have since corrected. The kernel does not submit anything (ADR-0037 §3):

1. download the corrected XML (step 3) and file it as a
   **parandusdeklaratsioon** in e-MTA;
2. record what happened:
   ```
   POST /api/reporting-periods/{id}/submission-events
   { "event_kind": "correction_submitted", "external_ref": "<e-MTA ref>" }
   ```
   and later `correction_accepted`.

The flag is derived from the persisted event log, so it stays `true` across any
number of repeated reconciliations and clears only once the corrected version has
itself been submitted. The `statutory_report_incomplete` audit finding raised by
the first reconciliation stays open until an operator resolves it; retries do not
raise duplicates.

## What you must NOT do

- Do not edit `vat_report`, `statutory_filing_snapshot` or
  `statutory_submission_event` rows directly — the triggers reject it, and the
  hash-chain/Merkle evidence depends on it.
- Do not try to unlock a period or repost into it. A substantive error in a
  filed period is corrected **forward** (reversal + corrected voucher in the
  current open period, ADR-0009); the reconciliation here repairs the *record of
  what was filed*, not the books.
