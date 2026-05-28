# Business objects are the source of fact; Vouchers are their generated, immutable projection

Business objects (Expense, SalesInvoice, RecurringInvoice, Asset, …) are the source of truth for *what happened in the world* — supplier, category, attached document, status. A Voucher is the accounting projection of that fact: balanced, immutable double-entry lines generated from the business object.

The link is one-directional (object → Voucher) with a status machine on the object:

- `draft` — no Voucher yet; the object is freely editable (this is the "bypass AI/OCR" path: a human corrects the draft before posting).
- `posted` — posting generates the Voucher; the object points to it.
- `reversed` — editing a posted object reverses the old Voucher and generates a new one; the object re-points to the new Voucher. Voucher history is never mutated.

Chosen over a Voucher-only model (loses the business layer needed for triage, supplier memory, and UX) and over bidirectional object↔Voucher sync (a desync hazard). One source of truth for the fact (the business object), one for the accounting (the Voucher), with a single direction between them.
