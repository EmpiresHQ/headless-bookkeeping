# Prepayments / on-account balances; payment can be a VAT tax point

A payment can arrive before any invoice exists (retainers, deposits, "50% upfront" — common for freelancers/agencies). The reconciliation model previously assumed a payment always settles an existing AR/AP; prepayments break that assumption.

Decisions:

- **A prepayment is a liability, not a Receivable.** Money received before delivery means we owe delivery (or a refund), so it lands in a "Customer prepayments / payments on account" liability balance — never as AR. Symmetric on the buy side: paying a supplier in advance is a prepaid-expense / supplier on-account asset.
- **An unmatched incoming payment is an on-account balance, not an error.** It lands as a prepayment for that counterparty and is drawn down by one or more later invoices through the same N:M matching, with a two-sided outstanding (invoice: amount unpaid; prepayment: credit not yet consumed).
- **The kernel must not assume VAT arises only at invoice.** Under EU VAT Directive Art. 65, receiving an advance is itself a VAT tax point — output VAT can be due on receipt, before any invoice. The VAT engine takes the tax point from the country plugin; the advance-VAT computation and how it nets against later invoices (so VAT isn't double-counted) is a country-plugin rule.

Structure (liability + draw-down via matching) is built in v1; advance-VAT is implemented in the DK plugin first.
