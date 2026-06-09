# Headless Accounting OS

> An AI-native, **headless**, self-hosted accounting kernel for consultants, freelancers, and micro-SMBs.
>
> The accounting ledger lives in a single SQLite file and is the system of record. **AI proposes, rules validate, policy decides, and only then is a voucher posted.** The robot never touches the books directly.

---

## ⚠️ Read this first: what this repo *is*

This is a **learning / reference project**. Its real value is the **thinking**, not (yet) a finished product:

- A rich, opinionated **domain glossary** ([`CONTEXT.md`](./CONTEXT.md)) — how an accountant *actually* talks, turned into precise language.
- 23 **Architecture Decision Records** ([`docs/adr/`](./docs/adr/)) — every important "why did we build it this way" written down.
- A **working kernel** in NestJS + SQLite that implements the safe core and a growing surface of modules.

The big vision (Telegram bot, OCR AI, bank reconciliation AI, VAT filing) is **partially built but many pieces are still stubs or designed only**. Think of this repo as *"the foundation and most of the first floor, plus the blueprints for the rest."* See [What works today vs. what's planned](#-what-works-today-vs-whats-planned).

---

## 🧒 ELI5: what does this thing even do?

Imagine you run a one-person business. Receipts and invoices arrive from everywhere — email, photos, a Telegram message, a PDF in Google Drive. Normally you'd hire a bookkeeper or wrestle with a giant accounting app.

This project is a tiny robot bookkeeper that **lives on a $5 server you own**. Here's the idea:

1. You **upload a receipt** (eventually: via Telegram/email — today: via the API or file upload).
2. The **OCR extracts amounts and hints** (category, supplier). The AI classification layer is a stub; the plumbing for it exists.
3. But the OCR/AI is **not allowed to write in the accounting books directly**. Instead it makes a *proposal* that becomes a draft business object (Expense or SalesInvoice).
4. **Hard rules check the proposal** (do the numbers balance? is the tax period still open?). These rules can *never* be broken — not even by you.
5. A **policy** then decides: is this safe enough to record automatically, or should it **ask you to tap "Approve"** first?
6. Only then does it write one **voucher** (a permanent, balanced accounting entry) into the ledger.

The books are **append-only** — like a notebook written in pen. You never erase a line; if something's wrong you write a *correcting* line. The whole notebook is designed to become **hash-chained** (like git commits) so you can prove nobody secretly altered an old page.

That's the whole philosophy: **let AI do the boring reading and suggesting, but keep the money math deterministic, safe, and tamper-evident.**

---

## 🎯 Purpose (it's educational)

This codebase exists to demonstrate, end to end, how you'd design an **accounting-safe, AI-native system**. The interesting questions it answers:

- How do you let an LLM help with bookkeeping **without ever letting it corrupt the ledger**?
- How do you keep an accounting kernel **country-agnostic** while VAT rules differ wildly between countries?
- How do you make books **immutable, auditable, and tamper-evident** while still allowing corrections?
- How do you build something that runs on **one tiny box, one Docker container, one SQLite file** — no Postgres, no Redis, no Kubernetes?

It is explicitly **NOT** an ERP, not an accounting suite, not an enterprise finance platform. It's a *kernel* — like Strapi or Supabase, but for accounting.

---

## 🧠 Key concepts & big ideas

These are the load-bearing ideas. Understand these five and you understand the project.

### 1. The hidden double-entry ledger
Real accounting is **double-entry**: every economic event is recorded as balanced debits and credits. But normal users (a freelancer) should *never* see debits, credits, or "chart of accounts" jargon.

So there are **two layers**:
- **User-facing:** you only ever pick a **Category** (`software`, `transport`, `rent`…).
- **Machine-facing:** the kernel posts **Vouchers** made of **VoucherLines** that debit/credit hidden **Accounts**.

A country plugin is the bridge that turns a friendly `software` into the right Account + VAT treatment. *(ADR-0001)*

### 2. AI suggests → Rules validate → Policy decides → Voucher posts
This is the **core safety pipeline**, and the most important idea in the whole repo:

```
AI suggests   →   Rules validate   →   Policy decides   →   Voucher posts
(fallible)        (inviolable)         (configurable)       (immutable)
```

- **AI / OCR** is treated as fallible. It proposes; it never commits.
- **Rules** are the deterministic barrier. Two kinds are *inviolable for everyone, including humans*: **structural invariants** (debits = credits, amounts are positive integer cents) and **hard process rules** (you can't post into a locked tax period). A third kind — **semantic rules** (is this VAT code applicable?) — a human *can* override, but only with a logged reason.
- **Policy** is the tunable risk gate: it decides whether a valid voucher **auto-posts** or **waits for a human "Approve"** (based on amount ceiling, and in the future: AI confidence, known/unknown supplier, operation type).
- **Voucher** is the result — permanent and balanced. *(ADR-0005, ADR-0012, ADR-0019)*

> The kernel has **no "break-glass" / force-post**. If the numbers don't balance, *nothing* — not even an admin — can post it. *(ADR-0012)*

### 3. Immutable, append-only, tamper-evident books
- A posted **Voucher is never edited**. To fix a mistake you post a **reversal** (a mirrored counter-voucher) plus a corrected voucher — both referencing the original. *(ADR-0009)*
- The ledger is designed as a **hash-chained log**: each voucher commits to the hash of the previous ledger state (git-commit style). Double-entry proves the books are *correct*; the hash chain proves they *weren't altered after the fact*. The hash column is reserved; computation is not yet wired. *(ADR-0013)*
- When you file a tax period, you freeze a **VAT report** with a **Merkle root** over exactly the vouchers included — cryptographic proof of precisely what was filed. The Merkle root is reserved but not yet computed.

### 4. Country logic lives in plugins, not the kernel
There is **no universal VAT vocabulary**. Denmark's `DK_INPUT_25` means nothing in Germany. So the kernel stays *thin and country-agnostic*, and a **country plugin** is the **sole resolver** of anything country-specific: VAT codes, deductibility, period frequency, the base currency, category → account mapping. One deployment = one country = one active plugin. *(ADR-0002)*

### 5. Single-tenant, local-first, headless
- **Single-tenant:** one deployment serves **one business** (one Organization). No `org_id` threaded through the schema. Multiple businesses → multiple deployments. *(ADR-0003)*
- **Local-first:** target is a **$5 VPS, one `docker compose up`, one SQLite file, minimal RAM**. No Postgres/Redis/Kafka/Kubernetes required.
- **Headless:** there's no giant accounting GUI. You interact through **Telegram, Slack, email, REST API, and agent tools**. An admin diagnostics API exists for setup and visibility. Channel adapters (Telegram, Slack, email) are planned; the REST API works today.

---

## 🗂️ The main entities (the nouns)

The full, authoritative glossary is in [`CONTEXT.md`](./CONTEXT.md) — it's genuinely worth reading. Here's the map:

### The ledger (the books)
| Entity | ELI5 |
|---|---|
| **Voucher** | One permanent, balanced accounting document for a single economic event. Never edited — only reversed. |
| **VoucherLine** | One debit or credit against an Account inside a Voucher. The machine-level double-entry layer. Carries amount, currency, FX rate, and a VAT code. |
| **Account** | A hidden chart-of-accounts node that lines debit/credit. Technical; never shown to users. |
| **Category** | The *user-facing* label for what something is (`software`, `rent`…). A plugin maps it to an Account + VAT code. |
| **Base currency** | The single currency all reports are expressed in. Comes from the country plugin (Ireland → EUR), with an optional org override. |

### Counterparties & org
| Entity | ELI5 |
|---|---|
| **Organization** | "Us" — the single business that owns this deployment. Exactly one per deployment. |
| **Entity** | A counterparty we deal with, tagged `supplier` or `customer`. Identified by a **strong key** (VAT number / Danish CVR), *never* by name. Carries aliases + classification memory. |

### Intake & documents
| Entity | ELI5 |
|---|---|
| **Document** | The raw incoming artifact (the PDF/photo) and the **dedup anchor** — the same file arriving via email + Telegram collapses into one Document. |
| **Expense / SalesInvoice** | Business objects derived from a Document; the source that a Voucher is projected from. *(ADR-0006)* |
| **Credit note** | A counterparty's external document that cancels a prior invoice (distinct from our own internal reversal). |

### Periods, reporting & money flow
| Entity | ELI5 |
|---|---|
| **Reporting period** | A VAT period (`open → locked`). Frequency set by plugin + org config. Locked only by filing, never the calendar. |
| **VAT report** | The frozen, immutable snapshot produced when a period is filed (+ its Merkle root). |
| **Receivable / Payable** | What customers owe us / what we owe suppliers after an invoice but before payment. |
| **Prepayment** | Money received before any invoice exists — a *liability*, not a receivable. |
| **Realized FX gain/loss** | The base-currency difference that crystallizes when a foreign-currency position settles at a different rate. |
| **Dividend** | Owner withdrawal as equity distribution (declaration + settlement). *(ADR-0023)* |

### Bank & reconciliation
| Entity | ELI5 |
|---|---|
| **Bank statement** | An uploaded bank statement for a specific account covering a date range. |
| **Bank transaction** | A single line from a statement. Positive = incoming, negative = outgoing. |
| **Reconciliation match** | N:M link between a bank transaction and a voucher — exact, partial, or prepayment. |

### The agents & their plumbing
| Entity | ELI5 |
|---|---|
| **AuditFinding** | A persisted "attention item" with a dynamic **severity**. The buffer that decouples *detecting* problems from *nagging* you about them. |
| **Severity** | The priority on a finding — doubles as the nag-frequency knob (low → ~daily, high → ~hourly). |
| **Approval** | A valid submission Policy is holding for a human decision (`pending → approved / rejected / superseded`). Never auto-resolves. |
| **Override** | A logged, human-authored exception to a *semantic* rule (structural invariants can never be overridden). |
| **Conversation** | The durable, auditable thread of messages on a single channel (email/Telegram/Slack). *(ADR-0016)* |

---

## 🔌 What are "plugins"?

A **country plugin** is the single place where all country-specific accounting knowledge lives, so the kernel itself stays small and universal.

**One deployment runs exactly one country plugin**, chosen by the Organization's country. It is the **sole resolver** of anything country-specific:

- the set of valid **VAT codes** (e.g. `DK_INPUT_25`) and how they're classified
- **deductibility** and **reverse-charge** rules
- mapping a user **Category** → kernel **Account** + **VAT code**
- the **default base currency** (Irish plugin → `EUR`, Danish → `DKK`)
- allowed **reporting-period frequencies** and the default
- country rules for rounding, tax-point dates, advance VAT, bad-debt VAT relief, capitalization thresholds, dividend withholding tax…

The contract every plugin implements lives in [`src/plugins/country-plugin.interface.ts`](./src/plugins/country-plugin.interface.ts):

```ts
export interface CountryPlugin {
  getName(): string;
  getVATCodes(): VATCode[];
  resolveCategoryMapping(category, supplierContext): { account, vatCode };
  getPeriodFrequencyOptions(): string[];
  getDefaultPeriodFrequency(): string;
  getDefaultBaseCurrency(): string;
  validateVATCode(vatCode, context): boolean;
}
```

Today only one plugin is implemented: **`NullCountryPlugin`** ([`src/plugins/null-country.plugin.ts`](./src/plugins/null-country.plugin.ts)) — a safe stub that returns neutral defaults (`EUR`, `yearly`, a single `NULL_STANDARD` VAT code). It lets the kernel run end-to-end before any real national plugin exists. The `PluginLoader` resolves a plugin by country code and falls back to the null plugin for anything it doesn't recognize. Real plugins (DK, DE, …) get registered there as they're built.

---

## ✅ What works today vs. what's planned

**Honesty matters here** — the full vision in [`docs/VISION.md`](./docs/VISION.md) is partial design + partial code.

### Implemented (the working kernel)

**Core & ledger:**
- NestJS app boot + global Zod validation + `/health` endpoint
- SQLite + Kysely database layer with 24 migrations covering the full domain model
- **Organization** module (single-business config with `org_type`: company / sole proprietor)
- **Currency** module (base-currency resolution + FX rate service)
- **Account** module (chart of accounts with computed balances)
- The **double-entry ledger**: Accounts, Vouchers, VoucherLines, the posting service, ledger validation, and voucher hashing infrastructure
- **Voucher numbering** with idempotent atomic claim (yearly sequence, TOCTOU-safe *(ADR-0021)*)

**Business objects & pipeline:**
- **Expenses** — create, list, get, generate draft voucher, full posting pipeline (`post`), corrections
- **Sales invoices** — create, list, get, generate draft, send, full posting pipeline (`post`), corrections
- **Corrections** — reversal + replacement counter-vouchers for both expenses and sales invoices *(ADR-0009)*
- **Posting pipeline** — unified `PostingPipelineService` orchestrating: draft → account resolution → structural rules → hard process rules (period lock) → semantic rules → Policy gate → atomic post-or-hold with status update *(ADR-0019, ADR-0021)*
- **Rules** — three-tier validation (structural/hard/semantic) with override support for semantic failures
- **Policy** — configurable risk gate with amount ceiling, defaults to auto-post for small transactions

**Counterparties & intake:**
- **Entities** — onboard suppliers/customers with strong identity keys (CVR/VAT), aliases, and classification memory *(ADR-0014)*
- **Documents** — upload with dedup (hash-based), list, get with hydrated sources
- **Triage** — route documents through intake pipeline, pending queue, completion
- **OCR service** — stub that extracts hints (amount, category, supplier); real AI deferred

**Bank & reconciliation:**
- **Bank statements** — upload, list, list transactions
- **Reconciliation** — propose matches for open transactions, execute matches (exact/partial/prepayment)
- **Prepayment handling** — mark bank transactions as prepayment liability
- **Personal disposition** — mark transactions as personal/owner drawings *(ADR-0017)*
- **FX realized** — record realized foreign-exchange gains/losses on settlement

**Periods, reporting & tax:**
- **Reporting periods** — create, list, get current, lock, warnings
- **Period lock** — hard process rule rejects posting into locked periods *(ADR-0009, ADR-0015)*
- **VAT reports** — generate immutable snapshot, get by ID, list included voucher IDs
- **Dividends** — declare (through full pipeline) and settle against bank transactions *(ADR-0023)*

**Operational support:**
- **Approvals** — full lifecycle (create, approve, reject, supersede), pending queue
- **Audit findings** — create, list, resolve, snooze with severity-driven cadence *(ADR-0018)*
- **Conversations** — resolve, append messages, attach artifacts, associate documents/objects, close, list, get
- **Agents module** — registered stubs (AccountingAgent, AuditAgent, ReconciliationAgent, SecretaryAgent, DevAgent) with NestJS scheduler wiring
- **Admin diagnostics** — guarded `/admin` endpoints for accounts, vouchers, periods, approvals, findings, health *(ADR-0018 Task 39)*

### Still stubbed / planned

- **AI agents** — the `AccountingAgent` and other agents are empty stubs; the orchestration wiring exists but no LLM calls are made
- **Real country plugins** — only `NullCountryPlugin` exists; DK/DE/etc. are not implemented yet. Cross-border VAT treatment mis-books until a real plugin arrives
- **Channel adapters** — Telegram, Slack, email intake, Google Drive watcher are designed but not built. Document upload works today only via the REST API
- **Merkle root computation** — `vat_report.merkle_root` is reserved but not computed *(ADR-0013)*
- **Hash chain** — `voucher.previous_hash` is reserved but unused *(ADR-0013)*
- **Cash-basis report view** — accrual ledger is the only view today
- **Depreciation engine** — off by default; expense-by-default *(ADR-0007)*
- **Domain plugins** — payroll and self-billing are deferred to v2 per [`docs/V2-ROADMAP.md`](./docs/V2-ROADMAP.md)

---

## 🏃 Run it locally

**Requirements:** Node.js 22+ (`better-sqlite3` is a native module, so build tools are needed). The repo is configured for **npm** (there's a `package-lock.json`; the Docker image uses `npm ci`).

```bash
# 1. Install dependencies
npm ci          # or: npm install

# 2. Run in watch mode (dev)
npm run start:dev

# 3. Or build + run production
npm run build
npm run start
```

The server listens on **http://localhost:3000** (override with `PORT`). Check it's alive:

```bash
curl http://localhost:3000/health
```

The SQLite database lives at **`./data/app.sqlite`**.

### With Docker (the intended deployment)

```bash
docker compose up -d        # builds + runs the production image on :3000
```

`docker-compose.yml` mounts `./data` into the container and wires a healthcheck against `/health`. The Dockerfile is a multi-stage build.

### Tests

```bash
npm test            # unit tests (*.spec.ts)
npm run test:e2e    # end-to-end tests in ./test
```

> ⚠️ The default-NestJS README that previously shipped here mentioned `bun` — that was boilerplate. This project actually uses **npm** (see `package-lock.json` + Dockerfile).

### Configuration

The full catalog of configurable knobs (env vars, org settings, policy thresholds, LLM profiles, channels, feature flags) is documented in [`docs/CONFIG.md`](./docs/CONFIG.md). Key env vars: `PORT`, `NODE_ENV`, `DATA_DIR`, and (planned) `COUNTRY_PLUGIN`, `ORG_COUNTRY`, `ORG_VAT_REGISTERED`, `BASE_CURRENCY`, `DEV_AGENT_ENABLED`.

---

## 🧰 Tech stack

- **NestJS** (TypeScript) — application framework / DI
- **SQLite** via **better-sqlite3** — the single-file system of record
- **Kysely** (`nestjs-kysely`) — type-safe SQL query builder + migrations
- **Zod** — runtime schema validation (wired as a global NestJS pipe)
- **Jest** — unit + e2e tests
- **Docker / docker compose** — single-container deployment
- *(planned)* **Mastra** — agent / workflow / tool orchestration (orchestration only; SQLite stays the source of truth)

---

## 🗺️ Where to look next

| You want to… | Read |
|---|---|
| Understand the precise vocabulary | [`CONTEXT.md`](./CONTEXT.md) — the domain glossary |
| Understand *why* each design choice was made | [`docs/adr/`](./docs/adr/) — 23 ADRs |
| See the original product brief | [`docs/VISION.md`](./docs/VISION.md) |
| See what's configurable and where | [`docs/CONFIG.md`](./docs/CONFIG.md) |
| Understand the domain model & flows | [`docs/DOMAIN-MODEL.md`](./docs/DOMAIN-MODEL.md) |
| Read the working ledger code | [`src/ledger/`](./src/ledger/) |
| Understand the plugin boundary | [`src/plugins/`](./src/plugins/) |
| See deferred v2 bounded contexts | [`docs/V2-ROADMAP.md`](./docs/V2-ROADMAP.md) |
| See implementation wave plans | [`docs/superpowers/plans/`](./docs/superpowers/plans/) |

---

## 📜 License

See [`LICENSE`](./LICENSE).
