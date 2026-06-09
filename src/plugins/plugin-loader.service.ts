import { Injectable, Logger } from '@nestjs/common';
import { CountryPlugin } from './country-plugin.interface';
import { NullCountryPlugin } from './null-country.plugin';

/**
 * PluginLoader - Resolves country-specific plugins by country code.
 *
 * Uses simple map-based resolution (no dynamic loading from npm/packages).
 * The NullCountryPlugin is the neutral default (Ireland/EUR, ADR-0004); real
 * country plugins (DK, DE, …) are registered here as they are implemented.
 *
 * Exactly one plugin is active per deployment (the Organization's country,
 * ADR-0002). The default deployment legitimately runs on the neutral plugin.
 */
@Injectable()
export class PluginLoader {
  private readonly logger = new Logger(PluginLoader.name);
  private readonly plugins: Map<string, CountryPlugin> = new Map();

  /**
   * Country codes already warned about, so an unknown country is logged
   * exactly once rather than on every resolve() (which runs per voucher).
   * Spam control: a busy DK deployment with no DK plugin gets ONE warning,
   * not one per posting.
   */
  private readonly warnedUnknownCodes: Set<string> = new Set();

  constructor(private readonly nullPlugin: NullCountryPlugin) {
    // Register the null plugin as the default fallback.
    // Real country plugins will be registered here as they are implemented.
    this.plugins.set('null', this.nullPlugin);
  }

  /**
   * Resolves a CountryPlugin for the given country code.
   *
   * Observability over silence (ADR-0002 friction #6): when no dedicated
   * plugin is registered for `countryCode`, resolution falls back to the
   * neutral {@link NullCountryPlugin} (Ireland/EUR defaults) and emits a
   * WARNING — never a silent return. A DK org with no DK plugin would
   * otherwise book against IE-ish defaults with no signal.
   *
   * Warn, not throw: the default deployment legitimately runs on the neutral
   * plugin (`resolve('null')` / `resolve('IE')`-style usage), so throwing would
   * break it. A warning makes the misconfiguration visible without breaking a
   * valid neutral-plugin deployment. The warning fires once per distinct
   * unknown country code to avoid per-voucher log spam.
   *
   * @param countryCode - ISO country code (e.g. "DK", "DE") or "null"
   * @returns The registered CountryPlugin, or NullCountryPlugin as the fallback
   */
  resolve(countryCode: string): CountryPlugin {
    const plugin = this.plugins.get(countryCode);
    if (plugin) {
      return plugin;
    }

    // No dedicated plugin: fall back to the neutral default, but make the
    // fallback OBSERVABLE (warn once per unknown code), not silent.
    if (!this.warnedUnknownCodes.has(countryCode)) {
      this.warnedUnknownCodes.add(countryCode);
      this.logger.warn(
        `No country plugin registered for "${countryCode}"; falling back to ` +
          `NullCountryPlugin (neutral ${this.nullPlugin.getDefaultBaseCurrency()} ` +
          `defaults). VAT codes and treatment for "${countryCode}" will NOT be ` +
          `country-specific. Register a dedicated plugin for this deployment.`,
      );
    }

    return this.nullPlugin;
  }
}
