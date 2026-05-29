# Learnings

## H2 — Per-line CHECK constraints + FX_GAIN_LOSS collapse (2026-05-29)
- Migration 004 now has 4 CHECK constraints: `amount > 0`, `base_amount > 0`, `fx_rate > 0`, `is_debit IN (0, 1)`.
- FX_GAIN (revenue) row removed from seed; FX_LOSS → FX_GAIN_LOSS (expense, single net account per ADR-0019/ADR-0004).
- 6 new per-line constraint tests added to `db-constraints.spec.ts` (4 rejection tests + 1 boundary + 1 happy-path acceptance).
- `account.service.spec.ts` updated: FX_LOSS → FX_GAIN_LOSS in arrayContaining, plus `not.toContain('FX_GAIN')`.
- All 10 db-constraints + 8 account.service tests pass on commit 969a81f.
- SQLite CHECK constraints are enforced at the DB level and caught by Kysely as thrown errors — no special error-type matching needed.

## H7 — Full gate + e2e + evidence (2026-05-29)
- Full gate passed: `npm run build` (0 errors), `npm run lint` (0 errors), `npm run test` (14 suites, 107 tests), `npm run test:e2e` (3 suites, 10 tests).
- Grep guard 1 (`createTable/CREATE TABLE` outside migrations): clean.
- Grep guard 2 (`previous_hash: null`): initially failed in 2 spec files (`voucher.controller.spec.ts`, `db-constraints.spec.ts`) — fixed by importing `GENESIS_HASH` and replacing all `previous_hash: null` fixtures with `GENESIS_HASH`.
- Grep guard 3 (`: any` / `as [A-Z]`): only pre-existing match is `import { Database as DBType }` in `database.module.ts` (import alias, not a type assertion) — no new wave-2 matches.
- Evidence captured in `.omo/evidence/wave-2-hardening-test.txt` and `.omo/evidence/wave-2-hardening-e2e.txt`.
- Commit `a659f5b` on branch `wave-2-ledger`.
