/**
 * Settlement FX evidence (issue #403).
 *
 * A card settlement in the base-currency account can carry its own conversion
 * evidence: the original foreign amount, the bank's rate, and a separately
 * charged fee. This file owns the DETERMINISTIC arithmetic that turns such a
 * line into a usable valuation — rate derivation, fee separation, and the
 * consistency checks that refuse a line whose numbers do not add up.
 *
 * It is deliberately pure: no IO, no DB, no plugin. The LINK (which bank line
 * belongs to which purchase) is resolved by the adapter that owns the
 * purchase row; the DERIVATION (below) runs where the conversion is decided,
 * which knows the effective base currency. The rules, from the issue's
 * acceptance:
 *
 *   - Prefer the bank's EXPLICIT rate; the rounded rate × source amount must
 *     agree with the fee-separated principal EXACTLY. The bank's charged
 *     principal IS its own rounding of its own rate, so a one-cent drift
 *     between them is CONFLICTING data, refused BEFORE anything posts —
 *     accepting it would book a purchase whose settlement leaves the fee
 *     strandable (an accepted rounding difference must not survive to become
 *     an unreconcilable remainder; issue #403's full-debit acceptance).
 *   - Derive the rate from (|debit| − explicit fee) / source amount ONLY when
 *     the rate is absent and the fee is explicitly evidenced.
 *   - Only an EXPLICITLY evidenced fee (or an explicit zero) is a fee. A
 *     debit-minus-principal residual nobody evidenced is CONFLICTING data,
 *     never a guessed fee.
 *   - Missing/zero amounts, refunds (credits), foreign-account settlements
 *     and inconsistent values are explicit outcomes, never silent estimates.
 */

/**
 * A deterministically linked bank settlement line, RAW as the bank recorded
 * it — no derived fields, no judgment. Assembled by the adapter that owns the
 * purchase (which supplier/dates/amounts the purchase carries); valued by
 * {@link deriveSettlementFx} where the base currency is known.
 */
export interface BankSettlementLink {
  bankTransactionId: number;
  /** The statement the line came from (raw source provenance, ADR-0031). */
  statementId: number;
  /**
   * The SUPPLIER whose recorded identity the line's counterparty matched —
   * part of the link's identity facts, re-validated atomically at claim
   * time (issue #403): a draft edited onto a different supplier between the
   * generation and the claim must not reserve this line.
   */
  supplierId: number;
  /** The settlement (value) date — the transaction-date rate's own date (RTJ1 §93). */
  transactionDate: string;
  /** The bank's booking date when the statement distinguishes it; null = not. */
  bookingDate: string | null;
  /** The original (foreign) currency the payment was charged in. */
  sourceCurrency: string;
  /** The original amount, in source-currency minor units. */
  sourceAmount: number;
  /** The settled account currency (the debit's currency). */
  settledCurrency: string;
  /** The signed settled amount, in settled-currency minor units. */
  settledAmount: number;
  /** The bank's explicit conversion rate (base per source unit), if printed. */
  fxRate: number | null;
  /**
   * Decimal places in the bank's PRINTED rate, when the source presented it
   * as text; NULL = precision unknown (numeric-only/legacy input — never
   * fabricated) or the rate is derived (issue #403).
   */
  fxRateDecimals: number | null;
  /**
   * The bank's separately charged conversion fee, in settled-currency minor
   * units. NULL means the statement did not evidence a fee — it is NOT a
   * default zero (issue #403); 0 asserts the bank charged nothing.
   */
  conversionFee: number | null;
  /**
   * The reference-rate OBSERVATION the bank itself prints on the line, as
   * printed — carried for the AUDIT only. EXPLICITLY UNVERIFIED: the bank's
   * own report, never fed into the verified ECB cache, never used for a
   * statutory lookup or any valuation (issue #403, ADR-0004).
   */
  bankReferenceRate: number | null;
}

/** How the fee used in the evidence was established. */
export type SettlementFxFeeOrigin =
  /** The statement explicitly charges this fee (including an explicit zero). */
  | 'explicit'
  /** No fee enters the check — the debit is all principal. */
  | 'not_stated';

/** How the rate used in the evidence was established. */
export type SettlementFxRateOrigin =
  /** The bank printed its own conversion rate. */
  | 'bank_statement'
  /** Derived: fee-separated principal ÷ source amount. */
  | 'derived_principal';

/** A fully derived, consistent piece of settlement evidence. */
export interface SettlementFxEvidence {
  /** The bank transaction the evidence came from. */
  bankTransactionId: number;
  /**
   * The calculation precision of `rate`: the bank's PRINTED decimal places
   * when the rate was printed, or NULL when the rate was DERIVED (full
   * division precision) or the printed precision is unknown (issue #403).
   */
  rateDecimals: number | null;
  /** The bank's booking date when the statement distinguishes it; null = not. */
  bookingDate: string | null;
  /** Its statement (row provenance; the raw source stays there). */
  statementId: number;
  /** The transaction (settlement) date — the rate's own date. */
  transactionDate: string;
  /** The original (foreign) currency the payment was charged in. */
  sourceCurrency: string;
  /** The original amount, in source-currency minor units. */
  sourceAmount: number;
  /** The settled account currency (must equal the base currency to be usable). */
  baseCurrency: string;
  /** The full |debit| on the account, in base minor units. */
  debitAmount: number;
  /** The purchase principal (fee-separated), in base minor units. */
  principalAmount: number;
  /** The conversion fee, in base minor units (>= 0). */
  feeAmount: number;
  feeOrigin: SettlementFxFeeOrigin;
  /** Conversion rate: base-currency units per 1 source-currency unit. */
  rate: number;
  rateOrigin: SettlementFxRateOrigin;
}

/** Every non-evidence outcome is explicit and actionable, never silent. */
export type SettlementFxOutcome =
  | { outcome: 'evidence'; evidence: SettlementFxEvidence }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'conflicting'; reason: string };

/**
 * Derive settlement-FX evidence from a linked bank settlement line, or refuse
 * it with an explicit outcome. `baseCurrency` is the organisation's effective
 * base currency: a settlement valued in anything else is not a base valuation
 * and is refused rather than converted (a second rate would have to be
 * invented — exactly what this module exists to avoid).
 */
export function deriveSettlementFx(
  link: BankSettlementLink,
  baseCurrency: string,
): SettlementFxOutcome {
  // A refund or credit is not a purchase settlement; positive amounts flow the
  // other way and their "principal" would mean something else entirely.
  if (link.settledAmount >= 0) {
    return {
      outcome: 'unavailable',
      reason: `not a debit settlement (amount ${link.settledAmount})`,
    };
  }
  if (link.sourceCurrency === baseCurrency) {
    return {
      outcome: 'unavailable',
      reason: 'no foreign-currency conversion evidence on the line',
    };
  }
  if (link.settledCurrency !== baseCurrency) {
    return {
      outcome: 'unavailable',
      reason:
        `the account settled in ${link.settledCurrency}, not the base ` +
        `currency ${baseCurrency}; no base valuation is evidenced`,
    };
  }
  if (link.sourceAmount <= 0) {
    return {
      outcome: 'unavailable',
      reason: 'no positive original-currency amount on the line',
    };
  }

  const debit = Math.abs(link.settledAmount);

  // A fee is a fee ONLY because the statement says so. `null` (not evidenced)
  // and `0` (explicitly free) are different assertions and are kept apart:
  // `fee !== null` is therefore the "explicitly evidenced" test everywhere
  // below, and it narrows the value at the same time. A stated fee is taken
  // AS stated — a negative or non-integer one is refused, not repaired by an
  // abs() that would hide the statement's own data error.
  const fee: number | null = link.conversionFee;
  if (fee !== null && (!Number.isSafeInteger(fee) || fee < 0)) {
    return {
      outcome: 'unavailable',
      reason: `not a usable conversion fee: ${link.conversionFee}`,
    };
  }

  if (link.fxRate !== null) {
    // Prefer the explicit rate — but it must explain the charged figures.
    const rate = link.fxRate;
    if (!Number.isFinite(rate) || rate <= 0) {
      return {
        outcome: 'unavailable',
        reason: `not a usable conversion rate: ${link.fxRate}`,
      };
    }
    const principal = Math.round(rate * link.sourceAmount);
    const residual = debit - principal;
    if (fee !== null) {
      // fee (possibly 0) must absorb the residual EXACTLY: the bank's charged
      // principal is its own rounding of its own rate, so any drift — even
      // one minor unit — is conflicting data, refused before anything posts.
      if (residual !== fee) {
        return {
          outcome: 'conflicting',
          reason:
            `rate × source amount = ${principal} but the debit is ${debit} ` +
            `with a stated fee of ${fee}: the charged principal ` +
            `(${debit - fee}) does not equal the quoted rate's own rounded ` +
            `product (${principal})`,
        };
      }
      return {
        outcome: 'evidence',
        evidence: {
          bankTransactionId: link.bankTransactionId,
          statementId: link.statementId,
          bookingDate: link.bookingDate,
          transactionDate: link.transactionDate,
          sourceCurrency: link.sourceCurrency,
          sourceAmount: link.sourceAmount,
          baseCurrency,
          debitAmount: debit,
          principalAmount: principal,
          feeAmount: fee,
          feeOrigin: 'explicit',
          rate,
          rateDecimals: link.fxRateDecimals,
          rateOrigin: 'bank_statement',
        },
      };
    }
    // No fee was evidenced. An exactly-absorbed debit is fee-free settlement;
    // anything else is an unexplained residual — CONFLICTING, not a guess.
    if (residual !== 0) {
      return {
        outcome: 'conflicting',
        reason:
          `rate × source amount = ${principal} but the debit is ${debit}; ` +
          `the ${residual} minor-unit residual is not an evidenced fee and is ` +
          `not guessed`,
      };
    }
    return {
      outcome: 'evidence',
      evidence: {
        bankTransactionId: link.bankTransactionId,
        statementId: link.statementId,
        bookingDate: link.bookingDate,
        transactionDate: link.transactionDate,
        sourceCurrency: link.sourceCurrency,
        sourceAmount: link.sourceAmount,
        baseCurrency,
        debitAmount: debit,
        principalAmount: principal,
        feeAmount: 0,
        feeOrigin: 'not_stated',
        rate,
        rateDecimals: link.fxRateDecimals,
        rateOrigin: 'bank_statement',
      },
    };
  }

  // No explicit rate: the fee-separated principal can still derive one — but
  // ONLY with an explicitly evidenced fee (an unseparated debit would guess).
  if (fee === null) {
    return {
      outcome: 'unavailable',
      reason:
        'no explicit conversion rate and no evidenced fee to separate the ' +
        'principal; the rate cannot be derived without a guess',
    };
  }
  const principal = debit - fee;
  if (principal <= 0) {
    return {
      outcome: 'conflicting',
      reason: `the stated fee ${fee} absorbs the whole debit ${debit}`,
    };
  }
  const rate = principal / link.sourceAmount;
  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      outcome: 'unavailable',
      reason: 'derived rate is not usable',
    };
  }
  return {
    outcome: 'evidence',
    evidence: {
      bankTransactionId: link.bankTransactionId,
      statementId: link.statementId,
      bookingDate: link.bookingDate,
      transactionDate: link.transactionDate,
      sourceCurrency: link.sourceCurrency,
      sourceAmount: link.sourceAmount,
      baseCurrency,
      debitAmount: debit,
      principalAmount: principal,
      feeAmount: fee,
      feeOrigin: 'explicit',
      rate,
      // A derived rate carries no printed precision — full division
      // precision, recorded as such (never a fabricated decimal count).
      rateDecimals: null,
      rateOrigin: 'derived_principal',
    },
  };
}
