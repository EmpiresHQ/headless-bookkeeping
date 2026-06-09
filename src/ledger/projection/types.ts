/**
 * The economic facts of a business object, expressed in the language a Voucher
 * projection needs — independent of whether the object is an Expense or a
 * SalesInvoice. An adapter (ExpensesService, SalesInvoicesService, …) supplies
 * these from its own row; the projection turns them into a balanced draft
 * Voucher.
 *
 * Amounts are integer cents in `currency` (the document currency); the
 * projection resolves the base-currency amounts via {@link CurrencyService}.
 */
export interface EconomicFacts {
  /** User-facing Category the object was tagged with (drives plugin mapping). */
  category: string;
  /** Gross amount (net + VAT) in document-currency cents. */
  grossAmount: number;
  /** VAT amount in document-currency cents (may be 0). */
  vatAmount: number;
  /** Document currency code (e.g. "EUR", "USD"). */
  currency: string;
  /** Tax-point date (YYYY-MM-DD) — drives the FX rate as-of and period membership. */
  taxPointDate: string;
}

/**
 * Which side of the ledger a business object posts on. A `purchase` (Expense)
 * debits the category and books a payable; a `sale` (SalesInvoice) credits the
 * category and books a receivable. This single value captures the *only*
 * structural difference between the two projections.
 */
export type Direction = 'purchase' | 'sale';
