import { Injectable } from '@nestjs/common';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import {
  ResolvedLine,
  RuleResult,
  SemanticValidationContext,
  Override,
} from './types';

/**
 * RulesService — Three-tier rule validation for vouchers.
 *
 * Tiers:
 * 1. Structural (inviolable) — delegates to LedgerValidationService (AC-3).
 *    Checks: debits=credits in base currency, account exists, amounts positive,
 *    fx_rate positive, line currency matches account currency.
 * 2. Hard process (inviolable) — period lock check (stub until Wave 6).
 * 3. Semantic (overridable) — VAT code validity, category mapping existence.
 *    A logged Override with reason can bypass a semantic failure.
 *
 * All tiers operate on *resolved* lines: account codes have already been
 * mapped to {account_id, account_currency} by the single resolver (AC-4).
 * RulesService never re-resolves codes.
 */
@Injectable()
export class RulesService {
  constructor(
    private readonly ledgerValidation: LedgerValidationService,
    private readonly pluginLoader: PluginLoader,
  ) {}

  /**
   * Validate a set of resolved voucher lines against one rule tier.
   *
   * @param resolvedLines — lines with account_id, account_currency, vat_code, category already resolved
   * @param validAccountIds — set of valid account IDs from the seeded chart
   * @param type — which tier to run
   * @param context — required for semantic tier (supplier facts, org context, country code)
   * @param override — optional logged override (only effective for semantic tier)
   */
  validate(
    resolvedLines: ResolvedLine[],
    validAccountIds: Set<number>,
    type: 'structural' | 'hard' | 'semantic',
    context?: SemanticValidationContext,
    override?: Override,
  ): RuleResult {
    switch (type) {
      case 'structural':
        return this.validateStructural(resolvedLines, validAccountIds);
      case 'hard':
        return this.validateHardProcess(resolvedLines);
      case 'semantic':
        return this.validateSemantic(resolvedLines, context, override);
      default:
        return {
          passed: false,
          ruleType: 'unknown',
          message: `Unknown rule type: ${type as string}`,
          overrideable: false,
        };
    }
  }

  private validateStructural(
    resolvedLines: ResolvedLine[],
    validAccountIds: Set<number>,
  ): RuleResult {
    const result = this.ledgerValidation.validateVoucherLines(
      resolvedLines,
      validAccountIds,
    );
    return {
      passed: result.isValid,
      ruleType: 'structural',
      message: result.isValid
        ? 'Structural validation passed'
        : result.errors.join('; '),
      overrideable: false,
    };
  }

  private validateHardProcess(_resolvedLines: ResolvedLine[]): RuleResult {
    // Stub: period locking will be implemented in Wave 6.
    // For now, always pass so the pipeline can proceed.
    return {
      passed: true,
      ruleType: 'hard_process',
      message: 'Hard process validation passed (period lock stub)',
      overrideable: false,
    };
  }

  private validateSemantic(
    resolvedLines: ResolvedLine[],
    context?: SemanticValidationContext,
    override?: Override,
  ): RuleResult {
    if (!context) {
      return {
        passed: false,
        ruleType: 'semantic',
        message: 'Semantic validation requires context',
        overrideable: true,
      };
    }

    const plugin = this.pluginLoader.resolve(context.countryCode);
    const errors: string[] = [];

    for (const line of resolvedLines) {
      const vatValid = plugin.validateVATCode(line.vat_code, {
        supplier: context.supplierFacts,
        org: context.orgContext,
      });
      if (!vatValid) {
        errors.push(`Invalid VAT code: ${line.vat_code}`);
      }

      const mapping = plugin.resolveCategoryMapping(
        line.category,
        context.supplierFacts,
        context.orgContext,
      );
      if (!mapping || !mapping.accountCode) {
        errors.push(`No category mapping for: ${line.category}`);
      }
    }

    if (errors.length === 0) {
      return {
        passed: true,
        ruleType: 'semantic',
        message: 'Semantic validation passed',
        overrideable: true,
      };
    }

    // Semantic rules may be overridden with a logged reason (ADR-0005, ADR-0012).
    if (override && override.ruleType === 'semantic') {
      return {
        passed: true,
        ruleType: 'semantic',
        message: `Semantic validation overridden: ${override.reason}`,
        overrideable: true,
      };
    }

    return {
      passed: false,
      ruleType: 'semantic',
      message: errors.join('; '),
      overrideable: true,
    };
  }
}
