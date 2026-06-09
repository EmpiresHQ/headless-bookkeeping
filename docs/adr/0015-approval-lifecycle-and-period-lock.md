# Approval lifecycle and its interaction with period locking

## Approval lifecycle

A Rules-valid submission that Policy gates becomes a pending **Approval** with states `pending → approved | rejected | superseded`. It never auto-resolves: a timeout only sends a reminder, never auto-posts (unsafe) and never auto-discards (data loss).

- **Approved** → released to posting (Rules already passed at submit); posting is idempotent (a double-tap of "approve" never double-posts).
- **Rejected** → the underlying draft returns to `draft` (editable / re-triage) with a reason — never discarded; the document is valuable.
- **Superseded** → a newer version of the same item arrived while pending (links to the correction triage of ADR-0010).

Approvals are decided by a configured approver. On Telegram/Slack the commit is a button tap (the approver identified by their authenticated channel identity). Email may also approve, but via a confirmation loop instead of a button and only with sender authentication (DKIM/SPF + verified sender = the configured approver) — see ADR-0016. Every action is logged into the audit trail / integrity chain.

## Interaction with period locking

A pending Approval whose tax-point falls in a period collides with period locking (ADR-0009): if the period is filed before the approval resolves, posting can no longer land there.

- **Filing guard (warn-and-confirm).** Filing a period (the approval-required VAT-lock action) surfaces all unresolved in-period items — pending approvals and unposted drafts with a tax-point in that period — and requires explicit confirmation to proceed. Not a hard block: deadlines are real and a straggler can be handled next period. No silent stranding.
- **Stranded items stay visible.** They remain `pending`, keep nagging, and are re-surfaced at every subsequent period close. They never vanish.
- **Resolution posts into the current open period.** Approving a stranded (never-posted) item posts it in the current period, tax-point = now, with a reference back to the original economic date. There is **no reversal** (nothing was posted). The VAT effect lands in the current return. This is the kernel default and always works.
- **Large items may need an amended return.** When the amount exceeds the plugin's correction-vs-amend threshold (ADR-0009), the plugin advises an amended return. An amendment never mutates the locked period: it produces a **new immutable VAT report snapshot** (e.g. Q1 v2) that supersedes the prior filing for submission, computed from the original + correction vouchers and referencing v1; the original snapshot and its Merkle root are preserved. Correction vouchers carry a marker that they belong to the amendment.

## Amendment (Wave 6 grilling, 2026-06-04)

**An Approval references its source business object/action and re-derives the draft Voucher at post time — it never freezes a draft-voucher payload.** This follows ADR-0006 (the business object is the source of truth, the Voucher is a projection) and ADR-0020 (a Voucher is minted only at posting). Freezing a draft would risk divergence if the source is corrected while the approval is pending — which is exactly what `superseded` exists to handle. `approve` re-derives and posts; idempotency is the atomic status claim (`pending → posted` only `where status='pending'`), so a double-tap never double-posts. The `object_type` is an open discriminator (a TEXT column with a migration-extensible CHECK list — `expense | sales_invoice | dividend | personal_disposition | bad_debt | correction`), not a fixed two-value enum, so every ADR-required approval (dividend per ADR-0023, personal disposition per ADR-0017, …) is representable without a later migration.
