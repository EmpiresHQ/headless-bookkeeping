import { Injectable } from '@nestjs/common';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CountryPlugin } from '../plugins/country-plugin.interface';

/**
 * The result of converting a monetary amount to base currency.
 *
 * Carries both the rounded base-currency amount AND the FX rate that was
 * applied, because every VoucherLine stores the rate it was booked at
 * (ADR-0004). Same-currency conversions report `rate = 1.0`.
 */
export interface BaseConversion {
  /** The amount expressed in base currency, rounded to integer cents. */
  baseAmount: number;
  /** The FX rate from the source currency to base currency. 1.0 if same. */
  rate: number;
  /** The resolved base currency code (e.g. "EUR"). */
  baseCurrency: string;
}

@Injectable()
export class CurrencyService {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly pluginLoader: PluginLoader,
  ) {}

  /**
   * Resolves the Organization's effective base currency.
   *
   * Resolution order (ADR-0004):
   *   1. The Organization's explicit base_currency override, if set.
   *   2. Otherwise the country plugin's default base currency.
   */
  async getBaseCurrency(): Promise<string> {
    const org = await this.organizationService.getOrganization();
    if (org.base_currency) {
      return org.base_currency;
    }
    return this.pluginLoader.resolve(org.country).getDefaultBaseCurrency();
  }

  /**
   * Resolves the active country plugin for the Organization — the SAME
   * resolution used by {@link getBaseCurrency} and {@link toBase}
   * (`pluginLoader.resolve(org.country)`). Centralised so every plugin-owned
   * rule (reference rate, base-currency, minor-unit rounding) is sourced
   * consistently from one place rather than re-resolved ad hoc.
   */
  private async resolvePlugin(): Promise<CountryPlugin> {
    const org = await this.organizationService.getOrganization();
    return this.pluginLoader.resolve(org.country);
  }

  /**
   * Convert a monetary amount in some currency to the Organization's base
   * currency at a given date — the SOLE way to perform this conversion.
   *
   * This is a deep module: behind this small interface it owns
   *   1. resolving the base currency (org override ?? plugin default),
   *   2. the same-currency short-circuit (identity, never hits the plugin —
   *      NullCountryPlugin throws on real cross-currency pairs),
   *   3. fetching the country-plugin prescribed reference rate (ADR-0002 keeps
   *      the plugin as the sole rate source; the kernel never invents a rate),
   *   4. the multiply, and
   *   5. rounding to base-currency minor units via the active plugin's rule
   *      ({@link CountryPlugin.roundToBaseMinorUnits}) — rounding to minor units
   *      is a JURISDICTION rule (ADR-0002), not a kernel constant. The neutral
   *      null plugin rounds with `Math.round`, preserving prior behavior.
   *
   * Returns the rounded base amount together with the rate applied, so callers
   * that store `fx_rate` on a VoucherLine get a consistent pair from one place.
   *
   * @param amount - The amount in the source currency (integer cents).
   * @param currency - The source currency code (e.g. "USD").
   * @param date - The tax-point / transaction date (the rate's "as-of").
   */
  async toBase(
    amount: number,
    currency: string,
    date: string,
  ): Promise<BaseConversion> {
    const baseCurrency = await this.getBaseCurrency();

    if (currency === baseCurrency) {
      return { baseAmount: amount, rate: 1.0, baseCurrency };
    }

    const plugin = await this.resolvePlugin();
    const rate = plugin.getReferenceRate(currency, baseCurrency, date);

    return {
      baseAmount: plugin.roundToBaseMinorUnits(
        this.convertToBase(amount, currency, rate),
      ),
      rate,
      baseCurrency,
    };
  }

  /**
   * Converts a foreign-currency amount to the base currency using the given FX rate.
   *
   * The arithmetic primitive used by {@link toBase}. Pure multiply (no
   * rounding) — {@link toBase} applies the cents rounding. Kept for callers
   * that already hold a rate.
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

  /**
   * Convert to base currency at an already-known rate, rounding to integer
   * minor units via the active country plugin's rounding rule
   * ({@link CountryPlugin.roundToBaseMinorUnits}) — rounding to base-currency
   * minor units is a JURISDICTION rule, not a kernel constant (ADR-0002). The
   * plugin is resolved via the SAME path as {@link toBase} / {@link getBaseCurrency}.
   *
   * Used by multi-line draft generators (Expense / SalesInvoice) that resolve a
   * single uniform rate once via {@link toBase} and then book several line
   * amounts at that same rate (ADR-0004 Wave-3 amendment: one uniform rate per
   * draft so the voucher balances in base currency).
   */
  async convertToBaseRounded(
    amount: number,
    currency: string,
    rate: number,
  ): Promise<number> {
    const plugin = await this.resolvePlugin();
    return plugin.roundToBaseMinorUnits(
      this.convertToBase(amount, currency, rate),
    );
  }
}
