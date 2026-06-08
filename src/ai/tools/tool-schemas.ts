import { z } from 'zod';

/**
 * Zod schemas for all Mastra tool inputs and outputs.
 * These define the contract between the AI agent and the kernel services.
 */

// ── searchSuppliers ──────────────────────────────────────────────────────────

export const searchSuppliersInputSchema = z.object({
  query: z.string().describe('Search query to match against supplier names or registration keys'),
});

export const searchSuppliersOutputSchema = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    country: z.string(),
    role: z.string(),
    goods_vs_services: z.string().nullable(),
  }),
);

export type SearchSuppliersInput = z.infer<typeof searchSuppliersInputSchema>;
export type SearchSuppliersOutput = z.infer<typeof searchSuppliersOutputSchema>;

// ── listCategories ───────────────────────────────────────────────────────────

export const listCategoriesInputSchema = z.object({}).optional();

export const listCategoriesOutputSchema = z.array(z.string());

export type ListCategoriesOutput = z.infer<typeof listCategoriesOutputSchema>;

// ── getClassificationMemory ──────────────────────────────────────────────────

export const getClassificationMemoryInputSchema = z.object({
  supplierId: z.number().describe('The supplier entity ID'),
});

export const getClassificationMemoryOutputSchema = z.object({
  supplierId: z.number(),
  categories: z.array(z.string()),
  categoryCounts: z.record(z.string(), z.number()),
});

export type GetClassificationMemoryInput = z.infer<typeof getClassificationMemoryInputSchema>;
export type GetClassificationMemoryOutput = z.infer<typeof getClassificationMemoryOutputSchema>;

// ── previewCategoryMapping ───────────────────────────────────────────────────

export const previewCategoryMappingInputSchema = z.object({
  category: z.string().describe('The user-facing category label'),
  supplierContext: z
    .object({
      country: z.string().optional(),
      goodsVsServices: z.enum(['goods', 'services', 'unknown']).optional(),
    })
    .optional()
    .describe('Supplier context for resolution'),
});

export const previewCategoryMappingOutputSchema = z.object({
  accountCode: z.string(),
  vatCode: z.string(),
});

export type PreviewCategoryMappingInput = z.infer<typeof previewCategoryMappingInputSchema>;
export type PreviewCategoryMappingOutput = z.infer<typeof previewCategoryMappingOutputSchema>;
