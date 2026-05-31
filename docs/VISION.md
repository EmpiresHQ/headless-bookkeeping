# AI-Native Headless Accounting OS — Handoff

> **Status: original handoff, preserved as-is.** This is the starting-point brief. Where it conflicts with later decisions, the authoritative sources are [`CONTEXT.md`](../CONTEXT.md) (glossary) and [`docs/adr/`](./adr/) (decisions). Known divergences are flagged inline below; this document is intentionally not rewritten so the origin record stays intact.

## Vision

Not an ERP.

A lightweight, self-hosted, AI-native accounting operating system for:

- consultants
- freelancers
- micro-SMBs
- agencies

**Core idea:**

```
base accounting kernel
+ agent runtime
+ country plugins
+ integrations
+ local customization
```

Like:

- Strapi
- Supabase
- Medusa

…but for accounting.

## Core Principles

### 1. Headless-first

No giant accounting UI.

Interfaces:

- Telegram
- Slack
- Email
- REST API
- Agent tools
- n8n

Admin UI only for:

- setup
- integrations
- reviews
- diagnostics
- configs

### 2. AI-native

System designed around:

- OCR
- document triage
- reconciliation
- advisory
- automation
- agent orchestration

NOT "ERP + AI wrapper".

### 3. Local-first

Target:

- $5 VPS
- single Docker compose
- SQLite
- minimal RAM

### 4. Accounting-safe

LLM never directly mutates ledger.

Always:

```
AI suggests
→ rules validate
→ policy decides
→ voucher posts
```

## Tech Stack

### Core

- NestJS
- Kysely
- SQLite
- Mastra
- Telegram Bot
- React/Vite Admin UI

### External services

- LLM → external/self-hosted endpoint
- n8n → external
- Storage → optional external

## Runtime Architecture

```
NestJS
 ├── REST API
 ├── Accounting engine
 ├── SQLite/Kysely
 ├── Mastra agents/tools/workflows
 ├── Telegram webhook
 ├── Slack integration
 ├── Email integration
 └── Admin UI
```

## Deployment

### Goal

```
docker compose up -d
```

- Single-node
- 1 container
- 1 sqlite file
- 1 data folder

### Default storage

```
./data/accounting.sqlite
./data/documents
./data/backups
```

Optional:

- S3
- Cloudflare R2
- Google Drive

## Channels

### Telegram

Primary operational UX.

Capabilities:

- approvals
- reports
- commands
- setup
- advisory
- alerts

### Slack

Team/business operations.

Capabilities:

- approvals
- reports
- alerts
- commands

### Email

Capabilities:

- invoice intake
- receipt intake
- supplier communication
- advisory replies
- customer invoice resend

NO approvals.

> **Superseded by ADR-0016 (+ Wave-8 amendment).** Email *can* carry action/approval, committed via a confirmation loop ("YES" / re-ask) gated by an email whitelist + DKIM/SPF (approver ⊆ whitelist). Ingest is **sender-gated** by a deterministic allowlist set at setup (unknown rejected by default; `ingest_policy: known-only | quarantine | open`) — not open to any sender.

### Google Drive Watcher

Capabilities:

- passive document ingestion

### HTTP/Webhooks

For:

- n8n
- automations
- integrations

## Unified Intake

All channels map to:

- channel
- sender
- message
- attachments
- metadata

Then:

```
intent router
→ advisory
→ action
→ report
→ reconciliation
→ approval
```

## Intent Routing

### Advisory

Examples:

- Can I deduct this?
- What is my VAT?
- Why profit dropped?

Read-only.

### Action

Examples:

- Create invoice
- Import statement
- Generate VAT report

Uses tools/workflows.

### Approval

Examples:

- approve
- reject
- looks good

Routes directly to review resolver.

## Accounting Model

### Main entities

- Organization
- Entity
- Document
- Expense
- SalesInvoice
- RecurringInvoice
- Voucher
- VoucherLine
- BankStatement
- BankTransaction
- ReconciliationMatch
- VatReport
- AuditFinding
- MemoryFact

### Entity Model

> **Superseded by ADR-0002 & ADR-0014.** A Supplier never stores a `vat_code` — the country plugin resolves it from the Organization's context. And `default_category` is not a deterministic default: classification is decided per line item by the LLM, with supplier history as *context* only. Suppliers store intrinsic facts (country, goods/services, aliases) anchored on a strong key (CVR/VAT), plus classification memory.

Minimal.

```json
{
  "id": "ent_123",
  "role": "supplier",
  "name": "OpenAI",
  "vat_number": null,
  "email": null,
  "default_category": "software",
  "default_vat_code": "EU_REVERSE_CHARGE_SERVICES"
}
```

### Supplier Intelligence

Suppliers act as AI/accounting memory.

```json
{
  "aliases": [
    "OPENAI API",
    "OPENAI",
    "OPENAI.COM"
  ],
  "default_category": "software",
  "default_vat_code": "EU_REVERSE_CHARGE_SERVICES"
}
```

Reduces LLM calls.

> **Superseded by ADR-0014.** Memory does *not* skip LLM calls — classification calls the LLM on every line item (per-supplier shortcuts are error-prone). Supplier memory is fed as *context/prior* to improve accuracy, not to avoid the call. The `default_category`/`default_vat_code` here are classification memory, not deterministic defaults; a Supplier never stores a `vat_code` (ADR-0002).

### Semantic Categories

User-facing categories:

- software
- transport
- travel
- hardware
- marketing
- salary
- contractor
- rent
- tax
- bank_fee
- meals
- insurance
- education
- other

NOT accounting chart-of-account names.

## Country Plugins

Critical architecture piece.

```
core engine
→ country plugin
→ VAT/reporting rules
```

### Plugin responsibilities

- VAT codes
- VAT rates
- deductibility
- invoice rules
- report exports
- rounding
- reverse charge
- country-specific mappings

### Plugin structure

```
country-pack/
 ├── manifest.json
 ├── vat-codes.json
 ├── category-mappings.json
 ├── rules.ts
 └── exports/
```

### VAT Codes

Separate from VAT rates.

Examples:

- DOMESTIC_STANDARD
- EU_REVERSE_CHARGE_SERVICES
- EXPORT_OUTSIDE_EU
- EXEMPT
- OUT_OF_SCOPE

VAT reports built from VAT codes, not rates.

## Voucher System

Internal accounting source of truth.

### Flow

```
business object
→ voucher
→ immutable ledger entries
```

### Voucher rules

- immutable
- reversible
- auditable

No editing posted vouchers.

## Reconciliation

### Scope

No outgoing bank payments.

Only:

- matching
- payable visibility
- invoice settlement
- expense matching

### Flow

```
bank statement
→ parse
→ match invoices/expenses
→ suggest reconciliation
→ approval if needed
```

## OCR + Triage

Not plain OCR.

Pipeline:

```
document
→ classify
→ extract
→ entity match
→ VAT suggestion
→ next action
```

### Output

```json
{
  "document_type": "receipt",
  "entity_guess": "Bolt",
  "gross_amount": 1525,
  "vat_amount": 275,
  "suggested_category": "transport",
  "suggested_vat_code": "DK_INPUT_25",
  "confidence": 0.94
}
```

## Approval Model

### Auto-execute

Low-risk operations:

- known supplier
- known VAT code
- high confidence
- low amount

### Approval-required

High-risk operations:

- VAT lock
- correction voucher
- unknown supplier
- invoice send
- large expense

Approval channels:

- Telegram
- Slack

ONLY.

## LLM Profiles

Per-task model profiles.

- intent_routing
- ocr
- processing
- advisory
- audit
- reconciliation
- dev_agent

Each profile:

- provider
- model
- temperature
- timeout
- structured output settings

## Mastra Role

Mastra = orchestration layer.

NOT source of truth.

Mastra handles:

- agents
- workflows
- tool runtime
- conversational state
- approvals
- middleware

SQLite ledger remains source of truth.

## Agent Architecture

### Agents

- AccountingAgent
- AuditAgent
- ReconciliationAgent
- DevAgent

Separate capabilities.

> **Superseded by ADR-0018.** The architecture is **five** agents — add **SecretaryAgent**, the only proactive, user-facing agent (cron-driven, working-hours-gated, read-only) that chases the severity-ranked AuditFinding queue. AuditAgent writes findings (with severity); SecretaryAgent does the outreach. DevAgent is off by default.

### Tool Architecture

NestJS structure:

```
expenses/
  expenses.controller.ts
  expenses.service.ts
  expenses.tool.ts
```

Rule:

```
controller → service ← tool
```

Shared business logic.

### REST + Tools

Both supported.

**REST** — Stable external/public contract.

**Tools** — Agent-friendly workflows.

Example:

```
POST /v1/expenses
↔
expenses.createDraft tool
```

## Memory

### Structured memory

In SQLite:

- supplier defaults
- aliases
- mappings
- policies

### Agent memory

Contextual:

- preferences
- corrections
- advisory history

## Admin UI

Minimal.

### Responsibilities

- setup
- integrations
- reviews
- logs
- health
- configs
- LLM profiles
- country plugins
- supplier defaults
- VAT settings

NOT:

- full ERP UI
- CRM
- inventory
- project management

## Email Architecture

### Incoming

```
IMAP/n8n
→ intake API
→ intent routing
→ OCR/triage
```

### Outgoing

SMTP:

- invoice sending
- replies
- VAT reports
- summaries

## Dev Agent

Optional. Disabled by default.

```
DEV_AGENT_ENABLED=false
```

### Capabilities

- clone repo
- edit files
- run tests
- commit
- push branch
- watch CI
- create PR

NO:

- merge main
- prod access
- secrets
- infra mutation

### Dev Sandbox

Sandboxed execution environment.

- ephemeral workspace
- repo-scoped token
- branch-only push
- allowlisted commands
- CI verification

## VPS Constraints

MUST NOT require:

- Postgres
- Redis
- Kafka
- Kubernetes
- heavy vector DB
- local LLM

Everything optional/external.

## Product Positioning

### NOT:

- ERP
- Accounting suite
- Enterprise finance platform

### YES:

- AI-native accounting kernel
- Agent-first bookkeeping system
- Headless accounting runtime
- Self-hosted accounting OS
