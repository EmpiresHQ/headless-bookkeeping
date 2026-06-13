import type { OutgoingSignals } from '../triage/types';

/**
 * Compose a 0..1 confidence that a document is OUR outgoing invoice.
 *
 * The IBAN match is the gate AND the dominant signal: if our IBAN is not on the
 * document this is not an outgoing candidate at all (returns 0). When it is, we
 * start at a 0.5 base and add corroborating weight from the agent's structured
 * issuer signals. Weights sum to 1.0 when everything agrees.
 */
const WEIGHTS = {
  base: 0.5, // org IBAN present on the document
  org_name_is_issuer: 0.2,
  org_vat_is_issuer: 0.2,
  has_buyer_block: 0.05,
  self_identifies_as_invoice: 0.05,
} as const;

export function composeOutgoingConfidence(
  ibanMatched: boolean,
  signals: OutgoingSignals,
): number {
  if (!ibanMatched) return 0;
  let score = WEIGHTS.base;
  if (signals.org_name_is_issuer) score += WEIGHTS.org_name_is_issuer;
  if (signals.org_vat_is_issuer) score += WEIGHTS.org_vat_is_issuer;
  if (signals.has_buyer_block) score += WEIGHTS.has_buyer_block;
  if (signals.self_identifies_as_invoice) score += WEIGHTS.self_identifies_as_invoice;
  return Math.min(1, score);
}
