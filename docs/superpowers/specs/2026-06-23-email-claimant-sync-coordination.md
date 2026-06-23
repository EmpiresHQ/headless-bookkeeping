# Coordination: email-intake ⇄ claimant-reimbursement

**Date:** 2026-06-23
**From:** email-sync branch (`feat/email-sync`)
**To:** claimant-reimbursement branch (ADR-0036, `plans/2026-06-23-claimant-reimbursement.md`)
**Status:** handoff — action items below land on the **claimant** branch

The two branches meet on the Pass-2 recipient signal and `IntakeWorkflowService` routing. This note records what each side owns and the one fix the claimant branch must apply before it merges. The full rationale is in `2026-06-23-email-intake-design.md` → "Coordination seam".

## Agreed split

- **Single recipient fact, two consumers.** Pass-2 emits **both**:
  - `recipient_match: 'ours' | 'other_party' | 'none'` — the real extraction, **owned by email-sync**.
  - `company_addressed_receipt: boolean` — **derived** as `recipient_match === 'ours'`, in the Pass-2 output assembly.
- **Claimant consumers are unchanged.** Migration 056, `EconomicFacts.companyAddressedReceipt`, the projection `false|null → NULL_VAT_CODE`, and the Task 8 read of `triageResult.companyAddressedReceipt` all keep reading the **boolean**. No rewrite.
- **Email-sync lights up the extraction** the claimant plan left out of scope. Until email-sync lands, the boolean is `null` → conservative no-reclaim (safe). After, it is populated → claimant VAT path comes alive.
- **Landing order:** claimant → `main` first; email-sync rebases and layers `recipient_match` extraction + boolean derivation + disposition on top.

## Action item for the claimant branch (before merge)

**Fix Task 7: run Pass-2 for claimant docs, force routing *after* it — do not skip OCR.**

Current Task 7 early-returns to `needs_triage` **before Pass-1 OCR**:

```ts
// At the TOP of processInner, BEFORE Pass 1 OCR:
if (claimantId != null) { …updateStatus('needs_triage'); return; }
```

This contradicts ADR-0036's own "Pass 2 artefacts are already stored; the system builds the Expense from them without re-running OCR." If OCR/Pass-2 is skipped:

- `confirm-payment` has **no artefacts** to build the Expense from.
- `company_addressed_receipt` is never extracted → VAT reclaim suppressed even for company-addressed receipts.
- No supplier / category / amount extracted.
- `recipient_match` never runs for claimant docs.

**Required change:** let claimant docs flow through Pass-1 + Pass-2 normally (extract amounts, supplier, category, `recipient_match` → `company_addressed_receipt`, store artefacts). Then **override the routing decision** to `needs_triage` regardless of confidence — i.e. move the claimant branch from "before OCR" to **after Pass-2**, changing only the routing outcome, not whether extraction runs.

The reason claimant docs need a human ("did this person pay out of pocket?") is real, but it is a *routing* decision, orthogonal to *whether we read the document*. Read first, then park.

## Disposition precedence (where the two layers meet)

In the post-Pass-2 disposition layer, order is:

1. **Claimant** — `claimant_id != null` → `needs_triage` (always; never `discarded`). Outranks the rest.
2. **Ingest profile** (email-sync) — `recipient_match`/channel → `discarded | needs_triage | normal`.
3. **Policy** — auto-post vs Approval.

`email_sync` never sets `claimant_id` (no Principal resolved), so the two only overlap on deliberate channels (`email_push`, Telegram, iOS, upload), where claimant wins. Email-sync's disposition does not run for claimant docs.

## Migrations

Claimant owns **054–057**. Email-sync takes **058–059** and rebuilds `document` *after* 055, carrying `claimant_id` through the rebuilt columns. No migration is needed for `recipient_match` (transient); the boolean persists on `expense` via claimant migration 056.
