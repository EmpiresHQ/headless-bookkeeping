import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
import { Injectable } from '@nestjs/common';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';
import { DraftVoucher, DraftVoucherLine } from '../ledger/voucher/types';
import type { Selectable } from 'kysely';
import type { AllowanceTable } from '../database/types';
import type { FringeBenefitTax } from '../plugins/health-allowance.types';

export type AllowanceRow = Selectable<AllowanceTable>;

/**
 * The employer's own tax on a taxable fringe benefit, as decided by the
 * allocation that produced this row's split. Passed in rather than re-derived
 * so the voucher cannot disagree with the persisted amounts (issue #212).
 */
export interface FringeBenefitPosting {
  tax: FringeBenefitTax;
  incomeTax: number;
  socialTax: number;
}

/**
 * AllowanceProjectionService — projects an AllowanceRow into a balanced
 * DraftVoucher for downstream posting via PostingPipelineService (Task 7).
 *
 * Balance invariant, without fringe tax:
 *   Dr EXPENSE_TRAVEL(tax_free_amount) + Dr EXPENSE_SALARY(taxable_amount)
 *   = Cr CLAIMANT_PAYABLE(gross_amount)
 *
 * With an employer-level fringe-benefit tax (issue #212), the taxable part is
 * NOT salary — it is a fringe benefit the employer is separately taxed on, so
 * it books to its own expense account and the tax rides on top:
 *   Dr <allowance account>(tax_free_amount)
 * + Dr EXPENSE_FRINGE_BENEFIT(taxable_amount)
 * + Dr EXPENSE_FRINGE_BENEFIT_TAX(income + social)
 *   = Cr CLAIMANT_PAYABLE(gross_amount)
 *   + Cr <income tax payable> + Cr <social tax payable>
 *
 * The claimant is still paid the gross: the tax is the employer's cost ON TOP,
 * never withheld from the payout.
 *
 * All lines use NULL_VAT_CODE — allowances carry no recoverable VAT, and a
 * health benefit in particular carries no input-VAT deduction at all.
 * FX rate is always 1 (allowances are in the org's base currency).
 */
@Injectable()
export class AllowanceProjectionService {
  constructor(private readonly plugin: NullCountryPlugin) {}

  async project(
    allowance: AllowanceRow,
    fringe?: FringeBenefitPosting | null,
  ): Promise<DraftVoucher> {
    const travelAccount = this.plugin.getAllowanceAccount(
      allowance.type as Parameters<typeof this.plugin.getAllowanceAccount>[0],
    );

    const lines: DraftVoucherLine[] = [];
    const line = (
      accountCode: string,
      amount: number,
      isDebit: boolean,
      metadata?: Record<string, unknown>,
    ): DraftVoucherLine => ({
      account_code: accountCode,
      amount,
      currency: allowance.currency,
      base_amount: amount,
      fx_rate: 1,
      fx_rate_date: allowance.period_start,
      fx_rate_source: IDENTITY_RATE_SOURCE,
      vat_code: NULL_VAT_CODE,
      is_debit: isDebit,
      ...(metadata ? { metadata } : {}),
    });

    // Debit line 1: tax-free portion → the plugin-resolved allowance account.
    // Emitted only when there is one: a wholly taxable benefit has no exempt
    // leg, and a zero line would assert an exemption that was not granted.
    if (allowance.tax_free_amount > 0) {
      lines.push(line(travelAccount, allowance.tax_free_amount, true));
    }

    // Debit line 2 (conditional): the taxable portion.
    if (allowance.taxable_amount > 0) {
      if (fringe) {
        lines.push(
          line(
            fringe.tax.benefitExpenseAccount,
            allowance.taxable_amount,
            true,
            {
              fringe_benefit: true,
              exemption_basis: allowance.exemption_basis,
            },
          ),
        );
      } else {
        // No employer-level fringe tax in this jurisdiction: the taxable part
        // is an ordinary employment cost, exactly as before.
        lines.push(
          line('EXPENSE_SALARY', allowance.taxable_amount, true, {
            payroll_flag: true,
          }),
        );
      }
    }

    // Debit line 3 + the two tax credits: the employer's own tax on the
    // benefit. Booked as one expense line and two liabilities, because the two
    // taxes are declared and paid separately even though one expense bears them.
    if (fringe && fringe.incomeTax + fringe.socialTax > 0) {
      lines.push(
        line(
          fringe.tax.taxExpenseAccount,
          fringe.incomeTax + fringe.socialTax,
          true,
          { fringe_benefit_tax: true, tax_basis: fringe.tax.basis },
        ),
      );
    }

    // Credit line: gross → CLAIMANT_PAYABLE. Unchanged by the tax above.
    lines.push(line('CLAIMANT_PAYABLE', allowance.gross_amount, false));

    if (fringe && fringe.incomeTax > 0) {
      lines.push(line(fringe.tax.incomeTaxAccount, fringe.incomeTax, false));
    }
    if (fringe && fringe.socialTax > 0) {
      lines.push(line(fringe.tax.socialTaxAccount, fringe.socialTax, false));
    }

    return {
      tax_point_date: allowance.period_start,
      lines,
    };
  }
}
