# Accrual basis with AR/AP; bad debt written off, not left as eternal receivable

The ledger is accrual-basis: revenue/expense and VAT are recognized when the economic event occurs, not when cash moves. Issuing a SalesInvoice immediately posts `Dr AR / Cr Revenue / Cr output VAT`; receiving a bill posts to AP. Payment is a separate settlement Voucher that clears the AR/AP balance.

This was effectively already chosen when we accepted the reconciliation model: settlement vouchers, outstanding balances, and partial-payment matching only exist because accrual opens a gap between "earned/incurred" and "paid", and AR/AP live in that gap. Cash basis has no AR/AP and nothing to reconcile. Accrual also matches EU/Danish VAT, where the tax point is generally the invoice date, not payment.

An uncollectible receivable is **written off as bad debt** (`Dr bad-debt expense / Cr AR`) — never left as an eternal receivable, which would overstate assets. The write-off is a loss recognition, hence approval-required. Reclaiming output VAT already paid on a bad debt is permitted under EU VAT Directive Art. 90 but under country-specific conditions, so it is a country-plugin rule.

A cash-basis *report* may be added later as a view over the accrual ledger; the ledger basis itself stays accrual.
