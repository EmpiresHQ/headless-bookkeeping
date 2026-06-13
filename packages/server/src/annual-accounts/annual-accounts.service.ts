import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PostingService } from '../ledger/posting/posting.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { depreciationCharge } from '../fixed-assets/depreciation-engine';
import type {
  AccountBalanceRow,
  AnnualAccountsInput,
  AnnualAccountsResult,
  FixedAssetSnapshotRow,
  AnnualAccountsWarning,
} from '../plugins/annual-accounts.types';
import type { CountryPlugin } from '../plugins/country-plugin.interface';

/**
 * A kernel diagnostic warning. {@link AnnualAccountsWarning} (= StatutoryWarning)
 * has no `severity`; the kernel adds an optional structural extension so
 * `finalize` (Task 8) can hard-block on `severity: 'block'` while soft signals
 * pass through. Structurally assignable to `AnnualAccountsWarning[]`.
 */
type DiagnosticWarning = AnnualAccountsWarning & {
  severity?: 'block' | 'soft';
};

/** The asset classes the kernel knows about (mirrors the `fixed_asset` register). */
type AssetClass = 'vehicle' | 'it_equipment' | 'machinery' | 'furniture';

/** The fixed-asset → contra-account map for posting/virtualizing depreciation. */
const ACCUM_BY_CLASS: Record<AssetClass, string> = {
  vehicle: 'ACCUM_DEPRECIATION_VEHICLES',
  it_equipment: 'ACCUM_DEPRECIATION_IT',
  machinery: 'ACCUM_DEPRECIATION_EQUIPMENT',
  furniture: 'ACCUM_DEPRECIATION_FURNITURE',
};

/**
 * The year's depreciation charge for one register row, with the asset's identity
 * kept alongside the engine's pure result. Produced by the local
 * {@link AnnualAccountsService.computeYearCharges} helper.
 */
interface AssetAnnualCharge {
  assetId: number;
  assetClass: AssetClass;
  chargeMinor: number;
}

/**
 * AnnualAccountsService — assembles a NEUTRAL {@link AnnualAccountsInput} from the
 * posted ledger + the fixed-asset register and delegates ALL jurisdiction
 * rendering to the active country plugin (ADR-0034), mirroring
 * StatutoryReportService.
 *
 * draft (generate): computes the annual depreciation charge VIRTUALLY (engine
 * only), folds it into the balances, renders, posts nothing.
 * final (finalize): posts the depreciation charge as a system-generated
 * voucher, locks the year, then renders the identical numbers.
 */
@Injectable()
export class AnnualAccountsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
    private readonly orgResolver: OrgContextResolver,
    // Only the finalize path (Task 8) posts/locks; optional so the draft path
    // (and its self-contained spec) construct without wiring these.
    @Optional() private readonly postingService?: PostingService,
    @Optional() private readonly reportingPeriods?: ReportingPeriodsService,
  ) {}

  async generate(periodId: number): Promise<AnnualAccountsResult> {
    const { input, plugin, diagnostics } = await this.assemble(periodId, 'draft');
    const result = plugin.generateAnnualAccounts(input, { taxonomyVersion: 2026 });
    return {
      artifacts: result.artifacts,
      warnings: [...diagnostics, ...result.warnings],
    };
  }

  /**
   * The shared assembly used by both modes. Builds the neutral input with the
   * annual depreciation charge folded in VIRTUALLY (so draft and final read
   * identical numbers), plus the kernel diagnostics (Task 7).
   */
  private async assemble(
    periodId: number,
    mode: 'draft' | 'final',
  ): Promise<{
    input: AnnualAccountsInput;
    plugin: CountryPlugin;
    diagnostics: DiagnosticWarning[];
    charges: AssetAnnualCharge[];
    period: { id: number; name: string; start_date: string; end_date: string };
  }> {
    const period = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date', 'status'])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }

    const prior = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date'])
      .where('end_date', '<', period.start_date)
      .orderBy('end_date', 'desc')
      .executeTakeFirst();

    const { organization, plugin } = await this.orgResolver.resolve();

    // ── Load every account, compute current + prior closing/flow balances. ──
    const accounts = await this.db
      .selectFrom('account')
      .select(['code', 'type'])
      .execute();

    const balances: AccountBalanceRow[] = [];
    for (const a of accounts) {
      const type = a.type as AccountBalanceRow['type'];
      const isPnl = type === 'revenue' || type === 'expense';
      const creditPositive =
        type === 'liability' || type === 'equity' || type === 'revenue';

      // Balance-sheet accounts: cumulative-to-date (no startDate).
      // P&L accounts: in-year flow (startDate..endDate).
      const current = await this.ledgerBalance.getLedgerNetForPeriod(
        { codes: [a.code] },
        isPnl
          ? { startDate: period.start_date, endDate: period.end_date }
          : { endDate: period.end_date },
        { creditPositive },
      );
      const prior_ = prior
        ? await this.ledgerBalance.getLedgerNetForPeriod(
            { codes: [a.code] },
            isPnl
              ? { startDate: prior.start_date, endDate: prior.end_date }
              : { endDate: prior.end_date },
            { creditPositive },
          )
        : 0;
      balances.push({ code: a.code, type, current, prior: prior_ });
    }

    // ── Fixed-asset register snapshot + virtual annual depreciation. ──
    const assetRows = await this.db
      .selectFrom('fixed_asset')
      .select([
        'id',
        'asset_class',
        'acquisition_date',
        'cost_base_minor',
        'useful_life_years',
        'residual_value_minor',
        'retired_at',
      ])
      .execute();

    // The year's charge per asset = accumulated(periodEnd) − accumulated(priorEnd).
    // `priorPeriodEnd` is the prior reporting period's end (null ⇒ first operating
    // year ⇒ charge from acquisition). Each register row is passed straight to the
    // engine: its 7 fields structurally satisfy the engine's 4-field
    // DepreciableAsset param, and we keep id + asset_class alongside the result.
    const charges = this.computeYearCharges(
      assetRows,
      prior ? prior.end_date : null,
      period.end_date,
    );

    // Fold the virtual charge into the balances so draft == final numbers:
    //   Dr DEPRECIATION_EXPENSE (debit-normal +), Cr ACCUM_DEPRECIATION_* (asset, −).
    const totalCharge = charges.reduce((s, c) => s + c.chargeMinor, 0);
    if (totalCharge !== 0) {
      this.addToBalance(balances, 'DEPRECIATION_EXPENSE', 'expense', totalCharge);
      for (const c of charges) {
        // Contra-asset: a credit reduces the normal-side-positive asset balance.
        this.addToBalance(
          balances,
          ACCUM_BY_CLASS[c.assetClass],
          'asset',
          -c.chargeMinor,
        );
      }
    }

    const fixedAssets: FixedAssetSnapshotRow[] = assetRows.map((r) => ({
      id: r.id,
      assetClass: r.asset_class as FixedAssetSnapshotRow['assetClass'],
      costMinor: r.cost_base_minor,
      retired: r.retired_at !== null,
    }));

    // ── Net income (revenue − expense), including the virtual depreciation. ──
    const periodNetIncome = this.netIncome(balances, 'current');
    const priorNetIncome = this.netIncome(balances, 'prior');

    // Retained earnings brought forward = RETAINED_EARNINGS closing balance.
    const retainedEarningsBroughtForward =
      balances.find((b) => b.code === 'RETAINED_EARNINGS')?.current ?? 0;

    const input: AnnualAccountsInput = {
      period: {
        name: period.name,
        startDate: period.start_date,
        endDate: period.end_date,
      },
      priorPeriod: prior
        ? { name: prior.name, startDate: prior.start_date, endDate: prior.end_date }
        : null,
      mode,
      balances,
      fixedAssets,
      periodNetIncome,
      priorNetIncome,
      retainedEarningsBroughtForward,
      declarant: {
        regNumber: organization.vat_registration_number,
        name: organization.name,
      },
    };

    const diagnostics = this.diagnose(input);

    return { input, plugin, diagnostics, charges, period };
  }

  /**
   * The year's depreciation charge per (non-retired) register row, wrapping the
   * pure engine's {@link depreciationCharge}. The charge is the change in
   * accumulated depreciation between the prior period end and this period end:
   * `depreciationCharge(row, priorPeriodEnd, periodEnd)` = accumulated(periodEnd)
   * − accumulated(priorPeriodEnd). `priorPeriodEnd === null` ⇒ first operating
   * year ⇒ charge accrues from acquisition. Each `fixed_asset` row carries the
   * engine's four math fields (plus id/asset_class/retired_at), so it satisfies
   * the engine's `DepreciableAsset` param by structural typing — we pass the row
   * directly and keep `id` + `asset_class` alongside the returned `chargeMinor`.
   */
  private computeYearCharges(
    rows: Array<{
      id: number;
      asset_class: string;
      acquisition_date: string;
      cost_base_minor: number;
      useful_life_years: number;
      residual_value_minor: number;
      retired_at: number | null;
    }>,
    priorPeriodEnd: string | null,
    periodEnd: string,
  ): AssetAnnualCharge[] {
    const charges: AssetAnnualCharge[] = [];
    for (const row of rows) {
      if (row.retired_at !== null) continue; // retired assets accrue no charge
      const chargeMinor = depreciationCharge(row, priorPeriodEnd, periodEnd);
      charges.push({
        assetId: row.id,
        assetClass: row.asset_class as AssetClass,
        chargeMinor,
      });
    }
    return charges;
  }

  private addToBalance(
    balances: AccountBalanceRow[],
    code: string,
    type: AccountBalanceRow['type'],
    deltaCurrent: number,
  ): void {
    const existing = balances.find((b) => b.code === code);
    if (existing) {
      existing.current += deltaCurrent;
    } else {
      balances.push({ code, type, current: deltaCurrent, prior: 0 });
    }
  }

  /** Net income = Σ revenue (credit-positive) − Σ expense (debit-positive). */
  private netIncome(
    balances: AccountBalanceRow[],
    field: 'current' | 'prior',
  ): number {
    let revenue = 0;
    let expense = 0;
    for (const b of balances) {
      if (b.type === 'revenue') revenue += b[field];
      if (b.type === 'expense') expense += b[field];
    }
    return revenue - expense;
  }

  /**
   * Jurisdiction-neutral draft diagnostics. The RTJ-map-dependent
   * unmapped-nonzero check is owned by the PLUGIN (it warns during render);
   * `finalize` re-reads those plugin warnings to hard-block (Task 8). Here the
   * kernel checks only arithmetic invariants + soft signals:
   *  - balance-sheet balance (Aktiva == Kohustused + Omakapital) — BLOCK,
   *  - EXPENSE_OTHER concentration — soft,
   *  - depreciation not yet posted (register has assets, no ACCUM voucher) — soft,
   *  - register-vs-ledger cost mismatch — soft.
   */
  protected diagnose(input: AnnualAccountsInput): DiagnosticWarning[] {
    const warnings: DiagnosticWarning[] = [];

    // 1. Balance-sheet balance. Assets (debit-normal +) must equal
    //    liabilities + equity, where equity = capital + brought-forward retained
    //    + period result (the three live lines, ADR §3).
    const sum = (pred: (b: AccountBalanceRow) => boolean): number =>
      input.balances.filter(pred).reduce((s, b) => s + b.current, 0);
    const assets = sum((b) => b.type === 'asset');
    const liabilities = sum((b) => b.type === 'liability');
    // Equity live lines: EQUITY (capital) + RETAINED_EARNINGS brought forward
    // + period net income. (RETAINED_EARNINGS current = brought forward in v1.)
    const capital = input.balances
      .filter((b) => b.type === 'equity' && b.code !== 'RETAINED_EARNINGS')
      .reduce((s, b) => s + b.current, 0);
    const equity =
      capital + input.retainedEarningsBroughtForward + input.periodNetIncome;
    if (assets !== liabilities + equity) {
      warnings.push({
        code: 'balance_sheet_imbalance',
        message: `Balance sheet does not balance: assets ${assets} != liabilities ${liabilities} + equity ${equity}`,
        severity: 'block',
      });
    }

    // 2. EXPENSE_OTHER concentration (soft): > 50% of total expense.
    const totalExpense = input.balances
      .filter((b) => b.type === 'expense')
      .reduce((s, b) => s + b.current, 0);
    const other =
      input.balances.find((b) => b.code === 'EXPENSE_OTHER')?.current ?? 0;
    if (totalExpense > 0 && other / totalExpense > 0.5) {
      warnings.push({
        code: 'expense_other_concentration',
        message: `EXPENSE_OTHER is ${Math.round((other / totalExpense) * 100)}% of total expenses`,
        severity: 'soft',
      });
    }

    // 3. Depreciation not yet posted (soft): register has live assets but the
    //    ledger ACCUM_DEPRECIATION_* lines for the period are absent. In draft
    //    the charge is virtual, so this signal fires whenever no real ACCUM
    //    voucher has been posted for the period's depreciation.
    const liveAssets = input.fixedAssets.filter((a) => !a.retired).length;
    if (liveAssets > 0 && input.mode === 'draft') {
      warnings.push({
        code: 'depreciation_not_yet_posted',
        message: `${liveAssets} asset(s) in the register; annual depreciation is computed virtually and not yet posted`,
        severity: 'soft',
      });
    }

    // 4. Register-vs-ledger cost mismatch (soft): Σ register cost per class vs
    //    the FIXED_ASSETS_* ledger balance per class.
    const ledgerByClass: Record<string, number> = {
      vehicle:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_VEHICLES')?.current ??
        0,
      it_equipment:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_IT')?.current ?? 0,
      machinery:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_EQUIPMENT')
          ?.current ?? 0,
      furniture:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_FURNITURE')
          ?.current ?? 0,
    };
    const registerByClass: Record<string, number> = {};
    for (const a of input.fixedAssets) {
      if (a.retired) continue;
      registerByClass[a.assetClass] =
        (registerByClass[a.assetClass] ?? 0) + a.costMinor;
    }
    for (const cls of Object.keys(ledgerByClass)) {
      if ((registerByClass[cls] ?? 0) !== ledgerByClass[cls]) {
        warnings.push({
          code: 'register_ledger_cost_mismatch',
          message: `Fixed-asset register cost for ${cls} (${registerByClass[cls] ?? 0}) != ledger (${ledgerByClass[cls]})`,
          severity: 'soft',
        });
      }
    }

    return warnings;
  }
}
