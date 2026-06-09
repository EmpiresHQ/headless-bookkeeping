import { Injectable } from '@nestjs/common';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import {
  ResolvedLine,
  RuleResult,
  RuleTier,
  SemanticValidationContext,
  Override,
  TierValidationInput,
  TierResults,
} from './types';

/**
 * RulesService — Three-tier rule validation for vouchers.
 *
 * Tiers (CONTEXT.md → "Rules"):
 * 1. Structural invariants (inviolable) — delegates to LedgerValidationService
 *    (AC-3). Debits=credits in base currency, account exists, amounts positive
 *    integers, fx_rate positive, line currency matches account currency.
 * 2. Hard process rules (inviolable) — period lock check. Delegates to
 *    PeriodLockService.findLockedPeriod (ADR-0009): the very same check the
 *    PostingService write chokepoint enforces. Running it here gives the
 *    pipeline an early, well-messaged RuleResult (defense-in-depth) before any
 *    write is attempted; the authoritative throw still lives in PostingService.
 * 3. Semantic rules (overridable) — VAT code validity, category mapping
 *    existence, and cross-border treatment resolvability (ADR-0002). A logged
 *    Override with reason can relax a semantic failure.
 *
 * Unified tier interface (ADR-0005): every tier is reached through a SINGLE
 * async {@link validate} entry that takes a {@link RuleTier} discriminator and
 * one {@link TierValidationInput} bag, and every tier returns the same
 * {@link RuleResult} shape. Callers no longer juggle a sync `validate` for two
 * tiers plus a separate async `validateHardProcess` — {@link validateAll} runs
 * all three and returns them in the array shape Policy consumes.
 *
 * The structural and semantic tiers operate on *resolved* lines: account codes
 * have already been mapped to {account_id, account_currency} by the single
 * resolver (AC-4). RulesService never re-resolves codes. The hard-process tier
 * is keyed on the voucher's tax-point date rather than its lines.
 */
@Injectable()
export class RulesService {
  constructor(
    private readonly ledgerValidation: LedgerValidationService,
    private readonly pluginLoader: PluginLoader,
    private readonly periodLock: PeriodLockService,
  ) {}

  /**
   * Validate a voucher against ONE rule tier. The single, consistent entry for
   * every tier: the caller picks the tier with `tier` and supplies whatever
   * that tier needs in `input` (lines + validAccountIds for structural;
   * taxPointDate for hard_process; lines + context + optional override for
   * semantic). Every tier returns the same {@link RuleResult} shape, so a
   * caller never has to special-case the hard-process tier's async signature.
   */
  async validate(
    tier: RuleTier,
    input: TierValidationInput,
  ): Promise<RuleResult> {
    switch (tier) {
      case 'structural':
        return this.validateStructural(
          input.resolvedLines ?? [],
          input.validAccountIds ?? new Set<number>(),
        );
      case 'hard_process':
        return this.validateHardProcess(input.taxPointDate ?? '');
      case 'semantic':
        return this.validateSemantic(
          input.resolvedLines ?? [],
          input.context,
          input.override,
        );
      default: {
        const exhaustive: never = tier;
        return {
          passed: false,
          ruleType: 'structural',
          message: `Unknown rule type: ${String(exhaustive)}`,
          overrideable: false,
        };
      }
    }
  }

  /**
   * Run all three tiers for a voucher and return them in declaration order
   * [structural, hardProcess, semantic] — the array Policy consumes. The single
   * call that replaces a caller's hand-rolled orchestration of the three tiers.
   *
   * The semantic tier is only meaningful for lines carrying a real VAT code; the
   * caller passes {@link TierValidationInput.semanticLines} (a pre-filtered
   * subset). When that subset is empty the semantic tier is skipped with a
   * passing result, matching the prior pipeline behavior.
   */
  async validateAll(input: TierValidationInput): Promise<TierResults> {
    const structural = await this.validate('structural', input);
    const hardProcess = await this.validate('hard_process', input);

    const semanticLines = input.semanticLines ?? input.resolvedLines ?? [];
    let semantic: RuleResult;
    if (semanticLines.length === 0) {
      semantic = {
        passed: true,
        ruleType: 'semantic',
        message: 'Semantic validation skipped (no lines with VAT code)',
        overrideable: true,
      };
    } else {
      semantic = await this.validate('semantic', {
        ...input,
        resolvedLines: semanticLines,
      });
    }

    return { structural, hardProcess, semantic };
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

  /**
   * Hard process tier (ADR-0009): reject if the voucher's tax-point date falls
   * within a locked reporting period. Delegates to the canonical
   * PeriodLockService check so the rule lives in exactly one place; the
   * PostingService write chokepoint runs the same check as the authoritative
   * backstop. Non-overridable — a filed period is closed by law, not arithmetic.
   *
   * Kept public so existing callers/tests that target the hard tier directly
   * keep working; the unified {@link validate}('hard_process', …) routes here.
   */
  async validateHardProcess(taxPointDate: string): Promise<RuleResult> {
    const locked = await this.periodLock.findLockedPeriod(taxPointDate);
    if (locked) {
      return {
        passed: false,
        ruleType: 'hard_process',
        message: `Cannot post into locked period ${locked.name}`,
        overrideable: false,
      };
    }
    return {
      passed: true,
      ruleType: 'hard_process',
      message: 'Hard process validation passed',
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
    }

    // Category mapping: use the business object's real category from the
    // semantic context rather than reverse-engineering it from account codes.
    const mapping = plugin.resolveCategoryMapping(
      context.category,
      context.supplierFacts,
      context.orgContext,
    );
    if (!mapping || !mapping.accountCode) {
      errors.push(`No category mapping for: ${context.category}`);
    }

    // Cross-border treatment (ADR-0002): the country plugin — the sole resolver
    // — maps the supplier's country to a VAT territory and decides whether the
    // purchase is domestic / reverse-charge / import / non-reclaimable foreign
    // cost. When it cannot resolve a treatment (e.g. a foreign supplier whose
    // territory the plugin does not yet cover) it returns `unresolvable`. The
    // kernel must NEVER silently reclaim a foreign document_vat_marking, so we
    // surface this as a semantic failure — overrideable, hence held for
    // Approval by Policy (conservative default: book gross as a cost). It lives
    // in the semantic tier because cross-border treatment is a country-plugin
    // decision, and the Rules→Policy split keeps the HOLD in Policy.
    const crossBorder = plugin.resolveCrossBorderTreatment(
      context.supplierFacts,
      context.orgContext,
      { vatCharged: context.vatCharged ?? false },
    );
    if (crossBorder.treatment === 'unresolvable') {
      errors.push(
        `Unresolvable cross-border VAT treatment for supplier country ` +
          `${context.supplierFacts.country}; hold for Approval (book gross as cost)`,
      );
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
    if (override && override.ruleType === 'semantic' && override.reason) {
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
