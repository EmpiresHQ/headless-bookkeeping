# Intake triage: dedup, correction-supersession, and new — three outcomes

All channels (Telegram, email, Drive, API) map to a unified intake envelope (`channel, sender, message, attachments, metadata`); attachments are hashed on arrival. The **Document** is the deduplication anchor. Triage routes every intake into one of three outcomes — not a binary "duplicate or not":

1. **Same document** — byte-identical attachment (hash match) arriving via multiple channels. Auto-collapse into one Document with multiple `sources`. A correction invoice has different bytes, so it is never caught here.
2. **Correction / supersession of an already-handled document** — detected by document type (credit note), an explicit reference to the original, or a `(supplier, invoice_number)` collision with differing content. Not a new expense and not a discardable duplicate: it is linked to the original and routed into the correction flow. Always approval-required.
3. **New document** — a fresh business object.

The correction flow branches on what actually changed:

- **Cosmetic only** (address/typo; amounts, VAT, tax-point unchanged) → replace the Document attachment; the Voucher is untouched. No reversal noise for a typo.
- **Financial change, original still draft** → edit the draft (nothing posted yet).
- **Financial change, original posted, period open** → reversal + corrected Voucher (per ADR-0006).
- **Financial change, original posted, period locked** → reversal + correction in the current open period with `reverses` / `corrects_object` references (per ADR-0009).
- **Supplier-issued credit note** → booked as its **own** Voucher with its own VAT effect, referencing the original — never a silent internal reversal. Whether a reversal suffices or a formal credit note is required is a country VAT rule (plugin).

`(supplier, invoice_number)` thus acts as a router into the correction flow (and a posting guard against true duplicates), not as a "discard duplicate" signal.
