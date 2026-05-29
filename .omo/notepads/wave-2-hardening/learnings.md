# Learnings

## H2 — Per-line CHECK constraints + FX_GAIN_LOSS collapse (2026-05-29)
- Migration 004 now has 4 CHECK constraints: `amount > 0`, `base_amount > 0`, `fx_rate > 0`, `is_debit IN (0, 1)`.
- FX_GAIN (revenue) row removed from seed; FX_LOSS → FX_GAIN_LOSS (expense, single net account per ADR-0019/ADR-0004).
- 6 new per-line constraint tests added to `db-constraints.spec.ts` (4 rejection tests + 1 boundary + 1 happy-path acceptance).
- `account.service.spec.ts` updated: FX_LOSS → FX_GAIN_LOSS in arrayContaining, plus `not.toContain('FX_GAIN')`.
- All 10 db-constraints + 8 account.service tests pass on commit 969a81f.
- SQLite CHECK constraints are enforced at the DB level and caught by Kysely as thrown errors — no special error-type matching needed.
