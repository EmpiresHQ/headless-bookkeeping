import type {
  StatutoryReportArtifact,
  StatutoryWarning,
} from './statutory-report.types';

/** Reuse the artifact/warning shapes so the two seams stay parallel. */
export type AnnualAccountsArtifact = StatutoryReportArtifact;
export type AnnualAccountsWarning = StatutoryWarning;

/** A single account's signed balances for the period and the comparative prior. */
export interface AccountBalanceRow {
  /** Kernel account code, e.g. "EQUITY", "REVENUE", "FIXED_ASSETS_VEHICLES". */
  code: string;
  /** Account type, for type-keyed roll-up fallbacks. */
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  /**
   * Closing balance at period end, base-currency minor units, NORMAL-SIDE
   * positive: assets/expenses debit-positive, liabilities/equity/revenue
   * credit-positive. A normal asset balance is +; a normal liability is +.
   */
  current: number;
  /** Same convention, at the comparative prior period end. Zero for a first year. */
  prior: number;
}

/** A capitalized asset's register snapshot, neutral (no jurisdiction depreciation method). */
export interface FixedAssetSnapshotRow {
  id: number;
  assetClass: 'vehicle' | 'it_equipment' | 'machinery' | 'furniture';
  /** Original cost, base-currency minor units, from the acquisition voucher. */
  costMinor: number;
  /** Whether the asset is retired (disposed) — excluded from live põhivara. */
  retired: boolean;
}

/** Jurisdiction-neutral input the kernel assembles and the plugin renders. */
export interface AnnualAccountsInput {
  /** Reporting year being closed. */
  period: { name: string; startDate: string; endDate: string };
  /** Comparative prior year. `null` ⇒ first operating year (zero prior column). */
  priorPeriod: { name: string; startDate: string; endDate: string } | null;
  mode: 'draft' | 'final';
  /** Every account with activity, with current + prior normal-side balances. */
  balances: AccountBalanceRow[];
  /** Register snapshot for põhivara/kulum lines + register-vs-ledger checks. */
  fixedAssets: FixedAssetSnapshotRow[];
  /** Period net income (revenue − expense), credit-positive, base minor units. */
  periodNetIncome: number;
  /** Prior-year net income, credit-positive. Zero for a first year. */
  priorNetIncome: number;
  /** Retained earnings brought forward (RETAINED_EARNINGS closing), credit-positive. */
  retainedEarningsBroughtForward: number;
  /** Declarant identity for the XBRL entity context. */
  declarant: { regNumber: string | null; name: string | null };
}

export interface AnnualAccountsOpts {
  /** Pinned taxonomy version. v1 only supports 2026. */
  taxonomyVersion: 2026;
}

export interface AnnualAccountsResult {
  artifacts: AnnualAccountsArtifact[];
  warnings: AnnualAccountsWarning[];
}
