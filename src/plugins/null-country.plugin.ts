import { Injectable, Logger } from '@nestjs/common';
import {
  CategoryMappingResult,
  CountryPlugin,
  CrossBorderResolution,
  OrgContext,
  SupplierFacts,
  VATCode,
} from './country-plugin.interface';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';

/**
 * Re-exported for backward compatibility with existing importers. The SOURCE
 * OF TRUTH is now the kernel (`src/ledger/posting/vat-constants.ts`):
 * `NULL_VAT_CODE` is a kernel POSTING convention (a line not subject to VAT
 * reporting), NOT a jurisdiction VAT code this plugin owns. The plugin merely
 * REFERENCES it as one of the codes it recognizes.
 */
export { NULL_VAT_CODE } from '../ledger/posting/vat-constants';

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
  private readonly logger = new Logger(NullCountryPlugin.name);

  getName(): string {
    return 'null';
  }

  getVATCodes(): VATCode[] {
    return [NULL_VAT_CODE, 'IE_INPUT_23', 'IE_OUTPUT_23'];
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
    return [NULL_VAT_CODE, 'IE_INPUT_23', 'IE_OUTPUT_23'].includes(vatCode);
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
      return { treatment: 'domestic', vatCode: NULL_VAT_CODE };
    }
    // Different country → unresolvable (hold for Approval).
    return { treatment: 'unresolvable', vatCode: null };
  }

  dividendWithholdingRate(_orgContext: OrgContext): number {
    // Null plugin: no withholding tax (0%).
    return 0.0;
  }

  assertDistributable(
    grossAmount: number,
    retainedEarnings: number,
    _orgContext: OrgContext,
  ): boolean {
    // Soft check: warn but don't block.
    // Real country plugins may hard-block (throw) when dividends exceed
    // retained earnings (a legal cap in most jurisdictions).
    if (grossAmount > retainedEarnings) {
      this.logger.warn(
        `Dividend of ${grossAmount} cents exceeds retained earnings of ${retainedEarnings} cents — soft warning, not blocked`,
      );
    }
    // Always return true — soft check only.
    return true;
  }
}
