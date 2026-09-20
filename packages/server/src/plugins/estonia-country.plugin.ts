import { Injectable } from '@nestjs/common';
import { FxLookupPolicy, FxRateService } from '../fx/fx-rate.service';
import type {
  AdvanceTaxPointContext,
  AdvanceTaxPointDecision,
} from './advance-tax-point.types';
import { ResolvedFxRate } from '../fx/fx-rate.types';
import {
  CategoryDef,
  CategoryMappingResult,
  CountryPlugin,
  CrossBorderResolution,
  OrgContext,
  ServicePlaceRule,
  SupplierFacts,
  SupplyFacts,
  VATCode,
} from './country-plugin.interface';
import {
  AssetClass,
  DepreciationMethod,
  FixedAssetDefaults,
} from './fixed-asset.types';
import { AllowanceRates, AllowanceType } from './allowance-rates.types';
import type {
  FringeBenefitTax,
  HealthAllowanceRules,
} from './health-allowance.types';
import { UnresolvedHealthAllowanceError } from './health-allowance.errors';
import {
  ExpenseTreatmentPreview,
  KmdBaseClassification,
  KmdClassificationContext,
  VatComputation,
} from './country-plugin-retrieval.interface';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';
import { UnresolvedVatTreatmentError } from './vat-treatment.errors';
import type {
  InputVatEntitlement,
  InputVatEntitlementContext,
} from './input-vat-entitlement.types';
import { NO_ENTITLEMENT } from './input-vat-entitlement.types';
import { entitlementFromOrgContext } from './input-vat-entitlement';
import {
  StatutoryFormat,
  StatutoryReportInput,
  StatutoryReportResult,
  StatutoryWarning,
} from './statutory-report.types';
import { renderKmdXml } from './estonia-kmd/kmd-xml';
import { renderKmdCsv } from './estonia-kmd/kmd-csv';
import { buildInfPart } from './estonia-kmd/kmd-inf';
import {
  AnnualAccountsInput,
  AnnualAccountsOpts,
  AnnualAccountsResult,
} from './annual-accounts.types';
import { renderAnnualAccountsXbrl } from './estonia-annual-accounts/xbrl';
import { unmappedNonzeroCodes } from './estonia-annual-accounts/rtj-mapping';

/**
 * The single source of the EE plugin's category → account binding. Both
 * resolveCategoryMapping() and getCategories() read from this map, so the two
 * cannot diverge. Mirrors NullCountryPlugin's map; the VAT code is resolved
 * separately (EE_INPUT_24) in resolveCategoryMapping.
 */
const EE_CATEGORY_ACCOUNTS: Readonly<Record<string, string>> = {
  software: 'EXPENSE_SOFTWARE',
  transport: 'EXPENSE_TRANSPORT',
  travel: 'EXPENSE_TRAVEL',
  marketing: 'EXPENSE_MARKETING',
  salary: 'EXPENSE_SALARY',
  contractor: 'EXPENSE_CONTRACTOR',
  rent: 'EXPENSE_RENT',
  tax: 'EXPENSE_TAX',
  'bank fee': 'EXPENSE_BANK_FEE',
  meals: 'EXPENSE_MEALS',
  insurance: 'EXPENSE_INSURANCE',
  education: 'EXPENSE_EDUCATION',
  vehicle: 'FIXED_ASSETS_VEHICLES',
  it_equipment: 'FIXED_ASSETS_IT',
  machinery: 'FIXED_ASSETS_EQUIPMENT',
  furniture: 'FIXED_ASSETS_FURNITURE',
};

/** Title-cases a category key into a display label ("bank fee" → "Bank Fee"). */
function labelFor(key: string): string {
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * EstoniaCountryPlugin — the first real-jurisdiction CountryPlugin adapter.
 *
 * Implements Estonian VAT (24% standard since 2025-07-01, 13% accommodation
 * since 2025-01-01, 9% reduced, 0% zero-rated), monthly periods, EUR, and
 * the Estonian CIT-on-distribution model (22/78 of net, on top of dividend).
 *
 * Per ADR-0027: registered under country code 'EE' in PluginLoader.
 * FX rates are v1 placeholders (deterministic for tests); live ECB integration
 * is deferred (tracked debt).
 */
@Injectable()
export class EstoniaCountryPlugin implements CountryPlugin {
  constructor(private readonly fxRates: FxRateService) {}

  /**
   * VAT_RATES: numeric rates (0.0–1.0) for every EE VAT code.
   * Reverse-charge is self-accounted at the standard 24% rate.
   * NULL_STANDARD sentinel resolves to 0 (not subject to VAT reporting).
   */
  private static readonly VAT_RATES: Record<string, number> = {
    EE_OUTPUT_24: 0.24,
    EE_INPUT_24: 0.24,
    EE_OUTPUT_13: 0.13,
    EE_INPUT_13: 0.13,
    EE_OUTPUT_9: 0.09,
    EE_INPUT_9: 0.09,
    EE_ZERO: 0,
    // LEGACY reverse-charge code (pre-#210). It collapsed an intra-EU
    // acquisition and a third-country one into a single code, so a voucher
    // carrying it does not say which KMD acquisition row (6 or 7) its base
    // belongs to. Nothing produces it any more; it stays a VALID code because
    // vouchers that carry it are posted, immutable and must keep rendering —
    // and classifyKmd reports it as UNRESOLVED rather than guessing row 7.
    EE_REVERSE_CHARGE: 0.24,
    // Reverse charge on an intra-Community acquisition — goods/services from a
    // taxable person of another member state (KMS §3 lg 4, §4 lg 1 p 5).
    // KMD row 6, inside the row-1 taxable base (issue #210).
    EE_REVERSE_CHARGE_EU: 0.24,
    // Reverse charge on an acquisition from OUTSIDE the Community — the
    // general-rule service imported from a third-country business, self-
    // assessed under KMS §10 lg 5. KMD row 7, inside the row-1 taxable base.
    EE_REVERSE_CHARGE_3RD_COUNTRY: 0.24,
    // 0% intra-EU B2B supply of services taxable in the customer's member state
    // (KMS §10 / VAT Directive Art. 44 & 196). Reported as 0% käive (KMD row 3)
    // and on the VD koondaruanne with tähis 3S — the VD form is filed manually.
    EE_OUTPUT_0_EU: 0,
    // 0% general-rule service supplied to a THIRD-COUNTRY business (issue #209).
    // Place of supply is the customer's country (KMS §10 lg 1), so no Estonian
    // VAT arises. It is declared in KMD row 3 like any 0% supply, but — unlike
    // the intra-EU code above — it belongs to NEITHER row 3.1 NOR the VD
    // koondaruanne: both are reports on supplies to other MEMBER STATES.
    // A distinct code (rather than the generic EE_ZERO) keeps that difference
    // visible in the ledger and in the per-code VAT summary.
    EE_OUTPUT_0_3RD_COUNTRY: 0,
    [NULL_VAT_CODE]: 0,
  };

  /**
   * EU member states by political country code (ISO 3166-1 alpha-2).
   * Sub-territory exceptions (Canary Islands excluded, Monaco included, etc.)
   * are a future refinement — documented in ADR-0027.
   */
  private static readonly EU = new Set([
    'AT',
    'BE',
    'BG',
    'HR',
    'CY',
    'CZ',
    'DK',
    'EE',
    'FI',
    'FR',
    'DE',
    'GR',
    'HU',
    'IE',
    'IT',
    'LV',
    'LT',
    'LU',
    'MT',
    'NL',
    'PL',
    'PT',
    'RO',
    'SK',
    'SI',
    'ES',
    'SE',
  ]);

  /** Commercial registry code identifying the KMD / annual-accounts declarant. */
  private static readonly REG_RE = /^\d{8}$/;

  /**
   * The FX lookup rule Estonian VAT law prescribes (issue #203 — this replaces
   * a hardcoded placeholder map that ignored the date entirely).
   *
   * KMS § 29 lg 13: for a non-import transaction whose VAT data is in a
   * foreign currency, the rate applied is the European Central Bank euro rate
   * *in force* ("kehtiv") on the day determined under § 11 — the tax point.
   * This is Estonia's enactment of EU VAT Directive Art. 91.
   *
   * The ECB publishes around 16:00 CET on working days only, never on TARGET
   * closing days. Because the statute says "in force" rather than "published
   * that day", the last publication governs until the next one: a Saturday tax
   * point applies Friday's rate, and 1 January applies the preceding working
   * day's. Hence `on-or-before`.
   *
   * The lookback is bounded at 7 days. The longest real ECB gap is the Easter
   * or Christmas/New Year TARGET run (at most four consecutive closing days),
   * so seven days covers every legitimate gap with margin, while a silence
   * longer than that means something is wrong upstream — and a fortnight-old
   * rate is not "in force", it is stale. In that case the conversion is
   * REFUSED, never completed with the newest rate we happen to hold.
   */
  private static readonly FX_POLICY: FxLookupPolicy = {
    source: 'ECB',
    fallback: 'on-or-before',
    maxLookbackDays: 7,
  };

  // ── Identity ──────────────────────────────────────────────────────────────

  getName(): string {
    return 'EE';
  }

  // ── VAT codes ─────────────────────────────────────────────────────────────

  getVATCodes(): VATCode[] {
    return Object.keys(EstoniaCountryPlugin.VAT_RATES);
  }

  // ── Category mapping ──────────────────────────────────────────────────────

  resolveCategoryMapping(
    category: string,
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
    supplyFacts?: SupplyFacts,
  ): CategoryMappingResult {
    if (category === 'revenue') {
      return {
        accountCode: 'REVENUE',
        vatCode: this.resolveRevenueVatCode(
          supplierFacts,
          orgContext,
          supplyFacts,
        ),
      };
    }

    // Expense categories → seeded chart accounts + EE standard input VAT.
    // Mirrors NullCountryPlugin's map; VAT code swapped to EE_INPUT_24.
    const accountCode = EE_CATEGORY_ACCOUNTS[category] ?? 'EXPENSE_OTHER';
    return { accountCode, vatCode: 'EE_INPUT_24' };
  }

  /**
   * The output VAT code for a sale — the place-of-supply decision (issue #209).
   *
   * Before this, the decision read only "other EU + services", which charged
   * Estonian 24% on a service sold to a US business and zero-rated a service
   * sold to a Finnish CONSUMER purely because Finland is in the EU. Neither
   * follows from the statute: under KMS §10 the place of a GENERAL-RULE service
   * turns on whether the recipient is a taxable person acting as such, which is
   * a recorded fact about the customer, not an inference from its country.
   *
   * General-rule services (KMS §10 lg 1 / lg 2 p 9; EMTA's place-of-supply
   * table, https://www.emta.ee/en/business-client/taxes-and-payment/
   * value-added-tax/taxation-services/taxation-and-declaration-supply-services,
   * updated 2025-07-03):
   *
   *   recipient                                   rate   KMD             VD
   *   ─────────────────────────────────────────── ────── ─────────────── ────
   *   Estonia (business or consumer)               24%   rows 1 + 4       —
   *   other member state, taxable person            0%   rows 3 + 3.1    3S
   *   other member state, non-taxable person       24%   rows 1 + 4       —
   *   third country, business                       0%   row 3            —
   *   third country, consumer                      24%   rows 1 + 4       —
   *
   * The two 24% cross-border rows are the general rule doing its job: a B2C
   * service is taxed where the SUPPLIER is established, which is Estonia. They
   * are not a fallback — §10 lg 5 carves out specific services to third-country
   * consumers, and those arrive here as a declared ServicePlaceRule exception,
   * which this plugin refuses rather than silently taxes.
   *
   * GOODS are untouched: their place of supply follows movement, not this
   * table, and this issue is scoped to services.
   */
  private resolveRevenueVatCode(
    customerFacts: SupplierFacts,
    orgContext: OrgContext,
    supplyFacts?: SupplyFacts,
  ): VATCode {
    // A LIMITED registration is not an ordinary one (issue #211). A piiratud
    // maksukohustuslane is registered only to self-assess VAT on specified
    // acquisitions: it adds no Estonian VAT to its own supplies and declares no
    // taxable turnover, so none of the output codes below describes its sale.
    // Picking one anyway would put a taxable supply — and an output tax — on a
    // return that has no business carrying either. The treatment of its sales
    // is not auto-classified here.
    if (orgContext.vatRegistrationKind === 'limited') {
      throw new UnresolvedVatTreatmentError({
        code: 'limited_registration_sale_unsupported',
        message:
          `The organisation is registered as a limited taxable person ` +
          `(piiratud maksukohustuslane), which self-assesses VAT on specified ` +
          `acquisitions but charges no Estonian VAT on its own supplies. The EE ` +
          `plugin does not auto-classify a sale under that registration, so ` +
          `nothing was posted.`,
        missingFacts: ['organization.vat_registration_kind=limited on a sale'],
        howToResolve:
          'If the organisation holds an ORDINARY VAT registration, PUT ' +
          '/api/organization with {"vat_registration_kind":"ordinary"} and post ' +
          'again; otherwise book the sale explicitly with your accountant.',
      });
    }

    const customerCountry = customerFacts.country;
    const isDomestic = customerCountry === orgContext.country;

    // What this invoice supplies. The invoice's own supply type wins; absent
    // it we fall back to what the counterparty deals in, which is how every
    // pre-#209 invoice was classified.
    const supplyType =
      supplyFacts?.supplyType && supplyFacts.supplyType !== 'unknown'
        ? supplyFacts.supplyType
        : customerFacts.goodsVsServices;

    const placeRule: ServicePlaceRule =
      supplyFacts?.servicePlaceRule ?? 'general';

    // A declared place-of-supply exception is a statement about a SERVICE. On a
    // supply that is not known to be a service the declaration cannot be
    // honoured — and quietly ignoring it would drop the one fact the caller
    // took the trouble to state. Refuse the contradiction instead.
    if (placeRule !== 'general' && supplyType !== 'services') {
      throw new UnresolvedVatTreatmentError({
        code: 'service_place_rule_without_service_supply',
        message:
          `The invoice declares the service place-of-supply rule '${placeRule}' ` +
          `but its supply is '${supplyType}', so the rule cannot apply and must ` +
          `not be ignored.`,
        missingFacts: [
          `service_place_rule=${placeRule} with supply_type=${supplyType}`,
        ],
        howToResolve:
          'Set supply_type="services" on the invoice if it is a service supply, ' +
          'or service_place_rule="general" if the declared exception does not apply.',
      });
    }

    if (supplyType === 'goods') {
      // Goods: place of supply follows the movement of the goods, not §10.
      // Unchanged by this issue, which is scoped to services.
      return 'EE_OUTPUT_24';
    }

    if (supplyType !== 'services') {
      // Supply type unknown — neither the invoice nor the customer says.
      //
      // DOMESTIC: it does not matter. A supply inside Estonia is 24% whether it
      // is goods or a service, so the unknown changes no figure and the
      // long-standing domestic mapping stands. This is the ONLY place an
      // unknown supply type is allowed through, and only because it cannot
      // alter the answer. (It also covers an invoice with no customer at all,
      // which the projection treats as domestic.)
      if (isDomestic) return 'EE_OUTPUT_24';

      // CROSS-BORDER: it decides everything — goods keep the domestic mapping
      // here, while a service reopens the whole place-of-supply question. The
      // old code answered "24%" for both by never asking. Refuse and ask.
      throw new UnresolvedVatTreatmentError({
        code: 'supply_type_unknown',
        message:
          `Cannot classify a sale to a customer in ${customerCountry}: whether ` +
          `the invoice supplies goods or services is not recorded, and it ` +
          `decides where the supply is taxed.`,
        missingFacts: [
          "sales_invoice.supply_type (or the customer entity's goods_vs_services)",
        ],
        howToResolve:
          'Create the invoice with supply_type="services" (or "goods"), or ' +
          'PATCH /api/entities/{customerId} with {"goodsVsServices":"services"} ' +
          '(or "goods"), then post the invoice again.',
      });
    }

    if (placeRule !== 'general') {
      // A declared exception (immovable property, admission, catering, §10 lg 5
      // electronic services to a consumer, …) has its own place of supply that
      // this plugin does not implement. Inventing one — zero-rating it or
      // taxing it here — would put an unsupported figure on a filed return, so
      // it is refused with the rule named and the accountant pointed at it.
      throw new UnresolvedVatTreatmentError({
        code: 'service_place_rule_unsupported',
        message:
          `Service place-of-supply rule '${placeRule}' has its own place under ` +
          `KMS §10 and is not auto-classified by the EE plugin.`,
        missingFacts: [`service_place_rule=${placeRule}`],
        howToResolve:
          'Determine the treatment for this rule with your accountant and book ' +
          'it explicitly, or set service_place_rule="general" on the invoice if ' +
          'the general rule in fact applies.',
      });
    }

    // Domestic: 24% whoever the recipient is — tax status changes nothing, so
    // it is not required.
    if (isDomestic) return 'EE_OUTPUT_24';

    const taxStatus = customerFacts.taxStatus ?? 'unknown';
    if (taxStatus === 'unknown') {
      // The one fact that decides this supply is not recorded. Unknown is not
      // a consumer: guessing either way would misstate a KMD row (and, for the
      // EU case, the VD). Refuse, name the fact, and say how to supply it.
      throw new UnresolvedVatTreatmentError({
        code: 'customer_tax_status_unknown',
        message:
          `Cannot classify a general-rule service supplied to a customer in ` +
          `${customerCountry}: the customer's tax status is not recorded, and it ` +
          `decides whether the supply is 0% (taxed where the customer is) or 24% ` +
          `(taxed in Estonia).`,
        missingFacts: [
          `entity.tax_status for the customer in ${customerCountry}`,
        ],
        howToResolve:
          'PATCH /api/entities/{customerId} with ' +
          '{"taxStatus":"taxable_business"} or {"taxStatus":"non_taxable"} ' +
          '(a business acting as such vs a consumer), then post the invoice again.',
      });
    }

    if (taxStatus === 'non_taxable') {
      // B2C general-rule service: taxed where the supplier is established.
      return 'EE_OUTPUT_24';
    }

    // Taxable business abroad — 0%, but the two zeros are different reports.
    return EstoniaCountryPlugin.EU.has(customerCountry)
      ? 'EE_OUTPUT_0_EU' // rows 3 + 3.1, VD tähis 3S (Art. 44/196)
      : 'EE_OUTPUT_0_3RD_COUNTRY'; // row 3 only, no VD
  }

  getCategories(): CategoryDef[] {
    return Object.entries(EE_CATEGORY_ACCOUNTS).map(([key, accountCode]) => ({
      key,
      label: labelFor(key),
      accountCode,
    }));
  }

  /**
   * A SERVICE sale's tax amount must agree with the treatment its facts resolved
   * to, and a disagreement is refused BEFORE anything is posted (issue #209).
   *
   * The reported bug was exactly this disagreement surviving into the books: a
   * EUR 100 service invoice carrying vat_amount = 0 was booked against the
   * domestic 24% code, so the KMD showed a 100.00 base in row 1 against 0.00 of
   * output VAT and the XML exported `<transactions24>100.00</transactions24>` —
   * arithmetic no return should carry. Once the code is DERIVED from facts the
   * stated amount is checkable: a 0% supply cannot carry tax, and a 24% supply
   * must carry 24% — of the rate in force at the invoice's own tax point, so a
   * rate change never makes a correctly-taxed older invoice look wrong.
   *
   * Scope is the service sales this issue is about. A GOODS sale states its own
   * tax (its place of supply follows the movement of the goods, which this
   * plugin does not model), and reduced-rate/partially-exempt supplies have no
   * derived code here — recomputing those would refuse legitimate documents.
   */
  assertSaleTaxAmount(input: {
    netMinorUnits: number;
    vatMinorUnits: number;
    vatCode: VATCode;
    taxPointDate: string;
    counterpartyFacts: SupplierFacts;
    supplyFacts?: SupplyFacts;
  }): void {
    const supplyType =
      input.supplyFacts?.supplyType &&
      input.supplyFacts.supplyType !== 'unknown'
        ? input.supplyFacts.supplyType
        : input.counterpartyFacts.goodsVsServices;
    if (supplyType !== 'services') return;

    const rate = this.getVatRate(input.vatCode, input.taxPointDate);
    const expected = Math.round(input.netMinorUnits * rate);
    if (input.vatMinorUnits === expected) return;

    throw new UnresolvedVatTreatmentError({
      code: 'vat_amount_conflicts_with_treatment',
      message:
        `The invoice's VAT amount (${input.vatMinorUnits}) contradicts the VAT ` +
        `treatment its facts resolve to: ${input.vatCode} at ${rate * 100}% on a ` +
        `net of ${input.netMinorUnits} is ${expected}. Nothing was posted.`,
      missingFacts: [
        `vat_amount=${input.vatMinorUnits} (expected ${expected} for ${input.vatCode} on ${input.taxPointDate})`,
      ],
      howToResolve:
        'PATCH /api/sales-invoices/{id} with corrected gross_amount/vat_amount, ' +
        'or correct the facts that decide the rate (the customer country / tax ' +
        "status, or the invoice's supply_type and service_place_rule), then post again.",
    });
  }

  // ── Document classification vocabulary (EE) ───────────────────────────────

  getDocumentClassificationHints(): string {
    return (
      'DOCUMENT-TYPE GUIDANCE (Estonian documents):\n' +
      '- "Tellimus", "Tellimuse kinnitus", "Tellimuse number" = an ORDER / ' +
      'order confirmation. Even if it shows "Kokku tasuda" or "Makstud" ' +
      '(paid), it is NOT a tax invoice. Set document_type="order_confirmation".\n' +
      '- "Ettemaksuarve" = prepayment/pro-forma invoice; "Pakkumine" / ' +
      '"Hinnapakkumine" = quote. Neither is a final invoice — set ' +
      'document_type="proforma". "Saateleht" = delivery note; a Saateleht ' +
      'with no payable amount is not postable — set document_type="other" ' +
      'and set kind="not_a_document".\n' +
      '- "Arve" (an invoice) with "Arve nr", "Maksetähtpäev" (due date) and a ' +
      '"Käibemaks" VAT breakdown (e.g. 24%) IS the primary tax document. Set ' +
      'document_type="invoice".\n' +
      '- A document titled "Arve nr X / Tellimus nr Y" is the INVOICE for order ' +
      'Y — classify it as invoice, not as an order.\n' +
      'When both a Tellimus and an Arve describe the same purchase, ONLY the ' +
      'Arve is postable.'
    );
  }

  // ── Fixed-asset norms (ADR-0035) ──────────────────────────────────────────
  private static readonly FIXED_ASSET_DEFAULTS: Record<
    AssetClass,
    FixedAssetDefaults
  > = {
    vehicle: { defaultUsefulLifeYears: 5, defaultResidualMinor: 400000 },
    it_equipment: { defaultUsefulLifeYears: 3, defaultResidualMinor: 0 },
    machinery: { defaultUsefulLifeYears: 5, defaultResidualMinor: 0 },
    furniture: { defaultUsefulLifeYears: 7, defaultResidualMinor: 0 },
  };

  getDepreciationMethod(): DepreciationMethod {
    return 'straight_line';
  }

  getFixedAssetDefaults(assetClass: AssetClass): FixedAssetDefaults {
    return EstoniaCountryPlugin.FIXED_ASSET_DEFAULTS[assetClass];
  }

  // ── Period / currency ─────────────────────────────────────────────────────

  getPeriodFrequencyOptions(): string[] {
    return ['monthly'];
  }

  getDefaultPeriodFrequency(): string {
    return 'monthly';
  }

  getDefaultBaseCurrency(): string {
    return 'EUR';
  }

  // ── FX ────────────────────────────────────────────────────────────────────

  /**
   * The prescribed VAT-base rate for `date`, from the ECB, with the
   * publication date and source that were actually applied.
   *
   * The plugin owns the RULE (which authority, how a non-publication day
   * resolves, how far back a rate stays in force); {@link FxRateService} owns
   * the mechanism (cache, one fetch, direction and cross-rate arithmetic).
   * Neither owns a rate value — there is no longer any rate constant in this
   * file, which is the point of #203.
   *
   * @throws {FxRateUnavailableError} when the ECB quotes no such pair, or
   *   published nothing for `date` or the seven days before it.
   */
  getReferenceRate(
    fromCurrency: string,
    toCurrency: string,
    date: string,
  ): Promise<ResolvedFxRate> {
    return this.fxRates.resolve(
      fromCurrency,
      toCurrency,
      date,
      EstoniaCountryPlugin.FX_POLICY,
    );
  }

  // ── Rounding ──────────────────────────────────────────────────────────────

  roundToBaseMinorUnits(amount: number): number {
    return Math.round(amount);
  }

  // ── VAT validation ────────────────────────────────────────────────────────

  validateVATCode(
    vatCode: string,
    _context: { supplier: SupplierFacts; org: OrgContext },
  ): boolean {
    return vatCode in EstoniaCountryPlugin.VAT_RATES;
  }

  // ── Input-VAT deduction entitlement ───────────────────────────────────────

  /**
   * How much of a purchase's input VAT an Estonian organisation may deduct
   * (issue #211), decided BEFORE any VAT_RECEIVABLE leg exists.
   *
   * KMD row 5 takes only tax that is deductible under KMS §§29–31 (EMTA's KMD
   * instructions, row 5). Three of the facts that govern it were not being read
   * at all:
   *
   *  - NOT REGISTERED — a person who is not a taxable person has no deduction
   *    right. The 24% on a domestic purchase is simply part of what the thing
   *    cost, and there is no return to put it on.
   *
   *  - LIMITED REGISTRATION (piiratud maksukohustuslane, KMS §21) — registered
   *    because it receives specified acquisitions, it self-assesses and PAYS
   *    the output VAT on them and deducts nothing (EMTA handbook, limited
   *    liability VAT payer). This is the case that proves liability and
   *    entitlement are separate questions: the reverse charge still produces a
   *    real output tax, and the input side of it is zero.
   *
   *  - PARTIAL USE — inputs used both for business and non-business, or for
   *    both taxable and exempt supply, are deductible only in proportion
   *    (KMS §29 lg 1, §32). The proportion is recorded, never inferred.
   *
   * What this deliberately does NOT do is the year-end recalculation of the
   * proportion (KMS §32 lg 4). This resolves the proportion a posting is made
   * at; an annual adjustment is a separate entry against it.
   */
  resolveInputVatEntitlement(
    orgContext: OrgContext,
    _context: InputVatEntitlementContext,
  ): InputVatEntitlement {
    if (
      orgContext.vatRegistered &&
      orgContext.vatRegistrationKind === 'limited'
    ) {
      // The output side of a reverse charge is unaffected — it is exactly what
      // a limited registration exists to collect. Only the deduction is nil.
      return NO_ENTITLEMENT('limited_registration');
    }
    return entitlementFromOrgContext(orgContext);
  }

  // ── Personal disposition ──────────────────────────────────────────────────

  resolvePersonalDispositionAccount(orgType: string): string {
    return orgType === 'sole_proprietor'
      ? 'OWNERS_DRAWINGS'
      : 'SHAREHOLDER_LOAN';
  }

  // ── Cross-border treatment ────────────────────────────────────────────────

  /**
   * The VAT treatment of a PURCHASE, and — when it is self-assessed — a VAT
   * code that records WHERE the acquisition came from (issue #210).
   *
   * Both an intra-Community acquisition and an imported third-country service
   * are reverse-charged at the same 24%, so one code used to serve for both.
   * But the KMD splits them: the taxable value goes to row 6 when the supply
   * came from a taxable person of another MEMBER STATE, and to row 7 for other
   * acquisitions subject to reverse charge (EMTA KMD instructions, rows 6 and
   * 7). A single code cannot carry that difference, and the classifier was
   * answering row 7 for every reverse charge — so every intra-EU acquisition
   * was declared on the wrong row.
   *
   * The origin is therefore decided HERE, from the facts recorded about the
   * supplier, and frozen into the VAT code the voucher is posted with. The
   * declaration then reads the booked code: an entity edited later cannot
   * retro-reclassify a return that was already filed, and the ledger says what
   * it was posted on.
   *
   * @throws {UnresolvedVatTreatmentError} when a supplier in another member
   *   state has no recorded tax status — the fact that decides whether the
   *   acquisition is an intra-Community one at all.
   */
  resolveCrossBorderTreatment(
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
    _context: { vatCharged: boolean },
  ): CrossBorderResolution {
    const supplier = supplierFacts.country;

    if (supplier === orgContext.country) {
      return { treatment: 'domestic', vatCode: 'EE_INPUT_24' };
    }

    if (EstoniaCountryPlugin.EU.has(supplier)) {
      return this.resolveIntraCommunityAcquisition(supplierFacts);
    }

    // Non-EU goods are an import (customs VAT at the border via EE_INPUT_24).
    // Untouched by this issue — the customs route is outside it.
    if (supplierFacts.goodsVsServices === 'goods') {
      return { treatment: 'import', vatCode: 'EE_INPUT_24' };
    }

    return this.resolveThirdCountryAcquisition(supplierFacts);
  }

  /**
   * A purchase from a supplier OUTSIDE the Community. The supported case is the
   * general-rule SERVICE bought from a foreign person engaged in business:
   * under KMS §10 its place of supply is where the buyer is established
   * (Estonia), so the Estonian company self-assesses (pöördmaksustamine) —
   * output 24% and an immediate input 24% deduction, net cash zero — and the
   * taxable value is declared in KMD row 7. Any tax the foreign supplier put on
   * the invoice is never reclaimable EE input VAT (it folds into the cost
   * base), but it does not remove the reverse-charge duty.
   *
   * The facts that make that case the case are REQUIRED, not assumed. Row 7 is
   * the only acquisition row available here, but the prior question — whether a
   * reverse charge is due at all — is not answered by the country: it turns on
   * the supplier being in business and on the supply being a service. The old
   * code answered both by default (unknown ⇒ service, status never consulted),
   * which is how a figure nobody had evidence for reached a return.
   */
  private resolveThirdCountryAcquisition(
    supplierFacts: SupplierFacts,
  ): CrossBorderResolution {
    const country = supplierFacts.country;

    if (supplierFacts.goodsVsServices !== 'services') {
      // Neither goods (handled above as an import) nor services: nothing says
      // what was bought, and that decides between the customs route and the
      // self-assessed one. Two different returns, so it is asked, not guessed.
      throw new UnresolvedVatTreatmentError({
        code: 'acquisition_supply_type_unknown',
        message:
          `Cannot classify a purchase from a supplier in ${country}: whether it ` +
          `supplies goods or services is not recorded, and it decides between an ` +
          `import (VAT at the border) and a self-assessed service acquisition ` +
          `(KMD rows 1 + 7).`,
        missingFacts: [
          `entity.goods_vs_services for the supplier in ${country}`,
        ],
        howToResolve:
          'PATCH /api/entities/{supplierId} with {"goodsVsServices":"services"} ' +
          '(or "goods"), then post the expense again.',
      });
    }

    const taxStatus = supplierFacts.taxStatus ?? 'unknown';

    if (taxStatus === 'taxable_business') {
      return {
        treatment: 'reverse_charge',
        vatCode: 'EE_REVERSE_CHARGE_3RD_COUNTRY',
      };
    }

    if (taxStatus === 'non_taxable') {
      // A service bought from a person NOT in business is not reverse-charged:
      // there is no §3 lg 4 duty to self-assess, so stamping the row-7 code on
      // it would invent both an output tax and an input deduction. Its own
      // treatment (a plain foreign cost) is not auto-classified here.
      throw new UnresolvedVatTreatmentError({
        code: 'supplier_non_taxable_acquisition_unsupported',
        message:
          `The supplier in ${country} is recorded as a non-taxable person, so ` +
          `this service purchase carries no reverse charge — a treatment the EE ` +
          `plugin does not auto-classify. Nothing was posted.`,
        missingFacts: [
          `entity.tax_status=non_taxable for the supplier in ${country}`,
        ],
        howToResolve:
          'If the supplier IS a person engaged in business, PATCH ' +
          '/api/entities/{supplierId} with {"taxStatus":"taxable_business"} and ' +
          'post again; otherwise book the cost explicitly with your accountant.',
      });
    }

    throw new UnresolvedVatTreatmentError({
      code: 'supplier_tax_status_unknown',
      message:
        `Cannot classify a service purchase from a supplier in ${country}: the ` +
        `supplier's tax status is not recorded, and it decides whether an ` +
        `Estonian reverse charge is due on it at all.`,
      missingFacts: [`entity.tax_status for the supplier in ${country}`],
      howToResolve:
        'PATCH /api/entities/{supplierId} with {"taxStatus":"taxable_business"} ' +
        'or {"taxStatus":"non_taxable"} (a person engaged in business vs a ' +
        'private person), then post the expense again.',
    });
  }

  /**
   * A purchase from a supplier in another member state. KMD row 6 is defined by
   * the supplier being a TAXABLE PERSON of that member state — a fact about the
   * supplier, which its country cannot stand in for (the #209 lesson, applied
   * to the purchase side).
   *
   * Goods vs services is NOT required here, unlike on the third-country branch:
   * row 6 takes the intra-Community acquisition of goods AND the services
   * received from a taxable person of another member state, so the answer does
   * not move a figure.
   */
  private resolveIntraCommunityAcquisition(
    supplierFacts: SupplierFacts,
  ): CrossBorderResolution {
    const taxStatus = supplierFacts.taxStatus ?? 'unknown';

    if (taxStatus === 'taxable_business') {
      // Intra-Community acquisition — self-accounted, declared in KMD row 6.
      return { treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE_EU' };
    }

    if (taxStatus === 'non_taxable') {
      // A supply from a non-taxable person of another member state carries no
      // reverse-charge duty and is not an intra-Community acquisition, so it
      // belongs to neither row 6 nor row 7. Booking it as one would put a
      // taxable base on the return that the facts deny — and self-assessing
      // 24% would invent both an output and an input deduction. Its correct
      // treatment (a plain foreign cost, possibly with a special-scheme
      // wrinkle) is not auto-classified here.
      throw new UnresolvedVatTreatmentError({
        code: 'supplier_non_taxable_acquisition_unsupported',
        message:
          `The supplier in ${supplierFacts.country} is recorded as a non-taxable ` +
          `person, so this purchase is not an intra-Community acquisition and ` +
          `carries no reverse charge — a treatment the EE plugin does not ` +
          `auto-classify. Nothing was posted.`,
        missingFacts: [
          `entity.tax_status=non_taxable for the supplier in ${supplierFacts.country}`,
        ],
        howToResolve:
          'If the supplier IS a taxable person acting as such, PATCH ' +
          '/api/entities/{supplierId} with {"taxStatus":"taxable_business"} and ' +
          'post again; otherwise book the cost explicitly with your accountant.',
      });
    }

    // Unknown is not "taxable business" — guessing it would decide KMD row 6
    // vs row 7 (and whether a reverse charge is due at all) on no evidence.
    throw new UnresolvedVatTreatmentError({
      code: 'supplier_tax_status_unknown',
      message:
        `Cannot classify a purchase from a supplier in ${supplierFacts.country}: ` +
        `the supplier's tax status is not recorded, and it decides whether this ` +
        `is an intra-Community acquisition (KMD row 6) or not.`,
      missingFacts: [
        `entity.tax_status for the supplier in ${supplierFacts.country}`,
      ],
      howToResolve:
        'PATCH /api/entities/{supplierId} with {"taxStatus":"taxable_business"} ' +
        'or {"taxStatus":"non_taxable"} (a business acting as such vs a ' +
        'consumer), then post the expense again.',
    });
  }

  // ── Dividends / withholding ───────────────────────────────────────────────

  dividendWithholdingRate(_orgContext: OrgContext): number {
    // Estonia abolished the 14%/7% reduced-rate regime from 2025.
    // No withholding from the shareholder — the tax is paid at the company level.
    return 0.0;
  }

  // ── Distribution tax (company-level CIT 22/78) ────────────────────────────

  private distributionTax(netToOwner: number): number {
    return Math.round((netToOwner * 22) / 78);
  }

  resolveDistributionTax(
    netToOwner: number,
    _orgContext: OrgContext,
  ): { accountCode: string; amount: number } | null {
    return {
      accountCode: 'DISTRIBUTION_TAX_PAYABLE',
      amount: this.distributionTax(netToOwner),
    };
  }

  assertDistributable(
    grossAmount: number,
    retainedEarnings: number,
    _orgContext: OrgContext,
  ): boolean {
    // Total equity hit = net distribution + company-level distribution tax on top.
    const totalHit = grossAmount + this.distributionTax(grossAmount);
    return totalHit <= retainedEarnings;
  }

  // ── CountryPluginRetrieval (compute-only, advisory agent surface) ──────────

  /**
   * Estonia's standard VAT rate by the date it was in force (KMS §15 lg 1, as
   * amended). A rate change does not reach back: a supply's rate is the one in
   * force at its tax point, so a back-dated invoice must be measured against
   * the rate of ITS date, not of today.
   *
   * Newest first; the first entry whose `from` is on or before the date wins.
   */
  private static readonly STANDARD_RATE_HISTORY: ReadonlyArray<{
    from: string;
    rate: number;
  }> = [
    { from: '2025-07-01', rate: 0.24 },
    { from: '2024-01-01', rate: 0.22 },
    { from: '0000-01-01', rate: 0.2 },
  ];

  /** The codes whose rate IS the standard rate, and therefore moves with it. */
  private static readonly STANDARD_RATE_CODES = new Set([
    'EE_OUTPUT_24',
    'EE_INPUT_24',
    'EE_REVERSE_CHARGE',
    'EE_REVERSE_CHARGE_EU',
    'EE_REVERSE_CHARGE_3RD_COUNTRY',
  ]);

  getVatRate(vatCode: string, onDate?: string): number {
    if (onDate && EstoniaCountryPlugin.STANDARD_RATE_CODES.has(vatCode)) {
      const era = EstoniaCountryPlugin.STANDARD_RATE_HISTORY.find(
        (e) => e.from <= onDate,
      );
      if (era) return era.rate;
    }
    return EstoniaCountryPlugin.VAT_RATES[vatCode] ?? 0;
  }

  computeVat(netMinorUnits: number, vatCode: string): VatComputation {
    const rate = this.getVatRate(vatCode);
    const vatMinorUnits = Math.round(netMinorUnits * rate);
    return {
      netMinorUnits,
      vatMinorUnits,
      grossMinorUnits: netMinorUnits + vatMinorUnits,
      rate,
    };
  }

  previewExpenseTreatment(
    category: string,
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
  ): ExpenseTreatmentPreview {
    const mapping = this.resolveCategoryMapping(
      category,
      supplierFacts,
      orgContext,
    );
    const cross = this.resolveCrossBorderTreatment(supplierFacts, orgContext, {
      vatCharged: true,
    });
    return {
      accountCode: mapping.accountCode,
      vatCode: mapping.vatCode,
      rate: this.getVatRate(mapping.vatCode),
      treatment: cross.treatment,
    };
  }

  getVatRegistrationThreshold(_orgContext: OrgContext): number | null {
    // €40,000 registration threshold in EUR cents (minor units).
    return 4000000;
  }

  // ── KMD (käibedeklaratsioon) row classification ───────────────────────────

  /**
   * Map a taxable-base VAT code onto the Estonian KMD rows. The VAT report reads
   * this to build the declaration; the VAT *amount* rows (4 output, 5 input) are
   * derived by the report from the VAT-control accounts, so this only places the
   * taxable base.
   *
   * EE KMD rows used here:
   *   1  — 24% taxable supply (and self-assessed reverse-charge received supply)
   *   2  — 9% taxable supply
   *   3  — 0% supply (intra-EU services, exports); intra-EU services also go on
   *        the VD koondaruanne with tähis 3S
   *   6/7 — acquisition base for reverse charge (6 = from a taxable person of
   *        another member state, 7 = other, e.g. an imported non-EU service)
   *
   * The acquisition origin is carried by the VAT code the voucher was posted
   * with — EE_REVERSE_CHARGE_EU (row 6) vs EE_REVERSE_CHARGE_3RD_COUNTRY
   * (row 7), decided from the supplier's recorded facts by
   * {@link resolveCrossBorderTreatment}. The legacy EE_REVERSE_CHARGE recorded
   * neither, and is classified as UNRESOLVED rather than defaulted to row 7.
   */
  // ── Statutory reports (KMD XML + CSV) ────────────────────────────────────

  generateStatutoryReports(
    input: StatutoryReportInput,
    opts: { formats: StatutoryFormat[] },
  ): StatutoryReportResult {
    const warnings: StatutoryWarning[] = [];
    const reg = input.declarant.regNumber;
    if (!reg) {
      warnings.push({
        code: 'missing_declarant_reg_number',
        message: 'KMD declarant has no commercial registry code',
      });
    } else if (!EstoniaCountryPlugin.REG_RE.test(reg)) {
      warnings.push({
        code: 'invalid_declarant_reg_number',
        message: `Declarant reg number ${reg} must be an 8-digit commercial registry code`,
      });
    }

    // INF warnings (missing invoice numbers on qualifying rows).
    warnings.push(...buildInfPart(input.salesLines, 'sales').warnings);
    warnings.push(...buildInfPart(input.purchaseLines, 'purchase').warnings);

    // A reverse-charge acquisition whose origin the ledger never recorded
    // (issue #210) belongs to row 6 or row 7 and the vouchers do not say which.
    // The KMD has no "either" box, so a rendered return would silently drop
    // those cents from both rows — which is how the defect looked from the
    // outside. A draft renders with this warning; a FINAL does not render.
    const unresolved = input.declaration.unresolved_acquisition_vouchers ?? [];
    if (unresolved.length > 0) {
      warnings.push({
        code: 'unresolved_acquisition_origin',
        blocksFinal: true,
        message:
          `Voucher(s) ${unresolved.join(', ')} carry reverse-charge acquisition base ` +
          `(${input.declaration.row6_7_unresolved_acquisition} cents in total) that ` +
          `records no acquisition origin, so it belongs to KMD row 6 or row 7 and the ` +
          `return cannot say which. Record the supplier's tax status (PATCH ` +
          `/api/entities/{supplierId}) and correct each expense (POST ` +
          `/api/expenses/{id}/correct {"kind":"financial","reason":"..."}), then export again.`,
      });
    }

    // A customer receipt in the period that nobody has classified (issue
    // #213) either declared VAT it should not have, or omitted VAT it owed.
    // The return cannot say which, so a draft renders with this warning and a
    // FINAL does not render at all — the same treatment an acquisition of
    // unknown origin gets above.
    const heldAdvances = input.declaration.unresolved_advance_receipts ?? [];
    if (heldAdvances.length > 0) {
      warnings.push({
        code: 'unclassified_advance_receipt',
        blocksFinal: true,
        message:
          `Customer advance(s) ${heldAdvances.join(', ')} ` +
          `(${input.declaration.unresolved_advance_base ?? 0} cents) were received in this ` +
          `period and carry no tax treatment. A payment for an identified taxable supply is ` +
          `a tax point in itself (KMS §11 lg 1), so this return cannot state whether their ` +
          `VAT belongs in it. Classify each receipt (POST ` +
          `/api/prepayments/{voucherId}/tax-treatment), then export again.`,
      });
    }

    const unsupportedReversals =
      input.declaration.unsupported_advance_reversals ?? [];
    if (unsupportedReversals.length > 0) {
      warnings.push({
        code: 'unsupported_advance_reversal',
        blocksFinal: true,
        message:
          `Advance voucher(s) ${unsupportedReversals.join(', ')} are reversed in a way this ` +
          `return cannot show as documents: a counter-voucher that does not mirror them ` +
          `completely or was itself reversed, or the reversal of an advance draw-down or ` +
          `refund whose own document belongs to an earlier period. The documents would not ` +
          `reconcile with the boxes, so no final return is rendered. Resolve those vouchers ` +
          `and export again.`,
      });
    }

    const base = input.period.name.replace(/[^\w-]/g, '_');
    const artifacts = [];
    for (const fmt of opts.formats) {
      if (fmt === 'xml') {
        artifacts.push({
          filename: `kmd-${base}.xml`,
          mimeType: 'application/xml',
          content: renderKmdXml(input),
        });
      } else if (fmt === 'csv') {
        artifacts.push({
          filename: `kmd-${base}.csv`,
          mimeType: 'text/csv',
          content: renderKmdCsv(input),
        });
      }
    }
    return { artifacts, warnings };
  }

  // ── Annual accounts (RIK-XBRL) ────────────────────────────────────────────

  generateAnnualAccounts(
    input: AnnualAccountsInput,
    opts: AnnualAccountsOpts,
  ): AnnualAccountsResult {
    const warnings: StatutoryWarning[] = [];

    // Plugin-side soft signal: nonzero accounts the mapping does not cover.
    // (The kernel HARD-blocks final on the same condition; here it is surfaced
    // as a rendering warning so a draft still renders.)
    const unmapped = unmappedNonzeroCodes(input.balances);
    for (const code of unmapped) {
      warnings.push({
        code: 'unmapped_nonzero_account',
        message: `Account ${code} has a nonzero balance but maps to no RTJ line`,
      });
    }

    // Declarant identity: the COMMERCIAL REGISTRY code, never the VAT number.
    // Without it there is no filable instance at all — XBRL 2.1 requires an
    // entity identifier in every context — so we surface the gap and hand back
    // no artifact rather than emitting a document that names the wrong key.
    const reg = input.declarant.regNumber?.trim() ?? '';
    if (reg === '') {
      warnings.push({
        code: 'missing_declarant_reg_number',
        message: 'Annual accounts declarant has no commercial registry code',
      });
      return { artifacts: [], warnings };
    }
    if (!EstoniaCountryPlugin.REG_RE.test(reg)) {
      warnings.push({
        code: 'invalid_declarant_reg_number',
        message: `Declarant reg number ${reg} must be an 8-digit commercial registry code`,
      });
      return { artifacts: [], warnings };
    }

    const base = input.period.name.replace(/[^\w-]/g, '_');
    const content = renderAnnualAccountsXbrl(input, opts);
    return {
      artifacts: [
        {
          filename: `annual-accounts-${base}.xbrl`,
          mimeType: 'application/xml',
          content,
        },
      ],
      warnings,
    };
  }

  // ── Allowance rates & accounts (TuMS statutory rates) ────────────────────

  getAllowanceRates(
    type: AllowanceType,
    year: number,
    opts: { domestic: boolean },
  ): AllowanceRates {
    void year;
    if (type === 'daily_allowance') {
      if (opts.domestic) {
        return { ratePerUnit: 0, monthlyTaxFreeCeiling: 0 };
      }
      return {
        ratePerUnit: 7500,
        highRateDaysPerMonth: 15,
        fallbackRatePerUnit: 4000,
        monthlyTaxFreeCeiling: null,
      };
    }
    if (type === 'mileage') {
      return { ratePerUnit: 50, monthlyTaxFreeCeiling: 55000 };
    }
    return { ratePerUnit: 0, monthlyTaxFreeCeiling: null };
  }

  getAllowanceAccount(type: AllowanceType): string {
    if (type === 'daily_allowance' || type === 'mileage') {
      return 'EXPENSE_TRAVEL';
    }
    return 'EXPENSE_OTHER';
  }

  // ── Health / sports exemption and fringe-benefit tax (issue #212) ─────────

  /**
   * TuMS § 48 lg 5^5, by the date the benefit was given.
   *
   * From 2025-01-01 the exemption is EUR 400 per employee per CALENDAR YEAR
   * (VAT included) and the qualifying list was widened — massage and a broader
   * set of services from registered health-care providers joined it. Before
   * that, from the provision's entry into force on 2018-01-01, it was EUR 100
   * per employee per CALENDAR QUARTER over a narrower list that did not include
   * them. Neither the cap nor the list reaches backwards: a 2024 massage was a
   * taxable fringe benefit in full, and exempting it today because the 2025
   * list allows it would understate the tax that was due then.
   *
   * Before 2018-01-01 there is no entry — no exemption is asserted for a date
   * whose rules this plugin has not verified.
   *
   * The health-service categories carry a provider condition: they qualify
   * because a provider on the statutory register supplied them, not because the
   * expense is health-related. A general check-up or an arbitrary medical
   * invoice is not blanket-eligible, so those categories demand the provider's
   * registration on the claim and are not exempt without it.
   *
   * Newest first; the first entry whose `from` is on or before the date wins.
   */
  private static readonly HEALTH_RULE_HISTORY: ReadonlyArray<
    { from: string } & HealthAllowanceRules
  > = [
    {
      from: '2025-01-01',
      windowKind: 'year',
      capPerClaimant: 40000,
      eligibleCategories: [
        'sports_facility_fee',
        'sports_event_participation',
        'employer_sports_facility_upkeep',
        'rehabilitation_or_physiotherapy',
        'massage',
        'registered_healthcare_service',
        'health_insurance_premium',
      ],
      categoriesRequiringProviderRegistration: [
        'rehabilitation_or_physiotherapy',
        'massage',
        'registered_healthcare_service',
      ],
      legalBasis:
        'TuMS §48 lg 5^5 (from 2025-01-01): EUR 400 per employee per calendar year, VAT included',
    },
    {
      from: '2018-01-01',
      windowKind: 'quarter',
      capPerClaimant: 10000,
      eligibleCategories: [
        'sports_facility_fee',
        'sports_event_participation',
        'employer_sports_facility_upkeep',
        'rehabilitation_or_physiotherapy',
        'health_insurance_premium',
      ],
      categoriesRequiringProviderRegistration: [
        'rehabilitation_or_physiotherapy',
      ],
      legalBasis:
        'TuMS §48 lg 5^5 (2018-01-01 to 2024-12-31): EUR 100 per employee per calendar quarter',
    },
  ];

  getHealthAllowanceRules(date: string): HealthAllowanceRules | null {
    const rule = EstoniaCountryPlugin.HEALTH_RULE_HISTORY.find(
      (r) => r.from <= date,
    );
    if (!rule) return null;
    const { from: _from, ...rules } = rule;
    void _from;
    return rules;
  }

  /**
   * The domestic supplies whose tax point a payment CAN advance (issue #213).
   *
   * KMS §11 lg 1: the supply is created on whichever comes first — the
   * dispatch/making available of the goods, the provision of the service, or
   * the receipt of full or partial payment — EXCEPT for intra-Community
   * supply, which has its own timing (§11 lg 2) and is therefore not advanced
   * by a payment at all. EMTA states the same rule in its general
   * time-of-supply guidance.
   *
   * Only the rated domestic output codes are listed. A 0% code is deliberately
   * absent: an export or intra-Community supply carries conditions (proof of
   * despatch, the customer's VAT number) that a payment alone does not
   * satisfy, so this plugin holds those instead of declaring a 0% advance
   * turnover it cannot evidence.
   */
  private static readonly ADVANCE_TAX_POINT_CODES = new Set([
    'EE_OUTPUT_24',
    'EE_OUTPUT_13',
    'EE_OUTPUT_9',
  ]);

  resolveAdvanceTaxPoint(
    context: AdvanceTaxPointContext,
  ): AdvanceTaxPointDecision {
    const { vatCode, receiptDate, orgContext } = context;

    if (!orgContext.vatRegistered) {
      return {
        supported: false,
        code: 'not_registered',
        message:
          'The organisation is not a registered taxable person, so it declares no ' +
          'output VAT and a payment received in advance creates no tax point.',
        howToResolve:
          'Leave the receipt unclassified for accounting review: whether the organisation ' +
          'should be registered (and from which date) decides what this money is, and that ' +
          'is not a bookkeeping default. Classify it as a non-taxable deposit ONLY if the ' +
          'facts really are a deposit rather than payment for a supply.',
      };
    }

    // A limited taxable person (piiratud maksukohustuslane, KMS §21) is
    // registered because of what it ACQUIRES. It makes no taxable supplies of
    // its own, so nothing it receives in advance is advance turnover — the
    // same distinction issue #211 drew on the purchase side.
    if (orgContext.vatRegistrationKind === 'limited') {
      return {
        supported: false,
        code: 'limited_registration',
        message:
          'A limited taxable person (piiratud maksukohustuslane, KMS §21) self-assesses ' +
          'VAT on specified acquisitions and makes no taxable supplies of its own, so a ' +
          'payment received in advance declares no output VAT.',
        howToResolve:
          'Leave the receipt unclassified for accounting review. If the organisation is in ' +
          'fact an ORDINARY taxable person, that is a registration fact to establish and ' +
          'record (PUT /api/organization) on its own evidence — not a setting to change in ' +
          'order to post this advance.',
      };
    }

    if (!EstoniaCountryPlugin.ADVANCE_TAX_POINT_CODES.has(vatCode)) {
      const classification = this.classifyKmd(vatCode);
      const isIntraCommunity = vatCode === 'EE_OUTPUT_0_EU';
      return {
        supported: false,
        code: isIntraCommunity
          ? 'intra_community_supply_not_advanced'
          : 'advance_tax_point_unsupported_code',
        message: isIntraCommunity
          ? 'An intra-Community supply is excluded from the general time-of-supply rule ' +
            '(KMS §11 lg 1 names every case EXCEPT intra-Community supply; §11 lg 2 gives ' +
            'it its own timing), so a payment received for one does not create a tax ' +
            'point and declares nothing now.'
          : `VAT code '${vatCode}' is not a domestic rated supply whose tax point a payment ` +
            `advances` +
            (classification.outputBaseRow === null
              ? ' — it does not describe an output supply at all.'
              : '. A 0%, exempt or specially-timed supply carries conditions a payment ' +
                'alone does not satisfy, so this is held rather than declared.'),
        howToResolve: isIntraCommunity
          ? 'Leave the receipt unclassified for accounting review: it is payment for a ' +
            'supply, so it is not a deposit, and it declares nothing until the supply is ' +
            'made / invoiced under KMS §11 lg 2. Classify it under the domestic rated code ' +
            'only if the supply is in fact domestic.'
          : 'Use the domestic rated output code the supply is actually taxable under. If the ' +
            'treatment is a 0%, exempt or specially-timed one, leave the receipt ' +
            'unclassified for accounting review — payment for a supply is not a deposit, and ' +
            'relabelling it as one would hide it from the filing checks.',
      };
    }

    const rate = this.getVatRate(vatCode, receiptDate);
    if (rate <= 0) {
      return {
        supported: false,
        code: 'no_rate_in_force',
        message:
          `No rate is in force for '${vatCode}' on ${receiptDate}, so the VAT inside the ` +
          'payment cannot be stated.',
        howToResolve:
          'Check the receipt date, or use the code that governed the supply on that day.',
      };
    }

    return { supported: true, vatCode, ratePermille: Math.round(rate * 1000) };
  }

  /**
   * Fringe-benefit tax at the employer's expense (TuMS §48, SMS §2 lg 1 p 7).
   *
   * Income tax is the gross-up form of the income-tax rate — 22/78 from
   * 2025-01-01, 20/80 over 2015-01-01…2024-12-31 — because the benefit is a net
   * amount the employer bears the tax on. Social tax is 33% of the benefit PLUS
   * that income tax, so the two are computed in order and never independently.
   * A 600.00 benefit in 2026 is therefore 169.23 income tax and 253.85 social
   * tax: 423.08 of employer tax on top of the 600.00 paid out, not 22% and 33%
   * of 600 in parallel.
   *
   * There is NO catch-all oldest entry. The rate before 2015-01-01 was not
   * verified against a primary source for this issue, and a benefit dated then
   * is refused rather than taxed at a rate this table invented. A made-up
   * historical rate produces a number that looks filed-ready and is wrong.
   *
   * Newest first; the first entry whose `from` is on or before the date wins.
   */
  private static readonly FRINGE_TAX_HISTORY: ReadonlyArray<{
    from: string;
    /** Income tax as the exact fraction numerator/denominator of the benefit. */
    incomeTaxNumerator: number;
    incomeTaxDenominator: number;
    /** Social tax as a percentage of benefit + income tax. */
    socialTaxPercent: number;
  }> = [
    {
      from: '2025-01-01',
      incomeTaxNumerator: 22,
      incomeTaxDenominator: 78,
      socialTaxPercent: 33,
    },
    {
      from: '2015-01-01',
      incomeTaxNumerator: 20,
      incomeTaxDenominator: 80,
      socialTaxPercent: 33,
    },
  ];

  /** The earliest date {@link FRINGE_TAX_HISTORY} was verified for. */
  private static readonly FRINGE_TAX_VERIFIED_FROM = '2015-01-01';

  resolveFringeBenefitTax(
    benefitValue: number,
    date: string,
    _orgContext: OrgContext,
  ): FringeBenefitTax | null {
    void _orgContext;
    if (benefitValue <= 0) return null;

    const rates = EstoniaCountryPlugin.FRINGE_TAX_HISTORY.find(
      (r) => r.from <= date,
    );
    if (!rates) {
      throw new UnresolvedHealthAllowanceError({
        code: 'fringe_benefit_tax_rate_unverified',
        message:
          `A taxable fringe benefit dated ${date} is before ` +
          `${EstoniaCountryPlugin.FRINGE_TAX_VERIFIED_FROM}, the earliest date ` +
          `this plugin holds verified Estonian fringe-benefit tax rates for. ` +
          `Applying a later rate to it would state a tax that was never due, so ` +
          `nothing was posted.`,
        missingFacts: [
          `verified fringe-benefit tax rates for ${date} (plugin holds them from ` +
            `${EstoniaCountryPlugin.FRINGE_TAX_VERIFIED_FROM})`,
        ],
        howToResolve:
          'Post the benefit under its correct (later) date, or extend the ' +
          "plugin's fringe-benefit rate history from a primary source before " +
          'booking benefits of this vintage.',
      });
    }

    const incomeTax = Math.round(
      (benefitValue * rates.incomeTaxNumerator) / rates.incomeTaxDenominator,
    );
    const socialTax = Math.round(
      ((benefitValue + incomeTax) * rates.socialTaxPercent) / 100,
    );

    return {
      incomeTax,
      socialTax,
      benefitExpenseAccount: 'EXPENSE_FRINGE_BENEFIT',
      taxExpenseAccount: 'EXPENSE_FRINGE_BENEFIT_TAX',
      incomeTaxAccount: 'FRINGE_BENEFIT_INCOME_TAX_PAYABLE',
      socialTaxAccount: 'SOCIAL_TAX_PAYABLE',
      basis:
        `TuMS §48 income tax ${rates.incomeTaxNumerator}/${rates.incomeTaxDenominator} of the benefit; ` +
        `SMS social tax ${rates.socialTaxPercent}% of benefit + income tax`,
    };
  }

  // ── KMD (käibedeklaratsioon) row classification ───────────────────────────

  classifyKmd(
    vatCode: string,
    context?: KmdClassificationContext,
  ): KmdBaseClassification {
    const none: KmdBaseClassification = {
      outputBaseRow: null,
      outputSubRow: null,
      acquisitionRow: null,
      vdCode: null,
      review: null,
    };
    switch (vatCode) {
      case 'EE_OUTPUT_24':
        return { ...none, outputBaseRow: 1 };
      case 'EE_OUTPUT_13':
      case 'EE_OUTPUT_9':
        return { ...none, outputBaseRow: 2 };
      case 'EE_OUTPUT_0_EU':
        // Row 3, and within it row 3.1 (supplies to a taxable person of another
        // member state) — plus the VD koondaruanne under tähis 3S.
        return { ...none, outputBaseRow: 3, outputSubRow: '3.1', vdCode: '3S' };
      case 'EE_OUTPUT_0_3RD_COUNTRY':
        // Row 3 only: a third-country supply is not intra-Community, so it
        // never reaches row 3.1 or the VD.
        return { ...none, outputBaseRow: 3 };
      case 'EE_ZERO':
        return { ...none, outputBaseRow: 3 };
      case 'EE_REVERSE_CHARGE_EU':
        // Intra-Community acquisition from a taxable person of another member
        // state: the taxable value is declared in row 6, inside the row-1 base
        // it is also part of. The origin was decided from recorded facts at
        // posting time, so nothing here needs an accountant's review.
        return {
          outputBaseRow: 1,
          outputSubRow: null,
          acquisitionRow: 6,
          vdCode: null,
          review: null,
        };
      case 'EE_REVERSE_CHARGE_3RD_COUNTRY':
        // Reverse-charged acquisition that is not intra-Community — row 7.
        return {
          outputBaseRow: 1,
          outputSubRow: null,
          acquisitionRow: 7,
          vdCode: null,
          review: null,
        };
      case 'EE_REVERSE_CHARGE':
        if (context?.reversesVoucherFiledWithoutAcquisitionOrigin) {
          // A REMOVAL of an acquisition that a previous return already
          // declared, back when every reverse-charge acquisition was declared
          // in row 7. Nothing here is being classified afresh: the amount comes
          // out of the row the filed document actually put it in, which is the
          // only way the two periods reconcile. This is the leg a correction
          // leaves behind when it is redirected out of a locked period
          // (ADR-0009); its replacement carries the resolved origin into
          // row 6 or 7 on its own.
          return {
            outputBaseRow: 1,
            outputSubRow: null,
            acquisitionRow: 7,
            vdCode: null,
            review:
              'A reverse-charge acquisition filed before the origin was ' +
              'recorded has been reversed: the base is taken back out of KMD ' +
              'row 7, the row the earlier return declared it in, and its ' +
              'corrected replacement declares the resolved origin. Check the ' +
              'pair against that return before filing.',
          };
        }
        // The legacy code (issue #210): a reverse-charge acquisition whose
        // ORIGIN it never recorded. It is a real taxable base carrying real
        // self-assessed VAT — so it stays in row 1 and is read debit-positive —
        // but which acquisition row it belongs to is genuinely unknown, and
        // answering "7" is what put every intra-EU acquisition on the wrong
        // row. It is reported as unresolved: visible in the declaration, named
        // in a review flag, and blocking a FINAL return until it is corrected.
        return {
          outputBaseRow: 1,
          outputSubRow: null,
          acquisitionRow: 'unresolved',
          vdCode: null,
          review:
            'Reverse charge posted before the acquisition origin was recorded ' +
            '(EE_REVERSE_CHARGE): its base belongs in KMD row 6 (from a taxable ' +
            'person of another member state) or row 7 (other), and the voucher ' +
            "does not say which. Record the supplier's facts — PATCH " +
            '/api/entities/{supplierId} {"taxStatus":"taxable_business"} — then ' +
            'POST /api/expenses/{id}/correct {"kind":"financial","reason":"..."} ' +
            'to reverse and repost it on the resolved origin.',
        };
      default:
        // Domestic input codes and the NULL sentinel carry no base row — their
        // only return effect is the input-VAT total (KMD row 5).
        return none;
    }
  }
}
