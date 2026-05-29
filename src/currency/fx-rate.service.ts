import { Injectable } from '@nestjs/common';

// TODO: In production, this would call an external API (ECB, OpenExchangeRates)
const HARDCODED_RATES: Record<string, number> = {
  'DKK:USD': 0.14,
  'USD:DKK': 7.14,
  'DKK:EUR': 0.134,
  'EUR:DKK': 7.46,
};

@Injectable()
export class FXRateService {
  /**
   * Returns the hardcoded exchange rate from one currency to another.
   *
   * @param fromCurrency - Source currency code (e.g., "USD")
   * @param toCurrency - Target currency code (e.g., "DKK")
   * @returns The exchange rate (1 unit of fromCurrency = rate units of toCurrency)
   * @throws Error if the rate is not configured
   *
   * Example: getRate("USD", "DKK") => 7.14
   */
  getRate(fromCurrency: string, toCurrency: string): number {
    const key = `${fromCurrency}:${toCurrency}`;
    const rate = HARDCODED_RATES[key];

    if (rate === undefined) {
      throw new Error(
        `No FX rate configured for ${fromCurrency} → ${toCurrency}`,
      );
    }

    return rate;
  }
}
