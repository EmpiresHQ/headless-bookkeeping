import { Injectable } from '@nestjs/common';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';
import { DraftVoucher, DraftVoucherLine } from '../ledger/voucher/types';
import type { Selectable } from 'kysely';
import type { AllowanceTable } from '../database/types';

export type AllowanceRow = Selectable<AllowanceTable>;

/**
 * AllowanceProjectionService — projects an AllowanceRow into a balanced
 * DraftVoucher for downstream posting via PostingPipelineService (Task 7).
 *
 * Balance invariant:
 *   Dr EXPENSE_TRAVEL(tax_free_amount) + Dr EXPENSE_SALARY(taxable_amount)
 *   = Cr CLAIMANT_PAYABLE(gross_amount)
 *
 * The taxable split (Dr EXPENSE_SALARY) is only emitted when taxable_amount > 0.
 * All lines use NULL_VAT_CODE — allowances carry no recoverable VAT.
 * FX rate is always 1 (allowances are in the org's base currency).
 */
@Injectable()
export class AllowanceProjectionService {
  constructor(private readonly plugin: NullCountryPlugin) {}

  async project(allowance: AllowanceRow): Promise<DraftVoucher> {
    const travelAccount = this.plugin.getAllowanceAccount(
      allowance.type as Parameters<typeof this.plugin.getAllowanceAccount>[0],
    );

    const lines: DraftVoucherLine[] = [];

    // Debit line 1: tax-free portion → EXPENSE_TRAVEL (or plugin-resolved account)
    lines.push({
      account_code: travelAccount,
      amount: allowance.tax_free_amount,
      currency: allowance.currency,
      base_amount: allowance.tax_free_amount,
      fx_rate: 1,
      vat_code: NULL_VAT_CODE,
      is_debit: true,
    });

    // Debit line 2 (conditional): taxable portion → EXPENSE_SALARY + payroll_flag
    if (allowance.taxable_amount > 0) {
      lines.push({
        account_code: 'EXPENSE_SALARY',
        amount: allowance.taxable_amount,
        currency: allowance.currency,
        base_amount: allowance.taxable_amount,
        fx_rate: 1,
        vat_code: NULL_VAT_CODE,
        is_debit: true,
        metadata: { payroll_flag: true },
      });
    }

    // Credit line: gross → CLAIMANT_PAYABLE
    lines.push({
      account_code: 'CLAIMANT_PAYABLE',
      amount: allowance.gross_amount,
      currency: allowance.currency,
      base_amount: allowance.gross_amount,
      fx_rate: 1,
      vat_code: NULL_VAT_CODE,
      is_debit: false,
    });

    return {
      tax_point_date: allowance.period_start,
      lines,
    };
  }
}
