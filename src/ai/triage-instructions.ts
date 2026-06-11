import type { CategoryDef } from '../plugins/country-plugin.interface';

/**
 * Append the active plugin's valid category keys to the base triage prompt, so
 * the model selects `category` from a CLOSED set at generation time rather than
 * inventing a label the kernel can't map (which would otherwise silently book to
 * EXPENSE_OTHER). Returns the base prompt unchanged when there are no categories.
 */
export function withCategoryList(
  baseInstructions: string,
  categories: CategoryDef[],
): string {
  if (categories.length === 0) return baseInstructions;
  const list = categories.map((c) => `"${c.key}"`).join(', ');
  return (
    baseInstructions +
    `\n\nThe \`category\` field MUST be EXACTLY ONE of these valid categories: ` +
    `${list}. Choose the closest match. NEVER invent a category outside this list.`
  );
}
