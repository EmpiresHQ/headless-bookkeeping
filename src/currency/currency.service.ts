import { Injectable } from '@nestjs/common';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';

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
   * Converts a foreign-currency amount to the base currency using the given FX rate.
   *
   * @param amount - The amount in the source currency
   * @param _currency - The source currency code (e.g., "USD")
   * @param rate - The FX rate from source currency to base currency
   * @returns The amount expressed in base currency
   *
   * Example: convertToBase(100, "USD", 7.14) => 714
   */
  static convertToBase(amount: number, rate: number): number {
    return amount * rate;
  }

  convertToBase(amount: number, _currency: string, rate: number): number {
    return CurrencyService.convertToBase(amount, rate);
  }
}
