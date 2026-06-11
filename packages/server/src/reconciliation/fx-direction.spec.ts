import { determineFXDirection, FXDirection } from './fx-direction';

/**
 * Unit test for the realized-FX direction invariant (ADR-0004).
 *
 * Covers all four quadrants of (incoming/outgoing × gain/loss). This is the
 * testability win of extracting the rule from the posting method: the
 * gain-vs-loss meaning of `realized`'s sign can be exercised directly, without
 * a DB, a bank statement, or the posting pipeline.
 *
 *   realized = booked_base − actual_settled_base
 *   incoming (AR): realized < 0 → gain (received MORE base than booked)
 *   outgoing (AP): realized > 0 → gain (paid LESS base than booked)
 */
describe('determineFXDirection (ADR-0004)', () => {
  const cases: Array<{
    name: string;
    realized: number;
    isIncoming: boolean;
    expected: FXDirection;
  }> = [
    // Incoming (AR receipt): realized < 0 → gain, realized > 0 → loss.
    {
      name: 'incoming + realized < 0 → gain (received more base than booked)',
      realized: -1_400,
      isIncoming: true,
      expected: 'gain',
    },
    {
      name: 'incoming + realized > 0 → loss (received less base than booked)',
      realized: 1_400,
      isIncoming: true,
      expected: 'loss',
    },
    // Outgoing (AP payment): realized > 0 → gain, realized < 0 → loss.
    {
      name: 'outgoing + realized > 0 → gain (paid less base than booked)',
      realized: 1_400,
      isIncoming: false,
      expected: 'gain',
    },
    {
      name: 'outgoing + realized < 0 → loss (paid more base than booked)',
      realized: -1_400,
      isIncoming: false,
      expected: 'loss',
    },
  ];

  for (const { name, realized, isIncoming, expected } of cases) {
    it(name, () => {
      expect(determineFXDirection(realized, isIncoming)).toBe(expected);
    });
  }
});
