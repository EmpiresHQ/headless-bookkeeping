# Headless Bookkeeping Kernel — Master Plan

> **Overview**: This is the orchestration-level plan. Each wave has its own detailed PRD linked below. Start here for the big picture; dive into wave PRDs for task-level execution details.

> **⚠️ READ BEFORE EVERY WAVE: [`engineering-guardrails.md`](./engineering-guardrails.md).** These are hard gates derived from the Wave 1 post-mortem (CI-parity lint gate, real-DI integration tests, schema-only-in-migrations, DB-level invariants, "Must NOT do" enforcement, per-wave verification). Each wave's Definition of Done now includes the wave gate.

> **Status / authoritative decisions (post Wave 1 review):** Wave 1 was reviewed and reconciled. Base currency is sourced from the **country plugin** with an Organization **override** (ADR-0004); the default deployment is **Ireland → EUR** (not DK/DKK). All wave examples and the canonical chart use EUR. The Organization is a DB-level singleton (`id = 1`).

---

## TL;DR

> **Quick Summary**: Implement the core accounting kernel for a headless, AI-native bookkeeping OS in 6 deployable waves, from database scaffolding through ledger, posting pipeline, intake/triage, reconciliation, and agent/period infrastructure. Each wave is runnable via `docker compose up` and verifiable via agent-executed QA.
>
> **Deliverables**:
> - Wave 1: NestJS + Kysely migration runner, Organization singleton, CountryPlugin interface, health endpoint
> - Wave 2: Canonical Account chart, Voucher + VoucherLine, double-entry validation, posting service, immutability
> - Wave 3: Business objects (Expense, SalesInvoice), Rules engine (structural/hard/semantic), Policy gate, Override logging
> - Wave 4: Document intake + dedup, OCR triage stub, correction flow, ReportingPeriod schema
> - Wave 5: BankStatement + matching engine, prepayments, personal disposition, FX realized auto-posting
> - Wave 6: Period lock + VAT report snapshot, Approval lifecycle, AuditFinding + agent stubs, Admin API endpoints
>
> **Estimated Effort**: Large (6 waves, ~31 tasks, 35 total with final verification)
> **Parallel Execution**: YES — 6 waves, 5-6 tasks per wave, max 6 concurrent per wave
> **Critical Path**: Wave 1 → Wave 2 → Wave 3 → Wave 4/5 → Wave 6 → Final Verification

---

## Context

### Original Request
"Давай попробуем поработать над prds, по первым нескольким adrs, нам нужны deployable waves" — Build work plan PRDs for the first ADRs, organized as deployable waves.

### Interview Summary
**Key Discussions**:
- **Scope**: All ADRs 0001-0018 in 6 deployable waves, from foundation to agents+admin
- **Test strategy**: Tests-after + agent QA (jest exists, build currently passes)
- **Wave structure**: 6 waves (maximized detail/parallelism), not 3 or 4
- **Admin UI**: No React/Vite frontend; Wave 6 includes minimal admin API endpoints only
- **Deferred to v1+**: Depreciation engine (0007), bad debt deep logic (0008), crypto integrity (0013), admin UI frontend

**Research Findings**:
- Current codebase: ~129 lines, 80% NestJS boilerplate, 20% custom (Kysely+better-sqlite3 wired)
- Build passes (`npm run build`, `npm run test` — 1 unit test for placeholder `users` table)
- No domain code exists; only `users` table placeholder
- No migration system exists — schema created ad-hoc in `onModuleInit()`
- Kysely 0.29.2 + better-sqlite3 dialect already configured via `nestjs-kysely`
- Design docs (18 ADRs + CONTEXT.md + VISION.md + CONFIG.md) are mature and comprehensive

### Metis Review
**Identified Gaps (addressed)**:
1. **No migration system** → Wave 1: Kysely migration runner with `migrateToLatest`
2. **CountryPlugin interface undefined** → Wave 1: Design interface + `NullCountryPlugin` stub
3. **Approval added too late** → Wave 3: Reserve Policy gate with `autoApprove: true` default
4. **Hash chain deferred but schema not reserved** → Wave 2: Add `previous_hash` column to `voucher` (nullable)
5. **FX rate source undefined** → Wave 1: Stub FX rate service
6. **Document storage unspecified** → Wave 4: Filesystem storage (`data/documents/`), SQLite holds metadata+hash only

---

## Work Objectives

### Core Objective
Implement a working accounting kernel with double-entry ledger, posting pipeline, document intake, bank reconciliation, and period/agent infrastructure — in 6 runnable increments, each deployable and testable.

### Concrete Deliverables
- 6 waves of NestJS modules with Kysely SQLite persistence
- Kysely migration system with versioned schema files
- Canonical chart of accounts (kernel-level, country-agnostic)
- Immutable voucher log with double-entry validation
- Business object → draft → Rules → Policy → posted Voucher flow
- Document intake with hash-based deduplication
- Bank statement matching with N:M reconciliation
- Reporting period + VAT report snapshot
- Approval lifecycle with pending/approved/rejected/superseded states
- Agent scaffolding (5 agents as cron stubs)
- Admin API endpoints for diagnostics and reviews

### Definition of Done
Each wave completes when:
- [ ] `docker compose up` starts successfully and health endpoint responds `200 OK`
- [ ] All new code compiles (`npm run build` passes with zero errors)
- [ ] At least one new test file exists and passes (`npm test` includes new tests)
- [ ] Agent-executed QA scenarios pass with evidence captured
- [ ] Git commit records the wave's changes

### Must Have
- Kysely migration runner in Wave 1 (no ad-hoc schema creation)
- CountryPlugin interface + stub implementation in Wave 1
- `previous_hash` column on `voucher` table in Wave 2 (deferred feature, schema-ready)
- Double-entry invariant enforced in Wave 2 (sum of lines = 0)
- Voucher immutability at API layer in Wave 2 (no PUT/DELETE on posted vouchers)
- Structural and hard Rules are inviolable in Wave 3 (no override possible)
- Policy gate structure exists in Wave 3 (even if auto-approves everything)
- Document dedup by SHA-256 hash in Wave 4
- Filesystem document storage in Wave 4 (never SQLite blobs)
- Deterministic N:M matching in Wave 5 (amount + date window + counterparty)
- ReportingPeriod lock prevents posting in Wave 6
- Approval lifecycle states in Wave 6 (pending → approved/rejected/superseded)
- Admin endpoints are read-only or simple state transitions in Wave 6

### Must NOT Have (Guardrails)
- NO React/Vite admin UI in any wave (deferred)
- NO depreciation engine (deferred to v1+)
- NO bad debt write-off deep logic (deferred to v1+)
- NO cryptographic hash chain computation (column reserved, logic deferred)
- NO Merkle root computation in v1 (schema-ready, logic deferred)
- NO actual OCR engine in Wave 4 (stub only)
- NO ML/AI matching in Wave 5 (deterministic only)
- NO real Telegram/Slack/Email integrations in Wave 6 (agent stubs log only)
- NO OAuth/JWT/session auth in Wave 6 (hardcoded API key or none)
- NO document blobs in SQLite (filesystem only)
- NO editing posted vouchers ever (only reversal + counter-voucher)
- NO structural rule overrides ever (only semantic rules via logged Override)
- NO auto-approval on timeout (timeout = reminder only)

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.
> Acceptance criteria requiring "user manually tests/confirms" are FORBIDDEN.

### Test Decision
- **Infrastructure exists**: YES (jest 30.0.0, ts-jest, NestJS testing utils)
- **Automated tests**: Tests-after
- **Framework**: jest (ts-jest transform)
- **If tests-after**: Implementation tasks complete first, then test tasks within same wave verify the implementation

### QA Policy
Every task MUST include agent-executed QA scenarios (see per-wave PRDs).
Evidence saved to `.omo/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Frontend/UI**: Use Playwright (not applicable — API-only)
- **API/Backend**: Use Bash (curl) — Send requests, assert status + response fields
- **Library/Module**: Use Bash (bun/node REPL) — Import, call functions, compare output
- **Docker/Deploy**: Use Bash (`docker compose up`, `curl` health endpoint)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation + scaffolding):
├── Task 1: Kysely migration runner + schema init
├── Task 2: Organization singleton module
├── Task 3: CountryPlugin interface + NullCountryPlugin stub
├── Task 4: Base currency + FX rate stub service
└── Task 5: Health endpoint + docker-compose smoke test

Wave 2 (After Wave 1 — ledger primitives, MAX PARALLEL):
├── Task 6: Account chart schema + canonical seed
├── Task 7: Voucher + VoucherLine schema + repository
├── Task 8: Double-entry validation service
├── Task 9: Posting service (atomic voucher creation)
└── Task 10: Immutability enforcement at API layer

Wave 3 (After Wave 2 — posting pipeline, MAX PARALLEL):
├── Task 11: Expense business object + draft generation
├── Task 12: SalesInvoice business object + draft generation
├── Task 13: Rules engine (structural/hard/semantic)
├── Task 14: Policy gate + Override logging
└── Task 15: Pipeline integration (end-to-end flow)

Wave 4 (After Wave 3 — intake + triage):
├── Task 16: Document schema + filesystem storage + dedup
├── Task 17: OCR triage stub + intake routing
├── Task 18: Correction flow (supersession, reversal)
├── Task 19: ReportingPeriod schema + CRUD
└── Task 20: Intake integration (document → draft → pipeline)

Wave 5 (After Wave 3 — reconciliation, parallel with Wave 4):
├── Task 21: BankStatement + BankTransaction schema
├── Task 22: Matching engine (N:M deterministic)
├── Task 23: Prepayment balances (liability/asset vouchers)
├── Task 24: Personal disposition
├── Task 25: FX realized auto-posting
└── Task 26: Reconciliation integration

Wave 6 (After Waves 4-5 — agents + periods + admin):
├── Task 27: ReportingPeriod lock + filing guard
├── Task 28: VAT report snapshot
├── Task 29: Approval lifecycle
├── Task 30: AuditFinding + Agent stubs
└── Task 31: Admin API endpoints

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: Task 1 → Task 6 → Task 11 → Task 16/21 → Task 27 → F1-F4 → user okay
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 6 (Wave 5)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1-5 | — | 6-10 |
| 6-10 | 1-5 | 11-15 |
| 11-15 | 6-10 | 16-26 |
| 16-20 | 11-15 | 27-31 |
| 21-26 | 11-15 | 27-31 |
| 27-31 | 16-26 | F1-F4 |
| F1-F4 | 1-31 | — |

### Agent Dispatch Summary

- **Wave 1**: 5 tasks → all `quick` (scaffolding, config, interfaces)
- **Wave 2**: 5 tasks → `quick` (schema, seed), `unspecified-high` (validation, posting, immutability)
- **Wave 3**: 5 tasks → `unspecified-high` (business objects, rules, policy), `deep` (integration)
- **Wave 4**: 5 tasks → `unspecified-high` (document, intake, correction), `deep` (integration)
- **Wave 5**: 6 tasks → T21-T25 → `unspecified-high`, T26 → `deep`
- **Wave 6**: 5 tasks → T27-T29 → `unspecified-high`, T30-T31 → `deep`
- **FINAL**: 4 tasks → F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## Wave PRDs

Each wave has a standalone PRD with full task details, acceptance criteria, and QA scenarios. Execute waves in order; tasks within a wave run in parallel unless dependencies dictate otherwise.

| Wave | PRD | Tasks | Focus |
|------|-----|-------|-------|
| 1 | [wave-1-foundation.md](wave-1-foundation.md) | 1-5 | Database migrations, Organization, CountryPlugin, Currency, Health |
| 2 | [wave-2-ledger.md](wave-2-ledger.md) | 6-10 | Account chart, Voucher schema, Double-entry validation, Posting, Immutability |
| 3 | [wave-3-pipeline.md](wave-3-pipeline.md) | 11-15 | Expense, SalesInvoice, Rules engine, Policy gate, End-to-end pipeline |
| 4 | [wave-4-intake.md](wave-4-intake.md) | 16-20 | Documents, Triage, Corrections, ReportingPeriod, Intake integration |
| 5 | [wave-5-reconciliation.md](wave-5-reconciliation.md) | 21-26 | Bank statements, Matching, Prepayments, Personal disposition, FX realized, Integration |
| 6 | [wave-6-agents-admin.md](wave-6-agents-admin.md) | 27-31 | Period lock, VAT report, Approvals, Agents, Admin API |
| FINAL | [final-verification.md](final-verification.md) | F1-F4 | Plan compliance, Code quality, Real QA, Scope fidelity |

> **How to use**: The orchestrator (`/start-work`) reads this master plan for wave sequencing, then drills into the per-wave PRD for task-level execution. Cross-wave references (e.g., "Task 9 needs posting service") are resolved by reading the relevant wave PRD.

---

## Commit Strategy

- **Wave 1**: `feat(db): migration runner + organization` — all Wave 1 files + tests
- **Wave 2**: `feat(ledger): account chart + voucher + posting + immutability` — all Wave 2 files + tests
- **Wave 3**: `feat(pipeline): business objects + rules + policy + integration` — all Wave 3 files + tests
- **Wave 4**: `feat(intake): documents + triage + corrections + periods` — all Wave 4 files + tests
- **Wave 5**: `feat(reconciliation): bank + matching + prepayments + personal + FX + integration` — all Wave 5 files + tests
- **Wave 6**: `feat(agents): period lock + VAT report + approvals + agents + admin` — all Wave 6 files + tests
- **Final**: `chore(review): final verification and fixes` — any fixes from F1-F4

---

## Success Criteria

### Verification Commands
```bash
# Build passes
npm run build

# All tests pass (unit + integration)
npm test

# Docker compose starts and health endpoint responds
docker compose up -d && sleep 5 && curl -s http://localhost:3000/health

# Admin endpoints accessible with key
curl -s -H "X-Admin-Key: dev" http://localhost:3000/admin/accounts

# Ledger immutability enforced
curl -s -X PUT -w "%{http_code}" http://localhost:3000/api/vouchers/1
# Expected: 405

# Period lock prevents posting
# (After locking a period in Wave 6)
curl -s -X POST -H "Content-Type: application/json" -d '{"voucher_number":"TEST","tax_point_date":"2024-01-15","lines":[...]}' http://localhost:3000/api/vouchers
# Expected: 400 with "locked period" error
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] `npm run build` passes with zero errors
- [ ] `npm test` passes with all new tests
- [ ] `docker compose up` starts successfully
- [ ] All 6 waves have evidence in `.omo/evidence/`
- [ ] All Final Verification tasks (F1-F4) approved
- [ ] User gave explicit "okay" to complete
