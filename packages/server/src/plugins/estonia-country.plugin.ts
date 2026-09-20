import { Injectable } from '@nestjs/common';
import { FxLookupPolicy, FxRateService } from '../fx/fx-rate.service';
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
import {
  ExpenseTreatmentPreview,
  KmdBaseClassification,
  VatComputation,
} from './country-plugin-retrieval.interface';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';
import { UnresolvedVatTreatmentError } from './vat-treatment.errors';
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
    EE_REVERSE_CHARGE: 0.24,
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

  // ── Personal disposition ──────────────────────────────────────────────────

  resolvePersonalDispositionAccount(orgType: string): string {
    return orgType === 'sole_proprietor'
      ? 'OWNERS_DRAWINGS'
      : 'SHAREHOLDER_LOAN';
  }

  // ── Cross-border treatment ────────────────────────────────────────────────

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
      // Intra-Community acquisition — buyer self-accounts with OUR reverse-charge code.
      return { treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' };
    }

    // Non-EU goods are an import (customs VAT at the border via EE_INPUT_24).
    if (supplierFacts.goodsVsServices === 'goods') {
      return { treatment: 'import', vatCode: 'EE_INPUT_24' };
    }

    // Non-EU services: under KMS §10 the place of supply of B2B general-rule
    // services is where the BUYER is established (Estonia), so the Estonian
    // company self-assesses (pöördmaksustamine) exactly as for an intra-EU
    // acquisition — output 24% and an immediate input 24% deduction, net cash
    // zero. This holds whether or not the foreign supplier put some tax on the
    // invoice: that foreign tax is never reclaimable EE input VAT (it folds
    // into the cost base), but it does not remove the reverse-charge duty.
    // 'unknown' goods/services is treated as a service import — the
    // conservative EE position for imported supplies that reach the buyer here.
    return { treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' };
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
   *   6/7 — acquisition base for reverse charge (6 = from another member state,
   *        7 = other, e.g. an imported non-EU service)
   *
   * EE_REVERSE_CHARGE covers BOTH intra-EU and non-EU service imports (the
   * resolver does not record which), so the acquisition lands in row 7 with a
   * review note to move it to row 6 when the supplier is in another member
   * state. KMD-INF row numbers should be confirmed by the accountant.
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
    warnings.push(...buildInfPart(input.salesLines).warnings);
    warnings.push(...buildInfPart(input.purchaseLines).warnings);

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

  // ── KMD (käibedeklaratsioon) row classification ───────────────────────────

  classifyKmd(vatCode: string): KmdBaseClassification {
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
      case 'EE_REVERSE_CHARGE':
        return {
          outputBaseRow: 1,
          outputSubRow: null,
          acquisitionRow: 7,
          vdCode: null,
          review:
            'Reverse charge: verify KMD acquisition row 6 (intra-EU) vs 7 ' +
            '(non-EU import) by supplier country; confirm KMD-INF row numbers.',
        };
      default:
        // Domestic input codes and the NULL sentinel carry no base row — their
        // only return effect is the input-VAT total (KMD row 5).
        return none;
    }
  }
}
