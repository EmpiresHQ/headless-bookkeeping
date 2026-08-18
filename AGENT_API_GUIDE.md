# headless-bookkeeping — Agent API Guide (remote, API-only)

Operating guide for an AI agent that drives the **headless-bookkeeping** system **exclusively over its remote HTTP API**. The agent never reads/edits code and never touches the database — it only calls a running instance over REST.

## What this is

**headless-bookkeeping** is an AI-native, self-hosted bookkeeping kernel for consultants, freelancers, and micro-SMBs. It runs on a "$5 VPS": one Docker container, one SQLite file, no Postgres/Redis/Kafka/Kubernetes.

Two defining properties:

- **Headless** — no big accounting UI. Interaction happens through channels (Telegram, email, Slack, REST API) and agent tools. There is only a guarded `/admin` surface for diagnostics/integrations.
- **Agent-facing** — designed around AI from the start (OCR, triage, classification, reconciliation), **but the AI is always advisory**. The books are kept by a deterministic, validated, tamper-evident kernel. The robot **never writes to the books directly.**

**The core invariant you must respect:**

```
AI suggests   →   Rules validate   →   Policy decides   →   Voucher posts
 (fallible)        (inviolable)         (configurable)       (immutable,
  OCR/triage,       structural +            auto-post          balanced,
  category,         period-lock +          or hold-           hash-chained)
  confidence        semantic               for-approval
```

The AI has no `forcePost()` / `bypassApproval()` / direct write to `voucher`. Every posting path goes through Rules → Policy → a deterministic, balanced, immutable Voucher.

## ⛔ Operating mode: remote HTTP API only

**This is the working contract. The system runs remotely. You do NOT:**
- ❌ read/edit source code, run migrations, or build/run the app;
- ❌ connect to SQLite or write tables directly (`setting`, `voucher`, `api_token`, …).

**You ONLY** make HTTP calls to a running instance: `Authorization: Bearer <token>`, business routes under `/api/...`, diagnostics under `/admin/...`. Your primary section is **"Standard bookkeeping operations (recipes, verified over API)"** below.

Architecture, domain model, the `src/` map and file paths in this document exist **only so you understand the behavior of the system you operate** — not as something to open or change. Install/run/settings/tokens are the **operator / deploy zone**; if something is not available over the API, you do not do it — you request it from the operator.

## Tech stack (context)

| Layer | Technology |
|------|-----------|
| Framework | NestJS 11 (TypeScript, Node ≥ 24) |
| DB (system of record) | SQLite via `better-sqlite3` (single file) |
| Query builder / migrations | Kysely + `nestjs-kysely` (type-safe SQL) |
| Validation | Zod 4 (global pipe) |
| AI orchestration | Mastra (`@mastra/core` 1.41) — in-process; the ledger stays the SoR |
| Scheduling | `@nestjs/schedule` (cron agents) |
| Tests | Jest 30 (unit + e2e); `@mastra/core` is stubbed in tests |
| Deploy | Docker Compose (multi-stage) |

---

## HTTP API basics (remote mode)

The system is built for remote operation: **the agent does all day-to-day bookkeeping over HTTP without touching code or DB.** Verified on a live instance — the full cycle (supplier → expense → posting → approval → VAT report → period lock) runs with plain REST calls.

**Authentication:** `Authorization: Bearer <token>` header on every route except `@Public()`. Without a token → `401`.

**Route prefixes (note: not a global prefix — it is baked into the controller decorators):**
- Business operations: `/api/...` (`/api/entities`, `/api/expenses`, …). `/entities` without `api` → `404`.
- Diagnostics: `/admin/...` (no `api`). Health: `/health` (no `api`, public).

**Amounts are in minor units (cents), integers.** `gross_amount: 12300` = 123.00. Dates are `YYYY-MM-DD`.

### What is NOT available over the API (deploy / operator / DB only)
- **API token issuance** — no HTTP route. The init token is written to the log **once** on first boot (`INIT API TOKEN …`); additional tokens only via `ApiTokenService.create()` (deploy-time). The agent is **handed** a token; it does not mint one.
- **Settings (`setting`)**: `ai_model.*`, `prompt.*`, `telegram_bot_token`, `telegram_webhook_secret`, `telegram_allowlist`, `approvers`, `email_whitelist`, `ingest_policy` — no controller.
- **Policy thresholds** (`policy_config`: ceiling, confidence) — only `GET /api/overrides` exists; there is no policy write endpoint.
- **Counterparty aliases** (`addAlias`) — service-only, no HTTP route (only create/list/get).

Answer to "can the agent operate over API without touching code/DB": **yes — for keeping the books.** Configuration of model/policy/channels/tokens stays an operator (deploy-time) concern — by design (the agent must not rewrite its own guardrails).

---

## Standard bookkeeping operations (recipes, verified over API)

`B=http://host:3000`, `H="Authorization: Bearer $T"`, `J="Content-Type: application/json"`.

### Onboard the organization
```bash
curl -H "$H" $B/api/organization                      # current state (id=1)
curl -H "$H" -H "$J" -X PUT $B/api/organization \
  -d '{"country":"IE","org_type":"company","vat_registered":true,"base_currency":"EUR"}'
```
`org_type`: `company | sole_proprietor`. Seed: IE, base_currency=null (→ EUR from the plugin).

### Open a reporting period (without it, posting hits the period-lock)
```bash
curl -H "$H" -H "$J" -X POST $B/api/reporting-periods \
  -d '{"name":"FY2026","start_date":"2026-01-01","end_date":"2026-12-31"}'   # status: open
curl -H "$H" $B/api/reporting-periods/current
```

### Add a supplier / customer
```bash
curl -H "$H" -H "$J" -X POST $B/api/entities -d '{
  "role":"supplier", "country":"IE", "name":"Acme Software Ltd",
  "registrationKey":"IE1234567T", "goodsVsServices":"services"}'
# role: supplier|customer; identity is by registrationKey (VAT/CVR), never by name.
# GET /api/entities, GET /api/entities/:id. No update/alias over API.
```

### Enter an expense (purchase)
```bash
EXP=$(curl -s -H "$H" -H "$J" -X POST $B/api/expenses -d '{
  "category":"software","gross_amount":12300,"vat_amount":2300,
  "currency":"EUR","tax_point_date":"2026-06-09","supplier_id":1}')   # status: draft
# run it through the pipeline (Rules→Policy→post/hold):
curl -H "$H" -H "$J" -X POST $B/api/expenses/<id>/post -d '{}'
```
The response contains `policy.action`: **`auto-post`** (e.g. "within ceiling" → a voucher is created; double entry Dr EXPENSE_* + Dr VAT_RECEIVABLE = Cr AP, VAT code from the plugin e.g. `IE_INPUT_23`) or **`hold-for-approval`** ("exceeds ceiling …").

### Enter an invoice (outbound sales invoice — one we issue)
```bash
curl -H "$H" -H "$J" -X POST $B/api/sales-invoices -d '{
  "invoice_number":"INV-001","customer_id":null,"gross_amount":24600,
  "vat_amount":4600,"currency":"EUR","tax_point_date":"2026-06-09"}'   # status: draft
curl -H "$H" -H "$J" -X POST $B/api/sales-invoices/<id>/post -d '{}'    # → voucher (Dr AR = Cr REVENUE + Cr VAT_PAYABLE)
# optional: POST .../generate-draft (preview entry), POST .../send (mark as sent)
```
> An inbound supplier invoice is an **expense** (intake is purchase-side only), not a sales invoice.

### Hold → approval (HITL) — the correct path
> ⚠️ If you expect a hold, **do not call `/post`**: it moves the object to `pending` **without** creating an approval, and the object gets stuck (verified). Do this instead:
```bash
# 1) object in draft (create it and DO NOT post)
# 2) create the approval directly — it runs Rules, transitions draft→pending, creates the record:
curl -H "$H" -H "$J" -X POST $B/api/approvals -d '{
  "object_type":"expense","object_id":4,"requested_by":"agent","reason":"over ceiling"}'
# 3) a human confirms → the voucher posts:
curl -H "$H" -H "$J" -X POST $B/api/approvals/<id>/approve -d '{"approved_by":"owner@acme.ie"}'
# /reject {"rejected_reason":...}, /supersede {"superseded_by":...}
curl -H "$H" $B/api/approvals/pending
```
Approval is idempotent and never bypasses the period lock or invariants.

### Add supporting documents (upload + triage)
```bash
curl -H "$H" -F "file=@receipt.pdf" $B/api/documents          # → {document, deduplicated}; dedup by SHA-256
curl -H "$H" -H "$J" -X POST $B/api/documents/<id>/triage -d '{}'   # AI: OCR→classify→draft|needs_triage
curl -H "$H" $B/api/triage/pending
curl -H "$H" -H "$J" -X POST $B/api/documents/<id>/complete -d '{}' # mark processed
# an expense can be linked to a document at creation: document_id field on POST /api/expenses
```

### Read the VAT figures (safe, read-only)
```bash
curl -H "$H" "$B/api/reporting-periods/<id>/vat-report/preview"
# → the same shape the snapshot would have (input/output by code, totals,
#   voucher_ids, merkle_root) computed LIVE and stored nowhere. Call it freely.
#   `frozen_snapshot_id` is non-null when a snapshot already exists — then these
#   live figures may differ from it, and filing will use the FROZEN one.
curl -H "$H" "$B/api/reporting-periods/<id>/kmd"   # KMD declaration rows, also derived live
```

### Freeze the VAT report (permanent — only when filing)
```bash
curl -H "$H" -H "$J" -X POST $B/api/reporting-periods/<id>/vat-report -d '{}'
curl -H "$H" $B/api/vat-reports/<id>
curl -H "$H" $B/api/vat-reports/<id>/vouchers
```
> ⚠️ **This FREEZES a snapshot — it is not a calculator.** "Idempotent" here means
> *return-existing*, not *recompute*: once a snapshot exists for the period, every
> later call hands back that stored copy, and `vat_report` rows reject UPDATE and
> DELETE at the database level. So a snapshot taken while the period is still open
> will **not** pick up vouchers posted, corrected or reversed afterwards — and
> `POST .../lock` files that stale copy silently. Undoing it means dropping the
> immutability triggers by hand on the live DB — precisely the break-glass ADR-0012
> forbids. **To look at the numbers, use the preview above.** Call this only when
> you actually mean to file.

### Close a period (file VAT) — immutable snapshot
```bash
curl -H "$H" -H "$J" -X POST $B/api/reporting-periods/<id>/lock -d '{}'
# atomic: generates the VAT snapshot + Merkle, status→locked. Sequential: an earlier open period blocks the lock.
# After locking, posting into that period → 'Cannot post into locked period' (hard_process, no break-glass).
# Fixes = reversal + a new voucher in the current period.
```

### Corrections (reversal / replacement)
```bash
curl -H "$H" -H "$J" -X POST $B/api/expenses/<id>/correct -d '{...}'
curl -H "$H" -H "$J" -X POST $B/api/sales-invoices/<id>/correct -d '{...}'
```

### Dividends (company only; gated by the plugin)
```bash
curl -H "$H" -H "$J" -X POST $B/api/dividends -d '{"gross_amount":100000,"tax_point_date":"2026-06-09"}'
# distributable profit = RETAINED_EARNINGS + net income (live, no year-end close); withholding is a plugin rule
curl -H "$H" -H "$J" -X POST $B/api/bank-transactions/<id>/dividend -d '{...}'   # settle via reconciliation
```

### Read the books
```bash
curl -H "$H" $B/api/accounts            ;  curl -H "$H" $B/api/accounts/<code>
curl -H "$H" $B/admin/accounts          # accounts WITH balances (raw trial balance)
curl -H "$H" $B/admin/vouchers          ;  curl -H "$H" $B/admin/vouchers/<id>    # hash chain (previous_hash) visible
curl -H "$H" "$B/admin/approvals" "$B/admin/findings/open" "$B/admin/periods"
```

### What is NOT there (honest): income tax and annual report
- **Taxes:** only **VAT** is computed (via the plugin's VAT codes and the VAT report). No income/corporate tax. Cross-border / reverse-charge — the interface exists but is **not called** in v1 (reserved); foreign VAT is never silently reclaimed, disputed cases → hold.
- **Annual report / financial statements (P&L, balance sheet, formatted trial balance):** **not implemented (V2).** Only raw balances (`/admin/accounts`) and a distributable-profit utility exist. Year-end close is deferred.

---

## Domain model (ubiquitous language)

Authority: `CONTEXT.md` (glossary) and `docs/DOMAIN-MODEL.md`. Key terms:

- **Hidden double-entry ledger** — real double entry, hidden from the user. The user sees a category (`software`, `transport`); the kernel posts balanced debits/credits to technical accounts.
- **Voucher** — one immutable, balanced document for a single economic event. Never edited — only reversed by a counter-voucher. Carries `tax_point_date` (which period it belongs to). The number is assigned **only at posting**.
- **VoucherLine** — a debit/credit against an `Account`: original amount + currency, base-currency amount, FX rate, VAT code. Machine layer, not shown to the user.
- **Account** — a chart-of-accounts node (Cash, Bank, AR, AP, Revenue, Expense-by-category, VAT-payable/receivable, Equity, Owner's-drawings, …). A thin canonical set; everything country-specific lives in the plugin.
- **Country plugin** (ADR-0002) — the sole resolver of VAT codes, `category → account + VAT` mapping, cross-border treatment, base currency, period frequency. There is no canonical VAT vocabulary in the kernel. Currently active: `NullCountryPlugin` (stub, Ireland).
- **Entity (Supplier/Customer)** — a counterparty by **strong key** (VAT number / CVR), not by name. Stores intrinsic facts + classification memory; **never stores a VAT code** (depends on org context).
- **Document** — a raw inbound artifact (PDF/photo) + a hash-based dedup anchor. Byte-identical attachments collapse into one Document.
- **Reporting period** — a VAT period (`open → locked`). Locked by **filing**, not by the calendar. After locking, fixes are reversal + a new voucher in the current period.
- **Reversal vs Credit note** — reversal = our internal cancellation of our own voucher; credit note = an external counterparty document. They are not mixed.
- **Multicurrency / Realized FX** (ADR-0004) — everything is computed in the base currency; realized FX difference is posted automatically on settlement.
- **Hash-chained voucher log** (ADR-0013) — an append-only chain of hashes (git-style), orthogonal to double entry. A Merkle root per period is frozen into the VAT report.

---

## `src/` module map (for understanding behavior only)

| Module | Responsibility |
|---|---|
| `database/` | Kysely module, 30 migrations, schema types |
| `organization/` | Single-tenant org (id=1; `org_type`: company \| sole_proprietor) |
| `ledger/` | Double entry: `account/`, `voucher/`, `posting/`, `validation/`, `pipeline/` |
| `ledger/posting/` | `PostingService` — the **single** validated write chokepoint; atomic post + hash |
| `ledger/pipeline/` | `PostingPipelineService` — draft → resolve → Rules (3 tiers) → Policy → post/hold |
| `rules/` | Three tiers: structural (arithmetic), hard_process (period lock), semantic (plugin) |
| `policy/` | Risk gate: amount/confidence/supplier/operation → auto-post or hold |
| `plugins/` | `CountryPlugin` interface + `NullCountryPlugin` |
| `expenses/`, `sales-invoices/` | Business objects (controller/service/tool) |
| `corrections/` | Reversal + replacement |
| `documents/`, `triage/` | Intake, dedup, OCR stub, triage queue |
| `ai/` | Mastra runtime, `AgentConfigService`, Pass-2 agent, `IntakeWorkflowService`, `ProposeDraftService` |
| `bank/`, `reconciliation/` | Bank statements, matching, dispositions, realized FX |
| `reporting-periods/`, `vat-report/` | Periods (open/lock), immutable snapshot + Merkle root |
| `approvals/` | Approval lifecycle (pending → approved \| rejected \| superseded) |
| `audit-findings/` | Findings + severity (forward-looking) |
| `audit-log/` | Append-only operational log (immutability triggers) |
| `conversations/` | Conversation/Message/Artifact, deterministic resolution by channel+thread_key |
| `interaction/` | Channel-adapter seam: envelope, Principal, router, intent classifier, FlowDispatcher |
| `agents/` | Five agents (Accounting, Reconciliation, Audit, Secretary, Dev) |
| `admin/`, `health/`, `auth/` | `/admin` diagnostics, `/health`, API-token guard |

---

## Runtime interaction (Interaction layer, ADR-0025)

### Channel-adapter seam
Each channel = a **pure mapper** (raw payload → `UnifiedEnvelope`, unit-testable, no I/O) + a **transport port** (`InteractionTransport.send(out)`) + a webhook controller (verifies authenticity). The core is channel-agnostic.

`UnifiedEnvelope`: `{ channel, sender, convKey, message, attachments[], metadata, auth: { senderId, transportVerified } }`.
`OutboundMessage`: `{ channel, convKey, text, actionPoint?: { id, label } }` — `actionPoint` renders as an inline button.

**Add a channel:** mapper + transport (`implements InteractionTransport`) + (if push) a webhook controller + registration in `TransportRegistryService`. The router/gating/flows do not change.

### Router (`interaction/router/interaction-router.service.ts`) — 7 steps
1. Resolve the `Conversation` deterministically by `channel + thread_key`.
2. Append the inbound turn to `message`.
3. Resolve the `Principal` (`PrincipalResolverService`).
4. Ingest track: on attachments → `ingestDecision(principal, policy)` → accept/quarantine/reject + audit.
5. Button (`metadata.callbackData`): check `canCommit` → deterministic action, no LLM.
6. Converse gate: only `role==='approver'` may hold a dialogue.
7. `IntentClassifierService.classify()` → `RoutedIntent` → `FlowDispatcher.dispatch()`.

### Principal & gating (`interaction/principal/`)
`Principal { role: 'approver' | 'known_counterparty' | 'unknown'; authVerified; senderId }`.
- `canConverse` — approver only.
- `canCommit` — approver **and** `authVerified` (transport proved authenticity: Telegram secret-token / email DKIM+SPF). **Actions are never committed from free text** — only via a button press (ADR-0016).
- `ingestDecision` — by `ingest_policy`: approver/known_counterparty always accept; unknown depends on the policy.

### Intents (`routed-intent.schema.ts`)
`advisory` | `action` (`actionIntent`: create_sales_invoice | approve | reject | correct) | `report` | `reconciliation` | `clarify`. When unsure, the agent prefers `clarify` over guessing.

### Intake: Document → Voucher (`ai/intake-workflow.service.ts`, ADR-0024/0010)
```
Upload → Pass1 OCR (→ markdown artifact) → Pass2 agent (classify, read-only tools)
       → TriageResult → deterministic routing:
         new_expense & confidence ≥ threshold → ProposeDraftService → pipeline → draft/hold
         else / unknown / supplier-unresolved → needs_triage (AuditFinding to a human)
```
Document statuses: `pending → triaged | needs_triage`, `triaged → processed`. OCR/Pass2 failures flow through one typed seam (failure categories recorded in audit).

### Approvals (ADR-0015) & audit log (ADR-0026)
- Policy held a draft → `Approval(pending)`. Approval **re-derives** the voucher from the business object and runs the pipeline (idempotent, no double posting). Reject → object back to draft. **Never auto-resolves** on a timeout — only a human does.
- `audit_log` — append-only `{ actor, action, outcome, target, detail }`, immutability via SQL triggers. Intake/gating/commit actions are written incrementally. This is **not** part of the hash-chained ledger.

---

## What the agent MUST and MUST NOT do

**MUST NOT (no break-glass, ADR-0012):**
- ❌ Write directly to `voucher`/`voucher_line` — only through `PostingService`/pipeline (and, remotely, only through the HTTP endpoints).
- ❌ Create drafts by writing to the DB — only via the API (`/api/expenses`, `/api/sales-invoices`, document triage).
- ❌ Bypass approval: a Policy-held draft waits for an explicit approver commit (button / `POST /api/approvals/:id/approve`).
- ❌ Post into a **locked** period — the kernel blocks it; fixes are reversal + a new voucher in the current period.
- ❌ Auto-resolve an approval on a human's behalf.
- ❌ Silently reclaim foreign VAT: `foreign_cost`/`unresolvable` emit no `VAT_RECEIVABLE`; `unresolvable` → hold.
- ❌ Mutate `Conversation`/`Message` directly — only via the service (the router owns the aggregate).

**Inviolable invariants:** structural (debit=credit in base currency, account existence, positive amounts/rates, currency consistency, immutability via triggers) and hard_process (period lock) are **not overridable**. Only a **semantic** rule is overridable — and only with a **logged Override** (`ruleType + reason`), atomically in the same transaction as the post.

---

## Common errors

| Symptom | Cause / fix |
|---|---|
| `401` on every call | Missing/invalid `Authorization: Bearer <token>` |
| `/entities` → `404` | Business routes are under `/api/...` (e.g. `/api/entities`) |
| Object stuck in `pending`, can't approve | You called `/post` and Policy held it. Use the draft → `POST /api/approvals` → `/approve` path instead |
| `Cannot post into locked period` | The target period is filed/locked — correct via reversal + new voucher in the current period |
| `earlier period … is still open — file it first` | Periods lock sequentially; lock the earlier one first |
| Posting blocked by missing period | No open reporting period covers the `tax_point_date` — create one first |

---

## Authoritative sources (operator/developer reference)

- `CONTEXT.md` — glossary (load-bearing terms); `docs/DOMAIN-MODEL.md` — aggregates/flows/invariants.
- `docs/CONFIG.md` — all configuration knobs (section 4 — LLM profiles and `ai_model.*`/`prompt.*`).
- `docs/VISION.md`, `docs/V2-ROADMAP.md`, `README.md`.
- ADRs (`docs/adr/`): 0001 (hidden ledger), 0002 (country plugin), 0005 (pipeline+policy), 0012 (no break-glass), 0013 (hash chain), 0015 (approvals/period-lock), 0016 (intent routing), 0018 (agents), 0019 (write path), 0024 (AI ingestion), 0025 (interaction seam), 0026 (audit log).
- Known gaps for API-only operation: see `findings.md`.
