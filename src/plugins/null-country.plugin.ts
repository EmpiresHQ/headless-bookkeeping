import { Injectable } from '@nestjs/common';
import { CategoryMappingResult, CountryPlugin, VATCode } from './country-plugin.interface';

/**
 * NullCountryPlugin - A stub implementation of CountryPlugin that returns safe defaults.
 *
 * Used as a fallback when no country-specific plugin is available or configured.
 * Provides minimal but valid responses for all interface methods.
 *
 * Per ADR-0002: Country specifics live in plugins; the kernel stays thin.
 * This null plugin ensures the kernel can function even without a real country plugin loaded.
 */
@Injectable()
export class NullCountryPlugin implements CountryPlugin {
  getName(): string {
    return 'null';
  }

  getVATCodes(): VATCode[] {
    return ['NULL_STANDARD'];
  }

  resolveCategoryMapping(category: string, _supplierContext: unknown): CategoryMappingResult {
    // Safe default: map any category to a generic expense account with the null VAT code.
    // The "software" case is explicitly handled as specified.
    if (category === 'software') {
      return { account: 'EXPENSE_SOFTWARE', vatCode: 'NULL_STANDARD' };
    }

    // Generic fallback: uppercase the category as the account key.
    return {
      account: `EXPENSE_${category.toUpperCase()}`,
      vatCode: 'NULL_STANDARD',
    };
  }

  getPeriodFrequencyOptions(): string[] {
    return ['yearly'];
  }

  getDefaultPeriodFrequency(): string {
    return 'yearly';
  }

  validateVATCode(vatCode: string, _context: unknown): boolean {
    return vatCode === 'NULL_STANDARD';
  }
}
