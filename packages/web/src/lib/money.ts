/**
 * Money INPUT convention (spec): humans type euros ("89", "89.05", "89,05"),
 * the API speaks integer cents. Every money form field must go through these.
 */
export function eurosToCents(input: string): number | null {
  const cleaned = input.trim().replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function centsToEuroInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** VAT portion inside a VAT-inclusive gross at an integer percent rate:
 *  vat = gross * r / (100 + r). Used to prefill VAT from a bank-line amount. */
export function vatFromGross(grossCents: number, ratePct: number): number {
  return Math.round((grossCents * ratePct) / (100 + ratePct));
}
