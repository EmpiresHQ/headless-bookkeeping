# Voucher numbering: gapless sequential, minted at posting; idempotency via an atomic status claim

This decision arose from the Wave-3 pipeline review. It refines ADR-0020 (a Voucher is minted only at posting) and ADR-0013 (cryptographic integrity layer) with the rule that governs *what number* a posted voucher carries and *how* the posting path stays idempotent.

## The problem found in Wave 3

The Wave-3 pipeline minted voucher numbers ad hoc and inconsistently:

- **Expenses** posted with `DRAFT-EXP-${id}-${Date.now()}`. That string is non-deterministic, carries a misleading `DRAFT-` prefix on an immutable posted voucher, and — because `Date.now()` differs per call — defeats the `voucher_number` UNIQUE constraint as an idempotency backstop.
- **SalesInvoices** reused the human `invoice_number`. Stable, but a *different* scheme from expenses, so the two object types had divergent numbering and divergent double-post guarantees.

Neither scheme is statutorily valid: EU/Danish bookkeeping (Bogføringsloven; EU Accounting Directive) requires a **continuous, gapless, sequential** voucher (bilag) numbering that an auditor can walk end-to-end with no holes.

## Decision

### 1. Gapless sequential numbering, minted at posting

A posted Voucher's `voucher_number` is a single **per-Organization, gapless, monotonic sequence** (e.g. `V-YYYY-NNNNNN`) assigned **inside `PostingService` at post time** — never derived from the business object, never carrying a timestamp or a `DRAFT-` prefix.

- The number is allocated within the same transaction that writes the voucher row and links the hash chain (ADR-0013), so the sequence and the chain advance together.
- The business object (expense, sales_invoice, …) keeps its own human reference (`invoice_number`, an expense reference) as a *separate* field; that reference is **not** the ledger voucher number.
- A transient draft Voucher (ADR-0020) has **no** voucher number — numbering is a posting-time act, consistent with "minted only at posting".

Gaplessness is a real invariant, proven by a test: the sequence increments by exactly one per posted voucher with no holes. A reversal/correction voucher (Wave 4, ADR-0010) consumes the next number in the same sequence — corrections are new postings, not edits.

### 2. Idempotent posting via an atomic status claim

Because every post now mints a *fresh* sequential number, the `voucher_number` UNIQUE constraint can no longer serve as the double-post backstop (it did, accidentally, for invoices). Idempotency therefore rests on an **atomic claim of the business object**, not a check-then-act read:

- The pipeline issues a single conditional `UPDATE … SET status = 'posting' WHERE id = ? AND status = 'draft'` (inside the posting transaction). Zero rows affected → the object was already claimed/posted → **409 Conflict**, no second voucher.
- This closes the TOCTOU window the Wave-3 code had (read status `draft`, then later update — two concurrent `/post` calls could both pass the read).
- A retried `/post` on an already-`posted`/`pending` object still returns 409 (AC-9).

## Consequences

- One numbering scheme across all business-object types; auditors get a single gapless ledger sequence.
- The hash chain (ADR-0013) and the voucher sequence are advanced together under one transaction — tampering that removed a voucher would leave both a chain break and a sequence gap.
- Implemented as a Wave-4 prologue remediation (carried from the Wave-3 review). See `.omo/plans/wave-4-intake.md`.

Confidence note: gapless sequential voucher numbering is principle-level required by Bogføringsloven and the EU Accounting Directive; the exact format/reset cadence (per-year vs continuous) is a country-plugin presentation choice, not a kernel hardcode.
