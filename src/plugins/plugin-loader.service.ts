import { Injectable } from '@nestjs/common';
import { CountryPlugin } from './country-plugin.interface';
import { NullCountryPlugin } from './null-country.plugin';

/**
 * PluginLoader - Resolves country-specific plugins by country code.
 *
 * Uses simple map-based resolution (no dynamic loading from npm/packages).
 * Currently only supports NullCountryPlugin as a fallback for all country codes.
 *
 * Future: Map will be populated with real country plugins (DK, DE, etc.)
 * as they are implemented.
 */
@Injectable()
export class PluginLoader {
  private readonly plugins: Map<string, CountryPlugin> = new Map();

  constructor(private readonly nullPlugin: NullCountryPlugin) {
    // Register the null plugin as the default fallback.
    // Real country plugins will be registered here as they are implemented.
    this.plugins.set('null', this.nullPlugin);
  }

  /**
   * Resolves a CountryPlugin for the given country code.
   *
   * @param countryCode - ISO country code (e.g. "DK", "DE") or "null"
   * @returns A CountryPlugin instance (currently always NullCountryPlugin)
   */
  resolve(countryCode: string): CountryPlugin {
    const plugin = this.plugins.get(countryCode);
    if (plugin) {
      return plugin;
    }

    // Fallback to null plugin for any unrecognized country code.
    return this.nullPlugin;
  }
}
