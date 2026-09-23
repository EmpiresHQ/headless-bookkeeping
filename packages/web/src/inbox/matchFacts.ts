import type { Approval, MatchFacts } from '../api';
import { currencyMark } from '../lib/money';
import { absoluteDateFromIso } from './format';

/**
 * Bank-match approval facts (issue #256). The response is untrusted input:
 * a decision may only be enabled for a payload that PROVES the exact pair —
 * the approval's own match, a decidable status, a positively identified
 * target and every amount/currency the screen states. Anything missing or
 * off-shape blocks Approve; it never falls back to a partial render that
 * looks complete.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
/** Money in integer cents, within the exactly representable range. */
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isId = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) > 0;
const isCount = (v: unknown): v is number => isInt(v) && v >= 0;
const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string';
const isCcy = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Z]{3}$/.test(v);

export type MatchFactsCheck =
  | { ok: true; facts: MatchFacts }
  | { ok: false; reason: string; facts: MatchFacts | null };

/** Why this payload cannot back a decision on `approval`, or the facts. */
export function checkMatchFacts(
  raw: unknown,
  approval: Approval,
): MatchFactsCheck {
  const bad = (reason: string): MatchFactsCheck => ({
    ok: false,
    reason,
    facts: null,
  });
  if (!isObj(raw)) return bad('The match facts could not be read.');
  if (!isId(raw.matchId) || raw.matchId !== approval.object_id)
    return bad('The loaded match is not the one this approval decides.');
  if (raw.status !== 'draft' && raw.status !== 'active')
    return bad('The match has an unknown status.');
  if (
    raw.matchType !== 'exact' &&
    raw.matchType !== 'partial' &&
    raw.matchType !== 'prepayment'
  )
    return bad('The match has an unknown type.');
  if (!isInt(raw.amountMatched) || raw.amountMatched <= 0)
    return bad('The matched amount is missing.');
  if (!isCcy(raw.baseCurrency)) return bad('The base currency is missing.');

  const tx = raw.bankTransaction;
  if (
    !isObj(tx) ||
    !isId(tx.id) ||
    !isId(tx.statementId) ||
    !isDate(tx.transactionDate) ||
    !isInt(tx.amount) ||
    tx.amount === 0 ||
    !isCcy(tx.currency) ||
    !(tx.sourceAmount === null || isInt(tx.sourceAmount)) ||
    !(tx.sourceCurrency === null || isCcy(tx.sourceCurrency)) ||
    !isStrOrNull(tx.description) ||
    !isStrOrNull(tx.reference) ||
    !isStrOrNull(tx.counterpartyIban) ||
    !isStrOrNull(tx.counterpartyDescriptor) ||
    (tx.sourceAmount === null) !== (tx.sourceCurrency === null)
  )
    return bad('The bank line could not be read.');

  const line = raw.line;
  if (
    !isObj(line) ||
    !isCount(line.activeAllocatedBase) ||
    !isCount(line.activeCashBase) ||
    !isCount(line.otherDraftCount) ||
    !isCount(line.otherDraftAllocatedBase)
  )
    return bad('The line’s other allocations could not be read.');

  const t = raw.target;
  if (
    !isObj(t) ||
    !isInt(t.voucherRemaining) ||
    !isStrOrNull(t.counterpartyName)
  )
    return bad('The matched object could not be read.');

  // The typed view is only handed out (for display while a decision stays
  // blocked) once the target's own shape is proven below.
  const facts = raw as unknown as MatchFacts;
  const blocked = (reason: string): MatchFactsCheck => ({
    ok: false,
    reason,
    facts,
  });

  if (t.kind === 'sales_invoice' || t.kind === 'expense') {
    if (
      !isId(t.objectId) ||
      !isStr(t.objectLabel) ||
      t.advanceKind !== null ||
      t.advance !== null ||
      !isInt(t.grossAmount) ||
      !isCcy(t.currency)
    )
      return bad('The matched document could not be identified.');
  } else if (t.kind === 'prepayment') {
    const a = t.advance;
    if (
      (t.advanceKind !== 'customer' && t.advanceKind !== 'supplier') ||
      t.objectId !== null ||
      !isStr(t.objectLabel) ||
      t.grossAmount !== null ||
      t.currency !== null ||
      !isObj(a) ||
      !isDate(a.date) ||
      !isInt(a.originalBaseAmount) ||
      !isCcy(a.currency) ||
      typeof a.needsReview !== 'boolean' ||
      typeof a.ownerResolved !== 'boolean' ||
      !isStr(a.taxTreatment) ||
      !(
        a.fundingLine === null ||
        (isObj(a.fundingLine) &&
          isDate(a.fundingLine.transactionDate) &&
          isStrOrNull(a.fundingLine.description) &&
          isStrOrNull(a.fundingLine.reference) &&
          isInt(a.fundingLine.amount) &&
          isCcy(a.fundingLine.currency))
      )
    )
      return bad('The advance could not be identified.');
    if (!a.ownerResolved || t.counterpartyName === null)
      return blocked(
        'The advance has no resolved owner, so it cannot be told apart from other advances.',
      );
    if (a.needsReview)
      return blocked(
        'The advance’s remaining balance is unverified (unlinked historical draw-downs).',
      );
    if (a.taxTreatment === 'unresolved')
      return blocked(
        'The advance is unclassified (taxable supply or deposit) and cannot be settled yet.',
      );
  } else {
    if (
      t.kind !== 'unidentified' ||
      !isStr(t.objectLabel) ||
      t.objectId !== null ||
      t.advanceKind !== null ||
      t.grossAmount !== null ||
      t.currency !== null ||
      t.advance !== null
    )
      return bad('The matched object could not be read.');
    return blocked(
      'The matched object could not be identified, so this match cannot be approved.',
    );
  }
  return { ok: true, facts };
}

export function formatMoney(cents: number, currency: string): string {
  return `${cents < 0 ? '−' : ''}${(Math.abs(cents) / 100).toFixed(2)} ${currencyMark(currency)}`;
}

/** Business name of the target, for copy. */
export function targetNoun(f: MatchFacts): string {
  switch (f.target.kind) {
    case 'sales_invoice':
      return `invoice ${f.target.objectLabel}`;
    case 'expense':
      return `the expense ${f.target.objectLabel}`;
    case 'prepayment':
      return f.target.advance !== null
        ? `the ${f.target.advanceKind} advance of ${absoluteDateFromIso(f.target.advance.date)}`
        : 'the advance';
    default:
      return 'an unidentified object';
  }
}
