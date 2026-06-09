import { Injectable } from '@nestjs/common';
import {
  CategoryMappingResult,
  CountryPlugin,
  CrossBorderResolution,
  OrgContext,
  SupplierFacts,
  VATCode,
} from './country-plugin.interface';
import {
  ExpenseTreatmentPreview,
  VatComputation,
} from './country-plugin-retrieval.interface';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';

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

  /**
   * v1 PLACEHOLDER rates (deterministic for tests). Live ECB integration is
   * deferred (tracked debt) — getReferenceRate is a pure sync function so it
   * cannot fetch.
   */
  private static readonly RATES: Record<string, number> = {
    'USD→EUR': 0.92,
    'GBP→EUR': 1.16,
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
    _supplierFacts: SupplierFacts,
    _orgContext: OrgContext,
  ): CategoryMappingResult {
    if (category === 'revenue') {
      return { accountCode: 'REVENUE', vatCode: 'EE_OUTPUT_24' };
    }

    // Expense categories → seeded chart accounts + EE standard input VAT.
    // Mirrors NullCountryPlugin's map; VAT code swapped to EE_INPUT_24.
    const expenseMap: Record<string, string> = {
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
    };

    const accountCode = expenseMap[category] ?? 'EXPENSE_OTHER';
    return { accountCode, vatCode: 'EE_INPUT_24' };
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

  getReferenceRate(
    fromCurrency: string,
    toCurrency: string,
    _date: string,
  ): number {
    if (fromCurrency === toCurrency) return 1.0;
    const direct = EstoniaCountryPlugin.RATES[`${fromCurrency}→${toCurrency}`];
    if (direct !== undefined) return direct;
    const inverse = EstoniaCountryPlugin.RATES[`${toCurrency}→${fromCurrency}`];
    if (inverse !== undefined) return 1.0 / inverse;
    throw new Error(
      `EE plugin: no reference rate for ${fromCurrency} → ${toCurrency} (live FX deferred)`,
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

  getVatRate(vatCode: string): number {
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
}
