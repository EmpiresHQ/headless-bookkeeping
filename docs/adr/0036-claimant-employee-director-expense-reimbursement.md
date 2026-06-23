# Claimant: employee and director expense reimbursement

An employee or board member who pays a business expense from their own funds and submits a claim for reimbursement is a **Claimant** — a new `Entity` role (`employee | director`) identified by email + channel identity (e.g. Telegram user id), not a business registration key. The pattern is the same across jurisdictions (Estonian *aruandekohustuslane*, Russian «подотчётное лицо»): the person is a creditor of the Organisation, not a supplier.

## Posting shape

The **Supplier** on an Expense is always the original vendor (restaurant, airline, software vendor). This never changes — it is the input to `Category → Account` mapping and **VAT code** resolution via the country plugin. What changes when a Claimant paid is the **credit leg** of the Voucher:

- Normal expense (company card / AP): `Dr EXPENSE_* [+ Dr VAT_RECEIVABLE] = Cr AP`
- Claimant-paid expense: `Dr EXPENSE_* [+ Dr VAT_RECEIVABLE] = Cr CLAIMANT_PAYABLE`

`claimant_id` on the Expense is the switch: `null` → `AP`; set → `CLAIMANT_PAYABLE`. A new kernel account `CLAIMANT_PAYABLE` (short-term liability) is added to the canonical chart (ADR-0002). Settlement (`Dr CLAIMANT_PAYABLE / Cr Bank`) is deferred to v2 — the liability accrues in the balance sheet until a reimbursement flow is built.

## VAT reclaim eligibility

Whether a claimant-paid receipt carries reclaimable input VAT depends on whether it is addressed to the Organisation. `company_addressed_receipt: boolean | null` is captured on the Expense by Pass 2 from the document. The country plugin receives this as a fact alongside `SupplierFacts` and `OrgContext` and uses it to resolve the VAT code: `true` → normal input VAT resolution; `false` or `null` → `NULL_VAT_CODE` (conservative — no reclaim when uncertain). `vat_amount` on the Expense always reflects what is printed on the document and is never mutated; the VAT code resolution determines whether it posts to `VAT_RECEIVABLE`.

## Claimant identity and intake routing

`claimant_id` is resolved **deterministically** by the router from the channel sender — a database lookup on `(tg_user_id | email) → Entity(role: employee | director)` — never by the LLM. The LLM receives the Claimant's name and role as system context in Pass 2 (improves category classification for travel, meals, etc.) but plays no role in the identity resolution. A sender whose channel identity matches no Claimant routes to `needs_triage`; `claimant_id = null` is only valid when the document arrives through the operator SPA rather than from a known person.

`claimant_id` is persisted on the `document` row at upload time (nullable column, migration). The router knows the sender at the moment of upload and writes it then. The `IntakeQueueWorker` processes documents asynchronously — by the time it picks one up, the channel context is gone — so it reads `claimant_id` from the document row and passes it as an explicit parameter to `IntakeWorkflowService.process(documentId, claimantId?)`. `ProposeDraftService` carries it through to the `Expense`. Storing it on `document_source` (per channel occurrence) was rejected: `source_identifier` is raw channel data with no cross-channel uniqueness guarantee, and the worker would need an extra resolution step on every dequeue.

A new `entity_identifier.kind` value `tg_user_id` is added so the router can look up a Claimant by their immutable Telegram numeric user id (not username, which can change). Email remains the second lookup key for email-channel submissions.

When the operator uploads via the SPA, `claimant_id` is an optional body parameter on `POST /api/documents` (the SPA renders a dropdown of `Entity(role: employee | director)`, defaulting to null). When null, the document flows as a normal supplier expense with `Cr AP`.

**All claimant-submitted documents always route to `needs_triage`**, regardless of Pass 2 confidence. This is because it is impossible to reliably determine from the document alone whether the Claimant actually paid it or merely forwarded a company invoice — a kassa receipt and a forwarded supplier invoice can look identical to OCR. During triage, the **approver** (not the Claimant, who is `known_counterparty` and cannot commit) is asked via an **Action point**: "John sent this receipt — did he pay out of pocket?" The approver's button tap calls `POST /api/documents/:id/confirm-payment { paid_by_claimant: boolean }` — a dedicated endpoint with single-purpose semantics ("did this person pay?"), not a reuse of `manual-classify`. Pass 2 artefacts are already stored; the system builds the Expense from them without re-running OCR. Only if `true` does the Expense carry `claimant_id` (`Cr CLAIMANT_PAYABLE`); if `false`, `claimant_id` is cleared and the Expense posts to `Cr AP` as a normal supplier expense. The Claimant Principal model is not extended — the approver owns all commits.

## Policy

All claimant-sourced Expenses are held for **Approval** by default (`hold_claimant_expenses: true` in `policy_config`). This is a configurable **Policy** gate (ADR-0005), not a kernel invariant — the operator may opt out explicitly — but the default is conservative: a human reviews every reimbursement claim before it posts. Amount ceilings and confidence thresholds still apply on top.

## What was rejected

**Claimant as Supplier.** Modelling the employee as the Supplier on the Expense was rejected: it would misidentify the original vendor, break Category/VAT resolution (the country plugin would see "employee" as the supplier facts), and conflate an internal person with an external counterparty.

**Separate `ExpenseClaim` object.** A dedicated business object for claimant expenses was rejected as premature — the posting shape, pipeline, Approval lifecycle, and correction mechanics are identical to a regular Expense. `claimant_id` + `company_addressed_receipt` on the existing Expense is sufficient; a richer object can be introduced when settlement complexity justifies it.

**LLM-resolved claimant identity.** Delegating `claimant_id` resolution to Pass 2 was rejected: the channel sender is a deterministic, verifiable signal (ADR-0016); the LLM is fallible and prompt-injectable. Deterministic router lookup is cheaper, safer, and consistent with how Principal resolution already works.

**Advance case (`CLAIMANT_ADVANCE`).** Pre-funding a Claimant before they spend (the advance direction) is deferred to v2 together with settlement. Modelling it now without a reimbursement flow would be an incomplete feature.
