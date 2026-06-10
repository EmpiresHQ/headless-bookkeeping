import { parse } from 'csv-parse/sync';
import {
  createStatementSchema,
  type CreateStatementInput,
} from './bank-statement.types';
import type { MappingRuleset } from './bank-mapping.types';

function toCents(raw: string): number {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`Not a number: "${raw}"`);
  return Math.round(n * 100);
}

function toIso(raw: string, format: string): string {
  const v = raw.trim();
  if (format === 'YYYY-MM-DD') return v;
  const m = /^(\d{2})[.\/](\d{2})[.\/](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v;
}

const cell = (row: Record<string, string>, col: string | null): string | null =>
  col ? (row[col] ?? '').trim() || null : null;

/**
 * Deterministically apply a mapping ruleset to a bank CSV, producing a
 * Zod-validated CreateStatementInput. Pure — no Mastra, no IO. Throws if the
 * result does not satisfy the kernel schema (the safeguard).
 */
export function applyRules(
  ruleset: MappingRuleset,
  csvText: string,
): CreateStatementInput {
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (rows.length === 0) throw new Error('No transactions in the CSV');

  const transactions = rows.map((row) => {
    let amount: number;
    if (ruleset.amount.mode === 'signed') {
      amount = toCents(row[ruleset.amount.column]);
    } else {
      const magnitude = Math.abs(toCents(row[ruleset.amount.amount_column]));
      const isDebit =
        (row[ruleset.amount.indicator_column] ?? '').trim() ===
        ruleset.amount.debit_value;
      amount = isDebit ? -magnitude : magnitude;
    }
    return {
      transaction_date: toIso(row[ruleset.date_column], ruleset.date_format),
      amount,
      currency: cell(row, ruleset.currency_column) ?? ruleset.default_currency,
      description: cell(row, ruleset.description_column),
      counterparty_iban: cell(row, ruleset.counterparty_iban_column),
      counterparty_descriptor: cell(row, ruleset.counterparty_descriptor_column),
      reference: cell(row, ruleset.reference_column),
    };
  });

  const dates = transactions.map((t) => t.transaction_date).sort();
  const candidate = {
    account_code: ruleset.account_code,
    start_date: dates[0],
    end_date: dates[dates.length - 1],
    transactions,
  };

  return createStatementSchema.parse(candidate);
}
