const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** Statement title. BankStatement carries no account/currency fields (the
 *  ledger account id is deliberately hidden, ADR-0001), so the period IS the
 *  statement's display identity. */
export function formatStatementPeriod(
  startDate: string,
  endDate: string,
): string {
  const s = parts(startDate);
  const e = parts(endDate);
  if (s.y === e.y && s.m === e.m) return `${MONTHS[s.m - 1]} ${s.y}`;
  if (s.y === e.y) return `${MONTHS[s.m - 1]} – ${MONTHS[e.m - 1]} ${s.y}`;
  return `${MONTHS[s.m - 1]} ${s.y} – ${MONTHS[e.m - 1]} ${e.y}`;
}

/** Short list-date for a bank line: "27 Jun" (absolute — bank dates are facts). */
export function formatTxDate(isoDate: string): string {
  const p = parts(isoDate);
  return `${p.d} ${MONTHS[p.m - 1]}`;
}

/** The line's display title — IDs are not data; the description answers
 *  "what is this". */
export function txTitle(tx: {
  description: string | null;
  counterparty_descriptor: string | null;
  reference: string | null;
}): string {
  return (
    tx.description ?? tx.counterparty_descriptor ?? tx.reference ?? 'Bank transaction'
  );
}

/**
 * DEGRADATION (documented in the plan appendix): no endpoint exposes the
 * country plugin's VAT rate, so the create-from-line form prefigures VAT at
 * the Estonian standard rate. The field stays editable; "no receipt" forces 0.
 */
export const STANDARD_VAT_RATE_PCT = 22;
