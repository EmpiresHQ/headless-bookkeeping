/**
 * Bank statement and transaction types for the bank module.
 */

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Valid statuses for a bank transaction line. */
export type BankTransactionStatus =
  | 'open'
  | 'prepayment'
  | 'personal'
  | 'bank_fee'
  | 'dividend';

const bankTransactionStatusSchema = z.enum([
  'open',
  'prepayment',
  'personal',
  'bank_fee',
  'dividend',
]);

/** Input for a single transaction line within a statement. */
export const createTransactionSchema = z.object({
  /** ISO date string of the transaction. */
  transaction_date: z.string(),
  /** Free-text description from the bank. */
  description: z.string().nullable().optional(),
  /** Signed cents: positive = incoming/credit, negative = outgoing/debit. */
  amount: z.number().int(),
  /** Currency of the amount (matches the account's currency). */
  currency: z.string(),
  /** Original currency when the bank performed a conversion. */
  source_currency: z.string().nullable().optional(),
  /** Cents in source_currency. */
  source_amount: z.number().int().nullable().optional(),
  /** The bank's actual conversion rate. */
  fx_rate: z.number().nullable().optional(),
  /**
   * Decimal places in the PRINTED rate, when the source presented it as
   * text; NULL = precision unknown (numeric-only input) (issue #403).
   */
  fx_rate_decimals: z.number().int().min(0).nullable().optional(),
  /**
   * The bank's separately charged conversion fee, in `currency` minor
   * units. NULL means the statement did not evidence a fee — it is NOT a
   * default zero (issue #403); 0 asserts the bank charged nothing.
   */
  conversion_fee: z.number().int().nullable().optional(),
  /**
   * The bank's own booking date (ISO), when the statement distinguishes it
   * from the transaction/value date. NULL/absent = not distinguished.
   */
  booking_date: z.string().nullable().optional(),
  /**
   * The reference-rate OBSERVATION the bank itself prints on the line, as
   * printed. EXPLICITLY UNVERIFIED evidence of what the bank REPORTS — never
   * fed into the verified ECB cache, never used for a statutory lookup or a
   * valuation (issue #403, ADR-0004). NULL/absent = not reported.
   */
  bank_reference_rate: z.number().positive().nullable().optional(),
  /** Counterparty IBAN. */
  counterparty_iban: z.string().nullable().optional(),
  /** Card merchant descriptor. */
  counterparty_descriptor: z.string().nullable().optional(),
  /** Parsed invoice number / match key. */
  reference: z.string().nullable().optional(),
  /**
   * The bank's own transaction id for this movement (issue #399). When it,
   * the provider and the source account reference are ALL known, this is
   * the canonical identity: the same movement imported through another
   * statement is recognised as already-known. NULL/absent = the source did
   * not carry one — the row never merges (conservative: date+amount is not
   * identity).
   */
  external_id: z.string().min(1).nullable().optional(),
  /**
   * The bank's archive/document reference for this movement (issue #399),
   * kept independently of `external_id` and of the payment `reference`.
   */
  archive_ref: z.string().min(1).nullable().optional(),
  /** Disposition status. */
  status: bankTransactionStatusSchema.optional(),
});

export class CreateTransactionInput extends createZodDto(
  createTransactionSchema,
) {}

/** Input for creating a bank statement with its transactions. */
export const createStatementSchema = z.object({
  /** Account code (must start with 'BANK_'). */
  account_code: z.string(),
  /** ISO date string — first date covered by the statement. */
  start_date: z.string(),
  /** ISO date string — last date covered by the statement. */
  end_date: z.string(),
  /** Optional path to the uploaded file. */
  file_path: z.string().nullable().optional(),
  /**
   * The bank, as asserted by this import (issue #399) — e.g. 'LHV'. Part of
   * the canonical identity scope: the same external id from a different
   * provider is a different movement. NULL/absent = unknown provider — the
   * import is accepted but its rows never merge across statements.
   */
  provider_code: z.string().min(1).nullable().optional(),
  /**
   * The bank's own account reference the statement covers (IBAN / account
   * number, issue #399). Part of the canonical identity scope. NULL/absent =
   * unknown — rows never merge across statements.
   */
  source_account_ref: z.string().min(1).nullable().optional(),
  /**
   * The authoritative RAW-source fingerprint (issue #399): SHA-256 over the
   * sorted FULL raw row multiset — every column the source carried, mapped
   * or not — computed by the deterministic transformer at ingestion. It is
   * what separates an exact source replay from a merely similar export:
   * two exports differing only in an unmapped memo value are DIFFERENT
   * sources and must never be collapsed as one replay. Absent for a direct
   * API import, where the structured input itself is the whole source.
   */
  source_fingerprint: z.string().min(1).nullable().optional(),
  /** Transaction lines from the statement. */
  transactions: z.array(createTransactionSchema),
});

export class CreateStatementInput extends createZodDto(createStatementSchema) {}

/** Persisted bank statement record. */
export interface BankStatementRecord {
  id: number;
  account_id: number;
  start_date: string;
  end_date: string;
  uploaded_at: number;
  file_path: string | null;
  provider_code: string | null;
  source_account_ref: string | null;
}

/** Persisted bank transaction record. */
export interface BankTransactionRecord {
  id: number;
  /** The ORIGIN statement, or null after that origin was detached while the
   *  canonical movement survived (issue #399). */
  statement_id: number | null;
  account_id: number | null;
  provider_code: string | null;
  source_account_ref: string | null;
  external_id: string | null;
  archive_ref: string | null;
  transaction_date: string;
  description: string | null;
  amount: number;
  currency: string;
  source_currency: string | null;
  source_amount: number | null;
  fx_rate: number | null;
  /** Decimal places in the PRINTED rate when presented as text; NULL = unknown. */
  fx_rate_decimals: number | null;
  /** Separately charged conversion fee (currency minor units); NULL = not evidenced. */
  conversion_fee: number | null;
  /** The bank's booking date when distinguished from the value date; NULL = not distinguished. */
  booking_date: string | null;
  /** The bank's OWN reported reference-rate observation, as printed — unverified, never statutory (issue #403). */
  bank_reference_rate: number | null;
  counterparty_iban: string | null;
  counterparty_descriptor: string | null;
  reference: string | null;
  status: BankTransactionStatus;
  created_at: number;
}

/** One imported source row that resolved to a canonical transaction. */
export interface BankTransactionSourceRef {
  statement_id: number;
  source_row_number: number | null;
  external_id: string | null;
  archive_ref: string | null;
  created_at: number;
}

/** A canonical transaction as returned with its many-source provenance. */
export interface BankTransactionWithSources extends BankTransactionRecord {
  /** Every imported source row that resolved to this canonical movement. */
  sources: BankTransactionSourceRef[];
}

/** A persisted same-identity conflict (issue #399). */
export interface BankImportConflictView {
  id: number;
  account_id: number;
  provider_code: string | null;
  source_account_ref: string | null;
  external_id: string;
  canonical_transaction_id: number;
  statement_id: number;
  source_row_number: number | null;
  kind:
    | 'amount_mismatch'
    | 'currency_mismatch'
    | 'fact_mismatch'
    | 'ambiguous_overlap';
  detail: {
    canonical: Record<string, unknown>;
    incoming: Record<string, unknown>;
  };
  status: 'open' | 'resolved';
  created_at: number;
}

/** The import's new/known/conflict summary (issue #399). */
export interface ImportSummary {
  /** Canonical transactions newly created by this import. */
  newCount: number;
  newTransactionIds: number[];
  /** Source rows recognised as an already-known canonical movement. */
  knownCount: number;
  knownTransactionIds: number[];
  /** Source rows whose same-identity money facts conflict — needs review. */
  conflictCount: number;
  conflicts: BankImportConflictView[];
}
