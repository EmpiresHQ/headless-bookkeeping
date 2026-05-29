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

### Dispositions

**Personal (non-business) disposition**:
A user-facing label for a payment from company funds that is actually personal (corporate card used by mistake, no receipt). Not a business expense: no input VAT, not deductible. The ledger books it as Owner's-drawings (sole proprietor) or Receivable-from-owner / shareholder-loan (company) — which one is org-type + country (plugin). Approval-required. One of the **ReconciliationAgent**'s dispositions for an unmatched bank line. In some jurisdictions (DK *kapitalejerlån*) a shareholder loan is legally restricted and taxable on creation — the plugin must surface this as advisory.
_Avoid_: Personal expense (it is not an expense), drawings (user-facing term is "personal")

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
The single business that owns this deployment — "us", the buyer/seller. Has exactly one country and one VAT-registration status. One deployment = one Organization (mono-structure); it is implicit, so no `org_id` is scoped through the schema. Multiple businesses → multiple deployments.
_Avoid_: Tenant, account, company (when ambiguous)

**Entity**:
A counterparty the Organization deals with, tagged by `role` (`supplier` | `customer`). NOT the Organization itself.
_Avoid_: Party, contact

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

### VAT

**VAT code**:
The country-specific classification of a line's VAT treatment, owned and defined by a country plugin (e.g. `DK_INPUT_25`). The set and naming vary per country — there is NO canonical kernel VAT vocabulary. It is what a VAT report's boxes are built from. Distinct from the VAT *rate*.
_Avoid_: VAT rate, tax class, VAT treatment (no such abstract layer exists)

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
The configurable risk gate on top of **Rules** that decides whether a Rules-valid voucher auto-posts or requires human approval (thresholds on amount, known/unknown **Supplier**, AI confidence, operation type). A human relaxes Policy, never structural **Rules**. Confidence is a Policy input, not a Rules input.
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

## Relationships

- A **Voucher** has two or more **VoucherLines** whose debits equal their credits in **base currency** (balanced double-entry). Each line carries a positive magnitude (`amount`/`base_amount`) plus an `is_debit` direction — the model is unsigned-magnitude + direction, not signed amounts that literally sum to zero.
- One source document / economic event = exactly one **Voucher**, regardless of how many lines or distinct **VAT codes** it carries. A Voucher is never split by VAT code.
- A **VoucherLine** debits or credits exactly one **Account** and carries one **VAT code** (the code lives on the line, not the Voucher). VAT amounts are split into one line per `account × VAT code` so reports can aggregate by code across all lines.
- One deployment has exactly one **Organization**, in one country, with one active country plugin
- All channels carry the full intent set (advisory, action, report, reconciliation, approval). They differ only in how an **Action point** commits: Telegram/Slack by button tap; email by a confirmation loop + DKIM/SPF
- **Email whitelist** gates conversation/commands/approval (approver ⊆ whitelist); **ingest is open to any sender** (suppliers email from arbitrary addresses) — a non-whitelisted sender's document is ingested but never conversed with
- A **Category** maps (via a country plugin) to one **Account** + **VAT code**, but the mapping may depend on the **Supplier**'s intrinsic facts and the **Organization**'s context
- A **VAT code** belongs to exactly one country plugin
- The country plugin is the **sole resolver** of a **VAT code** from `(Supplier intrinsic facts + Organization country/registration)`. No abstract cross-country VAT layer exists.
- The kernel owns a thin canonical chart of **Accounts**: Cash, Bank (per currency), AR, AP, Revenue, Expense-by-category, VAT-payable, VAT-receivable, Equity, Owner's-drawings (equity contra), Receivable-from-owner/shareholder-loan (asset), Customer-prepayments (liability), Supplier-prepayments/prepaid-expense (asset), FX-gain/loss, Bad-debt-expense, Accumulated-depreciation + Depreciation-expense (when assets are enabled), Suspense (clearing). All are kernel-canonical, country-agnostic; a country plugin may extend/refine, never replace.

## Example dialogue

> **Dev:** "The user tagged this expense as `software`. What gets posted?"
> **Domain expert:** "The country plugin takes `software`, the **Supplier**'s intrinsic facts (foreign, services), and the **Organization**'s country/registration, and resolves the right **Account** and **VAT code**, then we post a balanced **Voucher**. The user never sees the debit/credit — they only ever see the **Category**."

## Flagged ambiguities

- "Category" vs "Account": resolved — Category is the user-facing label, Account is the hidden double-entry node. They are distinct layers; a country plugin bridges them.
