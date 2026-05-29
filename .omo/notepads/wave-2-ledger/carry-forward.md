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

## Patterns to copy

- **Integration test harness:** see `src/currency/currency.resolution.spec.ts` — provide Kysely under `KYSELY_MODULE_CONNECTION_TOKEN()`, run `migrateToLatest`, assemble real services, assert end-to-end.
- **DB-level invariant:** see migration `001_create_organization.ts` — `id INTEGER PRIMARY KEY CHECK (id = 1)` for the singleton; mirror this style for Wave 2 constraints.
