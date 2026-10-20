import type {
  CounterpartyTaxStatus,
  ServicePlaceRule,
} from '../../plugins/country-plugin.interface';
import type { BankSettlementLink } from '../../bank/settlement-fx';

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
  /**
   * Counterparty (supplier) ISO country code, when known. Drives the plugin's
   * cross-border treatment for purchases (e.g. an imported service → reverse
   * charge). Absent ⇒ the projection assumes a domestic counterparty and books
   * the standard legs (behavior-preserving for objects with no supplier).
   */
  supplierCountry?: string;
  /**
   * Whether the counterparty supplies goods or services — the other input the
   * plugin needs to resolve cross-border treatment. Absent ⇒ 'unknown'.
   */
  goodsVsServices?: 'goods' | 'services' | 'unknown';
  /**
   * Whether the counterparty is a taxable person acting as such (issue #209).
   * Decides the place of supply of a cross-border general-rule service, which
   * its country cannot. Absent ⇒ 'unknown', which the plugin REFUSES to guess
   * at rather than defaulting to consumer.
   */
  taxStatus?: CounterpartyTaxStatus;
  /**
   * What THIS object supplies, when recorded on the object itself. Absent ⇒
   * the plugin falls back to the counterparty's `goodsVsServices`.
   */
  supplyType?: 'goods' | 'services';
  /**
   * The place-of-supply rule declared for a service supply. Absent ⇒ the
   * residual general rule.
   */
  servicePlaceRule?: ServicePlaceRule;
  /**
   * The ISO country where the declared rule's location physically is (the
   * supply's performance country / the property's country) — recorded
   * separately from the RULE because the rule names the criterion, not the
   * place (issue #403): a Danish supplier may cater in Estonia. Absent ⇒
   * unknown; a plugin that needs it holds with the fact named.
   */
  placeOfSupplyCountry?: string;
  /**
   * When set, the credit leg posts to CLAIMANT_PAYABLE instead of AP.
   * Null (or absent) → AP (normal supplier expense).
   */
  claimantId?: number | null;
  /**
   * Whether the receipt is addressed to the Organisation.
   * false | null → no VAT_RECEIVABLE line (conservative — no reclaim when uncertain).
   * Only meaningful for claimant-paid expenses; absent → treated as true.
   */
  companyAddressedReceipt?: boolean | null;
  /**
   * A deterministically linked bank settlement line for this PAID purchase
   * (issue #403): the bank transaction that settled the purchase's own
   * original-currency amount, RAW as the bank recorded it. The projection —
   * which owns conversion and knows the effective base currency — derives and
   * validates the evidence, and uses it ONLY as a narrow fallback: when the
   * statutory reference rate genuinely cannot be had AND the purchase carries
   * no VAT treatment that needs it (see project()'s fallback note and the
   * ADR-0004 amendment). Absent/undefined → nothing changes.
   */
  settlementFx?: BankSettlementLink;
  /**
   * WHY no link could be resolved for a purchase that needs one (issue #403):
   * ambiguous candidates, a line claimed by another expense, a claimant-paid
   * contradiction, no same-day line. Surfaced by the fallback as the reason
   * the statutory hold stands — an explicit, actionable outcome, never a
   * guess. Absent/undefined → nothing changes.
   */
  settlementFxUnresolved?: string;
}

/**
 * Which side of the ledger a business object posts on. A `purchase` (Expense)
 * debits the category and books a payable; a `sale` (SalesInvoice) credits the
 * category and books a receivable. This single value captures the *only*
 * structural difference between the two projections.
 */
export type Direction = 'purchase' | 'sale';
