import { Injectable } from '@nestjs/common';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CountryPlugin } from '../plugins/country-plugin.interface';
import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
import {
  OrganizationBasisRow,
  resolveLedgerBasis,
} from '../organization/ledger-basis';

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
  /**
   * The publication date `rate` was taken from (YYYY-MM-DD) — NOT always the
   * requested date, because authorities do not publish on non-business days
   * (issue #203). Persisted on the VoucherLine so a fallback is visible after
   * the fact instead of being re-derived from rates that may have moved.
   */
  rateDate: string;
  /** Who published `rate`: an authority id ("ECB"), or "identity". */
  rateSource: string;
  /**
   * The organisation's measurement basis AS IT STOOD when this conversion
   * resolved its base currency — read BEFORE any rate lookup was awaited
   * (issue #215).
   *
   * A generator that books `baseAmount` onto a draft puts this on the draft as
   * `measured_basis`, so the posting transaction can refuse the amount rather
   * than post it under a basis it was not measured in. Sampling the basis at
   * post time instead would start the window after the network wait, which is
   * exactly where the settings edit can land.
   */
  basis: OrganizationBasisRow;
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
   *
   * The resolution itself lives in {@link resolveLedgerBasis}, shared with the
   * measurement-basis guard in OrganizationService (issue #215), so what the
   * guard protects is by construction what the posting side applies.
   */
  async getBaseCurrency(): Promise<string> {
    return (await this.getLedgerBasis()).baseCurrency;
  }

  /**
   * The effective base currency TOGETHER WITH the raw organisation row it was
   * resolved from (issue #215) — one read, so the currency applied and the
   * basis recorded cannot describe two different instants.
   *
   * A draft generator that resolves its own rate (rather than going through
   * {@link toBase}) calls this INSTEAD of {@link getBaseCurrency} and stamps
   * `basis` on the draft as `measured_basis`. The sample is then taken before
   * the rate lookup is awaited, which is where a settings edit can land.
   */
  async getLedgerBasis(): Promise<{
    baseCurrency: string;
    basis: OrganizationBasisRow;
  }> {
    const org = await this.organizationService.getOrganization();
    return {
      baseCurrency: resolveLedgerBasis(org, this.pluginLoader).baseCurrency,
      basis: { country: org.country, base_currency: org.base_currency },
    };
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
   *      the plugin as the sole rate source; the kernel never invents a rate).
   *      Since #203 that lookup is ASYNCHRONOUS and authoritative — it may hit
   *      the network — so this method must never be called inside an open
   *      SQLite transaction (better-sqlite3 single connection),
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
    const { baseCurrency, basis } = await this.getLedgerBasis();

    if (currency === baseCurrency) {
      // Identity: no rate is needed, and none is invented. The provenance is
      // still recorded explicitly so an identity line stays distinguishable
      // from a legacy line whose provenance is simply unknown (#203).
      return {
        baseAmount: amount,
        rate: 1.0,
        baseCurrency,
        rateDate: date,
        rateSource: IDENTITY_RATE_SOURCE,
        basis,
      };
    }

    const plugin = await this.resolvePlugin();
    const { rate, rateDate, source } = await plugin.getReferenceRate(
      currency,
      baseCurrency,
      date,
    );

    return {
      baseAmount: plugin.roundToBaseMinorUnits(
        this.convertToBase(amount, currency, rate),
      ),
      rate,
      baseCurrency,
      rateDate,
      rateSource: source,
      // Sampled before the (possibly networked) rate lookup above, so it
      // describes the instant these amounts were measured at — not the instant
      // the lookup happened to return (issue #215).
      basis,
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
