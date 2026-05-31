# Domain Model

The **structural** model — aggregates, flows, state machines, and invariants. The **language** (term definitions) lives in [`CONTEXT.md`](../CONTEXT.md); this document references those terms in **bold** and never redefines them. Architectural decisions live in [`docs/adr/`](./adr/).

> Living document. Sections are added as decisions crystallise (e.g. during grilling sessions). Absence of a section means "not yet modelled here", not "no rule".

## Intake flow (Document → Voucher)

The path a document takes from arrival to a posted **Voucher**. Each step's authority is noted — what *decides*, not just what *happens*.

```
(1) Intake        Document arrives (any channel) → hashed → dedup anchor.
                  Byte-identical attachments collapse into one Document + many sources.
                      │
(2) OCR / triage  Extract facts: amounts (gross, vat), category guess,
                  supplier hints (name, registration key), Document VAT marking.
                  OCR proposes; it never decides treatment or identity.
                      │
(3) Supplier      Lookup Entity by registration key / alias.
    resolution      ├─ found      → reuse (set supplier_id)
                    └─ not found  → propose-create (human-confirmed Action point,
                                     captures country) → onboard → set supplier_id
                  Identity is resolved HERE, not gated at posting (ADR-0010).
                      │
(4) Draft         Create the business object — an EXPENSE (purchase) or a
                  correction; intake is the purchase side, NOT our SalesInvoice
                  (we issue those outbound). Already carries supplier_id.
                  Generate the draft Voucher: the country plugin resolves
                  Account + VAT code + cross-border treatment.
                      │
(5) Pipeline      Rules (structural → hard → semantic) → Policy (auto-post vs
                  Approval) → post. Voucher number minted only at posting.
                      │
(6) Voucher       Immutable, balanced, hash-chained. Corrections are reversal +
                  repost, never edits.
```

### Authority boundaries (the load-bearing invariants)

- **OCR proposes, never decides.** Amounts/category/marking/supplier hints are candidates. The **country plugin** decides VAT treatment; the human decides supplier creation.
- **The country plugin is the sole resolver** of **VAT code** and of **cross-border treatment** (domestic / reverse-charge / import / non-reclaimable foreign cost), keyed on the **Supplier**'s `country` → **VAT territory**, not on any **Document VAT marking** (ADR-0002).
- **Supplier identity is resolved at step 3 (intake), not at posting.** A posted **Voucher** always carries a real `supplier_id` in the happy path. The Policy `unknown_supplier_requires_approval` rule is a **backstop** that should never fire normally — if it does, intake was bypassed (ADR-0010).
- **A foreign VAT amount is never silently reclaimed.** `foreign_cost` / `unresolvable` treatments never emit a `VAT_RECEIVABLE` line; `unresolvable` holds for **Approval** (conservative default: gross-as-cost).
- **Intake is the purchase side.** An incoming document becomes an **Expense** or a **correction** — never our own **SalesInvoice** (we issue those outbound). v1 triage outcomes: `new_expense | correction | duplicate | unknown`. The lone exception, **self-billing** (incoming = our revenue), is deferred to **v2 as a domain plugin** (ADR-0010, ADR-0022, `V2-ROADMAP.md`).

## Aggregates (intake)

- **Document** — dedup anchor; 1 Document → N sources. Owns its lifecycle: `received → triaged → processed` (and `error`).
- **Entity** (**Supplier** / **Customer**) — identity anchored on a strong registration key (CVR / VAT number); names are aliases. Stores intrinsic facts (`country`, goods-vs-services) + classification memory. **Never** stores a **VAT code** (ADR-0002). _Built in Wave-5 Task 33 — does not exist before that; `expense.supplier_id` is currently a bare column._
- **Expense** / **SalesInvoice** — document-backed business objects; the source of truth that projects to a **Voucher** (ADR-0006). Carry `supplier_id` / `customer_id` → **Entity**.

## Conversation (channel intake & dialogue)

A **Conversation** is the persisted, auditable thread through which an intake is processed over a channel (email/Telegram/Slack). It is how a multi-turn exchange (client → agent → client → agent) stays coherent and reuses the first message's **Document**.

```
Inbound message arrives (channel adapter)
        │
   Router RESOLVES the Conversation        ← deterministic: channel + thread key
   (email Message-ID/References; chat thread id)   (NOT an LLM guess)
        ├─ existing thread → bind to that Conversation
        └─ no match        → create a new Conversation
        │
   Append a Message (direction, sender, ts, body, threading keys, DKIM/SPF)
   Inbound attachments → Artifacts → Document dedup
        │
   Router CLASSIFIES intent                 ← probabilistic (ADR-0016)
   (advisory | action | report | reconciliation), with the Conversation's
   bound Document/business-object context in hand
        │
   … free chat … → Action point (button / email YES-loop) commits
```

- **Owns:** `Message`s, `Artifact`s. **Associates (M:N):** **Document**(s), business object(s).
- **Identity:** channel + thread key. Resolution is deterministic and precedes intent routing (ADR-0016).
- **A bare reply (no attachment) reuses the original Document** through the Conversation binding — this is the whole point.
- **Audit vs ledger:** the Conversation is an auditable *operational* record (who said what, what was sent, when approved). It is **not** part of the hash-chained ledger; the **Voucher** log remains the accounting system of record. Mastra working memory is transient and rebuildable from the Conversation (ADR-0018).
- **Whitelist (ADR-0016):** ingest is open to any sender (a supplier's document is pulled in even from a non-whitelisted address); conversation/commands/approval are whitelist-gated. So a Conversation may exist with no outbound dialogue (ingest-only) until/unless a whitelisted participant engages.

### Lifecycle & retrieval-on-modification

```
            open ──────────────► closed
              ▲                     │
              │  inbound message    │  all associated in-flight objects
              │  resolves to it     │  reach terminal state (Voucher posted
              │  (reopen, logged)   ▼  / rejected)
              └──────────── closed (retained, queryable by association)
```

- **Close trigger:** a Conversation closes when every associated in-flight business object is terminal (posted/rejected). Threads carrying several invoices close only when all resolve.
- **Reopen:** an inbound message the router resolves (by thread key) to a *closed* Conversation reopens it — the transition is logged. This is the "client replies to the old thread to correct" case.
- **Retrieval for modification:** a **correction** of a posted object (reversal + repost, ADR-0010/ADR-0006) fetches the associated Conversation(s) — open *or* closed — via the M:N association, to recover the original dialogue and **Artifact**s as context. A correction arriving on a *different* thread/channel starts a **new** Conversation associated to the same object (which can then pull the prior closed one for context).
- The closed Conversation is never mutated to rewrite history; reopen/append and new-linked-Conversation are both append-only, audit-preserving.

## AI ingestion (Mastra, Wave 7)

The "AI proposes" layer — real OCR + agentic classification — embedded in-process on **Mastra** (ledger stays SoR). Replaces the Wave-4 stub. See ADR-0024.

```
[Pass 1: OCR → markdown]            vision model; transcribe, don't structure;
        │                          markdown stored as Conversation Artifact (audit + replay anchor)
[Pass 2: read-only agent + tools]  read-tools (searchSuppliers/listCategories/memory) →
        │                          ONE complete Zod-validated TriageResult (kind, amounts, currency,
        │                          document tax-point date, supplier proposal, category, marking, confidence)
[route by confidence + kind]
   ├─ confident & kind=new_expense → proposeDraft (deterministic step) creates ONE draft Expense
   │        → generateDraftVoucher → Rules → Policy → (auto-post | hold→Approval(draft))   [the only ledger path]
   └─ uncertain / unknown / supplier unresolved → NO draft → AuditFinding(needs_triage) → human → re-run
```

- **No garbage drafts:** the agent is **read-only** (no create-draft tool); a draft is created once, deterministically, only from a complete confident `new_expense` result. Uncertain → no draft, a `needs_triage` AuditFinding instead.
- **HITL is durable on our aggregates, not Mastra suspend (v1):** a held draft → `Approval` (Wave-6); an uncertain no-draft → `AuditFinding` (Wave-6). Both on-disk, reboot-safe. Mastra `suspend()` unused in v1 (reserved for future).
- **Boundary invariant:** only schema-validated structured output crosses into the kernel (no free text). Confidence → **Policy** (not Rules). Classification proposes **category + supplier**, never account/VAT (plugin sole resolver, ADR-0002). Tools wrap services: read-only agent / draft created by deterministic step / **no `post()` tool** (ADR-0018/0012/0019).
- **Non-determinism outside the chain:** the AI proposal + model id/version + markdown persisted for audit (`ai_proposal`); the hash-chained ledger only sees the deterministic posted voucher.
- **Runtime:** Mastra (Zod structured output, workflow). `pi-agent-core` evaluated, rejected (no first-class structured output / durable suspend) — ADR-0024.

## State machines

Several aggregates are **FSM-governed** — status is only ever changed via a defined transition, never an arbitrary write (the service rejects illegal transitions). Consistent posture across the system:

- **ReportingPeriod**: `open → locked` (locked is terminal; no unlock — ADR-0012/0009).
- **Approval**: `pending → approved | rejected | superseded` (never auto-resolves — ADR-0015).
- **Business object** (Expense/SalesInvoice): `draft → pending → posted → reversed` (corrections reverse + repost, never edit).
- **AuditFinding**: `open ⇄ snoozed`, `open|snoozed → resolved`, `resolved → open` (**reopen** when a sweep re-detects a resolved issue — same row via its UNIQUE key; severity re-scores while open/snoozed — ADR-0018).
- **Document**: `received → triaged → processed` (+ `error`).
- **bank_transaction** disposition: `open → prepayment | personal | bank_fee | dividend`.

Objects created *to resolve* a finding link back via `finding_reference` (provenance) — mirroring the Voucher's `reverses`/`corrects_object` back-references.

## Open structural gaps (tracked)

- **Entity aggregate unbuilt** — no table/module until Wave-5 Task 33; `expense.supplier_id` is a bare integer (not a FK), supplier memory and `(supplier, invoice_number)` dedup have no backing store, and the Policy known/unknown gate is an inert stub. (Wave-4 grilling finding.)
- **Cross-border treatment unimplemented** — `NullCountryPlugin` maps every supplier to domestic IE input VAT; foreign invoices mis-book until Wave-5 Task 34.
- **Payroll PARKED — and will be a `Domain plugin`, not a kernel feature (ADR-0022).** "salary" exists only as an expense **Category** (`salary → EXPENSE_SALARY`). Payroll (employees, gross→net, employer contributions/pension, filing, payroll-internal reconciliation) will live in an **out-of-process domain plugin with its own DB**, posting only a *summarized* voucher (`Dr SALARIES / Cr net-pay-payable / Cr tax-payable / …`) **through the pipeline**; the kernel holds only the `SALARIES` account + payables and reconciles the net-pay bank line against net-pay-payable. **Deliberately deferred** — for v1 the owner-withdrawal path is **dividends**, not salary. (Grilling, 2026-05-31.)
- **Dividend distribution — NOW IN SCOPE (primary owner-withdrawal path for v1).** Resolved during grilling (ADR-0023): a dividend is an equity distribution (`Dr Retained-earnings / Cr Dividend-payable`; settle `Dr Dividend-payable / Cr Bank`), withholding (IE DWT / DK udbytteskat) and the distributable-profits cap are **country-plugin** rules, approval-required, ledger-native (not a domain plugin). Scheduled: **Wave-6 Task 37** (declaration + settlement disposition + plugin hooks + `RETAINED_EARNINGS`/`DIVIDEND_PAYABLE` accounts); **Wave-5 Task 21** reserves the `dividend` disposition enum value. `org_type` default flipped to **`company`** (the primary persona).
