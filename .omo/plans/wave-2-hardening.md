# Wave 2 Hardening (post-review)

## Overview
The Wave-2 review (and a grill-with-docs session) found that the ledger's core invariants were enforced one layer too shallow — immutability only as an HTTP 405, balance/positivity only in a service that an exported repository could bypass, `base_amount` sign unchecked, and the ADR-0013 hash chain silently dropped (`previous_hash` written `null` on every post). These are **load-bearing** for Wave 3, which posts through this exact ledger. This hardening pass finishes Wave 2 before Wave 3 builds on it.

> **Detailed implementation plan (bite-sized TDD):** [`docs/superpowers/plans/2026-05-29-wave-2-hardening.md`](../../docs/superpowers/plans/2026-05-29-wave-2-hardening.md). This file is the "what / why".

## Why now, not deferred to Wave 3
- **Hash chain**: retrofitting after Wave 3 posts real vouchers means re-hashing the ledger and reconstructing genesis ordering — cheap now (≈no real vouchers), expensive later.
- **Immutability + single write path**: Wave-3 correction/reversal and Policy-hold flows assume these hold.
- **`base_amount` / CHECKs**: correctness of every voucher Wave 3 will post.
- Deferring would also mean Wave 2's gate passed over its own unmet DoD (carry-forward: "stated DB invariants are real DB constraints proven by a test").

## Decisions encoded (see ADRs)
- **ADR-0019** (new): single validated write path + defense-in-depth (DB triggers + CHECKs underneath, validated posting chokepoint on top).
- **ADR-0013** (amended): concrete hash-chain serialization (forever-contract) + genesis sentinel.
- **ADR-0004** (amended): ledger validation boundary (trust supplied rate; account-currency match) + single net `FX_GAIN_LOSS`.
- **CONTEXT.md** (amended): "debits equal credits in base currency" (not "sum to zero"); unsigned-magnitude + `is_debit` model.

## Definition of Done
- Posted-voucher immutability enforced by **DB triggers** (gated on `posted_at` so Wave-3 draft→post still works), proven by a rejection test.
- `voucher_line` **CHECK** constraints: `amount > 0`, `base_amount > 0`, `fx_rate > 0`, `is_debit IN (0,1)` — proven by rejection tests.
- Hash chain wired: `previous_hash` links to the prior posted voucher; first voucher uses the genesis sentinel (never `null`).
- Validation also checks `base_amount` sign/integerness, `fx_rate > 0`, and account-currency match.
- `PostingService` is the sole writer; `VoucherRepository`/`VoucherLineRepository` are read-only (`create*` deleted).
- Chart seeds a single net `FX_GAIN_LOSS` (no `FX_LOSS` row).
- Test fidelity restored: `database.module.spec` runs the real migrations; `account.service.spec` enforces `foreign_keys = ON`.
- **Wave gate — ALL green**: `npm run build && npm run lint && npm run test && npm run test:e2e`.
- Greps clean: no `createTable` outside migrations; no `previous_hash: null` in `src`.
- **Strict-clean** (baseline `04400b7`): all new code without `any` / `as` casts; migrations are `Kysely<Database>`. `npm run lint` (typescript-eslint strict) is the authority.

## Scope boundary
Polish that is NOT load-bearing rides into the Wave-3 prologue (see `wave-3-pipeline.md`): Zod `ValidationPipe` + 400/409 error contract, efficiency (codes-`IN` account query, batch line insert, FK index), `is_system` comment fix, `mapRow` dedup.

## TODOs
See the detailed plan. Execute tasks **H1 → H7 in order** (H1 first — test fidelity is the precondition for trusting every DB-invariant test below it).

- [ ] H1. Restore test fidelity (real migrations + FK pragma)
- [ ] H2. Per-line CHECK constraints + single `FX_GAIN_LOSS` seed
- [ ] H3. Posted-voucher immutability triggers
- [ ] H4. Validation: base_amount / fx_rate sign + account-currency match
- [ ] H5. Demote repositories to read-only (posting = sole writer)
- [ ] H6. Wire the hash chain
- [ ] H7. Full gate + e2e + evidence
