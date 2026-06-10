import { Injectable } from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { Organization } from './types';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CountryPlugin, OrgContext } from '../plugins/country-plugin.interface';

/**
 * The resolved organization context: the Organization record, its active
 * country plugin, and the {@link OrgContext} the country plugin consumes.
 */
export interface ResolvedOrgContext {
  organization: Organization;
  plugin: CountryPlugin;
  orgContext: OrgContext;
}

/**
 * OrgContextResolver — the single owner of the resolve-plugin + build-OrgContext
 * ceremony.
 *
 * Six services used to hand-build the same three steps before talking to the
 * country plugin (the SOLE resolver, ADR-0002):
 *   1. `org = await organizationService.getOrganization()`,
 *   2. `plugin = pluginLoader.resolve(org.country)`,
 *   3. `orgContext = { country, vatRegistered, baseCurrency }`.
 *
 * Concentrating that ceremony here removes the duplication and gives the plugin
 * boundary one canonical entry point. The resolver depends on
 * {@link OrganizationService} and {@link PluginLoader} only — neither depends on
 * it, so there is no cycle. The built {@link OrgContext} is byte-identical to
 * the inline form each caller produced (`vatRegistered` is already a boolean
 * from {@link OrganizationService}; `baseCurrency` is the raw, nullable
 * `org.base_currency` override per ADR-0004).
 */
@Injectable()
export class OrgContextResolver {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly pluginLoader: PluginLoader,
  ) {}

  /**
   * Resolve the Organization, its active country plugin, and the OrgContext the
   * plugin consumes — in one call.
   */
  async resolve(): Promise<ResolvedOrgContext> {
    const organization = await this.organizationService.getOrganization();
    const plugin = this.pluginLoader.resolve(organization.country);
    const orgContext: OrgContext = {
      country: organization.country,
      vatRegistered: !!organization.vat_registered,
      baseCurrency: organization.base_currency,
    };

    return { organization, plugin, orgContext };
  }
}
