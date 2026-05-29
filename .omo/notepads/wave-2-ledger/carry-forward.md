# Wave 2 carry-forward (from Wave 1 review)

> Read `.omo/plans/engineering-guardrails.md` first. This file is the Wave-1-specific carry-forward; the guardrails are the general rules.

## What bit us in Wave 1 (don't repeat)

- **Lint was never gated** → CI red on merge. Run `npm run lint` as part of the wave gate, every wave.
- **All-mock tests stayed green over a broken wiring** (CurrencyService was disconnected from the Organization). Wave 2 wires a lot (AccountService, posting service, validation reading the chart) — each cross-module path needs a **real-DI integration test** against in-memory SQLite, not mocks.
- **An AC passed by coincidence** (default == seed). Test ledger behaviour with values that differ from defaults.
- **Ad-hoc `CREATE TABLE` was reintroduced in a service.** All Wave 2 schema (account, voucher, voucher_line) lives in migrations only.
- **A "singleton/unique" invariant was code-only.** Wave 2 has real constraints to enforce at the DB: `account.code` UNIQUE, voucher immutability, `previous_hash` chaining, FK `voucher_line.voucher_id → voucher.id`. Prove each with a test that the DB rejects the violating write.

## Concrete Wave 2 specifics now aligned to the IE/EUR decision

- The canonical chart's home bank account is **`BANK_EUR`** (was `BANK_DKK`). Foreign-currency accounts (e.g. `BANK_USD`) keep their own `currency`.
- Example voucher payloads use **EUR** as the base currency.
- Base currency is resolved via `CurrencyService.getBaseCurrency()` (`org.base_currency ?? plugin default`) — do NOT hardcode a currency in the posting/validation services; ask the resolver.

## Cross-wave seams to reconcile at execution (flagged by the plan authors)

The detailed superpowers plans were authored per-wave in parallel; these seams need a decision when each wave runs (each plan also flags its own assumptions):

1. **Migration numbering.** Wave 2 = `002`–`004`, Wave 3 = `005`–`008`, Wave 4 = `010`–`011`, Wave 5 = placeholders `00X/00Y/00Z` (assign **012**–`014` at execution), Wave 6 = `020`–`022`. Gaps are harmless (Kysely orders by key); just avoid collisions and resolve Wave 5's placeholders.
2. **`FX_GAIN` account.** Add `FX_GAIN` to the Wave 2 canonical chart (the spec listed only `FX_LOSS`). Then Wave 5's conditional "add FX_GAIN if absent" migration becomes unnecessary.
3. **`voucher_line.account_id` FK.** The Wave 2 plan adds this FK + `PRAGMA foreign_keys = ON` and proves rejection (per CONTEXT "a VoucherLine debits/credits exactly one Account"). Confirm we want FK enforcement in the migration vs only on the connection.
4. **Validation signature.** Wave 2 plan: `validateVoucherLines(lines, validAccountIds: Set<number>)` (caller resolves account ids). Wave 3 assumed `validate(draft)`. Reconcile when Wave 3 runs — keep `account_code` on `DraftVoucherLine` either way.
5. **Plugin wiring for Wave 3.** Needs a `'revenue'` branch in `NullCountryPlugin.resolveCategoryMapping` and an unposted-voucher insert (`posted_at: null`) for the Policy-hold path. Wiring only, no new schema.
6. **Depth variance.** Waves 5–6 plans are more condensed than 2–4; deepen them (more bite-sized steps / full code) right before those waves execute.

## Patterns to copy

- **Integration test harness:** see `src/currency/currency.resolution.spec.ts` — provide Kysely under `KYSELY_MODULE_CONNECTION_TOKEN()`, run `migrateToLatest`, assemble real services, assert end-to-end.
- **DB-level invariant:** see migration `001_create_organization.ts` — `id INTEGER PRIMARY KEY CHECK (id = 1)` for the singleton; mirror this style for Wave 2 constraints.
