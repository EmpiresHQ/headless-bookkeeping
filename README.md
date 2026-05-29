# Headless Accounting OS

> An AI-native, **headless**, self-hosted accounting kernel for consultants, freelancers, and micro-SMBs.
>
> The accounting ledger lives in a single SQLite file and is the system of record. **AI proposes, rules validate, policy decides, and only then is a voucher posted.** The robot never touches the books directly.

---

## ⚠️ Read this first: what this repo *is*

This is a **learning / reference project**. Its real value is the **thinking**, not (yet) a finished product:

- A rich, opinionated **domain glossary** ([`CONTEXT.md`](./CONTEXT.md)) — how an accountant *actually* talks, turned into precise language.
- 20 **Architecture Decision Records** ([`docs/adr/`](./docs/adr/)) — every important "why did we build it this way" written down.
- A **thin, working kernel** in NestJS + SQLite that implements the safe core (organization, currency, the double-entry ledger, the country-plugin boundary, health checks).

The big vision (Telegram bot, OCR, AI agents, bank reconciliation, VAT filing) is **designed but mostly not built yet**. Think of this repo as *"the foundation and the blueprints,"* not *"the finished house."* See [What works today vs. what's planned](#-what-works-today-vs-whats-planned).

---

## 🧒 ELI5: what does this thing even do?

Imagine you run a one-person business. Receipts and invoices arrive from everywhere — email, photos, a Telegram message, a PDF in Google Drive. Normally you'd hire a bookkeeper or wrestle with a giant accounting app.

This project is a tiny robot bookkeeper that **lives on a $5 server you own**. Here's the idea:

1. You **forward it a receipt** (eventually: via Telegram/email — today: via the API).
2. The **AI reads it** and says *"looks like a €15 taxi ride, category `transport`."*
3. But the AI is **not allowed to write in the accounting books directly**. Instead it makes a *proposal*.
4. **Hard rules check the proposal** (do the numbers balance? is the tax period still open?). These rules can *never* be broken — not even by you.
5. A **policy** then decides: is this safe enough to record automatically, or should it **ask you to tap "Approve"** first?
6. Only then does it write one **voucher** (a permanent, balanced accounting entry) into the ledger.

The books are **append-only** — like a notebook written in pen. You never erase a line; if something's wrong you write a *correcting* line. And the whole notebook is **hash-chained** (like git commits) so you can prove nobody secretly altered an old page.

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

- **AI** is treated as fallible. It proposes; it never commits.
- **Rules** are the deterministic barrier. Two kinds are *inviolable for everyone, including humans*: **structural invariants** (debits = credits, amounts are positive integer cents) and **hard process rules** (you can't post into a locked tax period). A third kind — **semantic rules** (is this VAT code applicable?) — a human *can* override, but only with a logged reason.
- **Policy** is the tunable risk gate: it decides whether a valid voucher **auto-posts** or **waits for a human "Approve"** (based on amount, AI confidence, known/unknown supplier, operation type).
- **Voucher** is the result — permanent and balanced. *(ADR-0005, ADR-0012, ADR-0019)*

> The kernel has **no "break-glass" / force-post**. If the numbers don't balance, *nothing* — not even an admin — can post it. *(ADR-0012)*

### 3. Immutable, append-only, tamper-evident books
- A posted **Voucher is never edited**. To fix a mistake you post a **reversal** (a mirrored counter-voucher) plus a corrected voucher — both referencing the original. *(ADR-0009)*
- The ledger is a **hash-chained log**: each voucher commits to the hash of the previous ledger state (git-commit style). Double-entry proves the books are *correct*; the hash chain proves they *weren't altered after the fact*. *(ADR-0013)*
- When you file a tax period, you freeze a **VAT report** with a **Merkle root** over exactly the vouchers included — cryptographic proof of precisely what was filed.

### 4. Country logic lives in plugins, not the kernel
There is **no universal VAT vocabulary**. Denmark's `DK_INPUT_25` means nothing in Germany. So the kernel stays *thin and country-agnostic*, and a **country plugin** is the **sole resolver** of anything country-specific: VAT codes, deductibility, period frequency, the base currency, category → account mapping. One deployment = one country = one active plugin. *(ADR-0002)*

### 5. Single-tenant, local-first, headless
- **Single-tenant:** one deployment serves **one business** (one Organization). No `org_id` threaded through the schema. Multiple businesses → multiple deployments. *(ADR-0003)*
- **Local-first:** target is a **$5 VPS, one `docker compose up`, one SQLite file, minimal RAM**. No Postgres/Redis/Kafka/Kubernetes required.
- **Headless:** there's no giant accounting GUI. You interact through **Telegram, Slack, email, REST API, and agent tools**. An admin UI exists only for setup/diagnostics.

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
| **Entity** | A counterparty we deal with, tagged `supplier` or `customer`. |
| **Supplier** | Someone we buy from. Identified by a **strong key** (VAT number / Danish CVR), *never* by name. Carries aliases + classification memory. |
| **Customer** | Someone we sell to. |

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
| **Receivable (AR) / Payable (AP)** | What customers owe us / what we owe suppliers after an invoice but before payment. |
| **Prepayment** | Money received before any invoice exists — a *liability*, not a receivable. |
| **Realized FX gain/loss** | The base-currency difference that crystallizes when a foreign-currency position settles at a different rate. |

### The agents & their plumbing
| Entity | ELI5 |
|---|---|
| **AuditFinding** | A persisted "attention item" with a dynamic **severity**. The buffer that decouples *detecting* problems from *nagging* you about them. |
| **Severity** | The priority on a finding — doubles as the nag-frequency knob (low → ~daily, high → ~hourly). |
| **Approval** | A valid submission Policy is holding for a human decision (`pending → approved / rejected / superseded`). Never auto-resolves. |
| **Override** | A logged, human-authored exception to a *semantic* rule (structural invariants can never be overridden). |

---

## 🔌 What are "plugins"?

A **country plugin** is the single place where all country-specific accounting knowledge lives, so the kernel itself stays small and universal.

**One deployment runs exactly one country plugin**, chosen by the Organization's country. It is the **sole resolver** of anything country-specific:

- the set of valid **VAT codes** (e.g. `DK_INPUT_25`) and how they're classified
- **deductibility** and **reverse-charge** rules
- mapping a user **Category** → kernel **Account** + **VAT code**
- the **default base currency** (Irish plugin → `EUR`, Danish → `DKK`)
- allowed **reporting-period frequencies** and the default
- country rules for rounding, tax-point dates, advance VAT, bad-debt VAT relief, capitalization thresholds…

The contract every plugin implements lives in [`src/plugins/country-plugin.interface.ts`](./src/plugins/country-plugin.interface.ts):

```ts
export interface CountryPlugin {
  getName(): string;                 // "DK", "DE", "null"
  getVATCodes(): VATCode[];
  resolveCategoryMapping(category, supplierContext): { account, vatCode };
  getPeriodFrequencyOptions(): string[];
  getDefaultPeriodFrequency(): string;
  getDefaultBaseCurrency(): string;  // the source of the base currency
  validateVATCode(vatCode, context): boolean;
}
```

Today only one plugin is implemented: **`NullCountryPlugin`** ([`src/plugins/null-country.plugin.ts`](./src/plugins/null-country.plugin.ts)) — a safe stub that returns neutral defaults (`EUR`, `yearly`, a single `NULL_STANDARD` VAT code). It lets the kernel run end-to-end before any real national plugin exists. The `PluginLoader` resolves a plugin by country code and falls back to the null plugin for anything it doesn't recognize. Real plugins (DK, DE, …) get registered there as they're built.

---

## ✅ What works today vs. what's planned

**Honesty matters here** — most of the vision in [`docs/VISION.md`](./docs/VISION.md) is design, not code yet.

**Implemented (the working kernel):**
- NestJS app boot + `/health` endpoint
- SQLite + Kysely database layer with migrations (organization, account, voucher, voucher_line)
- **Organization** module (the single-business config)
- **Currency** module (base-currency resolution + FX rate service)
- The **double-entry ledger**: Accounts, Vouchers, VoucherLines, the posting service, ledger validation, and voucher hashing
- The **country-plugin boundary** + the null plugin + plugin loader

**Designed but not built yet** (described in VISION/CONTEXT/ADRs):
- Channels: Telegram, Slack, email intake, Google Drive watcher
- AI agents: AccountingAgent, AuditAgent, ReconciliationAgent, SecretaryAgent, DevAgent *(ADR-0018)*
- OCR / document triage / dedup pipeline *(ADR-0010)*
- Bank reconciliation & matching
- Reporting periods, VAT filing, Merkle anchoring *(ADR-0009, 0013)*
- Admin UI

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

`docker-compose.yml` mounts `./data` into the container and wires a healthcheck against `/health`. The Dockerfile is a 3-stage build (`builder` → `production`, plus a `test` stage).

### Tests

```bash
npm test            # unit tests (*.spec.ts), run one file at a time
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
- **Jest** — unit + e2e tests
- **Docker / docker compose** — single-container deployment
- *(planned)* **Mastra** — agent / workflow / tool orchestration (orchestration only; SQLite stays the source of truth)

---

## 🗺️ Where to look next

| You want to… | Read |
|---|---|
| Understand the precise vocabulary | [`CONTEXT.md`](./CONTEXT.md) — the domain glossary |
| Understand *why* each design choice was made | [`docs/adr/`](./docs/adr/) — 20 ADRs |
| See the original product brief | [`docs/VISION.md`](./docs/VISION.md) |
| See what's configurable and where | [`docs/CONFIG.md`](./docs/CONFIG.md) |
| Read the working ledger code | [`src/ledger/`](./src/ledger/) |
| Understand the plugin boundary | [`src/plugins/`](./src/plugins/) |

---

## 📜 License

See [`LICENSE`](./LICENSE).
