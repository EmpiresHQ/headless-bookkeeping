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
  /** Counterparty IBAN. */
  counterparty_iban: z.string().nullable().optional(),
  /** Card merchant descriptor. */
  counterparty_descriptor: z.string().nullable().optional(),
  /** Parsed invoice number / match key. */
  reference: z.string().nullable().optional(),
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
