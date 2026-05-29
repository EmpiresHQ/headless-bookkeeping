# Ledger write path: single validated chokepoint + defense-in-depth invariant enforcement

The Wave-2 review found the ledger's structural invariants enforced one layer too shallow: voucher immutability lived only as HTTP 405 in the controller (bypassable by any in-process caller), balance/positivity lived only in `LedgerValidationService` (bypassable via exported `VoucherRepository.createVoucher` / `VoucherLineRepository.createVoucherLine`), and `base_amount` sign was never checked. CONTEXT.md calls these invariants "inviolable for everyone including humans" (and ADR-0012 forbids break-glass) — so app-layer-only enforcement made that claim false. We decided the enforcement architecture explicitly.

**Single validated write path.** `PostingService.postVoucher` is the *only* code that writes `voucher` / `voucher_line`: it validates → computes the hash chain (ADR-0013) → inserts atomically in one transaction. The repositories are demoted to **read-only query objects**; their `create*` methods are deleted (they were dead, unvalidated, and wrote `previous_hash: null`). The two invariants that cannot be a row constraint — the cross-row **balance** (debits == credits in base currency) and the **hash chain** — therefore have exactly one chokepoint that must run.

**Defense in depth at the DB.** Everything that *can* be a DB guarantee is one, proven by a rejection test (per the Wave-2 carry-forward's "stated DB invariants are real DB constraints"):

- **Immutability**: `BEFORE UPDATE` / `BEFORE DELETE` triggers on `voucher` and `voucher_line` that `RAISE(ABORT, …)` once the voucher is posted. The HTTP 405 stays as the polite outer layer; the trigger is the backstop that holds for every write path. (Mirrors the `CHECK(id = 1)` singleton style in `001_create_organization.ts`.)
- **Per-line shape** (`voucher_line` CHECKs): `amount > 0`, `base_amount > 0`, `fx_rate > 0`, `is_debit IN (0,1)`. This is the unsigned-magnitude + `is_debit`-direction model (not signed amounts that literally sum to zero — see CONTEXT.md); it closes the negative-`fx_rate` hole that let a negative-magnitude voucher "balance".

**Why both layers.** The DB constraints/triggers are the inviolable floor (they hold even if a future caller forgets to validate); the validated posting chokepoint enforces the cross-row rules SQLite can't express and is where the hash is computed. Neither alone is sufficient: triggers can't check balance, and a service check is bypassable. Together they make "inviolable for everyone" true.

## Consequences

- A future feature that needs to write the ledger must go through `PostingService`, not a repository — by construction, not by convention.
- Reversals/corrections (ADR-0001/0006) are new posted vouchers through the same chokepoint; they never UPDATE an existing row, consistent with the triggers.
