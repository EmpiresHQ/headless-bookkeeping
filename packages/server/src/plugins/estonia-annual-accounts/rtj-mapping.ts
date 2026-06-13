import type { AccountBalanceRow } from '../annual-accounts.types';

/** Which statement a line belongs to, and its normal accumulation side. */
export interface RtjLineDef {
  id: string;
  /** Estonian RTJ taxonomy concept (2026), prefixed `ee-rtj:`. */
  concept: string;
  /** Human label (Estonian). */
  label: string;
  statement: 'balanceSheet' | 'incomeStatement';
  /** Which signed direction is the line's normal positive. */
  normalSide: 'debit' | 'credit';
}

/**
 * The väike-form line set rendered in v1. IDs are stable internal keys; the
 * `concept` is the pinned 2026 RIK taxonomy element. Totals/subtotals are
 * computed in the renderer from the calculation linkbase, not stored here.
 */
export const RTJ_LINES: Record<string, RtjLineDef> = {
  // ── Balance sheet — Aktiva (assets, debit-normal) ──
  cashAndBankAccounts: {
    id: 'cashAndBankAccounts',
    concept: 'ee-rtj:CashAndCashEquivalents',
    label: 'Raha',
    statement: 'balanceSheet',
    normalSide: 'debit',
  },
  receivablesAndPrepayments: {
    id: 'receivablesAndPrepayments',
    concept: 'ee-rtj:ReceivablesAndPrepayments',
    label: 'Nõuded ja ettemaksed',
    statement: 'balanceSheet',
    normalSide: 'debit',
  },
  inventories: {
    id: 'inventories',
    concept: 'ee-rtj:Inventories',
    label: 'Varud',
    statement: 'balanceSheet',
    normalSide: 'debit',
  },
  tangibleFixedAssets: {
    id: 'tangibleFixedAssets',
    concept: 'ee-rtj:TangibleFixedAssets',
    label: 'Materiaalne põhivara',
    statement: 'balanceSheet',
    normalSide: 'debit',
  },
  // ── Balance sheet — Kohustused (liabilities, credit-normal) ──
  payablesAndPrepayments: {
    id: 'payablesAndPrepayments',
    concept: 'ee-rtj:PayablesAndPrepayments',
    label: 'Võlad ja ettemaksed',
    statement: 'balanceSheet',
    normalSide: 'credit',
  },
  // ── Balance sheet — Omakapital (equity, credit-normal) ──
  issuedCapital: {
    id: 'issuedCapital',
    concept: 'ee-rtj:IssuedCapital',
    label: 'Osakapital',
    statement: 'balanceSheet',
    normalSide: 'credit',
  },
  retainedEarnings: {
    id: 'retainedEarnings',
    concept: 'ee-rtj:RetainedEarningsDeficit',
    label: 'Eelmiste perioodide jaotamata kasum (kahjum)',
    statement: 'balanceSheet',
    normalSide: 'credit',
  },
  profitForPeriod: {
    id: 'profitForPeriod',
    concept: 'ee-rtj:ProfitLossForPeriod',
    label: 'Aruandeaasta kasum (kahjum)',
    statement: 'balanceSheet',
    normalSide: 'credit',
  },
  // ── Income statement — skeem 1 (by nature) ──
  revenue: {
    id: 'revenue',
    concept: 'ee-rtj:Revenue',
    label: 'Müügitulu',
    statement: 'incomeStatement',
    normalSide: 'credit',
  },
  otherOperatingExpenses: {
    id: 'otherOperatingExpenses',
    concept: 'ee-rtj:OtherOperatingExpenses',
    label: 'Mitmesugused tegevuskulud',
    statement: 'incomeStatement',
    normalSide: 'debit',
  },
  labourExpense: {
    id: 'labourExpense',
    concept: 'ee-rtj:LabourExpense',
    label: 'Tööjõukulud',
    statement: 'incomeStatement',
    normalSide: 'debit',
  },
  depreciation: {
    id: 'depreciation',
    concept: 'ee-rtj:DepreciationAndImpairmentLoss',
    label: 'Põhivara kulum',
    statement: 'incomeStatement',
    normalSide: 'debit',
  },
};

/**
 * Account code → RTJ line id. A `FIXED_ASSETS_*` and its paired
 * `ACCUM_DEPRECIATION_*` both fold into `tangibleFixedAssets` (the contra
 * balance is stored normal-side-negative, so a plain sum nets book value).
 */
export const ACCOUNT_TO_LINE: Readonly<Record<string, string>> = {
  // Assets
  CASH: 'cashAndBankAccounts',
  BANK_EUR: 'cashAndBankAccounts',
  BANK_USD: 'cashAndBankAccounts',
  AR: 'receivablesAndPrepayments',
  VAT_RECEIVABLE: 'receivablesAndPrepayments',
  SUPPLIER_PREPAYMENTS: 'receivablesAndPrepayments',
  RECEIVABLE_FROM_OWNER: 'receivablesAndPrepayments',
  FIXED_ASSETS_VEHICLES: 'tangibleFixedAssets',
  FIXED_ASSETS_IT: 'tangibleFixedAssets',
  FIXED_ASSETS_EQUIPMENT: 'tangibleFixedAssets',
  FIXED_ASSETS_FURNITURE: 'tangibleFixedAssets',
  ACCUM_DEPRECIATION_VEHICLES: 'tangibleFixedAssets',
  ACCUM_DEPRECIATION_IT: 'tangibleFixedAssets',
  ACCUM_DEPRECIATION_EQUIPMENT: 'tangibleFixedAssets',
  ACCUM_DEPRECIATION_FURNITURE: 'tangibleFixedAssets',
  // Liabilities
  AP: 'payablesAndPrepayments',
  CUSTOMER_PREPAYMENTS: 'payablesAndPrepayments',
  VAT_PAYABLE: 'payablesAndPrepayments',
  DIVIDEND_PAYABLE: 'payablesAndPrepayments',
  DIVIDEND_WITHHOLDING_TAX_PAYABLE: 'payablesAndPrepayments',
  // Equity
  EQUITY: 'issuedCapital',
  OWNERS_DRAWINGS: 'retainedEarnings',
  RETAINED_EARNINGS: 'retainedEarnings',
  // Revenue
  REVENUE: 'revenue',
  // Expenses — skeem 1 by nature
  EXPENSE_SALARY: 'labourExpense',
  EXPENSE_CONTRACTOR: 'labourExpense',
  DEPRECIATION_EXPENSE: 'depreciation',
  EXPENSE_SOFTWARE: 'otherOperatingExpenses',
  EXPENSE_TRANSPORT: 'otherOperatingExpenses',
  EXPENSE_TRAVEL: 'otherOperatingExpenses',
  EXPENSE_MARKETING: 'otherOperatingExpenses',
  EXPENSE_RENT: 'otherOperatingExpenses',
  EXPENSE_TAX: 'otherOperatingExpenses',
  EXPENSE_BANK_FEE: 'otherOperatingExpenses',
  EXPENSE_MEALS: 'otherOperatingExpenses',
  EXPENSE_INSURANCE: 'otherOperatingExpenses',
  EXPENSE_EDUCATION: 'otherOperatingExpenses',
  EXPENSE_OTHER: 'otherOperatingExpenses',
  FX_GAIN_LOSS: 'otherOperatingExpenses',
  BAD_DEBT_EXPENSE: 'otherOperatingExpenses',
  GAIN_LOSS_ON_ASSET_DISPOSAL: 'otherOperatingExpenses',
};

/** A rolled-up RTJ line with current + prior totals. */
export interface RtjLineTotal {
  id: string;
  current: number;
  prior: number;
}

/**
 * Sum every mapped account balance into its RTJ line. Balances arrive
 * normal-side-positive; a contra-asset (`ACCUM_DEPRECIATION_*`) arrives
 * negative, so a plain add yields the book-value net.
 */
export function rollUpLines(balances: AccountBalanceRow[]): RtjLineTotal[] {
  const totals = new Map<string, RtjLineTotal>();
  for (const b of balances) {
    const lineId = ACCOUNT_TO_LINE[b.code];
    if (!lineId) continue;
    const t = totals.get(lineId) ?? { id: lineId, current: 0, prior: 0 };
    t.current += b.current;
    t.prior += b.prior;
    totals.set(lineId, t);
  }
  return [...totals.values()];
}

/** Codes whose current OR prior balance is nonzero but map to no RTJ line. */
export function unmappedNonzeroCodes(balances: AccountBalanceRow[]): string[] {
  return balances
    .filter((b) => !ACCOUNT_TO_LINE[b.code] && (b.current !== 0 || b.prior !== 0))
    .map((b) => b.code);
}
