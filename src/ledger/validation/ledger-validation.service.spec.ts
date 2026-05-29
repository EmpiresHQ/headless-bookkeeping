import { LedgerValidationService } from './ledger-validation.service';
import { ValidatableLine } from './types';

describe('LedgerValidationService', () => {
  let service: LedgerValidationService;
  const validIds = new Set([1, 2]);

  const line = (over: Partial<ValidatableLine>): ValidatableLine => ({
    account_id: 1,
    amount: 10000,
    currency: 'EUR',
    base_amount: 10000,
    fx_rate: 1,
    is_debit: true,
    account_currency: null,
    ...over,
  });

  beforeEach(() => {
    service = new LedgerValidationService();
  });

  it('passes a balanced voucher (Dr 100 / Cr 100)', () => {
    const result = service.validateVoucherLines(
      [
        line({ account_id: 1, is_debit: true }),
        line({ account_id: 2, is_debit: false }),
      ],
      validIds,
    );
    expect(result).toEqual({ isValid: true, errors: [] });
  });

  it('passes a balanced multi-line voucher with non-default amounts', () => {
    const result = service.validateVoucherLines(
      [
        line({
          account_id: 1,
          amount: 7000,
          base_amount: 7000,
          is_debit: true,
        }),
        line({
          account_id: 2,
          amount: 3000,
          base_amount: 3000,
          is_debit: true,
        }),
        line({
          account_id: 1,
          amount: 10000,
          base_amount: 10000,
          is_debit: false,
        }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(true);
  });

  it('fails an unbalanced voucher (Dr 100 / Cr 99)', () => {
    const result = service.validateVoucherLines(
      [
        line({
          account_id: 1,
          amount: 10000,
          base_amount: 10000,
          is_debit: true,
        }),
        line({
          account_id: 2,
          amount: 9900,
          base_amount: 9900,
          is_debit: false,
        }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Voucher lines do not balance');
  });

  it('balances on base_amount, not original amount', () => {
    const result = service.validateVoucherLines(
      [
        line({
          account_id: 1,
          amount: 10000,
          currency: 'USD',
          base_amount: 9200,
          fx_rate: 0.92,
          is_debit: true,
        }),
        line({
          account_id: 2,
          amount: 9200,
          currency: 'EUR',
          base_amount: 9200,
          fx_rate: 1,
          is_debit: false,
        }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(true);
  });

  it('fails when a line references a non-existent account', () => {
    const result = service.validateVoucherLines(
      [
        line({ account_id: 1, is_debit: true }),
        line({ account_id: 42, is_debit: false }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Account does not exist');
  });

  it('fails when an amount is not positive', () => {
    const result = service.validateVoucherLines(
      [
        line({
          account_id: 1,
          amount: -10000,
          base_amount: -10000,
          is_debit: true,
        }),
        line({
          account_id: 2,
          amount: 10000,
          base_amount: 10000,
          is_debit: false,
        }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Amount must be positive');
  });

  it('fails when an amount is not an integer', () => {
    const result = service.validateVoucherLines(
      [
        line({
          account_id: 1,
          amount: 100.5,
          base_amount: 100.5,
          is_debit: true,
        }),
        line({
          account_id: 2,
          amount: 100.5,
          base_amount: 100.5,
          is_debit: false,
        }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Amount must be an integer (cents)');
  });

  it('fails when currency is empty', () => {
    const result = service.validateVoucherLines(
      [
        line({ account_id: 1, currency: '', is_debit: true }),
        line({ account_id: 2, currency: 'EUR', is_debit: false }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Currency must not be empty');
  });

  it('fails on FX mismatch (amount=100, rate=7.14, base_amount=500)', () => {
    const result = service.validateVoucherLines(
      [
        line({
          account_id: 1,
          amount: 100,
          currency: 'USD',
          base_amount: 500,
          fx_rate: 7.14,
          is_debit: true,
        }),
        line({ account_id: 2, amount: 500, base_amount: 500, is_debit: false }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(
      'base_amount does not match amount * fx_rate',
    );
  });

  it('tolerates ±1 cent rounding in the FX check', () => {
    const result = service.validateVoucherLines(
      [
        line({
          account_id: 1,
          amount: 333,
          currency: 'USD',
          base_amount: 100,
          fx_rate: 0.301,
          is_debit: true,
        }),
        line({ account_id: 2, amount: 100, base_amount: 100, is_debit: false }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(true);
  });

  it('fails an empty voucher (no lines)', () => {
    const result = service.validateVoucherLines([], validIds);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Voucher must have at least two lines');
  });

  it('accumulates multiple distinct errors', () => {
    const result = service.validateVoucherLines(
      [
        line({
          account_id: 99,
          amount: -5,
          base_amount: -5,
          currency: '',
          is_debit: true,
        }),
        line({
          account_id: 2,
          amount: 10000,
          base_amount: 10000,
          is_debit: false,
        }),
      ],
      validIds,
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('rejects a non-positive base_amount even when amount is positive', () => {
    const result = service.validateVoucherLines(
      [
        {
          account_id: 1,
          amount: 10000,
          currency: 'EUR',
          base_amount: -10000,
          fx_rate: 1,
          is_debit: true,
          account_currency: null,
        },
        {
          account_id: 2,
          amount: 10000,
          currency: 'EUR',
          base_amount: -10000,
          fx_rate: 1,
          is_debit: false,
          account_currency: null,
        },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('base_amount must be positive');
  });

  it('rejects a non-integer base_amount', () => {
    const result = service.validateVoucherLines(
      [
        {
          account_id: 1,
          amount: 10000,
          currency: 'EUR',
          base_amount: 9200.5,
          fx_rate: 0.92,
          is_debit: true,
          account_currency: null,
        },
        {
          account_id: 2,
          amount: 9200,
          currency: 'EUR',
          base_amount: 9200,
          fx_rate: 1,
          is_debit: false,
          account_currency: null,
        },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('base_amount must be an integer (cents)');
  });

  it('rejects a non-positive fx_rate (negative-rate attack)', () => {
    const result = service.validateVoucherLines(
      [
        {
          account_id: 1,
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: -1,
          is_debit: true,
          account_currency: null,
        },
        {
          account_id: 2,
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: false,
          account_currency: null,
        },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('fx_rate must be positive');
  });

  it('rejects a line whose currency does not match its account currency', () => {
    const result = service.validateVoucherLines(
      [
        {
          account_id: 1,
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: true,
          account_currency: 'USD',
        },
        {
          account_id: 2,
          amount: 10000,
          currency: 'EUR',
          base_amount: 10000,
          fx_rate: 1,
          is_debit: false,
          account_currency: null,
        },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(
      'Line currency does not match account currency',
    );
  });

  it('accepts a line whose currency matches a foreign-currency account', () => {
    const result = service.validateVoucherLines(
      [
        {
          account_id: 1,
          amount: 10000,
          currency: 'USD',
          base_amount: 9200,
          fx_rate: 0.92,
          is_debit: true,
          account_currency: 'USD',
        },
        {
          account_id: 2,
          amount: 9200,
          currency: 'EUR',
          base_amount: 9200,
          fx_rate: 1,
          is_debit: false,
          account_currency: null,
        },
      ],
      new Set([1, 2]),
    );
    expect(result.isValid).toBe(true);
  });
});
