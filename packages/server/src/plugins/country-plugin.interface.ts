import type { CountryPluginRetrieval } from './country-plugin-retrieval.interface';
import type {
  StatutoryReportInput,
  StatutoryReportResult,
  StatutoryFormat,
} from './statutory-report.types';
import type {
  AssetClass,
  DepreciationMethod,
  FixedAssetDefaults,
} from './fixed-asset.types';

export type {
  VatComputation,
  ExpenseTreatmentPreview,
  KmdBaseClassification,
  CountryPluginRetrieval,
} from './country-plugin-retrieval.interface';

export type {
  StatutoryReportInput,
  StatutoryReportResult,
  StatutoryFormat,
} from './statutory-report.types';

export type {
  AssetClass,
  DepreciationMethod,
  FixedAssetDefaults,
} from './fixed-asset.types';

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
 * CategoryDef - A user-facing expense category and its country-neutral account
 * binding. The category → account binding is context-free (it is the
 * chart-of-accounts binding); the VAT code is resolved separately by
 * resolveCategoryMapping, which depends on supplier + org context.
 */
export interface CategoryDef {
  /** Stable category key, stored as the `category` value (e.g. "software"). */
  key: string;
  /** Human-facing label for UI (e.g. "Software"). */
  label: string;
  /** Kernel account code this category books to (e.g. "EXPENSE_SOFTWARE"). */
  accountCode: string;
}

/**
 * CrossBorderTreatment - The resolved VAT treatment for a cross-border transaction.
 *
 * Per ADR-0002, each country plugin encodes its own jurisdiction's view of cross-border
 * VAT treatment from the supplier's VAT territory.
 */
export type CrossBorderTreatment =
  | 'domestic'
  | 'reverse_charge'
  | 'import'
  | 'foreign_cost'
  | 'unresolvable';

/**
 * CrossBorderResolution - The result of resolveCrossBorderTreatment.
 * Provides the treatment classification and the applicable VAT code (if any).
 */
export interface CrossBorderResolution {
  treatment: CrossBorderTreatment;
  vatCode: VATCode | null;
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
 * - Resolve cross-border VAT treatment from the supplier's VAT territory
 *   (domestic / reverse-charge / import / non-reclaimable foreign cost),
 *   keyed on supplierFacts.country — NOT on any foreign VAT code. The
 *   territory-membership map lives in the plugin (ADR-0002). A foreign
 *   document_vat_marking is never silently reclaimed; unresolvable → Approval.
 *   (Concrete method deferred — see Wave-5 Task 34; supplierFacts.country is
 *   already the input channel.)
 */
export interface CountryPlugin extends CountryPluginRetrieval {
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
   * Returns the set of valid EXPENSE categories for this country, each with its
   * country-neutral account binding. Used for validation, the AI prompt/tool,
   * and UI display. Mirrors getVATCodes(). Does NOT include 'revenue'
   * (a sales/posting concept resolved by resolveCategoryMapping's own branch).
   */
  getCategories(): CategoryDef[];

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
   * Returns the reference exchange rate for converting between two currencies
   * as of a given date.
   *
   * Rate semantics: how many `toCurrency` units does 1 `fromCurrency` unit buy.
   * E.g., USD→EUR rate of 0.85 means 1 USD = 0.85 EUR.
   *
   * The rate must be a positive number.
   * When the two currencies are the same, the rate is exactly 1.0.
   *
   * In v1 (before real FX integration), the null plugin only supports
   * same-currency conversions (EUR→EUR = 1.0). Cross-currency throws.
   *
   * @param fromCurrency - The source currency code (e.g. "USD")
   * @param toCurrency - The target currency code (e.g. "EUR")
   * @param date - The date for which to fetch the rate (YYYY-MM-DD).
   *   Determines which historical rate to use.
   * @returns The exchange rate as a positive number
   * @throws Error if the rate is not available for the given pair or date
   */
  getReferenceRate(
    fromCurrency: string,
    toCurrency: string,
    date: string,
  ): number;

  /**
   * Rounds a fractional base-currency amount to integer minor units (cents).
   *
   * Rounding a converted base amount to the base currency's minor units is a
   * JURISDICTION rule, not a kernel constant: some VAT regimes mandate a
   * specific rounding (e.g. round-half-up, round-half-even, or truncation) for
   * the prescribed VAT-base conversion (EU VAT Directive Art. 91). The kernel
   * therefore never hardcodes a rounding rule — it asks the active plugin
   * (ADR-0002: rounding is explicitly a country-plugin concern).
   *
   * The neutral default (NullCountryPlugin) returns `Math.round(amount)` —
   * round-half-away-from-zero — which is behavior-preserving for the IE/EUR
   * deployment. A real country plugin overrides this with its own rule.
   *
   * @param amount - The fractional base-currency amount (e.g. 98.76 cents).
   * @returns The amount rounded to integer minor units (cents).
   */
  roundToBaseMinorUnits(amount: number): number;

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

  /**
   * Resolves the account code for a personal (non-business) disposition
   * based on the organization's legal form.
   *
   * Per ADR-0017:
   * - sole_proprietor → OWNERS_DRAWINGS (equity contra)
   * - company → SHAREHOLDER_LOAN (receivable-from-owner, asset)
   *
   * The kernel must NEVER hardcode the disposition account; it asks the
   * plugin so that country-specific variations can be introduced later.
   *
   * @param orgType - The organization's legal form ('company' | 'sole_proprietor')
   * @returns The account code for the personal disposition
   */
  resolvePersonalDispositionAccount(orgType: string): string;

  /**
   * Resolves the cross-border VAT treatment for a transaction with a supplier
   * from a different VAT territory.
   *
   * The country plugin maps the supplier's country to a VAT territory and
   * decides the treatment from:
   * - Our VAT territory + the supplier's VAT territory
   * - Whether the supplier provides goods or services
   * - Whether VAT was charged on the document
   *
   * A foreign document_vat_marking is never silently reclaimed as input VAT.
   * When the treatment cannot be resolved, it returns 'unresolvable' and
   * the transaction is held for Approval (conservative default: book gross).
   *
   * @param supplierFacts - Intrinsic facts about the supplier
   * @param orgContext - The Organization's context
   * @param context - Additional context (whether VAT was charged on the document)
   * @returns The resolved cross-border treatment + applicable VAT code
   */
  resolveCrossBorderTreatment(
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
    context: { vatCharged: boolean },
  ): CrossBorderResolution;

  /**
   * Returns the dividend withholding tax rate for the Organization's country.
   *
   * The rate is a fraction (0.0 – 1.0) applied to the gross dividend amount.
   * E.g. 0.27 for Denmark's 27% udbytteskat, 0.0 for Ireland (no DWT on
   * resident distributions).
   *
   * When the rate is > 0, the declaration voucher splits the payable:
   *   Dr RETAINED_EARNINGS            (gross)
   *   Cr DIVIDEND_PAYABLE             (net to owner)
   *   Cr DIVIDEND_WITHHOLDING_TAX_PAYABLE  (withheld portion)
   *
   * @param orgContext - The Organization's context
   * @returns Withholding rate as a fraction (0.0 = none)
   */
  dividendWithholdingRate(orgContext: OrgContext): number;

  /**
   * Checks whether a dividend of the given gross amount can be distributed
   * from the available retained earnings.
   *
   * Per ADR-0023: dividends are constrained by distributable profits — they
   * may not exceed retained earnings (a legal cap). The country plugin decides
   * whether this is a hard block (throws / returns false) or a soft warning.
   *
   * @param grossAmount - The proposed gross dividend in base-currency cents
   * @param retainedEarnings - Current retained-earnings balance in base-currency cents
   * @param orgContext - The Organization's context
   * @returns true if the distribution is permitted; false if it must be blocked
   */
  assertDistributable(
    grossAmount: number,
    retainedEarnings: number,
    orgContext: OrgContext,
  ): boolean;

  /**
   * Company-level tax due ON TOP of a dividend distribution, distinct from
   * `dividendWithholdingRate` (which is withheld FROM the shareholder).
   * Estonia taxes distributed profit at the company: CIT = 22/78 of the net
   * distribution, paid additionally; the shareholder receives the full amount.
   * Returns the tax account + amount (minor units), or null when the
   * jurisdiction has no such tax (IE/Null → null).
   *
   * @param netToOwner - the net amount the owner receives (base-currency minor units)
   */
  resolveDistributionTax(
    netToOwner: number,
    orgContext: OrgContext,
  ): { accountCode: string; amount: number } | null;

  /**
   * Render the jurisdiction's statutory VAT filing artifact(s) from a
   * neutral, pre-assembled input. The plugin owns ALL jurisdiction rules
   * (reportable-rate filter, B2C exclusion, thresholds, rate→box mapping,
   * declarant-id format) and stays pure — no DB access. Unsupported
   * jurisdictions return empty artifacts.
   */
  generateStatutoryReports(
    input: StatutoryReportInput,
    opts: { formats: StatutoryFormat[] },
  ): StatutoryReportResult;

  /**
   * The depreciation method this jurisdiction uses. Estonia: straight-line
   * (RTJ 5 prescribes no fixed-rate table). The kernel asks the plugin; it
   * never hardcodes the method (ADR-0002/0035).
   */
  getDepreciationMethod(): DepreciationMethod;

  /**
   * Per-class default useful life (years) and default residual value
   * (base-currency minor units) for a fixed-asset class. Estonia: lives
   * vehicle 5 / it_equipment 3 / machinery 5 / furniture 7; residual 0 for
   * every class except vehicle (a conventional non-zero default). Both are
   * overridable per asset at intake (ADR-0035).
   */
  getFixedAssetDefaults(assetClass: AssetClass): FixedAssetDefaults;
}
