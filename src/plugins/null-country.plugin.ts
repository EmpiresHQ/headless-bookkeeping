import { Injectable } from '@nestjs/common';
import {
  CategoryMappingResult,
  CountryPlugin,
  CrossBorderResolution,
  OrgContext,
  SupplierFacts,
  VATCode,
} from './country-plugin.interface';

export const NULL_VAT_CODE = 'NULL_STANDARD';

/**
 * NullCountryPlugin - A stub implementation of CountryPlugin that returns safe defaults.
 *
 * Used as a fallback when no country-specific plugin is available or configured.
 * Provides minimal but valid responses for all interface methods.
 *
 * Per ADR-0002: Country specifics live in plugins; the kernel stays thin.
 * This null plugin ensures the kernel can function even without a real country plugin loaded.
 *
 * Default deployment is Ireland → EUR (ADR-0004), so IE VAT codes are used.
 */
@Injectable()
export class NullCountryPlugin implements CountryPlugin {
  getName(): string {
    return 'null';
  }

  getVATCodes(): VATCode[] {
    return ['NULL_STANDARD', 'IE_INPUT_23', 'IE_OUTPUT_23'];
  }

  resolveCategoryMapping(
    category: string,
    _supplierFacts: SupplierFacts,
    _orgContext: OrgContext,
  ): CategoryMappingResult {
    // Revenue branch
    if (category === 'revenue') {
      return { accountCode: 'REVENUE', vatCode: 'IE_OUTPUT_23' };
    }

    // Expense categories mapped to seeded chart accounts + IE input VAT.
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
    return { accountCode, vatCode: 'IE_INPUT_23' };
  }

  getPeriodFrequencyOptions(): string[] {
    return ['yearly'];
  }

  getDefaultPeriodFrequency(): string {
    return 'yearly';
  }

  getDefaultBaseCurrency(): string {
    // Neutral default for an unknown country. A real country plugin
    // (e.g. a Danish plugin) overrides this with its national currency.
    return 'EUR';
  }

  getReferenceRate(
    fromCurrency: string,
    toCurrency: string,
    _date: string,
  ): number {
    if (fromCurrency === toCurrency) {
      return 1.0;
    }
    throw new Error(
      `Cross-currency FX not supported in null plugin: ${fromCurrency} → ${toCurrency}`,
    );
  }

  validateVATCode(
    vatCode: string,
    _context: { supplier: SupplierFacts; org: OrgContext },
  ): boolean {
    return ['NULL_STANDARD', 'IE_INPUT_23', 'IE_OUTPUT_23'].includes(vatCode);
  }

  resolvePersonalDispositionAccount(orgType: string): string {
    if (orgType === 'sole_proprietor') {
      return 'OWNERS_DRAWINGS';
    }
    // Default to 'company' → SHAREHOLDER_LOAN (ADR-0017/ADR-0023).
    return 'SHAREHOLDER_LOAN';
  }

  resolveCrossBorderTreatment(
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
    _context: { vatCharged: boolean },
  ): CrossBorderResolution {
    // Same country → domestic with default VAT code.
    if (supplierFacts.country === orgContext.country) {
      return { treatment: 'domestic', vatCode: 'NULL_STANDARD' };
    }
    // Different country → unresolvable (hold for Approval).
    return { treatment: 'unresolvable', vatCode: null };
  }
}
