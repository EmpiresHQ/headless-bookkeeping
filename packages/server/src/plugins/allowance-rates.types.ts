// packages/server/src/plugins/allowance-rates.types.ts

export type AllowanceType =
  | 'daily_allowance'
  | 'mileage'
  | 'phone'
  | 'internet'
  | 'health';

export interface AllowanceRates {
  /** Rate per unit in base-currency minor units (cents).
   *  daily_allowance: cents/day. mileage: cents/km. phone/internet/health: 0 (manual amount). */
  ratePerUnit: number;
  /** Monthly tax-free ceiling in base-currency minor units. null = no statutory ceiling. */
  monthlyTaxFreeCeiling: number | null;
  /** For daily_allowance: max days per calendar month at ratePerUnit before fallback applies. */
  highRateDaysPerMonth?: number;
  /** For daily_allowance: rate per day after highRateDaysPerMonth is exceeded. */
  fallbackRatePerUnit?: number;
}
