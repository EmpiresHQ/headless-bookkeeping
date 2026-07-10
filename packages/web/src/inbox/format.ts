/** Detail screens show ABSOLUTE dates (lists show relative — data rule 5). */
const pad2 = (n: number) => String(n).padStart(2, '0');

export function absoluteDate(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function absoluteDateFromIso(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Implied VAT percent from VAT-inclusive facts: vat / (gross − vat).
 *  Display-only ("16.32 € (22%)"); null when the division is meaningless. */
export function vatRatePct(
  grossCents: number,
  vatCents: number,
): number | null {
  const net = grossCents - vatCents;
  if (net <= 0 || vatCents < 0) return null;
  return Math.round((vatCents / net) * 100);
}

/** Signed euro string for hero amounts and outcome-stating button labels.
 *  Negative sign is the typographic minus U+2212 (matches fmtCents). */
export function signedEuros(cents: number): string {
  const base = `${(Math.abs(cents) / 100).toFixed(2)} €`;
  if (cents < 0) return `−${base}`;
  if (cents > 0) return `+${base}`;
  return base;
}
