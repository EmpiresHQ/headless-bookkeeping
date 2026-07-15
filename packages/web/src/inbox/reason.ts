import { fmtCents, type TriageOutcome, type TriageReasonType } from '../api';
import type { NeedsTriageItem } from '../api';

/**
 * Reasons in human language with numbers (spec data rule 3): parse the
 * PERSISTED policy_reason strings (the fact at hold time — the live policy
 * config may have changed since) and render threshold + fact, never a code.
 * Verified generators: packages/server/src/policy/policy.service.ts:70,84,97,107,119.
 */
const CEILING_RE = /^Voucher amount (\d+) exceeds ceiling (\d+)$/;
const CONFIDENCE_RE = /^AI confidence ([\d.]+) below threshold ([\d.]+)$/;
const RULE_RE = /^(?:Structural\/hard|Semantic) rule failure: (.*)$/;

export function humanizePolicyReason(policyReason: string | null): string {
  if (policyReason === null) return 'Held for your approval';
  const ceiling = CEILING_RE.exec(policyReason);
  if (ceiling) {
    return `${fmtCents(Number(ceiling[1]))} € above the ${fmtCents(
      Number(ceiling[2]),
    )} € auto-post limit`;
  }
  const confidence = CONFIDENCE_RE.exec(policyReason);
  if (confidence) {
    return `AI confidence ${confidence[1]} — below the ${confidence[2]} auto-post threshold`;
  }
  if (policyReason === 'Unknown supplier requires approval') {
    return 'Unknown supplier — policy requires your approval';
  }
  const rule = RULE_RE.exec(policyReason);
  if (rule) return `Rule check failed: ${rule[1]}`;
  return policyReason;
}

/** Needs-triage one-liner: the reason as a human question/instruction,
 *  keeping the numbers where the server sentence carries them. */
const TRIAGE_CONFIDENCE_RE = /confidence ([\d.]+) below threshold ([\d.]+)/i;

export function triageSubtitle(
  item: Pick<NeedsTriageItem, 'reason' | 'reason_type'>,
): string {
  switch (item.reason_type) {
    case 'supplier_unresolved':
      return 'Unknown supplier — who is this?';
    case 'outgoing_invoice':
      return 'Looks like your outgoing invoice — confirm it';
    case 'low_confidence': {
      const m = TRIAGE_CONFIDENCE_RE.exec(item.reason);
      return m
        ? `AI confidence ${m[1]} — below the ${m[2]} threshold, check the result`
        : 'AI was not confident — check the result';
    }
    case 'category_unresolved':
      return 'Category not recognized — pick one';
    case 'ocr_failed':
      return 'OCR could not read the file — retry or replace';
    case 'classification_failed':
      return 'AI classification failed — retry or classify manually';
    case 'not_a_document':
      return 'Does not look like a business document';
    case 'unimplemented':
      return 'Recognized, but not supported yet — handle manually';
    default:
      return item.reason;
  }
}

export function triageChipLabel(rt: TriageReasonType | null): string {
  switch (rt) {
    case 'supplier_unresolved':
      return 'resolve';
    case 'low_confidence':
    case 'category_unresolved':
    case 'classification_failed':
      return 'classify';
    case 'outgoing_invoice':
      return 'invoice';
    case 'ocr_failed':
      return 'retry';
    case 'not_a_document':
      return 'junk';
    default:
      return 'review';
  }
}

/** Receipt copy for triage/upload outcomes. No raw IDs (data rule 1). */
export function outcomeText(o: TriageOutcome): string {
  switch (o.kind) {
    case 'expense':
      return 'Expense created from the document';
    case 'invoice':
      return 'Sales invoice recorded';
    case 'bank_statement':
      return 'Bank statement — import started';
    default:
      return `Still needs review: ${o.reason}`;
  }
}
