/**
 * Identifier kinds that participate in supplier MATCHING. `address` is stored
 * (for record-keeping) but deliberately NOT a match key — exact-matching on a
 * postal address produces false merges (shared coworking addresses, formatting
 * variance). Reg number / email / phone are the strong anchors.
 */
export const MATCH_KINDS = ['registration_key', 'email', 'phone'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/**
 * Canonicalize an identifier value for BOTH storage and matching, so a later
 * lookup is a plain equality comparison. Returns null when the value carries no
 * usable signal (normalizes to empty) — the caller drops it.
 */
export function normalizeIdentifier(kind: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  switch (kind) {
    case 'registration_key': {
      const out = trimmed.toUpperCase().replace(/\s+/g, '');
      return out || null;
    }
    case 'email':
      return trimmed.toLowerCase();
    case 'phone': {
      const hasPlus = trimmed.startsWith('+');
      const digits = trimmed.replace(/\D/g, '');
      if (!digits) return null;
      return (hasPlus ? '+' : '') + digits;
    }
    case 'address':
      return trimmed.replace(/\s+/g, ' ').toLowerCase();
    default:
      return trimmed;
  }
}
