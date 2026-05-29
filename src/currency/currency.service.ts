import { Injectable, Inject } from '@nestjs/common';

/**
 * Injection token for the Organization's base currency configuration.
 * In production, this would be resolved from the Organization entity in the database.
 */
export const ORG_BASE_CURRENCY = 'ORG_BASE_CURRENCY';

@Injectable()
export class CurrencyService {
  constructor(
    @Inject(ORG_BASE_CURRENCY) private readonly baseCurrency: string,
  ) {}

  /**
   * Returns the Organization's base currency (e.g., "DKK").
   */
  getBaseCurrency(): string {
    return this.baseCurrency;
  }

  /**
   * Converts a foreign-currency amount to the base currency using the given FX rate.
   *
   * @param amount - The amount in the source currency
   * @param _currency - The source currency code (e.g., "USD")
   * @param rate - The FX rate from source currency to base currency
   * @returns The amount expressed in base currency
   *
   * Example: convertToBase(100, "USD", 7.14) => 714
   */
  convertToBase(amount: number, _currency: string, rate: number): number {
    return amount * rate;
  }
}
