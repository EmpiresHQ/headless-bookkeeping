import { Injectable } from '@nestjs/common';
import {
  CategoryDef,
  CategoryMappingResult,
  OrgContext,
  SupplierFacts,
  VATCode,
} from './country-plugin.interface';
import { NullCountryPlugin } from './null-country.plugin';

/**
 * The VAT code this plugin deliberately rejects to force a semantic Rule
 * failure. Exported so tests can reference the exact value rather than
 * re-typing the string.
 */
export const STRICT_REJECTED_VAT = 'STRICT_REJECTED';

/**
 * The Category whose mapping resolves to {@link STRICT_REJECTED_VAT}, the
 * lever a test pulls to drive a known-bad input through the pipeline.
 */
export const STRICT_REJECTED_CATEGORY = 'strict-test-category';

/**
 * StrictTestPlugin — the SECOND CountryPlugin adapter (after NullCountryPlugin),
 * existing solely to make the country-plugin seam real rather than hypothetical.
 *
 * "One adapter = a hypothetical seam." NullCountryPlugin is deliberately
 * permissive — every VAT code it emits is valid — so a semantic Rule can never
 * fail through the real pipeline while it is the only plugin, and the Override
 * path (ADR-0005) is therefore unreachable. This plugin is the strict counterpart
 * the ADR-0005 wave gate calls for: it FORCES a semantic failure for a single
 * known-bad input — the Category {@link STRICT_REJECTED_CATEGORY} maps to
 * {@link STRICT_REJECTED_VAT}, which {@link validateVATCode} then rejects. That
 * makes a semantic Rule failure → Approval → logged Override → post a path a
 * test can actually exercise.
 *
 * TEST/DEV ONLY. It is never wired into the production default deployment; the
 * production seam stays NullCountryPlugin. It extends NullCountryPlugin so it
 * inherits the full, valid interface and only diverges on the one rejected code.
 */
@Injectable()
export class StrictTestPlugin extends NullCountryPlugin {
  override getName(): string {
    return 'strict-test';
  }

  override getVATCodes(): VATCode[] {
    return [...super.getVATCodes(), STRICT_REJECTED_VAT];
  }

  override getCategories(): CategoryDef[] {
    return [
      ...super.getCategories(),
      { key: STRICT_REJECTED_CATEGORY, label: 'Strict Test Category', accountCode: 'EXPENSE_OTHER' },
    ];
  }

  override resolveCategoryMapping(
    category: string,
    supplierFacts: SupplierFacts,
    orgContext: OrgContext,
  ): CategoryMappingResult {
    if (category === STRICT_REJECTED_CATEGORY) {
      // Map the trigger Category to the code we will then reject, so the
      // semantic failure surfaces through normal resolution — not a hack.
      return {
        accountCode: 'EXPENSE_OTHER',
        vatCode: STRICT_REJECTED_VAT,
      };
    }
    return super.resolveCategoryMapping(category, supplierFacts, orgContext);
  }

  override validateVATCode(
    vatCode: string,
    context: { supplier: SupplierFacts; org: OrgContext },
  ): boolean {
    if (vatCode === STRICT_REJECTED_VAT) {
      // The forced semantic failure: this code is known-bad and a human must
      // relax it with a logged Override to post.
      return false;
    }
    return super.validateVATCode(vatCode, context);
  }
}
