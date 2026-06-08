import { EntitiesService } from '../../entities/entities.service';
import { ExpensesService } from '../../expenses/expenses.service';
import { PluginLoader } from '../../plugins/plugin-loader.service';
import { OrganizationService } from '../../organization/organization.service';
import { SupplierFacts, OrgContext } from '../../plugins/country-plugin.interface';
import {
  searchSuppliersInputSchema,
  searchSuppliersOutputSchema,
  listCategoriesOutputSchema,
  getClassificationMemoryInputSchema,
  getClassificationMemoryOutputSchema,
  previewCategoryMappingInputSchema,
  previewCategoryMappingOutputSchema,
} from './tool-schemas';

/**
 * Canonical categories exposed to the AI agent.
 * These are the user-facing labels that map to Accounts + VAT codes via the country plugin.
 */
const CANONICAL_CATEGORIES = [
  'software',
  'transport',
  'rent',
  'meals',
  'office',
  'utilities',
  'marketing',
  'professional_services',
  'other',
];

/**
 * Create the searchSuppliers tool.
 * Wraps EntitiesService.resolveByIdentifier / list to let the agent look up suppliers.
 */
export function createSearchSuppliersTool(entitiesService: EntitiesService) {
  return {
    id: 'searchSuppliers',
    description:
      'Search for existing suppliers by name or registration key. Returns matching entities with their IDs, names, and countries.',
    inputSchema: searchSuppliersInputSchema,
    outputSchema: searchSuppliersOutputSchema,
    execute: async ({
      query,
    }: {
      query: string;
    }): Promise<
      Array<{
        id: number;
        name: string;
        country: string;
        role: string;
        goods_vs_services: string | null;
      }>
    > => {
      const allSuppliers = await entitiesService.list();
      const suppliers = allSuppliers.filter((e) => e.role === 'supplier');
      const lowerQuery = query.toLowerCase();

      return suppliers
        .filter(
          (s) =>
            s.name.toLowerCase().includes(lowerQuery) ||
            s.country.toLowerCase().includes(lowerQuery),
        )
        .map((s) => ({
          id: s.id,
          name: s.name,
          country: s.country,
          role: s.role,
          goods_vs_services: s.goods_vs_services,
        }));
    },
  };
}

/**
 * Create the listCategories tool.
 * Returns the canonical set of user-facing expense categories.
 */
export function createListCategoriesTool() {
  return {
    id: 'listCategories',
    description:
      'List all available expense categories. These are user-facing labels that map to accounting accounts and VAT codes.',
    inputSchema: listCategoriesOutputSchema,
    outputSchema: listCategoriesOutputSchema,
    execute: async (): Promise<string[]> => {
      return CANONICAL_CATEGORIES;
    },
  };
}

/**
 * Create the getClassificationMemory tool.
 * Queries expense history for a given supplier to show what categories have been used before.
 */
export function createGetClassificationMemoryTool(
  expensesService: ExpensesService,
) {
  return {
    id: 'getClassificationMemory',
    description:
      'Get historical category usage for a specific supplier. Shows what categories this supplier\'s expenses have been classified as in the past.',
    inputSchema: getClassificationMemoryInputSchema,
    outputSchema: getClassificationMemoryOutputSchema,
    execute: async ({
      supplierId,
    }: {
      supplierId: number;
    }): Promise<{
      supplierId: number;
      categories: string[];
      categoryCounts: Record<string, number>;
    }> => {
      const expenses = await expensesService.getExpenses();
      const supplierExpenses = expenses.filter(
        (e) => e.supplier_id === supplierId,
      );

      const categoryCounts: Record<string, number> = {};
      for (const exp of supplierExpenses) {
        categoryCounts[exp.category] = (categoryCounts[exp.category] || 0) + 1;
      }

      return {
        supplierId,
        categories: Object.keys(categoryCounts),
        categoryCounts,
      };
    },
  };
}

/**
 * Create the previewCategoryMapping tool.
 * Wraps the country plugin's resolveCategoryMapping to show what Account + VAT code
 * would be used for a given category and supplier context.
 */
export function createPreviewCategoryMappingTool(
  pluginLoader: PluginLoader,
  organizationService: OrganizationService,
) {
  return {
    id: 'previewCategoryMapping',
    description:
      'Preview what accounting account and VAT code would be used for a given category and supplier context. This shows the kernel-side mapping without posting anything.',
    inputSchema: previewCategoryMappingInputSchema,
    outputSchema: previewCategoryMappingOutputSchema,
    execute: async ({
      category,
      supplierContext,
    }: {
      category: string;
      supplierContext?: {
        country?: string;
        goodsVsServices?: 'goods' | 'services' | 'unknown';
      };
    }): Promise<{ accountCode: string; vatCode: string }> => {
      const org = await organizationService.getOrganization();

      const supplierFacts: SupplierFacts = {
        country: supplierContext?.country ?? org.country,
        goodsVsServices: supplierContext?.goodsVsServices ?? 'unknown',
        classificationMemory: [],
      };

      const orgContext: OrgContext = {
        country: org.country,
        vatRegistered: org.vat_registered,
        baseCurrency: org.base_currency,
      };

      const plugin = pluginLoader.resolve(org.country);
      const mapping = plugin.resolveCategoryMapping(
        category,
        supplierFacts,
        orgContext,
      );

      return {
        accountCode: mapping.accountCode,
        vatCode: mapping.vatCode,
      };
    },
  };
}
