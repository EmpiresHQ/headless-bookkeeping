import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
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
 * The source ACCOUNT reference evidence (issue #399): where the statement
 * carries the IBAN / account number the row belongs to. Normalised (trimmed,
 * uppercased); null when the mapping carries no target or the cell is empty —
 * an unknown source account never merges.
 */
function sourceAccountCell(
  row: Record<string, string>,
  ruleset: MappingRuleset,
): string | null {
  const v = fxEvidenceCell(row, ruleset.source_account);
  return v ? v.toUpperCase() : null;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasUtf8Bom(buf: Buffer): boolean {
  return (
    buf.length >= UTF8_BOM.length &&
    buf.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
  );
}

/**
 * The column names of a bank CSV's header record, in the source's ORIGINAL
 * order, trimmed. A leading UTF-8 BOM is an encoding marker, not a column
 * name, so it is stripped (and `bom: true` is left on as a second guard).
 * Quoted and unquoted spellings of the same names are equal here: the CSV
 * parser removes the quotes, so a quoted export and an unquoted one describe
 * the same headers. Pure — no IO, no LLM.
 */
export function headerColumns(csvText: string): string[] {
  const withoutBom = csvText.replace(/^\uFEFF/, '');
  const [header = []] = parse(withoutBom, {
    bom: true,
    to_line: 1,
    skip_empty_lines: true,
  }) as string[][];
  return header.map((name) => name.trim());
}

/**
 * The stable identity of a bank export's FORMAT (issue: bank mapping profile):
 * SHA-256 over the ordered, trimmed header names. Uploads from the same bank
 * with the same export format share this signature, so the successful column
 * mapping can be reused instead of asking the LLM again. Order participates
 * (a reordered export is a different format); quoting and a leading BOM do
 * not.
 */
export function headerSignature(csvText: string): string {
  return createHash('sha256')
    .update(JSON.stringify(headerColumns(csvText)))
    .digest('hex');
}

/**
 * The authoritative raw-source fingerprint (issue #399, carrying #403's
 * raw-byte contract): SHA-256 over the SORTED FULL raw row multiset — every
 * column the source carried, mapped or NOT, byte-preserved. Order-
 * insensitive (a row-reordered export is the same source), but content-
 * sensitive (two exports differing only in an unmapped memo value — even
 * in non-UTF-8 bytes — are different sources, never one invented replay).
 * Pure and deterministic — the LLM never participates (ADR-0031).
 */
export function sourceFingerprint(source: string | Buffer): string {
  // Byte-preserving decode (issue #399, with #403's raw-byte contract): the
  // ORIGINAL bytes — never a lossy UTF-8 re-decode — so two exports whose
  // unmapped columns differ only in non-UTF-8 bytes are DIFFERENT sources,
  // never an invented exact replay. Row order is normalised; byte content is
  // not: every byte of every cell participates.
  const raw = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
  // A leading UTF-8 BOM is an encoding marker, not content: strip it before
  // the latin1 decode (where it would surface as "ï»¿" and break the header
  // quote parse), so a BOM'd re-save fingerprints as the same source.
  const buf = hasUtf8Bom(raw) ? raw.subarray(UTF8_BOM.length) : raw;
  const csvText = buf.toString('latin1');
  // Arrays retain every occurrence of duplicate headers. Object records
  // would discard earlier cells with the same name before we could hash them.
  const [headers = [], ...rows] = parse(csvText, {
    skip_empty_lines: true,
  }) as string[][];
  const columns = headers
    .map((name, index) => ({ name, index }))
    .sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index,
    );
  const normalised = rows
    .map((row) => JSON.stringify(columns.map((column) => row[column.index])))
    .sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        headers: columns.map((column) => column.name),
        rows: normalised,
      }),
    )
    .digest('hex');
}

/**
 * Reject a ruleset that cannot possibly apply to this CSV, BEFORE it is
 * applied. An LLM-inferred ruleset is unverified: it can name a column the
 * export does not have, point a settlement-FX target at the debit/credit
 * indicator (the production incident: `fx_rate` → `D`), or claim a rate where
 * the sample rows hold text. Each failure names the offending column/value so
 * the operator can see what to fix, and the caller never caches a ruleset that
 * failed.
 *
 * Deterministic and pure (ADR-0031): the LLM never emits rows, and this
 * validation never invents a value.
 */
export function validateRuleset(
  ruleset: MappingRuleset,
  csvText: string,
): void {
  const columns = new Set(headerColumns(csvText));
  const rejected = (reason: string): never => {
    throw new Error(`bank_mapping ruleset rejected: ${reason}`);
  };

  const references: { label: string; column: string }[] = [
    { label: 'date_column', column: ruleset.date_column },
  ];
  if (ruleset.amount.mode === 'signed') {
    references.push({
      label: 'amount.column',
      column: ruleset.amount.column,
    });
  } else {
    references.push(
      { label: 'amount.amount_column', column: ruleset.amount.amount_column },
      {
        label: 'amount.indicator_column',
        column: ruleset.amount.indicator_column,
      },
    );
  }
  const optionalColumns: { label: string; column: string | null }[] = [
    { label: 'currency_column', column: ruleset.currency_column },
    { label: 'description_column', column: ruleset.description_column },
    {
      label: 'counterparty_iban_column',
      column: ruleset.counterparty_iban_column,
    },
    {
      label: 'counterparty_descriptor_column',
      column: ruleset.counterparty_descriptor_column,
    },
    { label: 'reference_column', column: ruleset.reference_column },
  ];
  for (const { label, column } of optionalColumns) {
    if (column !== null) references.push({ label, column });
  }
  const evidenceTargets: {
    label: string;
    target: { column: string } | null | undefined;
  }[] = [
    { label: 'source_account', target: ruleset.source_account },
    { label: 'external_id', target: ruleset.external_id },
    { label: 'archive_id', target: ruleset.archive_id },
    { label: 'source_currency', target: ruleset.source_currency },
    { label: 'source_amount', target: ruleset.source_amount },
    { label: 'fx_rate', target: ruleset.fx_rate },
    { label: 'conversion_fee', target: ruleset.conversion_fee },
    { label: 'booking_date', target: ruleset.booking_date },
    { label: 'bank_reference_rate', target: ruleset.bank_reference_rate },
  ];
  for (const { label, target } of evidenceTargets) {
    if (target) references.push({ label, column: target.column });
  }
  for (const { label, column } of references) {
    if (!columns.has(column)) {
      rejected(
        `${label} references column '${column}' not found in the header`,
      );
    }
  }

  // A settlement-FX target must not REUSE the amount's debit/credit indicator:
  // that column holds a flag like "D"/"C", never a rate or an amount. This is
  // the production incident's failure (fx_rate → indicator column).
  if (ruleset.amount.mode === 'debit_credit') {
    const indicator = ruleset.amount.indicator_column;
    for (const label of [
      'fx_rate',
      'source_amount',
      'conversion_fee',
      'bank_reference_rate',
    ] as const) {
      const target = ruleset[label];
      if (target && target.column === indicator) {
        rejected(
          `${label} maps to the amount indicator column '${indicator}', ` +
            'which holds a debit/credit flag, not a numeric value',
        );
      }
    }
  }

  // Sample the first rows: a rate target can name a real column and still hold
  // text (a mis-mapped column). Only non-empty cells are checked — absent
  // evidence stays absent, never zero.
  const rows = parse(csvText, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  for (const [index, row] of rows.slice(0, 5).entries()) {
    for (const label of ['fx_rate', 'bank_reference_rate'] as const) {
      const target = ruleset[label];
      if (!target) continue;
      let raw: string | null = null;
      try {
        raw = fxEvidenceCell(row, target);
      } catch (e) {
        rejected(
          `${label} column '${target.column}' has an unusable extraction ` +
            `pattern: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (raw === null) continue;
      const n = Number(raw.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) {
        rejected(
          `${label} value "${raw}" from column '${target.column}' on sample ` +
            `row ${index + 1} is not a positive number`,
        );
      }
    }
  }
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

  const transactions = rows.map((row) => ({
    // Per-row source-account observation (issue #399): collected for the
    // consistency check below, not part of the transaction schema.
    __source_account_ref: sourceAccountCell(row, ruleset),
    payload: (() => {
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
        currency:
          cell(row, ruleset.currency_column) ?? ruleset.default_currency,
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
        // Canonical identity inputs (issue #399). All extracted by the SAME
        // deterministic rules/pattern machinery as the FX evidence — the LLM
        // emits rules, never rows (ADR-0031). Each is NULL when the mapping
        // carries no target or the cell is empty: absent identity stays NULL,
        // and a NULL anywhere in the identity triple means the row never
        // merges (conservative unknown-identity policy).
        external_id: fxEvidenceCell(row, ruleset.external_id),
        archive_ref: fxEvidenceCell(row, ruleset.archive_id),
      };
    })(),
  }));

  // The statement-level source-account reference (issue #399): every row of
  // ONE statement covers ONE bank account, so the value must be consistent
  // across rows. A file whose rows disagree about which account they cover
  // is bad source data — surfaced loudly, never silently first-row-wins.
  const sourceAccountRefs = new Set(
    transactions.map((t) => t.__source_account_ref),
  );
  if (sourceAccountRefs.size > 1) {
    throw new Error(
      'Inconsistent source account references across rows — ' +
        'a statement must cover exactly one bank account',
    );
  }
  const sourceAccountRef = transactions[0]?.__source_account_ref ?? null;
  const parsedTransactions = transactions.map((t) => t.payload);

  const dates = parsedTransactions.map((t) => t.transaction_date).sort();
  const candidate = {
    account_code: ruleset.account_code,
    start_date: dates[0],
    end_date: dates[dates.length - 1],
    provider_code: ruleset.provider_code
      ? ruleset.provider_code.trim().toUpperCase()
      : null,
    source_account_ref: sourceAccountRef,
    transactions: parsedTransactions,
  };

  return createStatementSchema.parse(candidate);
}
