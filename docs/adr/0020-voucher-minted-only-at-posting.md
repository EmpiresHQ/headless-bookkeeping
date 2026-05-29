# A Voucher is minted only at posting — no persisted unposted voucher rows

The Wave-3 plan review surfaced a model where a Policy-held item persists a `voucher` row with `posted_at = NULL` and the business object carries its `voucher_id`. That contradicts the decisions already made:

- **ADR-0006**: the business-object status machine is `draft` (*"no Voucher yet"*) → `posted` (*"posting generates the Voucher"*) → `reversed`. The Voucher is the projection minted **at posting**, not before.
- **ADR-0015**: a Policy-gated submission becomes a pending **Approval** (`pending → approved | rejected | superseded`). The Voucher is generated only on `approved → post`; a rejected item's draft *returns to `draft`*. Stranded items *"never posted"* are resolved by posting into the current open period — confirming nothing was persisted as a voucher while held.

## Decision

A `voucher` (and its `voucher_line`s) row exists **only for a posted voucher**. The draft voucher produced by a business object's `generate-draft` is a **transient, in-memory projection** (computed lines for preview / Rules input), never persisted. Policy-hold persists **no** voucher — the business object stays in a non-posted state (and, from Wave 6, a pending `Approval`). `PostingService.postVoucher` (the sole writer, ADR-0019) is the only thing that ever writes a voucher row, and it always inserts an already-posted, hash-chained voucher in one transaction.

## Consequences

- **No draft→posted `UPDATE` path.** Vouchers are insert-posted-only, so the hash chain (ADR-0013) is computed once at insert and never recomputed, and immutability holds trivially.
- The Wave-2 hardening immutability triggers gate on `WHEN posted_at IS NOT NULL`. Under this decision an unposted voucher row never occurs in v1, so the gate is always satisfied at UPDATE/DELETE time — it is defensive/forward-compatible, not load-bearing. (A blanket trigger would be equivalent; the gate is kept so a future deliberate draft-voucher feature wouldn't be boxed out.)
- **Supersedes carry-forward seam #5's "unposted-voucher insert (`posted_at: null`) for the Policy-hold path."** Wave 3's Policy-hold marks the object, it does not insert a voucher.
- Business objects own the pre-posting state; the `voucher_id` FK is set **only** once `posted_at` is non-null. A nullable `voucher_id` on a held object stays `NULL` until posting.
