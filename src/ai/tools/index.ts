import { EntitiesService } from '../../entities/entities.service';
import { ExpensesService } from '../../expenses/expenses.service';
import { PluginLoader } from '../../plugins/plugin-loader.service';
import { OrganizationService } from '../../organization/organization.service';
import {
  SupplierFacts,
  OrgContext,
} from '../../plugins/country-plugin.interface';
import {
  searchSuppliersInputSchema,
  searchSuppliersOutputSchema,
  listCategoriesOutputSchema,
  getClassificationMemoryInputSchema,
  getClassificationMemoryOutputSchema,
  previewCategoryMappingInputSchema,
  previewCategoryMappingOutputSchema,
  getClassificationContextInputSchema,
  getClassificationContextOutputSchema,
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
    execute: (): Promise<string[]> => {
      return Promise.resolve(CANONICAL_CATEGORIES);
    },
  };
}

/**
 * Gather a Supplier's Classification memory (ADR-0014/0024): the Categories its
 * purchases have historically been classified as, plus per-category counts. This
 * is the deterministic *retrieval* — what to put in context — while the decision
 * (and the weighting of recent vs old) stays the model's. Advisory only.
 *
 * Shared by the granular `getClassificationMemory` tool and the composed
 * `getClassificationContext` deep read so the memory is gathered once, in one
 * place, with no orchestration policy leaking into the agent prompt.
 */
async function gatherClassificationMemory(
  expensesService: ExpensesService,
  supplierId: number,
): Promise<{ categories: string[]; categoryCounts: Record<string, number> }> {
  const expenses = await expensesService.getExpenses();
  const supplierExpenses = expenses.filter((e) => e.supplier_id === supplierId);

  const categoryCounts: Record<string, number> = {};
  for (const exp of supplierExpenses) {
    categoryCounts[exp.category] = (categoryCounts[exp.category] || 0) + 1;
  }

  return { categories: Object.keys(categoryCounts), categoryCounts };
}

/**
 * Resolve the Category → Account + VAT code mapping through the country plugin,
 * which stays the SOLE resolver (ADR-0002). The `classificationMemory` flows into
 * `SupplierFacts.classificationMemory` as an advisory prior (ADR-0024) — this
 * helper composes the read; it embeds no mapping rules and invents no codes.
 *
 * Shared by the granular `previewCategoryMapping` tool and the composed
 * `getClassificationContext` deep read.
 */
async function resolveMapping(
  pluginLoader: PluginLoader,
  organizationService: OrganizationService,
  category: string,
  supplierContext: {
    country?: string;
    goodsVsServices?: 'goods' | 'services' | 'unknown';
    classificationMemory?: string[];
  },
): Promise<{ accountCode: string; vatCode: string }> {
  const org = await organizationService.getOrganization();

  const supplierFacts: SupplierFacts = {
    country: supplierContext.country ?? org.country,
    goodsVsServices: supplierContext.goodsVsServices ?? 'unknown',
    classificationMemory: supplierContext.classificationMemory ?? [],
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

  return { accountCode: mapping.accountCode, vatCode: mapping.vatCode };
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
      "Get historical category usage for a specific supplier. Shows what categories this supplier's expenses have been classified as in the past.",
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
      const { categories, categoryCounts } = await gatherClassificationMemory(
        expensesService,
        supplierId,
      );

      return { supplierId, categories, categoryCounts };
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
      return resolveMapping(
        pluginLoader,
        organizationService,
        category,
        supplierContext ?? {},
      );
    },
  };
}

/**
 * Create the getClassificationContext tool — ONE deep read for the Pass 2 agent.
 *
 * From document evidence it composes three reads that previously leaked into the
 * agent's prompt as orchestration policy (searchSuppliers → getClassificationMemory
 * → previewCategoryMapping):
 *   1. Resolve/propose the Supplier — matched on its strong registration key
 *      (ADR-0014), else proposed (a new Supplier should be created from evidence).
 *   2. Gather that Supplier's Classification memory (advisory prior, ADR-0024).
 *   3. Preview the Category → Account + VAT code mapping WITH that memory actually
 *      flowing into SupplierFacts.classificationMemory — fixing the prior
 *      hardcoded `classificationMemory: []` defect, so the memory finally reaches
 *      the mapping preview.
 *
 * The agent calls this once. The country plugin stays the SOLE resolver of the
 * Account + VAT code (ADR-0002) — this tool composes reads, it embeds no mapping
 * rules and invents no codes. The agent remains read-only (no write tool): this
 * is a read composition. Classification memory is advisory, never a gate.
 */
export function createGetClassificationContextTool(
  entitiesService: EntitiesService,
  expensesService: ExpensesService,
  pluginLoader: PluginLoader,
  organizationService: OrganizationService,
) {
  return {
    id: 'getClassificationContext',
    description:
      'Deep read for triage: from document evidence (supplier registration key, name, country, goods-vs-services) and a candidate category, resolve or propose the supplier, gather its classification memory, and preview the resulting account + VAT code mapping (with the memory fed in as an advisory prior). Call this ONCE instead of chaining searchSuppliers, getClassificationMemory, and previewCategoryMapping.',
    inputSchema: getClassificationContextInputSchema,
    outputSchema: getClassificationContextOutputSchema,
    execute: async ({
      category,
      evidence,
    }: {
      category: string;
      evidence: {
        registrationKey?: string;
        name?: string;
        country?: string;
        goodsVsServices?: 'goods' | 'services' | 'unknown';
      };
    }): Promise<{
      supplier: {
        resolution: 'matched' | 'proposed';
        matchEntityId?: number;
        name: string | null;
        country: string;
        goodsVsServices: 'goods' | 'services' | 'unknown';
      };
      classificationMemory: string[];
      mapping: { accountCode: string; vatCode: string };
    }> => {
      const org = await organizationService.getOrganization();

      // 1. Resolve the Supplier on its strong registration key (ADR-0014 — never
      //    on name). No key, or no match → propose a new Supplier from evidence.
      const matched = evidence.registrationKey
        ? await entitiesService.resolveByIdentifier(
            'registration_key',
            evidence.registrationKey,
          )
        : undefined;

      const resolution: 'matched' | 'proposed' = matched
        ? 'matched'
        : 'proposed';
      const supplierCountry =
        matched?.country ?? evidence.country ?? org.country;
      const goodsVsServices: 'goods' | 'services' | 'unknown' =
        (matched?.goods_vs_services as 'goods' | 'services' | null) ??
        evidence.goodsVsServices ??
        'unknown';

      // 2. Gather the resolved Supplier's Classification memory (advisory prior,
      //    ADR-0024). A proposed (new) Supplier has no history → empty.
      const { categories: classificationMemory } = matched
        ? await gatherClassificationMemory(expensesService, matched.id)
        : { categories: [] as string[] };

      // 3. Preview the mapping WITH the classification memory flowing through to
      //    the country plugin (the sole resolver, ADR-0002).
      const mapping = await resolveMapping(
        pluginLoader,
        organizationService,
        category,
        {
          country: supplierCountry,
          goodsVsServices,
          classificationMemory,
        },
      );

      return {
        supplier: {
          resolution,
          ...(matched ? { matchEntityId: matched.id } : {}),
          name: matched?.name ?? evidence.name ?? null,
          country: supplierCountry,
          goodsVsServices,
        },
        classificationMemory,
        mapping,
      };
    },
  };
}
