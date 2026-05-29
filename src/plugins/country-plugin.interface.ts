/**
 * VATCode - A country-specific classification of a line's VAT treatment.
 * Owned and defined by a country plugin (e.g. "DK_INPUT_25").
 * The set and naming vary per country — there is NO canonical kernel VAT vocabulary.
 */
export type VATCode = string;

/**
 * SupplierFacts - Intrinsic, context-free facts about a Supplier.
 * Used by the country plugin to resolve VAT treatment and account mapping.
 */
export interface SupplierFacts {
  /** ISO country code of the supplier (e.g. "IE", "DK", "GB"). */
  country: string;
  /** Whether the supplier provides goods or services. */
  goodsVsServices: 'goods' | 'services' | 'unknown';
  /** Historical categories this supplier's purchases have been mapped to. */
  classificationMemory: string[];
}

/**
 * OrgContext - The Organization's context for category mapping.
 */
export interface OrgContext {
  /** ISO country code of the Organization (e.g. "IE"). */
  country: string;
  /** Whether the Organization is VAT-registered. */
  vatRegistered: boolean;
  /** Base currency override, or null to inherit from the country plugin. */
  baseCurrency: string | null;
}

/**
 * CategoryMappingResult - The resolved account + VAT code for a given category.
 * Produced by a country plugin's resolveCategoryMapping().
 */
export interface CategoryMappingResult {
  accountCode: string;
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
   * - Supplier facts (country, goods-vs-services, classification memory)
   * - Organization context (registration status, base currency)
   *
   * @param category - User-facing category label
   * @param supplierFacts - Supplier intrinsic facts + classification memory
   * @param orgContext - Organization context (country, VAT registration, base currency)
   * @returns Resolved account code + VAT code
   */
  resolveCategoryMapping(
    category: string,
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
  ): CategoryMappingResult;

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
   * Returns the default base (reporting) currency for this country.
   *
   * The country plugin is the source of the base currency; the Organization
   * may override it (see ADR-0004). When an Organization has no explicit
   * base_currency override, this value is used.
   *
   * e.g. an Irish plugin returns "EUR", a Danish plugin "DKK".
   */
  getDefaultBaseCurrency(): string;

  /**
   * Validates whether a VAT code is applicable in a given context.
   *
   * @param vatCode - The VAT code to validate
   * @param context - Additional context (supplier, organization, line details)
   * @returns true if the VAT code is valid for this context
   */
  validateVATCode(
    vatCode: string,
    context: { supplier: SupplierFacts; org: OrgContext },
  ): boolean;
}
