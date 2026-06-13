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

/**
 * Org identity context passed into the Pass-2 agent when the intake pipeline
 * has already determined the document's direction (incoming vs outgoing) by
 * matching the organization's IBAN against the document.
 */
export interface OrgIdentityContext {
  name: string | null;
  vatNumber: string | null;
  iban: string | null;
  directionHint: 'incoming' | 'outgoing';
}

/**
 * Append the organization's identity (name, VAT, IBAN) and a pre-decided
 * direction hint to the agent instructions. The direction was determined
 * deterministically by matching the org IBAN against the document, so the LLM
 * should trust it rather than re-derive it.
 *
 * When direction is "outgoing": the agent should use kind="new_sales_invoice",
 * extract the CUSTOMER (buyer) into `customer_proposal`, and fill
 * `outgoing_signals` truthfully.
 *
 * When direction is "incoming": the agent behaves as before (kind="new_expense"
 * with a `supplier_proposal`).
 */
export function withOrgIdentity(
  instructions: string,
  org: OrgIdentityContext,
): string {
  return (
    instructions +
    `\n\nYOUR ORGANIZATION: name="${org.name ?? 'unknown'}", VAT="${org.vatNumber ?? 'unknown'}", IBAN="${org.iban ?? 'unknown'}".` +
    `\nThis document has been pre-classified as direction="${org.directionHint}" (decided by matching your IBAN against the document — trust it).` +
    `\nReport \`document_type\` accurately (invoice | receipt | bank_statement | credit_note | other).` +
    `\nWhen direction is "outgoing", set kind="new_sales_invoice", extract the CUSTOMER (buyer) into \`customer_proposal\` and the document's OWN invoice number (the schema field is named \`supplier_invoice_number\` for legacy reasons — for an outgoing invoice this is YOUR invoice number) into \`supplier_invoice_number\`, and set the \`outgoing_signals\` booleans truthfully (does YOUR org name / VAT appear as the issuer/seller? is there a distinct buyer block? does the document call itself an invoice?).` +
    `\nWhen direction is "incoming", behave as before: kind="new_expense" with a \`supplier_proposal\`.`
  );
}
