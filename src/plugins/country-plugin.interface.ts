/**
 * VATCode - A country-specific classification of a line's VAT treatment.
 * Owned and defined by a country plugin (e.g. "DK_INPUT_25").
 * The set and naming vary per country — there is NO canonical kernel VAT vocabulary.
 */
export type VATCode = string;

/**
 * CategoryMappingResult - The resolved account + VAT code for a given category.
 * Produced by a country plugin's resolveCategoryMapping().
 */
export interface CategoryMappingResult {
  account: string;
  vatCode: VATCode;
}

/**
 * CountryPlugin - The sole resolver of country-specific accounting rules.
 *
 * Per ADR-0002: "The country plugin is the sole resolver of a VAT code."
 * Each deployment has exactly one active country plugin determined by the Organization's country.
 *
 * Responsibilities:
 * - Resolve VAT codes from (category + supplier context + organization context)
 * - Provide the set of valid VAT codes for the country
 * - Map user-facing Categories to kernel Accounts + VAT codes
 * - Define period frequency options and defaults
 * - Validate VAT code applicability
 */
export interface CountryPlugin {
  /**
   * Returns the country code identifier for this plugin (e.g. "DK", "DE", "null").
   */
  getName(): string;

  /**
   * Returns the set of valid VAT codes for this country.
   * Used for validation and UI dropdowns.
   */
  getVATCodes(): VATCode[];

  /**
   * Resolves a user-facing Category to a kernel Account + VAT code.
   *
   * The mapping may depend on:
   * - The category string (e.g. "software", "transport")
   * - Supplier context (country, goods-vs-services, classification memory)
   * - Organization context (registration status, base currency)
   *
   * @param category - User-facing category label
   * @param supplierContext - Supplier intrinsic facts + classification memory
   * @returns Resolved account + VAT code
   */
  resolveCategoryMapping(category: string, supplierContext: unknown): CategoryMappingResult;

  /**
   * Returns the available reporting period frequency options for this country.
   * e.g. ["monthly", "quarterly", "half-yearly", "yearly"]
   */
  getPeriodFrequencyOptions(): string[];

  /**
   * Returns the default reporting period frequency for this country.
   * e.g. "quarterly"
   */
  getDefaultPeriodFrequency(): string;

  /**
   * Validates whether a VAT code is applicable in a given context.
   *
   * @param vatCode - The VAT code to validate
   * @param context - Additional context (supplier, organization, line details)
   * @returns true if the VAT code is valid for this context
   */
  validateVATCode(vatCode: string, context: unknown): boolean;
}
