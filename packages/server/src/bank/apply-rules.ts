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
  const m = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v;
}

const cell = (
  row: Record<string, string>,
  col: string | null,
): string | null => (col ? (row[col] ?? '').trim() || null : null);

/**
 * Read one settlement-FX evidence cell (issue #403). The whole cell is the
 * value unless the mapping carries an extraction pattern for a bank that
 * embeds the evidence in a free-text description (ADR-0031: the pattern is a
 * RULE the deterministic transformer applies — the LLM never emits rows).
 * Returns null for an empty cell: absent evidence stays NULL, never zero.
 */
function fxEvidenceCell(
  row: Record<string, string>,
  target: { column: string; pattern?: string | null } | null | undefined,
): string | null {
  if (!target) return null;
  const raw = cell(row, target.column);
  if (raw === null) return null;
  if (!target.pattern) return raw;
  let regex: RegExp;
  try {
    regex = new RegExp(target.pattern);
  } catch (e) {
    throw new Error(
      `Not a usable fx-evidence pattern for column '${target.column}': ` +
        `${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const m = regex.exec(raw);
  if (!m) return null;
  return (m[1] ?? m[0]).trim() || null;
}

/** A parsed source-currency evidence value, or null when the line has none. */
function sourceCurrencyCell(
  row: Record<string, string>,
  ruleset: MappingRuleset,
): string | null {
  const v = fxEvidenceCell(row, ruleset.source_currency);
  return v ? v.toUpperCase() : null;
}

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
    bom: true, // bank exports are often UTF-8 with a leading BOM
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
      counterparty_descriptor: cell(
        row,
        ruleset.counterparty_descriptor_column,
      ),
      reference: cell(row, ruleset.reference_column),
      source_currency: sourceCurrencyCell(row, ruleset),
      source_amount: (() => {
        const v = fxEvidenceCell(row, ruleset.source_amount);
        return v === null ? null : toCents(v);
      })(),
      fx_rate: (() => {
        const v = fxEvidenceCell(row, ruleset.fx_rate);
        if (v === null) return null;
        const n = Number(v.replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`Not a usable fx rate: "${v}"`);
        }
        return n;
      })(),
      fx_rate_decimals: (() => {
        // The QUOTED precision, retained before the numeric coercion eats it:
        // how many decimals the bank actually printed ('0.1338333' → 7).
        // NULL when the rate itself is absent or carries no printed precision
        // (a bare integer, an exponent form — none fabricated, issue #403).
        const v = fxEvidenceCell(row, ruleset.fx_rate);
        if (v === null) return null;
        const cleaned = v.replace(/\s/g, '').replace(',', '.');
        if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
        return cleaned.includes('.') ? cleaned.split('.')[1].length : 0;
      })(),
      conversion_fee: (() => {
        const v = fxEvidenceCell(row, ruleset.conversion_fee);
        return v === null ? null : toCents(v);
      })(),
      booking_date: (() => {
        const v = fxEvidenceCell(row, ruleset.booking_date);
        return v === null ? null : toIso(v, ruleset.date_format);
      })(),
      bank_reference_rate: (() => {
        // The bank's OWN printed reference-rate observation — retained
        // UNVERIFIED, never used for any conversion (issue #403).
        const v = fxEvidenceCell(row, ruleset.bank_reference_rate);
        if (v === null) return null;
        const n = Number(v.replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`Not a usable bank reference rate: "${v}"`);
        }
        return n;
      })(),
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
