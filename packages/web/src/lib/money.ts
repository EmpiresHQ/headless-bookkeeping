/**
 * Money INPUT convention (spec): humans type euros ("89", "89.05", "89,05"),
 * the API speaks integer cents. Every money form field must go through these.
 */
const AMOUNT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

export function eurosToCents(input: string): number | null {
  const m = AMOUNT.exec(input.trim().replace(',', '.'));
  if (m === null) return null;
  // Exact decimal → integer cents from the digits themselves (issue #265):
  // float arithmetic would silently move a cent on large amounts. An amount
  // with more digits than an exact integer holds is not an amount the
  // client can send faithfully as a JSON number — null, never rounded.
  const cents = BigInt(`${m[2]}${(m[3] ?? '').padEnd(2, '0')}`);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const n = Number(cents);
  return m[1] === '-' ? -n : n;
}

/** The largest amount `eurosToCents` represents exactly, as typed. */
export const MAX_EXACT_AMOUNT = `${String(Number.MAX_SAFE_INTEGER).slice(0, -2)}.${String(Number.MAX_SAFE_INTEGER).slice(-2)}`;

/**
 * The field message for a typed money amount (issue #265) — one wording
 * for every form: blank (the caller says what is missing), not an amount,
 * too large to be represented exactly (never rounded), or on the wrong
 * side of zero for `sign`. Null = the amount is fine.
 */
export function amountError(
  input: string,
  opts: { blank: string; sign: 'positive' | 'nonNegative'; what: string },
): string | null {
  const t = input.trim();
  if (t === '') return opts.blank;
  const cents = eurosToCents(t);
  if (cents === null) {
    return AMOUNT.test(t.replace(',', '.'))
      ? `Too large to record exactly — at most ${MAX_EXACT_AMOUNT}`
      : 'Enter an amount like 12.40 — digits, at most 2 decimals';
  }
  if (opts.sign === 'positive' && cents <= 0) {
    return `${opts.what} must be greater than zero`;
  }
  if (opts.sign === 'nonNegative' && cents < 0) {
    return `${opts.what} cannot be negative`;
  }
  return null;
}

export function centsToEuroInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** VAT portion inside a VAT-inclusive gross at an integer percent rate:
 *  vat = gross * r / (100 + r). Used to prefill VAT from a bank-line amount. */
export function vatFromGross(grossCents: number, ratePct: number): number {
  return Math.round((grossCents * ratePct) / (100 + ratePct));
}

/** Display mark for a currency: '€' for EUR (the app's existing
 *  convention), the unambiguous ISO code for anything else. Display only —
 *  nothing here converts between currencies. */
export function currencyMark(currency: string): string {
  return currency === 'EUR' ? '€' : currency;
}

/** Signed euro DISPLAY for hero amounts, group totals, and outcome-stating
 *  button labels/toasts. Signs by the INPUT's sign: negative → typographic
 *  minus U+2212, positive → '+', zero → unsigned. Callers showing an
 *  outflow stored as a positive magnitude pass the negation
 *  (`signedEuros(-grossCents)`). NEVER prefix a literal '−'/'+' around
 *  fmtCents/toFixed output instead — fmtCents self-signs, so that pattern
 *  renders '−−' the day a negative flows in (Plan 07 Task 1 decision). */
export function signedEuros(cents: number): string {
  return signedMoney(cents, 'EUR');
}

/** `signedEuros` for an amount in an explicit currency ('−1200.00 USD').
 *  EUR output is identical to `signedEuros`. The amount is never converted. */
export function signedMoney(cents: number, currency: string): string {
  const base = `${(Math.abs(cents) / 100).toFixed(2)} ${currencyMark(currency)}`;
  if (cents < 0) return `−${base}`;
  if (cents > 0) return `+${base}`;
  return base;
}
