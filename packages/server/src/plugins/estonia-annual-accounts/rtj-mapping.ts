import type { AccountBalanceRow } from '../annual-accounts.types';

/** Which statement a line belongs to, and its normal accumulation side. */
export interface RtjLineDef {
  id: string;
  /**
   * The concept as declared by the official `et-gaap_2026-01-01` taxonomy,
   * prefixed `et-gaap:`. Every name here exists in RIK's
   * `et-gaap-cor_2026-01-01.xsd`; the test suite validates rendered instances
   * against that schema, so a name invented here fails the build.
   */
  concept: string;
  /** Human label (Estonian). */
  label: string;
  statement: 'balanceSheet' | 'incomeStatement';
  /** Which signed direction is the LEDGER line's normal positive. */
  normalSide: 'debit' | 'credit';
  /**
   * Multiplier taking the ledger's normal-side-positive balance to the sign the
   * taxonomy expects. The et-gaap income-statement expense concepts are
   * declared `xbrli:balance="credit"` and enter `TotalProfitLoss` with
   * calculation weight +1, so an expense is REPORTED NEGATIVE; the ledger
   * carries it debit-positive. (Verified with Arelle against the official
   * `cal_IncomeStatementScheme1_role-301011` linkbase: positive expenses raise
   * `xbrl.5.2.5.2:calcInconsistency`, negative expenses validate clean.)
   */
  reportedSign: 1 | -1;
}

/**
 * The väikeettevõtja line set rendered in v1, mapped onto the balance-sheet
 * form [201012] and income-statement scheme 1 [301011] of the official
 * taxonomy. IDs are stable internal keys. Totals/subtotals follow the
 * taxonomy's calculation linkbase and are computed in the renderer.
 */
export const RTJ_LINES: Record<string, RtjLineDef> = {
  // ── Balance sheet — Aktiva (assets, debit-normal) ──
  cashAndBankAccounts: {
    id: 'cashAndBankAccounts',
    concept: 'et-gaap:CashAndCashEquivalents',
    label: 'Raha',
    statement: 'balanceSheet',
    normalSide: 'debit',
    reportedSign: 1,
  },
  receivablesAndPrepayments: {
    id: 'receivablesAndPrepayments',
    concept: 'et-gaap:ShortTermReceivablesAndPrepayments',
    label: 'Nõuded ja ettemaksed',
    statement: 'balanceSheet',
    normalSide: 'debit',
    reportedSign: 1,
  },
  inventories: {
    id: 'inventories',
    concept: 'et-gaap:Inventories',
    label: 'Varud',
    statement: 'balanceSheet',
    normalSide: 'debit',
    reportedSign: 1,
  },
  tangibleFixedAssets: {
    id: 'tangibleFixedAssets',
    concept: 'et-gaap:PropertyPlantAndEquipment',
    label: 'Materiaalne põhivara',
    statement: 'balanceSheet',
    normalSide: 'debit',
    reportedSign: 1,
  },
  // ── Balance sheet — Kohustused (liabilities, credit-normal) ──
  payablesAndPrepayments: {
    id: 'payablesAndPrepayments',
    concept: 'et-gaap:ShortTermPayablesAndPrepayments',
    label: 'Võlad ja ettemaksed',
    statement: 'balanceSheet',
    normalSide: 'credit',
    reportedSign: 1,
  },
  // ── Balance sheet — Omakapital (equity, credit-normal) ──
  issuedCapital: {
    id: 'issuedCapital',
    concept: 'et-gaap:IssuedCapital',
    label: 'Osakapital',
    statement: 'balanceSheet',
    normalSide: 'credit',
    reportedSign: 1,
  },
  retainedEarnings: {
    id: 'retainedEarnings',
    concept: 'et-gaap:RetainedEarningsLoss',
    label: 'Eelmiste perioodide jaotamata kasum (kahjum)',
    statement: 'balanceSheet',
    normalSide: 'credit',
    reportedSign: 1,
  },
  profitForPeriod: {
    id: 'profitForPeriod',
    concept: 'et-gaap:AnnualPeriodProfitLoss',
    label: 'Aruandeaasta kasum (kahjum)',
    statement: 'balanceSheet',
    normalSide: 'credit',
    reportedSign: 1,
  },
  // ── Income statement — skeem 1 (by nature) ──
  revenue: {
    id: 'revenue',
    concept: 'et-gaap:Revenue',
    label: 'Müügitulu',
    statement: 'incomeStatement',
    normalSide: 'credit',
    reportedSign: 1,
  },
  otherOperatingExpenses: {
    id: 'otherOperatingExpenses',
    concept: 'et-gaap:OtherOperatingExpense',
    label: 'Mitmesugused tegevuskulud',
    statement: 'incomeStatement',
    normalSide: 'debit',
    reportedSign: -1,
  },
  labourExpense: {
    id: 'labourExpense',
    concept: 'et-gaap:EmployeeExpense',
    label: 'Tööjõukulud',
    statement: 'incomeStatement',
    normalSide: 'debit',
    reportedSign: -1,
  },
  depreciation: {
    id: 'depreciation',
    concept: 'et-gaap:DepreciationAndImpairmentLossReversal',
    label: 'Põhivara kulum',
    statement: 'incomeStatement',
    normalSide: 'debit',
    reportedSign: -1,
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
    .filter(
      (b) => !ACCOUNT_TO_LINE[b.code] && (b.current !== 0 || b.prior !== 0),
    )
    .map((b) => b.code);
}
