import { z } from 'zod';

/**
 * Zod schemas for all Mastra tool inputs and outputs.
 * These define the contract between the AI agent and the kernel services.
 */

// ── searchSuppliers ──────────────────────────────────────────────────────────

export const searchSuppliersInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Search query to match against supplier names or registration keys',
    ),
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

export type GetClassificationMemoryInput = z.infer<
  typeof getClassificationMemoryInputSchema
>;
export type GetClassificationMemoryOutput = z.infer<
  typeof getClassificationMemoryOutputSchema
>;

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

export type PreviewCategoryMappingInput = z.infer<
  typeof previewCategoryMappingInputSchema
>;
export type PreviewCategoryMappingOutput = z.infer<
  typeof previewCategoryMappingOutputSchema
>;

// ── getClassificationContext (composed deep read) ────────────────────────────
//
// One deep read for the Pass 2 agent. From document evidence it resolves/proposes
// the Supplier, gathers that Supplier's Classification memory (ADR-0014/0024), and
// previews the Category → Account + VAT code mapping WITH that memory flowing
// through to the country plugin (the sole resolver, ADR-0002). The agent calls
// this once instead of orchestrating searchSuppliers → getClassificationMemory →
// previewCategoryMapping itself. Classification memory stays advisory (a prior
// fed to the model), never a deterministic gate.

export const getClassificationContextInputSchema = z.object({
  category: z.string().describe('The user-facing category label to preview'),
  evidence: z
    .object({
      registrationKey: z
        .string()
        .optional()
        .describe(
          'Supplier strong registration key (e.g. VAT number / DK CVR) read from the document. The anchor for supplier identity (ADR-0014) — never the name.',
        ),
      name: z
        .string()
        .optional()
        .describe('Supplier name as printed on the document (OCR variant).'),
      country: z
        .string()
        .optional()
        .describe('Supplier ISO country code read from the document.'),
      goodsVsServices: z
        .enum(['goods', 'services', 'unknown'])
        .optional()
        .describe('Whether the supplier provides goods or services.'),
    })
    .describe(
      'Document evidence about the supplier extracted from the markdown',
    ),
});

export const getClassificationContextOutputSchema = z.object({
  supplier: z.object({
    resolution: z
      .enum(['matched', 'proposed'])
      .describe(
        "'matched' when an existing Supplier was resolved on its registration key; 'proposed' when no match — a new Supplier should be created from the evidence.",
      ),
    matchEntityId: z
      .number()
      .optional()
      .describe('The resolved existing Supplier entity id (when matched).'),
    name: z.string().nullable(),
    country: z.string(),
    goodsVsServices: z.enum(['goods', 'services', 'unknown']),
  }),
  classificationMemory: z
    .array(z.string())
    .describe(
      "Advisory prior (ADR-0024): the Categories this Supplier's purchases have historically been classified as. Empty when matched-but-no-history or proposed (new) Supplier.",
    ),
  mapping: z
    .object({
      accountCode: z.string(),
      vatCode: z.string(),
    })
    .describe(
      'The country-plugin-resolved Account + VAT code for (category, supplier facts incl. classification memory, org context). The plugin is the sole resolver (ADR-0002).',
    ),
});

export type GetClassificationContextInput = z.infer<
  typeof getClassificationContextInputSchema
>;
export type GetClassificationContextOutput = z.infer<
  typeof getClassificationContextOutputSchema
>;
