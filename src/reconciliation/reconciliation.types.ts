/**
 * Types for the reconciliation matching engine.
 *
 * Matching is N:M: one bank transaction can match multiple vouchers,
 * and one voucher can be matched by multiple transactions.
 * Match state (unmatched/partial/full) is DERIVED from
 * SUM(reconciliation_match.amount_matched) vs |bank_transaction.amount|.
 */

/** The type of a reconciliation match. */
export type MatchType = 'exact' | 'partial' | 'prepayment';

/** The signal that produced a match proposal — ordered by strength. */
export type MatchSignal = 'invoice_number' | 'counterparty' | 'amount_date';

/** Confidence level derived from signal strength. */
export type MatchConfidence = 'high' | 'medium' | 'low';

/**
 * A proposed match returned by proposeMatches().
 * Not yet persisted — must be explicitly executed via executeMatch().
 */
export interface MatchProposal {
  /** The bank transaction being matched. */
  bankTransactionId: number;
  /** The voucher this transaction is proposed to match. */
  voucherId: number;
  /** The type of match. */
  matchType: MatchType;
  /** Positive cents — the portion of the transaction amount this match covers. */
  amountMatched: number;
  /** Confidence based on signal strength. */
  confidence: MatchConfidence;
  /** Which signal produced this proposal. */
  signal: MatchSignal;
}

/**
 * A persisted reconciliation match record.
 */
export interface ReconciliationMatchRecord {
  id: number;
  bankTransactionId: number;
  voucherId: number;
  matchType: MatchType;
  amountMatched: number;
  createdAt: number;
}

/** Input for executing matches. */
export interface ExecuteMatchInput {
  matches: MatchProposal[];
}

/**
 * Parsed tokens extracted deterministically from a bank transaction's
 * description/reference fields.
 */
export interface ParsedTransactionTokens {
  /** Invoice numbers found in reference or description. */
  invoiceNumbers: string[];
  /** IBAN found in counterparty_iban or extracted from description. */
  counterpartyIban: string | null;
  /** Merchant descriptor from card transactions. */
  merchantDescriptor: string | null;
}

/**
 * Candidate voucher for matching, with its remaining unmatched balance.
 */
export interface CandidateVoucher {
  voucherId: number;
  /** The AR/AP/prepayment account code this voucher lines against. */
  accountCode: string;
  /** The base_amount of the AR/AP line (positive cents). */
  lineBaseAmount: number;
  /** Already matched amount from existing reconciliation_match records. */
  alreadyMatched: number;
  /** Remaining unmatched balance (lineBaseAmount - alreadyMatched). */
  remainingBalance: number;
  /** The entity ID linked to this voucher (customer_id or supplier_id). */
  entityId: number | null;
  /** The voucher's tax_point_date. */
  taxPointDate: string;
  /** Whether this is a prepayment voucher (CUSTOMER_PREPAYMENTS / SUPPLIER_PREPAYMENTS). */
  isPrepayment: boolean;
}
