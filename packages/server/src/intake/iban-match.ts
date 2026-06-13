/**
 * IBAN matching for intake direction detection. Reuses the same IBAN shape the
 * reconciliation module recognises (see reconciliation.service.ts IBAN_PATTERN):
 * 2-letter country + 2 check digits + up to 30 alphanumerics. We normalise by
 * stripping spaces and upper-casing so OCR spacing/case never defeats a match.
 */
const IBAN_PATTERN = /[A-Z]{2}\d{2}[A-Z0-9]{4,30}/gi;

export function normaliseIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * All IBAN-shaped tokens found in free text, normalised and de-duplicated.
 * Note: two IBANs on the same line may concatenate into one super-token after
 * space-stripping, producing false positives/negatives from this enumerator.
 * `matchesOrgIban` does NOT rely on this function; it uses a per-line
 * substring check instead.
 */
export function extractIbans(text: string): string[] {
  // Strip only ASCII spaces (not newlines/tabs) so a spaced-out IBAN printed
  // on one line is joined into a single token, while newlines still act as
  // natural token boundaries between unrelated fields (e.g. "Ref 123").
  const compact = text.replace(/ /g, '');
  const found = compact.match(IBAN_PATTERN) ?? [];
  return Array.from(new Set(found.map((m) => m.toUpperCase())));
}

/**
 * True iff the organization's own IBAN appears anywhere in `text`. A null/empty
 * org IBAN never matches (feature inert until configured).
 */
export function matchesOrgIban(text: string, orgIban: string | null): boolean {
  if (!orgIban) return false;
  const target = normaliseIban(orgIban);
  if (!target) return false;
  // Compare per line with spaces removed: OCR splits one IBAN across spaces,
  // and two IBANs can share a line — a substring check on the space-stripped
  // line matches our full-length IBAN in either case without welding tokens.
  return text
    .split('\n')
    .some((line) => line.replace(/ /g, '').toUpperCase().includes(target));
}
