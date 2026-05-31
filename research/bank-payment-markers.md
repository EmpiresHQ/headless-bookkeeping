# Research: How Invoices Payments Are Marked in Bank Transactions

## Objective
Determine common ways that payments for invoices are marked in bank transaction data, focusing on fields such as `description`, `reference`, `counterparty_descriptor`, and other relevant fields in the `CreateTransactionInput` interface.

## Background
In accounting systems, matching bank transactions to invoices requires identifying reliable markers within transaction data. This research investigates patterns used by banks and counterparties to signal that a transaction corresponds to an invoice payment.

## Key Fields in Transaction Data

- **`description`**: Free-text field provided by the bank; often contains counterparty name, transaction type, and sometimes reference information.
- **`reference`**: Parsed invoice number or match key; expected to hold structured data like invoice identifiers.
- **`counterparty_descriptor`**: Card merchant descriptor; typically used for card transactions.
- **`counterparty_iban`**: Counterparty's IBAN; useful for identifying the payee.
- **`amount`, `currency`, `transaction_date`**: Used for matching with invoice totals and due dates.

## Common Patterns for Invoice Payments

### 1. Structured Reference (Structured Creditor Reference)
Many European countries use the **Structured Creditor Reference (ISO 11649)**, also known as **RF Creditor Reference**. This is a standardized format:

- Format: `RFxx-yyyy-zzzz...` (up to 25 alphanumeric characters)
- Example: `RF18 0000 1234 5678 9012` (for invoice INV-00123)
- Used in SEPA credit transfers
- Often appears in the `reference` field

> This is the most reliable indicator of an invoice payment.

### 2. Unstructured Reference / Remittance Information
In absence of structured references, banks include unstructured remittance info:

- May contain phrases like:
  - `Invoice payment for INV-123`
  - `Payment of invoice #456`
  - `Rechnungszahlung Nr. 789`
- Can appear in `description` or `reference`
- Language varies by country

> Less reliable due to formatting variability.

### 3. Counterparty Naming Conventions
Some organizations include invoice-related keywords in their banking profile:

- "Acme Corp PAYMENT"
- "Contoso Ltd INVOICE"
- "Widget Co - INV PAY"

> Appears in `description` or `counterparty_descriptor`

### 4. Bank Transaction Codes / Descriptors
Banks may classify transaction types:

- Transaction types like:
  - `SEPA Credit Transfer`
  - `Direct Debit`
  - `Invoice Payment`
- May be reflected in `description`

> Not universally standardized.

### 5. Matching via Amount and Date
When no explicit reference exists, systems infer invoice payments by:

- Matching transaction amount to open invoice totals
- Aligning transaction date with invoice due date or payment terms

> Heuristic-based and error-prone.

## Best Practices for Detection

1. **Prioritize `reference` field** for structured creditor reference (RFxx)
2. **Fuzzy match `description` and `reference`** against known invoice IDs
3. **Use counterparty IBAN + amount + date** as secondary match key
4. **Leverage external payment initiation data** (if available) to know what payments were expected

## Conclusion
The most reliable way to identify invoice payments in bank transactions is through the **Structured Creditor Reference (RFxx)** in the `reference` field. In its absence, systems must rely on parsing free-text fields (`description`, `reference`) for invoice identifiers and use heuristic matching based on amount and date.

For the current system, enhancing the transaction matching logic to detect `RF`-prefix references and support fuzzy invoice ID matching would improve automation accuracy.
