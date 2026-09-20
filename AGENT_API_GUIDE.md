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

**`country` and `base_currency` are settable only until the first voucher is
posted.** They are the UNIT of every amount in the ledger: a VoucherLine stores
`base_amount` as a bare integer, and which currency that integer is in — and
whose rate and rounding produced it — lives only in these two fields. Once
anything is posted, a PUT that would change the EFFECTIVE basis is refused with
**409 Conflict** and nothing is written; the historical ledger is never
re-converted, because no controlled basis transition is supported (posted
vouchers are immutable and hash-chained). Set the jurisdiction and the base
currency during onboarding; to keep books in another basis, start a separate
ledger.

One consequence worth knowing before you change the base currency on an empty
ledger: an **allowance** records its own currency at creation (the claim
workflow takes no currency field) and is booked at an identity rate, so a claim
raised under the previous base currency is refused at approval with **409**,
with its split rolled back and the claim left awaiting approval. There is no
restatement path — set the base currency back while the ledger is still empty,
or settle that claim outside the allowance workflow.

Still allowed after posting: an edit with no effect on the effective basis
(writing the plugin's own default into `base_currency`, or clearing it again),
restating the same `country`, a PUT that names neither field, and every other
setting — `name`, `iban`, `org_type`, the registry/VAT numbers and all the VAT
facts.

**Input-VAT deduction entitlement.** Being liable for VAT and being entitled to
deduct it are different questions, so three further fields record the second one
and the posting side reads them before any `VAT_RECEIVABLE` is created:

```bash
curl -H "$H" -H "$J" -X PUT $B/api/organization \
  -d '{"vat_registered":true,"vat_registration_kind":"ordinary",
       "input_vat_entitlement":"partial","input_vat_deduction_permille":500}'
```
* `vat_registration_kind`: `ordinary | limited`. A **limited** taxable person
  (EE *piiratud maksukohustuslane*) self-assesses VAT on specified acquisitions
  and deducts **nothing**; the EE plugin also refuses to auto-classify a SALE
  under it.
* `input_vat_entitlement`: `full | partial | none`.
* `input_vat_deduction_permille`: required exactly when the entitlement is
  `partial`, a whole number of per mille 0–1000 (`500` = 50%). Forbidden
  otherwise, and cleared automatically when the entitlement leaves `partial`.

The combinations are validated as one merged state: an entitlement other than
`none` on a non-registered organization is rejected — a percentage cannot buy
back a deduction the registration does not confer. A caller that sends only
`vat_registered` keeps working: deregistering carries the entitlement to `none`,
registering sets the ordinary default of `full`.

Whatever is **not** deductible is not lost — it increases the expense or the
capitalised asset cost, and it stays out of KMD row 5. On a reverse charge the
output VAT is still declared and paid in full; only the input side is reduced,
and the acquisition base declared in KMD rows 1/6/7 stays the value the supplier
invoiced. The entitlement a purchase was posted at is frozen on the voucher
(`input_vat_entitlement_basis`, `input_vat_deduction_numerator`/`_denominator`),
so later settings changes never restate an already-posted entry or a filed
return. This records the proportion in force at posting; it is not an annual
pro-rata recalculation engine.

For Estonian KMD exports, also set `registry_code` to the company's 8-digit
commercial registry code via `PUT /api/organization` (or Settings → Organization).
Keep `vat_registration_number` as the separate `EE…` VAT number. Existing
organizations receive `registry_code: null` on upgrade; final KMD export requires
a valid registry code and never infers it from the VAT number.

### Open a reporting period (without it, posting hits the period-lock)
```bash
curl -H "$H" -H "$J" -X POST $B/api/reporting-periods \
  -d '{"name":"2026-01","start_date":"2026-01-01","end_date":"2026-01-31"}'   # status: open
curl -H "$H" $B/api/reporting-periods/current
```
A reporting period is a **VAT period** — the scope a KMD is filed for. Two of
them may not overlap.

### Open a financial year (the scope the annual accounts are closed for)
```bash
curl -H "$H" -H "$J" -X POST $B/api/reporting-periods \
  -d '{"name":"FY2026","start_date":"2026-01-01","end_date":"2026-12-31","kind":"annual"}'
curl -H "$H" "$B/api/reporting-periods?kind=annual"     # the annual timeline
curl -H "$H" "$B/api/reporting-periods?kind=all"        # both, by start date
```
A financial year is an independent timeline: it deliberately spans the VAT
periods inside it, and it need not be a calendar year. It carries no VAT
declaration of its own — `POST /api/reporting-periods/<id>/lock`, the KMD and
the statutory export all refuse an annual id. Close it with
`POST /api/reporting-periods/<id>/annual-accounts/finalize`, which posts the
year-end depreciation charge (even if December's VAT period is already filed —
the filed return is left exactly as frozen) and locks the whole year: after
that, nothing posts anywhere inside it, including months still open for VAT.
Listing without `?kind=` returns the VAT calendar, as it always did.

### Add a supplier / customer
```bash
curl -H "$H" -H "$J" -X POST $B/api/entities -d '{
  "role":"supplier", "country":"IE", "name":"Acme Software Ltd",
  "registrationKey":"IE1234567T", "goodsVsServices":"services",
  "taxStatus":"taxable_business"}'
# role: supplier|customer; identity is by registrationKey (VAT/CVR), never by name.
# GET /api/entities, GET /api/entities/:id.
# PATCH /api/entities/:id updates the mutable facts: name, country,
# goodsVsServices, taxStatus. Identity (role, registration key) is immutable.
```
`taxStatus` — `taxable_business` (a business acting as such) | `non_taxable`
(a consumer) | `unknown`. **Omitting it means unknown, not consumer.** It is the
fact that decides where a cross-border service is taxed, so while it is unknown
a cross-border service invoice to this customer is REFUSED rather than guessed
(see below). On a SUPPLIER it decides the same question in the other direction —
whether a purchase is a reverse-charged acquisition, and whether it is an
intra-Community one — so a cross-border expense is refused while it is unknown
too. It describes the COUNTERPARTY; our own VAT registration is
`organization.vat_registered` (and `vat_registration_kind` /
`input_vat_entitlement`, above).

### Enter an expense (purchase)
```bash
EXP=$(curl -s -H "$H" -H "$J" -X POST $B/api/expenses -d '{
  "category":"software","gross_amount":12300,"vat_amount":2300,
  "currency":"EUR","tax_point_date":"2026-06-09","supplier_id":1}')   # status: draft
# run it through the pipeline (Rules→Policy→post/hold):
curl -H "$H" -H "$J" -X POST $B/api/expenses/<id>/post -d '{}'
```
The response contains `policy.action`: **`auto-post`** (e.g. "within ceiling" → a voucher is created; double entry Dr EXPENSE_* + Dr VAT_RECEIVABLE = Cr AP, VAT code from the plugin e.g. `IE_INPUT_23`) or **`hold-for-approval`** ("exceeds ceiling …").

### Cross-border purchases: where a reverse charge is declared (EE)

A purchase from a foreign supplier is self-assessed (pöördmaksustamine) when the
supplier is a person engaged in business: we owe the supplier only the net and
book equal output + input VAT at the Estonian rate, net cash zero. WHERE it is
declared depends on where it came from, and the KMD keeps the two apart:

| supplier | treatment | KMD |
|---|---|---|
| Estonia | ordinary input VAT | row 5 |
| other member state, taxable person | reverse charge | rows 1 + 4 + 5, **row 6** |
| third country, business, services | reverse charge | rows 1 + 4 + 5, **row 7** |
| third country, goods | import (VAT at the border) | unchanged |

The origin is decided from the supplier's recorded facts at POSTING time and
frozen into the voucher's VAT code (`EE_REVERSE_CHARGE_EU` /
`EE_REVERSE_CHARGE_3RD_COUNTRY`), so editing the supplier later never
reclassifies a return that was already filed.

**Refusals (HTTP 422)** — nothing is posted; the body carries `code`,
`missing_facts` and `how_to_resolve`:

| `code` | what to do |
|---|---|
| `supplier_tax_status_unknown` | `PATCH /api/entities/:id {"taxStatus":"taxable_business"}`, then post again |
| `supplier_non_taxable_acquisition_unsupported` | the supplier is recorded as a private person, so no reverse charge arises — correct the status, or book the cost with your accountant |
| `acquisition_supply_type_unknown` | `PATCH /api/entities/:id {"goodsVsServices":"services"\|"goods"}` — it decides import vs self-assessed service |

**Vouchers posted before the origin was recorded** carry the old
`EE_REVERSE_CHARGE` code, which does not say where the acquisition came from.
They are counted in NEITHER row 6 nor row 7 — they appear in
`row6_7_unresolved_acquisition` and are named voucher by voucher in
`unresolved_acquisition_vouchers` and `review_flags` on
`GET /api/reporting-periods/:id/kmd`. While any remain, `POST
/api/reporting-periods/:id/lock` and a final statutory export are refused (409):
a guessed row is exactly the defect. Clear them with the recorded facts and the
ordinary correction:
```bash
curl -H "$H" -H "$J" -X PATCH $B/api/entities/<supplierId> -d '{"taxStatus":"taxable_business"}'
curl -H "$H" -H "$J" -X POST $B/api/expenses/<id>/correct \
  -d '{"kind":"financial","reason":"record the acquisition origin"}'
```
which reverses the old voucher and reposts it on the resolved origin. A
correction of an expense in an ALREADY FILED period is redirected into the open
one (ADR-0009): there the removal comes back out of the row that filing
declared it in, and the replacement declares the resolved origin. Filed
snapshots are never rewritten.

### Enter an invoice (outbound sales invoice — one we issue)
```bash
curl -H "$H" -H "$J" -X POST $B/api/sales-invoices -d '{
  "invoice_number":"INV-001","customer_id":null,"gross_amount":24600,
  "vat_amount":4600,"currency":"EUR","tax_point_date":"2026-06-09",
  "supply_type":"services","service_place_rule":"general"}'            # status: draft
curl -H "$H" -H "$J" -X POST $B/api/sales-invoices/<id>/post -d '{}'    # → voucher (Dr AR = Cr REVENUE + Cr VAT_PAYABLE)
# optional: POST .../generate-draft (preview entry), POST .../send (mark as sent)
```
> An inbound supplier invoice is an **expense** (intake is purchase-side only), not a sales invoice.

`supply_type` — `goods` | `services`, what THIS invoice supplies. Omitted ⇒ the
customer entity's `goodsVsServices` decides (so existing callers are unchanged);
if neither says, a CROSS-BORDER sale is refused, because the answer depends on it.

`service_place_rule` — which place-of-supply rule the caller declares for a
service. Omitted ⇒ `general`, and that default is a **caller-declared scope**:
saying nothing asserts that the residual general rule (EE: KMS §10 lg 1 / lg 2)
applies, not that the rule is unknown. The named exceptions —
`immovable_property`, `passenger_transport`,
`cultural_artistic_sporting_admission`, `restaurant_catering`,
`short_term_hire_of_means_of_transport`, `electronically_supplied_to_consumer`,
`other_special` — each have their own place of supply and are **not**
auto-classified: declaring one gets an actionable refusal, never a blanket 0%
or a blanket domestic rate. Declaring one on a non-service supply is refused too,
rather than silently ignored.

### Service sales: how the place of supply is decided (EE)

For a **general-rule** service, the Estonia plugin maps the recorded facts onto
[EMTA's place-of-supply table](https://www.emta.ee/en/business-client/taxes-and-payment/value-added-tax/taxation-services/taxation-and-declaration-supply-services):

| customer | rate | KMD | VD |
|---|---|---|---|
| Estonia (business or consumer) | 24% | rows 1 + 4 | — |
| other member state, taxable person | 0% | rows 3 **and 3.1** | 3S |
| other member state, non-taxable person | 24% | rows 1 + 4 | — |
| third country, business | 0% | row 3 only | — |
| third country, consumer | 24% | rows 1 + 4 | — |

Country alone never decides it, and the rate used is the one in force at the
invoice's **tax-point date** (EE: 20% → 22% → 24%), so a back-dated invoice is
measured against its own era. GOODS sales are unaffected by this table.

**Refusals (HTTP 422).** When the recorded facts cannot decide the treatment,
nothing is posted — no voucher, no partial write, no logged override that could
bless a guess. The body carries `code`, `missing_facts` and `how_to_resolve`:

| `code` | what to do |
|---|---|
| `customer_tax_status_unknown` | `PATCH /api/entities/:id {"taxStatus":"taxable_business"\|"non_taxable"}`, then post again |
| `supply_type_unknown` | create the invoice with `supply_type`, or set the customer's `goodsVsServices` |
| `service_place_rule_unsupported` | book the declared exception explicitly with your accountant, or set `service_place_rule:"general"` if it does apply |
| `service_place_rule_without_service_supply` | set `supply_type:"services"`, or drop the declared exception |
| `vat_amount_conflicts_with_treatment` | correct the invoice's `vat_amount`, or the facts that decide the rate |

A document arriving through intake hits the same wall, and is **held**
(`needs_triage`) with the same actionable reason rather than posted on a guess.

Fix the invoice-side facts on the SAME draft (the invoice number is unique, so
re-creating it returns 409) and post again:
```bash
curl -H "$H" -H "$J" -X PATCH $B/api/sales-invoices/<id> -d '{
  "supply_type":"services","service_place_rule":"general",
  "gross_amount":10000,"vat_amount":0}'
# draft (or pending — its approval is superseded) only; posted -> 409:
# a posted voucher is immutable, correct it via POST .../correct (reversal).
# Amounts are validated AFTER the merge: sending vat_amount alone still has to
# fit the invoice's existing gross_amount (400 otherwise).
# Customer-side facts go to PATCH /api/entities/:id instead.
```

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

### Customer prepayments: what the money IS (issue #213)

A payment received in advance is taxed on the day it arrives when it pays for
an identified taxable supply — Estonia taxes the EARLIER of the supply and the
payment for it (KMS §11 lg 1). So the prepayment endpoint asks what the money
is, and never guesses:

```bash
# An advance on an identified taxable supply: 124.00 received, 24.00 of VAT
# declared on the RECEIPT date, 100.00 owed to the customer until the invoice.
# `vat_code` comes from the treatments endpoint below; `advance_document_number`
# is the advance invoice's number, when one was issued.
curl -H "$H" -H "$J" -X POST $B/api/bank-transactions/<txnId>/prepayment -d '{
  "entity_id": 7,
  "tax_treatment": "taxable_supply",
  "vat_code": "EE_OUTPUT_24",
  "supply_description": "Website build, delivery in March",
  "advance_document_number": "ETTEMAKS-12"
}'

# A security deposit: a gross liability that declares nothing.
curl -H "$H" -H "$J" -X POST $B/api/bank-transactions/<txnId>/prepayment \
  -d '{"entity_id":7,"tax_treatment":"non_taxable_deposit"}'

# Nothing stated → the money is still recorded, and the advance is HELD.
curl -H "$H" -X POST $B/api/bank-transactions/<txnId>/prepayment

# Which treatments a receipt on a given date may declare (the country plugin
# answers; the rate in force is part of the answer).
curl -H "$H" "$B/api/prepayments/advance-vat-treatments?receipt_date=2026-02-10"
```

- **Held** means held: an unclassified customer receipt cannot be drawn down,
  cannot settle a bank line, and its period's VAT return cannot be FILED —
  the declaration names it (`unresolved_advance_receipts`). Classify it with
  `POST /api/prepayments/<voucherId>/tax-treatment`; classifying a held
  receipt as taxable reverses the gross advance and reposts it split, at the
  same receipt tax point (no posted voucher is ever edited).
- Every prepayment posted before this existed is `unresolved` for the same
  reason: a gross posting is not evidence that its supply was non-taxable.
- **Supplier** advances are unaffected — they declare no output VAT, and their
  input VAT follows the supplier's invoice and issue #211's entitlement rules.
- The final invoice **releases** the advance VAT exactly once, and the release
  is dated at the INVOICE's own tax point, so the supply and its relief always
  fall in the same period. Drawing down against an invoice in a filed period is
  refused, as is pairing an advance taxed at 22% with an invoice at 24% (the
  advance keeps its own rate — EMTA's rate-change rule — and this kernel does
  not apportion an invoice across it).
- **Refunds** take the VAT back with the money, and need the document the
  relief is taken under:

```bash
curl -H "$H" -H "$J" -X POST $B/api/prepayments/<voucherId>/refund -d '{
  "bank_transaction_id": 42, "credit_reference": "KREEDIT-7",
  "reason": "Order cancelled by the customer"
}'
```

  The outgoing line must identify the advance's own customer, it is idempotent
  per bank transaction, and a foreign-currency refund is refused rather than
  letting an exchange difference move declared VAT.
- A counter-voucher posted against an advance, its draw-down or its refund in a
  LATER period puts that amount back into the later period's boxes with no
  document behind it. That period is **held** (`unsupported_advance_reversals`)
  rather than filed with an invented credit note, and the original period's own
  filing is left exactly as it was. The same hold covers a counter-voucher that
  mirrors only part of a document, or one that was itself reversed.
- In KMD INF the final invoice is reported LESS the advance already invoiced
  (EMTA's part-A example: a 2000 advance and a 5000 transaction is one row of
  3000, not 5000 plus a credit nobody issued). An INF-reportable advance with
  no document number blocks a FINAL export — record it with
  `POST /api/prepayments/<voucherId>/advance-document`.

### Allowances, and the health/sports exemption (issue #212)
```bash
# Trip-based and per-input allowances. A claim is created as a draft, submitted,
# and posted only when an approver confirms it.
curl -H "$H" -H "$J" -X POST $B/api/allowances -d '{"type":"mileage","claimant_id":4,"km":120,"period_start":"2026-09-01"}'
curl -H "$H" -X POST $B/api/allowances/<id>/submit          # → 204, creates the pending approval
curl -H "$H" -H "$J" -X POST $B/api/approvals/<id>/approve -d '{"approved_by":"owner"}'
```

A **health** claim is different from phone/internet: it is tax-exempt only up to
a statutory cap **per claimant per window** (EE: EUR 400 per calendar year from
2025-01-01; EUR 100 per calendar QUARTER before that) and only when the
exemption's conditions are met. So it must carry the facts those conditions turn
on, or it is refused (422) with each missing fact named:

```bash
curl -H "$H" -H "$J" -X POST $B/api/allowances -d '{
  "type":"health","claimant_id":4,"input_amount":100000,"period_start":"2026-09-01",
  "health_category":"sports_facility_fee",        # the qualifying list is date-specific
  "claimant_relation":"employee",                 # employee | board_member | other
  "supporting_document_ref":"INV-2026-0042",      # or "supporting_document_id": <document id>
  "offered_to_all_employees":true,
  "provider_registration":"L04321"                # required for provider-conditional services
}'
```

- The amount over the remaining cap is a **taxable fringe benefit**, not salary.
  The employer owes income tax (EE from 2025: 22/78 of the benefit) and social
  tax (33% of benefit + income tax) **on top of** what the claimant is paid: a
  EUR 1000 claim with the full cap available posts 400 exempt, 600 as a fringe
  benefit, 423.08 of employer tax, 1000 payable to the claimant.
- Facts that do not qualify → the whole claim is taxable, with the reason
  recorded on the row (`exemption_basis`). A claim recording NO facts (entered
  before this existed) is booked as fully taxable, never as exempt.
- Only claims whose money is in the books consume the cap. A draft reserves
  nothing; the authoritative allocation happens inside the transaction that
  posts the voucher, so two approvals cannot both take the same remaining cap.
- No input VAT is deducted on a health benefit.

### Health benefit declaration figures
```bash
curl -H "$H" "$B/api/reports/fringe-benefits/health?year=2026"
```
Returns the monthly **TSD annex 4, benefit code 4120** lines (taxable benefit,
income tax, social tax, due on the 10th of the following month) and the annual
**INF 14 part III** exempt total with the number of employees, each with the
allowance and voucher ids behind it. It **submits nothing** and produces no EMTA
upload file — these are the figures to file.

Read `readyToFile` before trusting a total:
- `unresolvedHistoricalClaims` lists claims posted before this accounting
  existed (no `exemption_basis`), claims whose voucher has been reversed, and
  taxable benefits carrying no recorded tax. Their amounts stay in the totals —
  the books are the record — but they need a human first. **v1 has no
  correction path for a posted allowance** (unlike an expense or a sales
  invoice), so resolving one needs an accountant-entered adjusting voucher.
- `roundingAdjustment` per month is the difference between the tax posted per
  claim and the tax the declaration computes on the month's total. Rounding once
  is not rounding twice, so the two can land a cent apart; both figures are
  given rather than one being quietly preferred.

### Read the books
```bash
curl -H "$H" $B/api/accounts            ;  curl -H "$H" $B/api/accounts/<code>
curl -H "$H" $B/admin/accounts          # accounts WITH balances (raw trial balance)
curl -H "$H" $B/admin/vouchers          ;  curl -H "$H" $B/admin/vouchers/<id>    # hash chain (previous_hash) visible
curl -H "$H" "$B/admin/approvals" "$B/admin/findings/open" "$B/admin/periods"
```

### What is NOT there (honest): income tax and annual report
- **Taxes:** **VAT** is computed (via the plugin's VAT codes and the VAT report), and the employer's **fringe-benefit tax** on a taxable health/sports benefit is computed and posted, with its TSD annex 4 / INF 14 figures exposed (see "Allowances" above). There is still no payroll, no income tax on wages and no corporate income tax. Cross-border reverse charge IS resolved and declared (see "Cross-border purchases" above), but only for the general-rule cases named there: goods acquisitions beyond the intra-Community one, customs procedures and the special schemes are not auto-classified, and are refused rather than guessed. Foreign VAT is never silently reclaimed; disputed cases → hold.
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
