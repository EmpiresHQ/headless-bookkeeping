import {
  RTJ_LINES,
  ACCOUNT_TO_LINE,
  rollUpLines,
  unmappedNonzeroCodes,
} from './rtj-mapping';
import type { AccountBalanceRow } from '../annual-accounts.types';

describe('Estonia RTJ mapping', () => {
  it('maps every leg a health fringe benefit posts, so none is dropped', () => {
    // rollUpLines silently skips an account it does not recognise, so an
    // unmapped code does not raise an error — it quietly removes a posted
    // amount from the annual accounts. A EUR 1000 health claim posts five
    // legs, three of them through accounts this issue added (#212).
    const balances: AccountBalanceRow[] = [
      { code: 'EXPENSE_OTHER', current: 40000, prior: 0, type: 'expense' },
      {
        code: 'EXPENSE_FRINGE_BENEFIT',
        current: 60000,
        prior: 0,
        type: 'expense',
      },
      {
        code: 'EXPENSE_FRINGE_BENEFIT_TAX',
        current: 42308,
        prior: 0,
        type: 'expense',
      },
      {
        code: 'CLAIMANT_PAYABLE',
        current: 100000,
        prior: 0,
        type: 'liability',
      },
      {
        code: 'FRINGE_BENEFIT_INCOME_TAX_PAYABLE',
        current: 16923,
        prior: 0,
        type: 'liability',
      },
      {
        code: 'SOCIAL_TAX_PAYABLE',
        current: 25385,
        prior: 0,
        type: 'liability',
      },
    ];

    expect(unmappedNonzeroCodes(balances)).toEqual([]);

    const lines = rollUpLines(balances);
    const total = (id: string) => lines.find((l) => l.id === id)?.current ?? 0;

    // The benefit and the employer's tax on it are labour costs; the exempt
    // part is an ordinary operating expense.
    expect(total('labourExpense')).toBe(102308);
    expect(total('otherOperatingExpenses')).toBe(40000);
    // Every expense leg is present: 400.00 + 600.00 + 423.08.
    expect(total('labourExpense') + total('otherOperatingExpenses')).toBe(
      142308,
    );
    // And so is every liability leg: 1000.00 owed to the claimant plus 423.08
    // of tax — the same 1423.08 the debits come to.
    expect(total('payablesAndPrepayments')).toBe(142308);
  });

  it('maps the core neutral accounts to RTJ lines', () => {
    expect(ACCOUNT_TO_LINE['BANK_EUR']).toBe('cashAndBankAccounts');
    expect(ACCOUNT_TO_LINE['AR']).toBe('receivablesAndPrepayments');
    expect(ACCOUNT_TO_LINE['FIXED_ASSETS_VEHICLES']).toBe(
      'tangibleFixedAssets',
    );
    expect(ACCOUNT_TO_LINE['ACCUM_DEPRECIATION_VEHICLES']).toBe(
      'tangibleFixedAssets',
    );
    expect(ACCOUNT_TO_LINE['AP']).toBe('payablesAndPrepayments');
    expect(ACCOUNT_TO_LINE['EQUITY']).toBe('issuedCapital');
    expect(ACCOUNT_TO_LINE['RETAINED_EARNINGS']).toBe('retainedEarnings');
    expect(ACCOUNT_TO_LINE['REVENUE']).toBe('revenue');
    expect(ACCOUNT_TO_LINE['DEPRECIATION_EXPENSE']).toBe('depreciation');
    expect(ACCOUNT_TO_LINE['EXPENSE_OTHER']).toBe('otherOperatingExpenses');
  });

  it('every RTJ_LINES key is a known concept with a statement + sign', () => {
    for (const [id, def] of Object.entries(RTJ_LINES)) {
      expect(def.concept).toMatch(/^et-gaap:/);
      expect(['balanceSheet', 'incomeStatement']).toContain(def.statement);
      expect(['debit', 'credit']).toContain(def.normalSide);
      expect([1, -1]).toContain(def.reportedSign);
      expect(id).toBe(def.id);
    }
  });

  it('rolls up balances into line totals, current and prior', () => {
    const balances: AccountBalanceRow[] = [
      { code: 'BANK_EUR', type: 'asset', current: 5000, prior: 3000 },
      { code: 'CASH', type: 'asset', current: 1000, prior: 0 },
      { code: 'AP', type: 'liability', current: 2000, prior: 1500 },
    ];
    const lines = rollUpLines(balances);
    const cash = lines.find((l) => l.id === 'cashAndBankAccounts')!;
    expect(cash.current).toBe(6000);
    expect(cash.prior).toBe(3000);
    const pay = lines.find((l) => l.id === 'payablesAndPrepayments')!;
    expect(pay.current).toBe(2000);
    expect(pay.prior).toBe(1500);
  });

  it('contra-accumulated-depreciation reduces the tangible-fixed-asset line', () => {
    const balances: AccountBalanceRow[] = [
      {
        code: 'FIXED_ASSETS_VEHICLES',
        type: 'asset',
        current: 20000,
        prior: 20000,
      },
      {
        code: 'ACCUM_DEPRECIATION_VEHICLES',
        type: 'asset',
        current: -4000,
        prior: -2000,
      },
    ];
    const lines = rollUpLines(balances);
    const tfa = lines.find((l) => l.id === 'tangibleFixedAssets')!;
    expect(tfa.current).toBe(16000);
    expect(tfa.prior).toBe(18000);
  });

  it('flags a nonzero balance on an unmapped account', () => {
    const balances: AccountBalanceRow[] = [
      { code: 'BANK_EUR', type: 'asset', current: 100, prior: 0 },
      { code: 'MYSTERY_SUSPENSE', type: 'asset', current: 250, prior: 0 },
      { code: 'OTHER_ZERO', type: 'asset', current: 0, prior: 0 },
    ];
    expect(unmappedNonzeroCodes(balances)).toEqual(['MYSTERY_SUSPENSE']);
  });
});
