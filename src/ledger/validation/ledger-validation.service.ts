import { Injectable } from '@nestjs/common';
import { ValidatableLine, ValidationResult } from './types';

@Injectable()
export class LedgerValidationService {
  private static readonly FX_TOLERANCE_CENTS = 1;

  validateVoucherLines(
    lines: ValidatableLine[],
    validAccountIds: Set<number>,
  ): ValidationResult {
    const errors: string[] = [];

    if (lines.length < 2) {
      errors.push('Voucher must have at least two lines');
    }

    let debitTotal = 0;
    let creditTotal = 0;
    let sawNonExistentAccount = false;
    let sawNonPositive = false;
    let sawNonInteger = false;
    let sawEmptyCurrency = false;
    let sawFxMismatch = false;
    let sawNonPositiveBase = false;
    let sawNonIntegerBase = false;
    let sawNonPositiveFx = false;
    let sawCurrencyMismatch = false;

    for (const line of lines) {
      if (!validAccountIds.has(line.account_id)) {
        sawNonExistentAccount = true;
      }
      if (line.amount <= 0) {
        sawNonPositive = true;
      }
      if (!Number.isInteger(line.amount)) {
        sawNonInteger = true;
      }
      if (line.currency.length === 0) {
        sawEmptyCurrency = true;
      }
      const expectedBase = Math.round(line.amount * line.fx_rate);
      if (
        Math.abs(expectedBase - line.base_amount) >
        LedgerValidationService.FX_TOLERANCE_CENTS
      ) {
        sawFxMismatch = true;
      }
      if (line.base_amount <= 0) {
        sawNonPositiveBase = true;
      }
      if (!Number.isInteger(line.base_amount)) {
        sawNonIntegerBase = true;
      }
      if (line.fx_rate <= 0) {
        sawNonPositiveFx = true;
      }
      if (
        line.account_currency !== null &&
        line.currency !== line.account_currency
      ) {
        sawCurrencyMismatch = true;
      }
      if (line.is_debit) {
        debitTotal += line.base_amount;
      } else {
        creditTotal += line.base_amount;
      }
    }

    if (sawNonExistentAccount) errors.push('Account does not exist');
    if (sawNonPositive) errors.push('Amount must be positive');
    if (sawNonInteger) errors.push('Amount must be an integer (cents)');
    if (sawEmptyCurrency) errors.push('Currency must not be empty');
    if (sawFxMismatch)
      errors.push('base_amount does not match amount * fx_rate');
    if (sawNonPositiveBase) errors.push('base_amount must be positive');
    if (sawNonIntegerBase)
      errors.push('base_amount must be an integer (cents)');
    if (sawNonPositiveFx) errors.push('fx_rate must be positive');
    if (sawCurrencyMismatch)
      errors.push('Line currency does not match account currency');
    if (debitTotal !== creditTotal) errors.push('Voucher lines do not balance');

    return { isValid: errors.length === 0, errors };
  }
}
