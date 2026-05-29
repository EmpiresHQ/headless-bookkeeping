# Engineering Guardrails (read before EVERY wave)

> **Why this exists.** Wave 1 shipped build-green and test-green but was rejected on review: CI was actually red (lint), an acceptance criterion was satisfied only by coincidence, a forbidden anti-pattern was reintroduced, and a DB-level invariant was implemented as a code-only check. Every failure below is a *real* thing that happened. The planner and implementing agents MUST treat these as hard gates, not advice.

These rules are authoritative across all waves and override convenience. They are derived from the Wave 1 post-mortem (see `.omo/notepads/wave-1-foundation/learnings.md` and the Wave 1 review).

---

## G1 — The wave gate is CI parity, all four commands green

A wave is NOT done until ALL of these pass locally, exactly as CI runs them:

```
npm run build && npm run lint && npm run test && npm run test:e2e
```

**Wave 1 trap:** the Definition of Done only said "build + test". Lint was never run, so 9 errors merged and CI (`.github/workflows/ci.yml` runs `npm run lint`) would have been red. `lint` is a gate, not an afterthought.

## G2 — Wiring needs a real integration test; all-mock tests prove nothing

Any behavior that crosses a module / DI boundary (a service reads the DB, resolves a plugin, calls another service) MUST have at least one test that boots the **real DI graph against an in-memory SQLite DB** and runs the real migration. A unit test that mocks every collaborator does NOT count as coverage for that wiring.

**Wave 1 trap:** `CurrencyService` returned a hardcoded constant disconnected from the Organization. Every test mocked the dependency, so it stayed green. The bug was only caught by an integration test (`currency.resolution.spec.ts`) that wired the real services. Pattern to copy: provide the Kysely instance under `KYSELY_MODULE_CONNECTION_TOKEN()`, run `migrateToLatest`, assemble the real services, assert end-to-end.

## G3 — Acceptance criteria must discriminate (test a non-default value)

An AC must be verified with an input that **differs from the seed/default**, so a hardcoded stub cannot pass by coincidence. "Returns X" where X equals the default is not evidence the value is actually computed.

**Wave 1 trap:** `getBaseCurrency()` "returned DKK" — but only because the stub's hardcoded default happened to equal the seed. Change the input (e.g. set an override, then assert the new value; clear it, assert the fallback) and prove the behaviour reacts.

## G4 — Schema lives ONLY in migrations

No service, controller, or module may run `CREATE TABLE` / `ALTER TABLE` (or `db.schema.createTable(...)`) at runtime or in `onModuleInit`. All schema and seeds live in `src/database/migrations/`.

**Wave 1 trap:** Task 1 explicitly deleted the ad-hoc `CREATE TABLE` from `AppService`, and Task 2 silently reintroduced it in `OrganizationService.onModuleInit` — with divergent column defaults. Two sources of schema truth.

**Grep gate (must be empty outside migrations):**
```
grep -rn "createTable\|CREATE TABLE" src --include=*.ts | grep -v "src/database/migrations/"
```

## G5 — "Must NOT do" is enforced, not advisory

For every task, the forbidden patterns named in its **Must NOT do** list must be grepped for at wave end. If a forbidden pattern is present, the wave fails.

**Wave 1 trap:** the forbidden ad-hoc table creation was present and nobody checked the "Must NOT do" list against the diff.

## G6 — Stated DB invariants are real DB constraints

When a task says "singleton", "unique", "foreign key", "not null", or "rejected at the DB", it must be a **real DB constraint**, and a test must prove the DB rejects the violating write (not just that application code declined it). A code-only check is defense-in-depth on top, never the sole mechanism.

**Wave 1 trap:** the Organization singleton was a `count === 1` check in the service; a raw second `INSERT` would have succeeded. Fixed with `id INTEGER PRIMARY KEY CHECK (id = 1)`.

## G7 — Evidence is adversarial and honest

Evidence files must contain the **exact command and its raw output** — not a prose summary asserting PASS. An AC that is met only by coincidence (G3) is a FAIL, and the evidence must say so. Hedged evidence ("returns DKK (default)") is a red flag, not a pass.

## G8 — Per-wave verification, not just end-of-project

Run a mini compliance pass at the END OF EACH WAVE (not only after Wave 6): plan-compliance (every Must-Have present), code-quality (G1 + no `as any` slop / empty catches / dead code), and scope-fidelity (G4/G5 greps + Must-NOT-do compliance + no cross-task contamination). The full `final-verification.md` (F1–F4) remains the project-end gate; this is its per-wave miniature.

---

## Authoritative design decisions (do not re-litigate or regress)

These were decided in review and encoded in the ADRs. Implement to them; do not reintroduce the superseded assumptions.

- **Base currency comes from the country plugin, with an Organization override** (ADR-0004). `CountryPlugin.getDefaultBaseCurrency()` is the source; `organization.base_currency` is a **nullable** override. Resolution: `org.base_currency ?? pluginLoader.resolve(org.country).getDefaultBaseCurrency()`.
- **The default organization is Ireland / EUR** (`country='IE'`, `base_currency=NULL` → resolves to `EUR`). The kernel chart and all examples use **EUR** as the base currency, not DKK. The DK/DKK scaffolding default is superseded.
- **A country plugin is mandatory**; the default plugin returns `EUR`; `PluginLoader` fails loud if no default is available (ADR-0012).
- **The Organization is a DB-level singleton** (`id = 1`, `CHECK (id = 1)`).
- **Health lives in `HealthController`**; there is no demo `/` or `/users` route.
