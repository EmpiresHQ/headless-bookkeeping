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
  /**
   * The period's own trading result (revenue − expense), credit-positive, base
   * minor units. An explicit P&L → retained-earnings CLOSING TRANSFER dated
   * inside the period is excluded: it moves an earlier year's result into
   * equity rather than being trading activity of this one. The `balances` rows
   * for revenue/expense accounts carry the same exclusion, so this figure is
   * exactly their signed sum.
   */
  periodNetIncome: number;
  /** Prior-year trading result, credit-positive, on the same basis. Zero for a first year. */
  priorNetIncome: number;
  /**
   * COMPLETE accumulated earnings brought forward into the period, credit-
   * positive: the closing balance of the accumulated-result equity accounts
   * (`RETAINED_EARNINGS`, `OWNERS_DRAWINGS` — every equity account that is not
   * contributed capital) PLUS the cumulative result of all earlier periods that
   * is still sitting on the revenue/expense accounts because no closing sweep
   * moved it (ADR-0034 §3 deliberately has no year-end sweep).
   *
   * Both parts are needed and neither double-counts the other: a closing
   * transfer that swept an earlier year zeroes that year's P&L accounts and
   * raises the retained balance by the same amount, so whichever way the books
   * are kept — swept, unswept, or mixed across years — the sum is the same
   * (issue #206). A dividend or drawing charged to equity reduces it once.
   */
  retainedEarningsBroughtForward: number;
  /**
   * The same figure for the COMPARATIVE column: accumulated earnings brought
   * forward into the prior period. Zero when there is no prior period. It is
   * NOT derivable from the prior retained balance minus `priorNetIncome` —
   * that assumes the balance already absorbed the prior result, which it only
   * does when a sweep happened to be posted.
   */
  priorRetainedEarningsBroughtForward: number;
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

/**
 * A country plugin refusing to render: the assembled input cannot produce a
 * filable document at all (an impossible period date, a comparative period
 * that overlaps the reported year, a declarant identity that is not a valid
 * registry code). It lives in the NEUTRAL contract rather than in a plugin so
 * the kernel can recognise a caller-fixable refusal without importing any
 * jurisdiction's module, and answer 400 instead of 500.
 */
export class AnnualAccountsRenderError extends Error {}
