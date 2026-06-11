/**
 * The realized-FX direction invariant (ADR-0004).
 *
 * When a foreign-currency position settles, the realized base-currency
 * difference is:
 *
 *     realized = booked_base − actual_settled_base   (ADR-0004)
 *
 * Whether that difference is a GAIN or a LOSS is direction-dependent — the
 * sign of `realized` means opposite things for an incoming receipt (AR) vs an
 * outgoing payment (AP):
 *
 *   - incoming (AR receipt):  realized < 0 → gain (received MORE base than booked)
 *   - outgoing (AP payment):  realized > 0 → gain (paid LESS base than booked)
 *
 * i.e. `isGain = isIncoming ? realized < 0 : realized > 0`.
 *
 * This is the single semantic invariant that answers "is a base-currency
 * difference a gain or a loss?". It is isolated here so it can be tested across
 * all four quadrants (incoming/outgoing × gain/loss) without standing up a
 * posting pipeline. The downstream posting (which account is debited vs
 * credited) consumes this verdict and is intentionally NOT part of it.
 */

/** Whether a realized base-currency difference is a gain or a loss. */
export type FXDirection = 'gain' | 'loss';

/**
 * Classify a realized base-currency difference as a gain or a loss (ADR-0004).
 *
 * @param realizedBase `booked_base − actual_settled_base`, in base-currency
 *                     cents. Must be non-zero (a zero difference is "no FX" and
 *                     is short-circuited before direction is ever asked).
 * @param isIncoming   true for an incoming receipt (AR), false for an outgoing
 *                     payment (AP) — derived from the bank-transaction sign.
 * @returns `'gain'` or `'loss'`.
 */
export function determineFXDirection(
  realizedBase: number,
  isIncoming: boolean,
): FXDirection {
  const isGain = isIncoming ? realizedBase < 0 : realizedBase > 0;
  return isGain ? 'gain' : 'loss';
}
