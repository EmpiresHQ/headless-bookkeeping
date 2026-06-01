# Intake triage: dedup, correction-supersession, and new — three outcomes

All channels (Telegram, email, Drive, API) map to a unified intake envelope (`channel, sender, message, attachments, metadata`); attachments are hashed on arrival. The **Document** is the deduplication anchor. Triage routes every intake into one of three outcomes — not a binary "duplicate or not":

1. **Same document** — byte-identical attachment (hash match) arriving via multiple channels. Auto-collapse into one Document with multiple `sources`. A correction invoice has different bytes, so it is never caught here.
2. **Correction / supersession of an already-handled document** — detected by document type (credit note), an explicit reference to the original, or a `(supplier, invoice_number)` collision with differing content. Not a new expense and not a discardable duplicate: it is linked to the original and routed into the correction flow. Always approval-required.
3. **New document** — a fresh business object.

Triage produces a **draft** from the incoming document: extracted category guess, supplier hints, amounts, a candidate **Document VAT marking**, and a confidence. The draft is a proposal — Rules/Policy still gate it (ADR-0012).

**Intake is the purchase side.** An incoming document is a *fresh business object* = an **Expense** (a purchase/receipt) or a **correction**/duplicate of one — never our own **SalesInvoice**. We **issue** sales invoices outbound (a separate command/agent flow → pipeline → send → later reconcile the payment); we do not OCR an incoming document into our own sale. The single exception is **self-billing** (EU VAT Directive Art. 224 — the customer issues the invoice on the supplier's behalf, e.g. a platform paying a creator): a *marked* incoming document that legitimately represents *our* revenue. Self-billing is **deferred to v2 as its own domain plugin** (ADR-0022; see `docs/V2-ROADMAP.md`) — its own self-billing-agreement registry + inbound-revenue handling, posting summarized vouchers through the pipeline — not a kernel intake path. So the v1 triage outcome set is `new_expense | correction | duplicate | unknown` — not `sales_invoice`.

The correction flow branches on what actually changed:

- **Cosmetic only** (address/typo; amounts, VAT, tax-point unchanged) → replace the Document attachment; the Voucher is untouched. No reversal noise for a typo.
- **Financial change, original still draft** → edit the draft (nothing posted yet).
- **Financial change, original posted, period open** → reversal + corrected Voucher (per ADR-0006).
- **Financial change, original posted, period locked** → reversal + correction in the current open period with `reverses` / `corrects_object` references (per ADR-0009).
- **Supplier-issued credit note** → booked as its **own** Voucher with its own VAT effect, referencing the original — never a silent internal reversal. Whether a reversal suffices or a formal credit note is required is a country VAT rule (plugin).

`(supplier, invoice_number)` thus acts as a router into the correction flow (and a posting guard against true duplicates), not as a "discard duplicate" signal.

**Supplier identity is resolved at triage, not gated at posting.** The dedup/correction keys above already presuppose a Supplier — so triage must establish one. The flow is: OCR → supplier check (lookup by registration key / alias) → **found ⇒ reuse**, **not found ⇒ propose creating a new Supplier** (a human-confirmed Action point carrying the OCR-extracted candidate facts, incl. `country`) → only then is the draft business object created, already carrying its `supplier_id`. Resolving identity here (rather than as a posting-time gate) avoids a chicken-and-egg trap: we propose creating the Supplier instead of killing the voucher, and it is the natural one-time point to capture `supplier.country` (the cross-border carrier, ADR-0002/ADR-0014). Consequence: the Policy rule `unknown_supplier_requires_approval` is a **backstop that should never fire in the happy path** — if it does, intake was bypassed and the voucher correctly holds for Approval.
