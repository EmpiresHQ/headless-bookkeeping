/**
 * Bank statement and transaction types for the bank module.
 */

/** Valid statuses for a bank transaction line. */
export type BankTransactionStatus =
  | 'open'
  | 'prepayment'
  | 'personal'
  | 'bank_fee'
  | 'dividend';

/** Input for creating a bank statement with its transactions. */
export interface CreateStatementInput {
  /** Account code (must start with 'BANK_'). */
  account_code: string;
  /** ISO date string — first date covered by the statement. */
  start_date: string;
  /** ISO date string — last date covered by the statement. */
  end_date: string;
  /** Optional path to the uploaded file. */
  file_path?: string | null;
  /** Transaction lines from the statement. */
  transactions: CreateTransactionInput[];
}

/** Input for a single transaction line within a statement. */
export interface CreateTransactionInput {
  /** ISO date string of the transaction. */
  transaction_date: string;
  /** Free-text description from the bank. */
  description?: string | null;
  /** Signed cents: positive = incoming/credit, negative = outgoing/debit. */
  amount: number;
  /** Currency of the amount (matches the account's currency). */
  currency: string;
  /** Original currency when the bank performed a conversion. */
  source_currency?: string | null;
  /** Cents in source_currency. */
  source_amount?: number | null;
  /** The bank's actual conversion rate. */
  fx_rate?: number | null;
  /** Counterparty IBAN. */
  counterparty_iban?: string | null;
  /** Card merchant descriptor. */
  counterparty_descriptor?: string | null;
  /** Parsed invoice number / match key. */
  reference?: string | null;
  /** Disposition status. */
  status?: BankTransactionStatus;
}

/** Persisted bank statement record. */
export interface BankStatementRecord {
  id: number;
  account_id: number;
  start_date: string;
  end_date: string;
  uploaded_at: number;
  file_path: string | null;
}

/** Persisted bank transaction record. */
export interface BankTransactionRecord {
  id: number;
  statement_id: number;
  transaction_date: string;
  description: string | null;
  amount: number;
  currency: string;
  source_currency: string | null;
  source_amount: number | null;
  fx_rate: number | null;
  counterparty_iban: string | null;
  counterparty_descriptor: string | null;
  reference: string | null;
  status: BankTransactionStatus;
  created_at: number;
}
