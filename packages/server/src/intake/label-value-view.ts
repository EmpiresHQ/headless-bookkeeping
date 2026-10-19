/**
 * Layout-tolerant canonical label/value view (issue #405).
 *
 * Some suppliers' PDF generators (Estonian columnar invoices, the issue #405
 * class) draw each field's value and its label as ONE PDF text run, so the
 * reconstructed text layer glues them without whitespace:
 *
 * ```
 * 5001799762Arve number:
 * 02.10.2026Kuupäev:
 * 6221000702446172Viitenumber:
 * ```
 *
 * A label-anchored reader takes the token AFTER the label — so it extracts
 * the NEXT line's value (the date) as the invoice number and reads no value
 * at all for the last label, which is how a valid invoice came out as
 * `invoice number 02.10.2026, gross 0` in production.
 *
 * The canonical view re-associates every glued value with its own label
 * deterministically: a run of value characters (digits, dates, amounts —
 * anything that is not a letter, whitespace or colon, and contains a digit)
 * directly followed by a digit-free label phrase that ends with a colon is
 * rewritten label-first. The result is not a keyword patch for one invoice —
 * it is layout normalization for any `valueLabel:` glue, in any language.
 *
 * The RAW OCR text is never rewritten or dropped (ADR-0024: the persisted
 * ocr_markdown artifact is the audit record); the canonical view is a
 * Pass-2 PROMPT input that PRECEDES the preserved raw text, because a
 * label-anchored reader takes the first `label:` it meets — and in the glued
 * raw text that would be followed by the next line's value.
 */

/**
 * Grouping whitespace inside printed values: space, NBSP (U+00A0), narrow
 * NBSP (U+202F) and thin space (U+2009) — the separators European invoices
 * use inside thousands-grouped amounts (`1\u00A0234,56`). NOT a field
 * boundary: a value can continue across it, so a match can never restart at
 * a whitespace-separated SUFFIX of a value (issue #405 root review — that is
 * how `1\u00A0234,56Kokku:` lost its thousands group and `− 91,00Kokku:`
 * its sign).
 */
const GROUPING_WS = '[ \\u00A0\\u202F\\u2009]';

/** A numeric chunk: value characters, at least one a digit. */
const CHUNK = '[\\d.,+\\-−/€$%]*\\d[\\d.,+\\-−/€$%]*';

/**
 * One glued `valueLabel:` junction, capturing the COMPLETE value:
 *
 * - The value is either a sign separated by grouping whitespace from the
 *   amount (`- 91,00`, `− 91,00`), a thousands-GROUPED amount
 *   (`1 234,56`, `1\u00A0234,56` — digit groups with grouping whitespace and
 *   an optional decimal part), or one plain numeric chunk (a date, a
 *   reference, an ungrouped amount). Any other shape — a token fused with
 *   letters (`INV-123`), two amounts separated by plain whitespace, a value
 *   containing a colon (a time `12:30`) — is an unsupported junction and is
 *   skipped ENTIRELY, never rewritten with a confidently truncated value.
 * - The junction must start at a WHOLE-FIELD boundary: line start, or the
 *   colon of a PREVIOUS label (`…number:02.10.2026…`). Whitespace is not a
 *   boundary (grouping lives inside values), and a letter or a
 *   value-preceded colon (a time) is an ambiguous fusion — both skip.
 * - The label is letter-initial, digit-free and colon-terminated, so codes
 *   whose letters and digits belong to one token (`RI7USPNX0014`) never
 *   match.
 */
const GLUED_VALUE_BEFORE_LABEL = new RegExp(
  '(?:^|(?<=\\p{L}:))' +
    '(?<value>' +
    `(?:[+\\-−]${GROUPING_WS}${CHUNK})` +
    `|\\d{1,3}(?:${GROUPING_WS}\\d{3})+(?:[.,]\\d+)?` +
    `|${CHUNK}` +
    ')' +
    '(?<label>\\p{L}[^\\p{N}\\n:]*:)',
  'gmu',
);

/**
 * Presentation normalization for the canonical line ONLY (the raw text
 * stays verbatim): grouping whitespace becomes a plain space and U+2212
 * becomes ASCII `-`, so the complete value reads naturally.
 */
function presentValue(value: string): string {
  return value
    .replace(/[\u00A0\u202F\u2009]/g, ' ')
    .replace(/−/g, '-')
    .trim();
}

/**
 * Every glued value-before-label junction in the text, rewritten label-first:
 * `5001799762Arve number:` → `Arve number: 5001799762`.
 */
export function canonicalLabelValueLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const match of markdown.matchAll(GLUED_VALUE_BEFORE_LABEL)) {
    const value = match.groups?.value;
    const label = match.groups?.label;
    if (value && label) {
      lines.push(`${label} ${presentValue(value)}`);
    }
  }
  return lines;
}

/**
 * The Pass-2 document text: the canonical field view FIRST (a label-anchored
 * reader must meet the true association before the glued raw text), then the
 * raw OCR text verbatim. Text with no glued junction is returned unchanged.
 */
export function withCanonicalLabelValueView(markdown: string): string {
  const lines = canonicalLabelValueLines(markdown);
  if (lines.length === 0) return markdown;
  return (
    'Printed labels and their values, re-associated from the document text ' +
    'below (these documents print the value immediately BEFORE its label; ' +
    'each line here is that label followed by its own value):\n' +
    lines.map((line) => `- ${line}`).join('\n') +
    '\n\nRaw document text:\n' +
    markdown
  );
}
