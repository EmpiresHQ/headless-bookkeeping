# Headless Accounting OS

An AI-native, headless, self-hosted accounting kernel for consultants, freelancers, and micro-SMBs. The accounting ledger lives in SQLite and is the system of record; AI proposes, rules validate, policy decides, and only then is a voucher posted.

## Language

### Ledger

**Voucher**:
An immutable, balanced accounting document that records a single economic event as a set of debit/credit lines. Once posted it is never edited — only reversed by a counter-voucher. Carries a **tax-point date** (drives period membership), and optional `reverses` (→ another Voucher) and `corrects_object` (→ a business object) references plus a `reason` for corrections.
_Avoid_: Transaction, entry, journal (when referring to the document itself)

**VoucherLine**:
A single debit or credit against an **Account** within a **Voucher**. Carries the original amount + currency, the **base-currency** amount, the FX rate used, and a **VAT code**. This is the machine-level, double-entry layer — never shown to end users.
_Avoid_: Posting, ledger row

**Account**:
A chart-of-accounts node that **VoucherLines** debit or credit. Internal/technical; never surfaced to SMB users. Carries a `currency`; a foreign-currency account (e.g. a USD bank account) is tracked in both its own currency (to reconcile against its statement) and in base currency.
_Avoid_: Ledger, GL code (in user-facing text)

**Base currency**:
The single reporting currency in which all balances, P&L, and VAT are expressed. Its value is **sourced from the country plugin** (`getDefaultBaseCurrency()`) with an optional **Organization-level override** (`organization.base_currency`, nullable; `NULL` = inherit from the plugin). Resolution: `org.base_currency ?? plugin(org.country).getDefaultBaseCurrency()`. The default deployment is Ireland → `EUR`. See ADR-0004.
_Avoid_: Home currency, functional currency (when ambiguous)

**Realized FX gain/loss**:
The base-currency difference that crystallizes when a foreign-currency position moves (e.g. settling a USD invoice from a USD account at a different rate than it was booked). Posted automatically by the kernel to an FX gain/loss account. Always computed — required for the ledger to balance.
_Avoid_: Exchange difference (when ambiguous with unrealized)

**Category**:
A user-facing semantic label for what an expense or income *is* (`software`, `transport`, `rent`, …). NOT an accounting account. A country plugin maps a Category to an **Account** + **VAT code** at posting time.
_Avoid_: Account, chart-of-account name

### Intake & corrections

**Document**:
The raw intake artifact (attachment + source metadata), and the **deduplication anchor**. Byte-identical attachments arriving via multiple channels collapse into one Document with multiple `sources` (telegram, email, drive). Triage turns a Document into a draft business object.
_Avoid_: File, attachment (when referring to the deduped record)

**Credit note**:
A supplier-issued (or customer-facing) document that formally reduces/cancels a prior invoice — an external accounting document with its own number, own VAT effect, and a reference to the original. Booked as its own Voucher; never silently merged. Distinct from a **reversal** (our own internal correction of our own books).
_Avoid_: Refund, reversal

**Reversal**:
Our own internal cancellation of a posted Voucher by a mirrored counter-voucher (the original stays in the books). Used for *our* errors (e.g. OCR misread). Contrast **Credit note** (the counterparty's external document).
_Avoid_: Void, storno (English canon is "reversal")

### Channels & conversations

**Conversation**:
A persisted, auditable thread of **Message**s on a single channel (an email thread, a Telegram/Slack chat thread) through which an intake is processed. Identified by channel + thread key (email `Message-ID`/`References`; chat thread id). The **router** resolves an inbound message to its Conversation **deterministically** by these keys — distinct from the *probabilistic* intent routing (ADR-0016) — creating a new Conversation only when none matches. Owns its **Message**s and **Artifact**s; *associates* (M:N) to the **Document**(s) and business object(s) it concerns, so a reply carrying no attachment still binds to the original **Document**. An auditable *operational* record linked to the ledger, but **NOT** part of the hash-chained ledger (the ledger stays the accounting system of record). States: `open → closed` — **closed** once every associated in-flight business object reaches a terminal state (its **Voucher** posted, or rejected). A closed Conversation is **retained and retrievable by association**: a later **correction**/modification of a posted object pulls it back for context. A new inbound message that the router resolves (by thread key) to a closed Conversation **reopens** it (logged); a correction arriving on a different thread starts a *new* Conversation associated to the same object.
_Avoid_: Ticket, case, thread (when ambiguous); "Mastra state" (that is transient working memory, not the durable record)

**Message**:
One turn in a **Conversation** — direction (inbound/outbound), sender, timestamp, body, threading keys, and (for email) the DKIM/SPF result. An inbound attachment feeds **Document** dedup.
_Avoid_: Email, chat (when referring to the persisted turn)

**Artifact**:
A file bound to a **Conversation** — an inbound attachment (→ **Document**) or an outbound generated output (a sent invoice PDF, a report). Retained for audit.
_Avoid_: Attachment (when referring to outbound or deduped artifacts), file

**Channel adapter**:
The **only** channel-specific code in the interaction layer (Wave 8). Inbound, it maps a raw channel payload (Telegram update, parsed email, Slack event, Drive notification) into a **unified envelope**; outbound, it renders an abstract **Action point** / dialogue reply into that channel's wire form (TG inline button, email body, Slack block). It splits into a pure **mapper** (payload ↔ envelope — testable in isolation) and a thin **transport port** (the live Bot API / SMTP / webhook edge — mocked in tests). It carries **no** routing, gating, or business logic; the core (router / flows / **Conversation** / pipeline) is channel-agnostic and never sees a raw payload.
_Avoid_: Connector, integration, transport (for the whole adapter — "transport" is only the port half)

**Unified envelope**:
The channel-agnostic representation of one inbound interaction that a **Channel adapter** produces and the core consumes: `{ channel, sender, conv-key, message, attachments, metadata, auth }`. The `conv-key` drives deterministic **Conversation** resolution; `auth` carries the channel's normalized authenticity signals (email DKIM/SPF + address; Telegram chat-id + secret-token result) from which the core resolves a **Principal**. The seam that keeps every channel's quirks out of the core.
_Avoid_: Payload, event, request (when referring to the normalized form)

**Principal**:
Who the core decides an inbound interaction is *from*, resolved channel-agnostically from the **unified envelope**'s `auth` signals: a role (`approver/owner | known-counterparty | unknown`) plus an `authVerified` flag (email: DKIM/SPF pass; Telegram: secret-token-verified webhook + allowlisted chat-id). Access gating lives **once in the core** over the Principal, never duplicated per adapter: converse/command requires an approver; ingest admits a known-counterparty per `ingest_policy`; an **Action point** commit requires an approver **and** `authVerified`. Not a security boundary in the routing sense (a misroute only yields a draft, ADR-0016) — it is the access gate that decides *whether we engage at all*.
_Avoid_: User, identity, role (when ambiguous), sender (the sender is raw; the Principal is resolved)

**Mailbox connector**:
A **pull-based** ingestion source: an external mailbox the Organization owner already owns (their Gmail/Outlook via OAuth, or any IMAP account via credentials) that the kernel is granted access to and periodically synchronizes to harvest invoice attachments. **Ingestion-only** — it produces **Document**s and nothing else: it resolves **no Principal** from the message sender (the sender is an ordinary supplier writing to the *owner*, not a party authorized to address our bot), and it never carries converse/approval traffic (any resulting approval flows through a push channel, not back into the connected mailbox). Trust is **wholesale**: connecting the mailbox authorizes harvesting from it, so admission is gated by **content** (does the message carry a document-like attachment, look invoice-related, and name *our* **Organization** as recipient?) — NOT by a per-sender allowlist. Contrast the email **Channel adapter** (push): a counterparty/approver emails *our* bot address and is gated per-sender by DKIM/SPF + **email whitelist**. The two converge at the **Document** dedup anchor — the same invoice arriving via both collapses into one Document with multiple `sources`. Multiple Mailbox connectors may be active at once.
_Avoid_: Email channel, IMAP adapter, inbox integration (when implying it is a **Channel adapter**)

**Mail sync**:
The periodic process by which a **Mailbox connector** polls (or holds a live connection to) its mailbox for new messages and decides, per message, whether to harvest. Event-driven the other way from the push **Channel adapter**'s inbound webhook: the connector reaches *out* to the mailbox on a schedule and tracks its own position in the mailbox (so an already-seen message is never re-harvested).
_Avoid_: Poll, fetch (when ambiguous with a single network call)

**Delivery channel**:
The path by which a **Document** arrived — `upload | telegram | ios_sync | email_sync | email_push | drive | …` (the `document_source.channel`). More than provenance: it carries an **intent prior** that tunes intake processing. **Deliberate-push** channels (upload, Telegram, iOS sync, **email_push** — the operator or a counterparty *consciously sent* this document) imply high intent → permissive handling; **ambient-pull** channels (**email_sync** — documents arrive unsolicited in a firehose harvested from the owner's own mailbox) imply low intent → conservative, content-gated handling. The same medium can sit on either side: email_push (a counterparty mails *our* bot address) is deliberate; email_sync (we harvest the owner's own mailbox) is ambient — same wire format, opposite profile. The channel is therefore a first-class axis of the **Ingest profile**, not just a label. See ADR-0038.
_Avoid_: Source, provenance (when implying it is only metadata), **Channel adapter** (the adapter is the code; the delivery channel is the document's arrival path)

**Ingest profile**:
The per-**Delivery channel** ruleset that decides how an arriving **Document** is admitted and how a non-matching one is disposed of — a small, **fixed** set of operator-configurable knobs (v1: accept a document that names no recipient, e.g. a receipt; accept photo/image attachments vs PDFs only; dispose of a non-invoice / wrong-recipient document as a silent **discarded** vs a `needs_triage` finding). Defaults differ by channel (its intent prior) and are overridable per-company and optionally per connector instance. **NOT** a general rules engine — a bounded knob set (YAGNI on a DSL). Distinct from **Policy** (the risk gate on a *Rules-valid voucher*: amount/confidence/known-supplier → auto-post vs **Approval**) and from `ingest_policy` (the per-*sender* admission allowlist for push channels: known-only/quarantine/open). The Ingest profile governs *whether and how we engage with a document at all, by channel*; **Policy** governs *whether a resulting voucher auto-posts*.
_Avoid_: **Policy** (the voucher risk gate), `ingest_policy` (the sender allowlist), rules engine

**Discarded (Document)**:
A terminal **Document** state for an arriving document an **Ingest profile** decided not to process — a firehose non-invoice, or an invoice plainly addressed to another party — on an **ambient-pull** channel. **Retained and retrievable** (listed under a "discarded" view, kept for audit and anti-re-harvest), but it raises **no** `needs_triage` finding and never nags the operator. The quiet-drop counterpart to `needs_triage`, chosen by the channel's intent prior: a deliberate-push channel parks an ambiguous document for a human (`needs_triage`); an ambient-pull channel discards it.
_Avoid_: Deleted, ignored, rejected (it is retained, not erased; "rejected" is an **Approval** outcome)

### Dispositions

**Personal (non-business) disposition**:
A user-facing label for a payment from company funds that is actually personal (corporate card used by mistake, no receipt). Not a business expense: no input VAT, not deductible. The ledger books it as Owner's-drawings (sole proprietor) or Receivable-from-owner / shareholder-loan (company) — which one is org-type + country (plugin). Approval-required. One of the **ReconciliationAgent**'s dispositions for an unmatched bank line. In some jurisdictions (DK *kapitalejerlån*) a shareholder loan is legally restricted and taxable on creation — the plugin must surface this as advisory.
_Avoid_: Personal expense (it is not an expense), drawings (user-facing term is "personal")

**Dividend**:
A distribution of a **company**'s profit to its owner(s) — the **primary owner-withdrawal path** in v1. An equity **distribution**, NOT an expense: declared `Dr Retained-earnings / Cr Dividend-payable`, settled `Dr Dividend-payable / Cr Bank` (the settlement reconciled via a `dividend` disposition that draws down the payable). Constrained by **distributable profits** — a legal cap. Because v1 has **no year-end close** (net income is never swept into the Retained-earnings account), distributable profits is **computed live** by the kernel = Retained-earnings balance + current net income (ΣRevenue − ΣExpense) − prior distributions, NOT the bare Retained-earnings account balance; the country plugin checks the proposed dividend against this computed figure. A declaration debits Retained-earnings directly, so that account may be **interim-negative** for a profitable company until a close engine exists (deferred). May carry **dividend withholding tax** (IE DWT, DK *udbytteskat*); the cap and the withholding are both country-plugin rules. Approval-required. Only a `company` pays dividends; a sole proprietor takes drawings. Distinct from a **Personal (non-business) disposition** (accidental personal spend) and from salary (payroll — deferred to a **Domain plugin**, ADR-0022). See ADR-0023.
_Avoid_: Distribution (when ambiguous), payout, drawings

### Basis & settlement

**Accrual basis**:
The kernel recognizes revenue/expense and VAT when the economic event happens (invoice issued / bill received), not when cash moves. Issuing a SalesInvoice immediately posts `Dr AR / Cr Revenue / Cr output VAT`; the later payment is a separate settlement Voucher. This is the only basis the ledger supports; a cash-basis report may be added later as a view.
_Avoid_: Cash basis (not the ledger basis)

**Receivable (AR)** / **Payable (AP)**:
What a **Customer** owes us / what we owe a **Supplier** after an invoice is recognized but before it is paid. Carries an outstanding balance until fully settled by **ReconciliationMatch**(es).
_Avoid_: Debt, balance (when ambiguous)

**Bad debt write-off**:
Removing an uncollectible **Receivable** by posting `Dr bad-debt expense / Cr AR`, rather than leaving an eternal receivable (which overstates assets). A loss recognition → approval-required. Any reclaim of already-paid output VAT is a country-plugin rule (EU VAT Directive Art. 90; conditions vary).
_Avoid_: Forgiveness, cancellation

**Prepayment (on-account balance)**:
Money received before any invoice exists — a *liability* (we owe delivery or refund), not a **Receivable**. An unmatched incoming payment lands here rather than as an error. Drawn down by one or more later invoices via the same N:M matching, with a two-sided outstanding (invoice: amount unpaid; prepayment: credit not yet consumed). Receiving a prepayment can itself be a VAT tax point (EU VAT Directive Art. 65) — the kernel must not assume VAT arises only at invoice; the advance-VAT computation is a country-plugin rule. Symmetric on the buy side (prepaid expense / supplier on-account).
_Avoid_: Deposit, advance (when ambiguous), deferred revenue

### Org & counterparties

**Customer** (an **Entity** with `role: customer`):
A counterparty we sell to.
_Avoid_: Client, buyer

**Organization**:
The single business that owns this deployment — "us", the buyer/seller. Has exactly one country, one VAT-registration status, and one **legal form** (`org_type`: `company` | `sole_proprietor`; **default `company`** — the v1 primary persona is a one-person company that withdraws via **Dividend**s) — the legal form, with country, drives org-type-dependent bookings the country plugin resolves (e.g. a **Personal (non-business) disposition** → shareholder-loan for a company vs Owner's-drawings for a sole proprietor). One deployment = one Organization (mono-structure); it is implicit, so no `org_id` is scoped through the schema. Multiple businesses → multiple deployments.
_Avoid_: Tenant, account, company (when ambiguous; "company" is one `org_type` value, not a synonym for Organization)

**Entity**:
A party the Organization deals with, tagged by `role` (`supplier` | `customer` | `employee` | `director`). `supplier` and `customer` are external counterparties identified by a strong business registration key. `employee` and `director` are internal persons (**Claimant**s) identified by email + channel identity. NOT the Organization itself.
_Avoid_: Party, contact

**Claimant** (an **Entity** with `role: employee | director`):
An internal person — employee or board member — who pays for a business expense from their own funds and submits a reimbursement claim. Identified by email + channel identity (e.g. Telegram user id); no business registration key. The **Supplier** on the **Expense** is always the original vendor (restaurant, airline, etc.) — it drives **Category** → **Account** mapping and **VAT code** resolution via the country plugin. The Claimant is the **creditor**: `claimant_id` on the **Expense** switches the **Voucher**'s credit leg from `AP` to `CLAIMANT_PAYABLE` (a short-term liability). `claimant_id` is resolved **deterministically** by the router from the channel sender — never by AI. An unknown sender whose channel identity matches no Claimant routes to `needs_triage`. Settlement (`Dr CLAIMANT_PAYABLE / Cr Bank`) is deferred to v2; the liability sits in the balance sheet until then. Whether the receipt is addressed to the **Organization** (`company_addressed_receipt: boolean | null` on the **Expense**) determines VAT reclaim eligibility: `true` → country plugin resolves input VAT normally; `false` or `null` → country plugin returns `NULL_VAT_CODE` (conservative — no reclaim when uncertain). Pass 2 detects this from the document; `vat_amount` always reflects what is printed on the document and is never mutated — VAT code resolution governs whether it posts to `VAT_RECEIVABLE`. All claimant-sourced expenses are held for **Approval** by default (`hold_claimant_expenses: true` in **Policy** config). The employee-vs-director distinction matters for country-plugin tax reporting rules (e.g. BIK) but not for the core posting shape.
_Avoid_: Reporting person (Estonian: *aruandekohustuslane* — correct concept, wrong language for this codebase), accountable person, employee (when used as the accounting role — use Claimant)

**Supplier** (an **Entity** with `role: supplier`):
A counterparty we buy from. Identity is anchored on a **strong registration key** (DK: CVR; generally the VAT number) when available, never on name — one legal entity can have many legitimate names (DK *binavne* / secondary registered names), so name matching alone is unreliable. All names (legal + binavne + OCR variants) are **aliases** hanging off that key. Stores intrinsic, context-free facts — country, goods-vs-services, aliases — plus a **classification memory** (which Categories its purchases have been, prior user corrections). It does NOT store a **VAT code** (that depends on the **Organization**'s context).
_Avoid_: Vendor, creditor

### Periods & reporting

**Tax-point date**:
The date that determines which **Reporting period** a **Voucher** falls into for VAT. What counts as the tax point is a country-plugin rule (in DK/EU, usually the invoice/document date). Distinct from the posting date.
_Avoid_: Booking date, posting date

**Reporting period**:
A VAT period whose boundaries and frequency are set by the country plugin + Organization config (frequency can depend on turnover — e.g. DK monthly/quarterly/half-yearly). States: `open → locked`. A **Voucher** belongs to the period whose range contains its **tax-point date**. Membership is *derived* while open. Lock is triggered by filing, never by the calendar; multiple periods may be open at once; filing must proceed in order.
_Avoid_: Quarter, fiscal period (when ambiguous)

**VAT report**:
The frozen snapshot produced when a **Reporting period** is filed: the exact set of included **Vouchers** plus computed declaration boxes, plus a **Merkle root** over those vouchers (cryptographic proof of exactly what was filed). Immutable (reproducibility of what was filed); filing locks the period. A late-discovered error in a locked period is never edited there — a reversal + corrected Voucher are posted in the current open period, dated to it, carrying `reverses` / `corrects_object` references back to the original. An **amended return** is never a mutation: it is a *new* immutable snapshot (e.g. Q1 v2) that supersedes the prior filing for submission and references it; the original snapshot and its Merkle root are preserved.
_Avoid_: Return, declaration (when ambiguous)

### Agents

**AuditFinding**:
The persisted output of the **AuditAgent** — an attention item + `severity` + reference. It is the **buffer that decouples detection from outreach**: AuditAgent (trigger + cron, any hour) writes and re-scores findings; the **SecretaryAgent** reads them during working hours and nags. `severity` is dynamic — AuditAgent re-scores it each sweep, so deadline-driven findings escalate as the deadline nears. The whole nag queue (pending approvals, missing receipts, deadlines) is materialized as severity-bearing findings.
_Avoid_: Alert, warning (when ambiguous)

**Severity**:
The priority on an **AuditFinding**, set and re-scored by the **AuditAgent**. Doubles as the nag-frequency regulator: low → ~daily, high → ~hourly. The **SecretaryAgent** never re-nags a finding more often than its severity allows.
_Avoid_: Priority, level

**SecretaryAgent**:
The only proactive, user-facing agent. Cron-driven but constrained to configurable **working hours**; read-only (never posts). Chases the severity-ranked **AuditFinding** queue via Telegram at a cadence driven by each finding's **Severity** (low → ~daily, high → ~hourly), with anti-spam discipline (digest, escalate-urgent, snooze, per-finding last-nagged tracking).
_Avoid_: Notifier, reminder bot

### Integrity

**Hash-chained voucher log**:
The append-only ledger is tamper-evident: each posted **Voucher** commits to the hash of the previous ledger state (git-commit style). Orthogonal to double-entry — double-entry proves *what* is recorded is correct, the hash chain proves the records *were not altered* after the fact. A **Merkle root** over each locked period's vouchers is stored in its **VAT report**.
_Avoid_: Blockchain, ledger hash (when ambiguous)

**Audit log**:
The single append-only record of *actions and access decisions* across the system — who did what, who was allowed to, and the outcome (`actor`, `action`, `target`, `outcome`, `detail`, time). Made immutable by SQL triggers, but it is an **operational** record (like the **Conversation** aggregate) and is **NOT** part of the **hash-chained voucher log** — ADR-0013's chain proves the *ledger* was not altered; the Audit log records operational events that are not accounting postings. The interaction layer is its first writer (gating decisions, **Action point** commits, channel auth failures); Approval/period-lock/corrections adopt it incrementally. Distinct from an **AuditFinding** (a forward-looking attention item the **SecretaryAgent** nags about) — the Audit log is the backward-looking record of what happened. See ADR-0026.
_Avoid_: Audit trail (when ambiguous with the ledger hash chain), AuditFinding, event log

### VAT

**VAT code**:
The country-specific classification of a line's VAT treatment, owned and defined by a country plugin (e.g. `DK_INPUT_25`). The set and naming vary per country — there is NO canonical kernel VAT vocabulary. It is what a VAT report's boxes are built from. Distinct from the VAT *rate*.
_Avoid_: VAT rate, tax class, VAT treatment (no such abstract layer exists)

**Document VAT marking**:
The raw VAT code/rate as printed on a counterparty's source document (e.g. a German supplier's invoice processed by an Irish Organization). An opaque, un-interpreted evidence string captured at intake; it belongs to **no** country plugin and is **never** an input to balancing, posting, or a **VAT report**. A country plugin may *read* it as a hint (mainly "was VAT charged at all?") when resolving the local treatment, but the booking **VAT code** is always plugin-resolved from `(Supplier intrinsic facts + Organization context)`. Distinct from **VAT code** — a Document VAT marking is the counterparty's foreign label; a **VAT code** is ours (kernel/plugin-owned).
_Avoid_: source VAT code, foreign VAT code (when implying it is itself a real "VAT code")

**VAT territory**:
The fiscal zone that governs cross-border VAT treatment — membership in the EU VAT territory, the EAEU, or "third country" — keyed on a counterparty's location, NOT its political country (the EU VAT territory *excludes* some EU regions, e.g. the Canary Islands, and *includes* some non-EU ones, e.g. Monaco). A country plugin maps a **Supplier**'s country to a VAT territory and decides, from `(our VAT territory + the supplier's VAT territory + goods-vs-services + whether VAT was charged)`, whether a purchase is **domestic**, **reverse-charged**, an **import**, or a **non-reclaimable foreign cost**. Both the membership map and the eligibility rule live in the country plugin (each plugin encodes its own jurisdiction's view); the kernel holds no cross-country VAT layer (ADR-0002). A foreign **Document VAT marking** is never silently reclaimed as input VAT; when the treatment cannot be resolved it is held for **Approval** (conservative default: book gross as a cost).
_Avoid_: country, jurisdiction (when ambiguous), VAT zone, trade bloc

### Voucher kinds

**Intake-driven Voucher**:
A Voucher generated from a document-backed business object (Expense, SalesInvoice) via the full AI-suggest → Rules → Policy → post pipeline.

**System-generated Voucher**:
A Voucher with no source document and no AI step — produced by a deterministic calculation on a schedule or at period close (depreciation, year-end FX revaluation, VAT settlement). Goes straight to Rules → Policy → post.
_Avoid_: Automatic voucher (ambiguous with auto-posted)

**Asset** _(modeled, engine deferred past v1)_:
A capitalized purchase depreciated over time rather than expensed at once. Capitalization threshold, method, and useful life are country-plugin rules. In v1 everything is expensed immediately; a year-end AI sweep may *propose* which posted expenses to reclassify as Assets — the AI proposes candidates and parameters, but depreciation amounts are computed deterministically, and reclassifying a posted Expense is a correction (reversal + repost), hence approval-required.
_Avoid_: Fixed asset (when ambiguous), capital good

### Memory & classification

**Classification memory**:
What a **Supplier**'s purchases have historically been categorized as, plus prior user corrections. Used as *context (a prior) fed to the LLM*, never as a deterministic gate. Accumulated as facts (not overwritten); the model weighs recent vs old. Advisory only — Policy still gates low-confidence/unknown.
_Avoid_: Defaults, rules

**Transactional memory**:
Authoritative, deterministic facts — Supplier identity keys (CVR/VAT), aliases, dedup keys `(supplier, invoice_number)`, and AR/AP/prepayment balances. Feeds deterministic guards (dedup, payment matching, identity). Never demoted to mere "LLM context".
_Avoid_: Cache, hints

### Posting pipeline

**Rules**:
The deterministic validation barrier between a draft and a posted **Voucher**. Three sorts: **structural invariants** (kernel — debits equal credits in base currency, account exists, every line's `amount`/`base_amount`/`fx_rate` is a positive integer (cents) / positive rate) — pure arithmetic; **hard process rules** (kernel — the period containing the voucher's tax-point date must not be locked) — legal/process; both inviolable for everyone including humans. And **semantic rules** (country plugin — VAT code applicability, deductibility) which a human may override via a logged **Override**.
_Avoid_: Validation, checks (when ambiguous)

**Policy**:
The configurable risk gate on top of **Rules** that decides whether a Rules-valid voucher auto-posts or requires human approval (thresholds on amount, known/unknown **Supplier**, AI confidence, operation type, and whether the expense was paid by a **Claimant**). The `hold_claimant_expenses` flag (default `true`) ensures claimant-sourced expenses never auto-post without explicit operator opt-out. A human relaxes Policy, never structural **Rules**. Confidence is a Policy input, not a Rules input.
_Avoid_: Authorization, permissions

**Override**:
An explicit, logged, human-authored exception to a *semantic* Rule (2b), carrying a reason and an audit trail. Structural invariants cannot be overridden.
_Avoid_: Bypass, force

**Approval**:
A Rules-valid submission held by **Policy** for a human decision. States: `pending → approved | rejected | superseded`. Never auto-resolves — a timeout only sends a reminder, never auto-posts or auto-discards. Approved → idempotent posting; rejected → the draft returns to `draft` with a reason (never discarded); superseded → a newer version arrived while pending. On Telegram/Slack the commit is a **button tap** at an action point (the authoritative, attributable signal). Email commits via a **confirmation loop** instead (explicit unambiguous "YES" or re-ask), gated by the email whitelist (approver ⊆ whitelist) + a DKIM/SPF pass. Every action is logged.
_Avoid_: Authorization, sign-off

**Action point**:
The unambiguous commit step inside an otherwise free-chat flow. On Telegram/Slack it is a button (Confirm / Send / Approve). On email — which has no buttons — it is a **confirmation loop**: commit only on an explicit "YES", re-ask on any hedge, never on a maybe. The free conversation leads up to it; the commit closes it.
_Avoid_: Confirmation dialog

### Extension model

**Country plugin**:
An **in-process, stateless** resolver of country-specific *rules* — VAT codes, `Category → Account + VAT code` mapping, cross-border / **VAT territory** treatment, reporting-period frequency, reference FX rate, base currency, org-type-dependent account choices. It has **no database of its own** (pure functions over Supplier facts + Organization context). The **sole resolver** of a **VAT code** (ADR-0002). Exactly one is active per deployment (the Organization's country).
_Avoid_: Plugin (when ambiguous with **Domain plugin**)

**Domain plugin**:
An **out-of-process bounded context with its own database**, integrating with the kernel over an **API**, that owns a whole functional sub-domain end-to-end (first: **payroll** — employees, gross→net, payroll-internal reconciliation). It posts only **summarized Voucher**s, and — like intake — does so **through the pipeline** (**Rules** → **Policy** → post), **never** writing the ledger directly (ADR-0012/0019). Its database is an *operational* store, **not** the accounting system of record (the kernel ledger is). Contrast **Country plugin** (in-process, stateless). See ADR-0022.
_Avoid_: Functional plugin, microservice, satellite service, module

## Relationships

- A **Voucher** has two or more **VoucherLines** whose debits equal their credits in **base currency** (balanced double-entry). Each line carries a positive magnitude (`amount`/`base_amount`) plus an `is_debit` direction — the model is unsigned-magnitude + direction, not signed amounts that literally sum to zero.
- One source document / economic event = exactly one **Voucher**, regardless of how many lines or distinct **VAT codes** it carries. A Voucher is never split by VAT code.
- A **VoucherLine** debits or credits exactly one **Account** and carries one **VAT code** (the code lives on the line, not the Voucher). VAT amounts are split into one line per `account × VAT code` so reports can aggregate by code across all lines.
- One deployment has exactly one **Organization**, in one country, with one active country plugin
- All channels carry the full intent set (advisory, action, report, reconciliation, approval). They differ only in how an **Action point** commits: Telegram/Slack by button tap; email by a confirmation loop + DKIM/SPF
- **Email whitelist** gates conversation/commands/approval (approver ⊆ whitelist) **and ingest** (Wave-8 amendment, ADR-0016): a deterministic sender allowlist (configured at setup) — unknown senders rejected by default (`ingest_policy: known-only`; `quarantine`/`open` are options). The kernel never auto-books an unknown-supplier doc regardless (Wave-7 → `needs_triage`)
- A **Category** maps (via a country plugin) to one **Account** + **VAT code**, but the mapping may depend on the **Supplier**'s intrinsic facts and the **Organization**'s context
- A **VAT code** belongs to exactly one country plugin
- The country plugin is the **sole resolver** of a **VAT code** from `(Supplier intrinsic facts + Organization country/registration)`. No abstract cross-country VAT layer exists.
- A country plugin maps a **Supplier**'s country to a **VAT territory** and resolves the cross-border treatment (domestic / reverse-charge / import / non-reclaimable foreign cost) from it. Reverse-charge uses *our* **VAT code**, not the supplier's; the kernel never reclaims a foreign **Document VAT marking** as input VAT. Unresolvable → **Approval**.
- A **Conversation** owns its **Message**s and **Artifact**s and associates (M:N) to the **Document**(s) and business object(s) it processes; the **router** resolves an inbound message to its Conversation *deterministically* by channel + thread key before doing (probabilistic) intent routing.
- The kernel is extended on **two axes**: **Country plugin**s (in-process, stateless rule resolvers, ADR-0002) and **Domain plugin**s (out-of-process bounded contexts with their own data, ADR-0022). Neither writes the ledger directly — both reach it only through the pipeline (ADR-0012/0019). The two compose: a **Domain plugin** may use a **Country plugin** internally.
- The kernel owns a thin canonical chart of **Accounts**: Cash, Bank (per currency), AR, AP, Revenue, Expense-by-category, VAT-payable, VAT-receivable, Equity, Owner's-drawings (equity contra), Receivable-from-owner/shareholder-loan (asset), Customer-prepayments (liability), Supplier-prepayments/prepaid-expense (asset), FX-gain/loss, Bad-debt-expense, Accumulated-depreciation + Depreciation-expense (when assets are enabled), Claimant-payable (liability — **Claimant** paid first, company owes reimbursement; settlement deferred to v2), Suspense (clearing). All are kernel-canonical, country-agnostic; a country plugin may extend/refine, never replace.

## Example dialogue

> **Dev:** "The user tagged this expense as `software`. What gets posted?"
> **Domain expert:** "The country plugin takes `software`, the **Supplier**'s intrinsic facts (foreign, services), and the **Organization**'s country/registration, and resolves the right **Account** and **VAT code**, then we post a balanced **Voucher**. The user never sees the debit/credit — they only ever see the **Category**."

## Flagged ambiguities

- "Category" vs "Account": resolved — Category is the user-facing label, Account is the hidden double-entry node. They are distinct layers; a country plugin bridges them.
- "VAT code" vs the code printed on a counterparty's document: resolved — the latter is a **Document VAT marking** (opaque evidence), NOT a **VAT code**. A VAT code is always plugin-owned (ours); no cross-country VAT vocabulary exists (ADR-0002). Naming `source_vat_code` was a trap — it implied the foreign label is a "VAT code". Renamed to `document_vat_marking` (Wave-5 Task 32).
- "conversation" (lowercase — ADR-0016 free-chat context) vs **Conversation** (the aggregate): resolved — the former is the *transient* per-channel context fed to the router (Mastra working memory, ADR-0018); the **Conversation** is the *durable, auditable* record (messages + artifacts), persisted and associated to Documents/business objects.
