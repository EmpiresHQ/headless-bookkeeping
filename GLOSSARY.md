# Headless Accounting OS

Vocabulary for the operator's bookkeeping work. Existing accounting terms are defined in [CONTEXT.md](CONTEXT.md#language).

## Language

**Canonical bank transaction**: the one journal row that records a real bank movement within a bank account — deduplicated across statements that reference it, with its provenance (every imported source row) retained. A statement is an import artifact referencing movements, not an owner of copies.
_Avoid_: statement row, per-statement transaction

**Movement identity**: the (provider, source account reference, bank transaction id) triple that authoritatively identifies a canonical bank transaction. Unknown in any component means unknown — and unknown identity never merges.
_Avoid_: date+amount matching as identity

**Source replay**: the exact same imported source (same rows, whatever the filename or row order) arriving again — recognised and inserted zero times, kept strictly separate from movement identity.

**Import conflict**: a same-identity source row whose money or settlement facts conflict with the canonical transaction — rejected for review, never silently merged and never overwriting the canonical row.

**Duplicate repair**: the previewable, audited, idempotent merge of an ALREADY-IMPORTED duplicate bank row into its canonical survivor — metadata-only (no financial postings), preserving aliases so the removed id stays resolvable.

**Operation result**:
A record of what was confirmed, or remained unconfirmed, when the operator attempted a bookkeeping action, such as submitting an Expense for posting or creating and matching an Expense from a bank line. It describes that attempt; a recorded wait for Approval remains historically valid after the object is approved.
_Avoid_: Current object state, proof of the object's present status

**Current object state**:
The business object's state at the time it is checked, including changes that happened after an earlier operation result was recorded.
_Avoid_: Operation result, receipt (when referring to present status)
