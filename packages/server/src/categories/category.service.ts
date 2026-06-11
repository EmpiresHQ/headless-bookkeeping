import { BadRequestException, Injectable } from '@nestjs/common';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CategoryDef } from '../plugins/country-plugin.interface';
import { OrganizationService } from '../organization/organization.service';

/**
 * CategoryService — the single read/validation surface over the active country
 * plugin's expense-category set (ADR-0002/0022: categories are plugin rules,
 * not DB rows). Backs GET /api/categories, the AI listCategories tool, the
 * triage-prompt injection, and write-path validation. getCategories() is
 * context-free, so this only needs the org's country to pick the active plugin.
 */
@Injectable()
export class CategoryService {
  constructor(
    private readonly pluginLoader: PluginLoader,
    private readonly organizationService: OrganizationService,
  ) {}

  async list(): Promise<CategoryDef[]> {
    const org = await this.organizationService.getOrganization();
    return this.pluginLoader.resolve(org.country).getCategories();
  }

  async isValid(category: string): Promise<boolean> {
    return (await this.list()).some((c) => c.key === category);
  }

  async assertValid(category: string): Promise<void> {
    const cats = await this.list();
    if (!cats.some((c) => c.key === category)) {
      const valid = cats.map((c) => c.key).join(', ');
      throw new BadRequestException(
        `Unknown category '${category}'. Valid categories: ${valid}`,
      );
    }
  }
}
