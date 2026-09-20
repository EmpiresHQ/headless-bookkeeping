import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PostingService } from '../ledger/posting/posting.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { depreciationCharge } from '../fixed-assets/depreciation-engine';
import {
  AttributionRow,
  DepreciationAttributionService,
} from '../fixed-assets/depreciation-attribution.service';
import { addDays } from '../reporting-periods/period-dates';
import type {
  AccountBalanceRow,
  AnnualAccountsInput,
  AnnualAccountsResult,
  FixedAssetSnapshotRow,
  AnnualAccountsWarning,
} from '../plugins/annual-accounts.types';
import { AnnualAccountsRenderError } from '../plugins/annual-accounts.types';
import type { CountryPlugin } from '../plugins/country-plugin.interface';
import type { DraftVoucher } from '../ledger/voucher/types';

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
 * The CONTRIBUTED-capital equity accounts. Every other equity account holds
 * accumulated result (`RETAINED_EARNINGS`, and `OWNERS_DRAWINGS` for a sole
 * proprietor's drawings), so it belongs to the brought-forward-earnings line
 * rather than to capital. Splitting equity this way — instead of naming
 * `RETAINED_EARNINGS` alone — is what keeps a drawings balance inside reported
 * equity instead of dropping it out of the balance sheet (issue #206).
 */
const CAPITAL_ACCOUNT_CODES = ['EQUITY', 'SHARE_CAPITAL'];

/** The accumulated-profit account a closing sweep discharges the P&L into. */
const RETAINED_EARNINGS_CODE = 'RETAINED_EARNINGS';

/**
 * The documented `reason` prefix that marks a voucher as an explicit P&L →
 * retained-earnings closing transfer (see {@link ClosingTransfer}). A prefix
 * rather than an exact string, so the operator can name the year being swept:
 * `Closing transfer of retained earnings for 2026`.
 */
export const CLOSING_TRANSFER_REASON_PREFIX =
  'Closing transfer of retained earnings';

/**
 * The documented `reason` prefix of the annual-close depreciation voucher, which
 * names the period it was posted for: `Annual depreciation charge for FY2026`.
 *
 * It is the idempotency key of the close, and — for a year closed BEFORE the
 * financial-year scope existed, under a full-year VAT period's name — the only
 * mark that year's charge carries. Recognition is by prefix + date, never by the
 * exact current period name, so adopting a financial year for an already closed
 * year does not charge it a second time (issue #207). Disposal catch-up
 * depreciation (#208) carries its own distinct reason and is never matched.
 */
export const ANNUAL_DEPRECIATION_REASON_PREFIX =
  'Annual depreciation charge for ';

/**
 * The ISO day before `date` — the as-of cutoff for "everything posted BEFORE
 * this period", used to isolate what was attributed INSIDE the period.
 */
function priorDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * A posted P&L → retained-earnings CLOSING TRANSFER: an operator's explicit
 * year-end sweep of a closed year's result into accumulated profit.
 *
 * The kernel posts none of its own — ADR-0034 §3 deliberately has no year-end
 * sweep, and the sweep that opens the next year is out of the annual-accounts
 * PRD's scope — so a sweep, when it exists at all, is an operator's own
 * voucher. It still has to be told apart from ordinary activity, because its
 * P&L leg is NOT trading of the period it is dated in: booked on the closed
 * year's last day it would erase that year's reported profit, and booked on the
 * new year's opening day it would report the new year as an equal loss.
 *
 * Identity is EXPLICIT PERSISTED INTENT: the voucher `reason` starts with
 * {@link CLOSING_TRANSFER_REASON_PREFIX}. This is the same mechanism the annual
 * depreciation close in this service already relies on (see
 * `annualDepreciationReason`), and it is the only stable one available. The
 * shape of a sweep is not evidence of intent: `Dr OWNERS_DRAWINGS /
 * Cr EXPENSE_RENT` reclassifying a previously expensed personal purchase has
 * exactly the same two-account shape while genuinely reducing the year's
 * expense. Nor is a resulting zero P&L balance evidence: a real sale dated on
 * the same day as the sweep leaves a balance behind, and a later reversal
 * re-opens one, so a balance probe would classify the same voucher differently
 * depending on what else happened around it.
 *
 * A marked voucher is recognised only if it is also STRUCTURALLY a transfer:
 * every line on a revenue/expense account or on `RETAINED_EARNINGS`, with at
 * least one leg on EACH side. A marked reclassification between two expense
 * accounts has no retained leg and stays inside the income statement. A sweep's
 * counterpart is accumulated profit by definition, so no other equity account
 * qualifies (owner drawings never do), and a marked voucher that moves real
 * money stays ordinary activity rather than having a cash movement
 * reclassified out of the year's result.
 *
 * A REVERSAL of a recognised transfer — `reverses_id` pointing back at it, the
 * correction route ADR-0012/§8 prescribes — is recognised with it, carrying its
 * own sign and its own date. Otherwise reversing a sweep would restore the P&L
 * balance while the original stayed excluded, inventing trading income in the
 * year the correction was booked.
 *
 * An UNMARKED sweep is simply read as posted: its P&L leg counts in the period
 * it is dated in. Total equity is still right and the balance sheet still
 * balances — only the split between the brought-forward and current-result
 * lines follows the posting. Recognition only ever moves an amount BETWEEN
 * those two equity lines, so the accounting identity, and with it the
 * balance-sheet check, holds whichever way a voucher is classified. This is
 * presentation, never a balancing plug, and nothing posted is ever rewritten.
 */
interface ClosingTransfer {
  taxPointDate: string;
  /** The P&L legs, as their signed contribution to each account's NORMAL-side balance. */
  pnlLines: Array<{
    code: string;
    type: 'revenue' | 'expense';
    normalSide: number;
  }>;
}

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
 * A charge aggregated per asset class — the granularity both the virtual fold
 * and the posted annual-close voucher work at (one ACCUM line per class).
 */
interface ClassAnnualCharge {
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
 * only), folds in whatever part of it the ledger does not already carry,
 * renders, posts nothing.
 * final (finalize): posts that still-unposted charge as a system-generated
 * voucher, locks the year, then renders the identical numbers. A repeat draft
 * of a finalized year therefore reads the same figures: the charge is then
 * posted, so nothing more is virtualized (issue #205).
 */
@Injectable()
export class AnnualAccountsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
    private readonly orgResolver: OrgContextResolver,
    // WHICH posted depreciation belongs to WHICH asset (issue #208). The draft
    // needs it to net per asset rather than per class, and finalize needs it to
    // record the split of the voucher it posts.
    private readonly attribution: DepreciationAttributionService,
    // Only the finalize path (Task 8) posts/locks; optional so the draft path
    // (and its self-contained spec) construct without wiring these.
    @Optional() private readonly postingService?: PostingService,
    @Optional() private readonly reportingPeriods?: ReportingPeriodsService,
    // Only the finalize path records the year-end-adjustment notice (issue
    // #207); optional for the same reason as the two above.
    @Optional() private readonly auditFindings?: AuditFindingsService,
  ) {}

  async generate(periodId: number): Promise<AnnualAccountsResult> {
    const { input, plugin, diagnostics } = await this.assemble(
      periodId,
      'draft',
    );
    const result = this.render(plugin, input);
    return {
      artifacts: result.artifacts,
      warnings: [...diagnostics, ...result.warnings],
    };
  }

  /**
   * Render through the country plugin, translating the plugin's refusal to
   * render into a 400 that carries WHY.
   *
   * `AnnualAccountsRenderError` means the assembled input cannot produce a
   * filable instance at all — an impossible period date, a comparative that
   * overlaps the reported year, a declarant identity that is not a registry
   * code. Those are caller-fixable data problems with an actionable message,
   * so they must not reach the global filter as an opaque 500. Anything else
   * really is unexpected and keeps propagating.
   */
  private render(
    plugin: CountryPlugin,
    input: AnnualAccountsInput,
  ): AnnualAccountsResult {
    try {
      return plugin.generateAnnualAccounts(input, { taxonomyVersion: 2026 });
    } catch (e) {
      if (e instanceof AnnualAccountsRenderError) {
        throw new BadRequestException(
          `Cannot render annual accounts: ${e.message}`,
        );
      }
      throw e;
    }
  }

  /**
   * Finalize the year: hard-block on imbalance / unmapped-nonzero, post the
   * annual depreciation charge as ONE system-generated voucher, lock the year
   * via the existing period-lock, then render the authoritative XBRL with
   * numbers IDENTICAL to the draft. One-shot: an already-locked period is
   * rejected.
   */
  async finalize(periodId: number): Promise<AnnualAccountsResult> {
    if (!this.postingService || !this.reportingPeriods) {
      throw new Error(
        'AnnualAccountsService.finalize requires PostingService and ' +
          'ReportingPeriodsService to be wired',
      );
    }

    const period = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'status', 'name', 'start_date', 'end_date', 'kind'])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }
    // One-shot.
    if (period.status === 'locked') {
      throw new ConflictException(
        `Reporting period ${period.name} is already finalized (locked)`,
      );
    }

    // DEFENSE 1: check the close precondition BEFORE posting anything.
    // The close call (which we cannot wrap in our transaction, because it opens
    // its own better-sqlite3 transaction) throws a ConflictException when an
    // EARLIER period on the same timeline is still `open`. If we posted the
    // depreciation voucher first and then the close threw, the period would stay
    // `open` WITH the voucher already committed — and a retry would re-post it
    // (double-charged depreciation). Replicate the precondition here so the most
    // realistic close failure leaves zero partial state.
    //
    // Scoped by timeline (issue #207): closing FY2026 is blocked by an open
    // FY2025, not by an open November — the monthly VAT calendar files on its
    // own schedule and a financial year is normally closed long after, and
    // sometimes before, the months inside it are all filed.
    const earlierOpen = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name'])
      .where('status', '=', 'open')
      .where('kind', '=', period.kind)
      .where('start_date', '<', period.start_date)
      .orderBy('start_date', 'asc')
      .executeTakeFirst();
    if (earlierOpen) {
      throw new ConflictException(
        `Cannot finalize period ${period.name}: earlier period ${earlierOpen.name} is still open — finalize it first`,
      );
    }

    const { input, plugin, diagnostics, unpostedByClass, unpostedByAsset } =
      await this.assemble(periodId, 'final');

    // Render now so we can hard-block on plugin warnings too (unmapped
    // nonzero) — and so a renderer refusal lands BEFORE anything is posted or
    // locked, as a 400 naming the defect.
    const rendered = this.render(plugin, input);

    // HARD BLOCK: any kernel blocking diagnostic OR any plugin unmapped-nonzero.
    const blocking = diagnostics.filter((w) => w.severity === 'block');
    // A missing/invalid declarant registry code blocks too: the plugin hands
    // back no artifact at all in that case, so finalizing would lock the year
    // against nothing filable.
    const rejected = rendered.warnings.filter(
      (w) =>
        w.code === 'unmapped_nonzero_account' ||
        w.code === 'missing_declarant_reg_number' ||
        w.code === 'invalid_declarant_reg_number',
    );
    if (blocking.length > 0 || rejected.length > 0) {
      const reasons = [...blocking, ...rejected]
        .map((w) => w.message)
        .join('; ');
      throw new BadRequestException(
        `Cannot finalize annual accounts: ${reasons}`,
      );
    }

    // DEFENSE 2: idempotent depreciation guard. The annual-close voucher carries
    // a stable, period-scoped `reason` (see `annualDepreciationReason`). If a
    // prior finalize already posted it (e.g. it posted, then `lock` threw and the
    // period stayed open), `assemble` has already netted that posted charge out
    // of what remains to book — so `unpostedByClass` is empty and nothing is
    // re-posted here. Re-posting would double-charge depreciation. Disposal
    // catch-up depreciation also debits DEPRECIATION_EXPENSE, so the posted
    // charge is identified by that distinctive `reason` (not by the account),
    // which keeps the annual close and a disposal catch-up apart.
    const totalCharge = unpostedByClass.reduce((s, c) => s + c.chargeMinor, 0);
    if (totalCharge !== 0) {
      // One credit per class (ACCUM_*), one debit to DEPRECIATION_EXPENSE for
      // the total — covering only what the ledger does not already carry.
      const draft: DraftVoucher = {
        tax_point_date: period.end_date,
        reason: this.annualDepreciationReason(period.name),
        lines: [
          {
            account_code: 'DEPRECIATION_EXPENSE',
            is_debit: true,
            amount: totalCharge,
            currency: 'EUR',
            base_amount: totalCharge,
            fx_rate: 1,
            fx_rate_source: IDENTITY_RATE_SOURCE,
          },
          ...unpostedByClass.map((c) => ({
            account_code: ACCUM_BY_CLASS[c.assetClass],
            is_debit: false,
            amount: c.chargeMinor,
            currency: 'EUR',
            base_amount: c.chargeMinor,
            fx_rate: 1,
            fx_rate_source: IDENTITY_RATE_SOURCE,
          })),
        ],
      };
      // HOW a year-end adjustment reaches the ledger (issue #207).
      //
      // The charge is dated on the year's last day, and by the time a year is
      // closed that day usually sits inside an ALREADY FILED VAT period (the
      // December KMD is due on 20 January; the annual report up to six months
      // later). Posting it as ordinary system-generated activity would be
      // rejected by the locked-period rule, and no correct answer lies in
      // reopening the month or in moving the charge out of the year it belongs
      // to. So a financial-year close declares the `annual-close` capability
      // for the year it is closing. That declaration does not grant anything by
      // itself: PostingService validates the accounts and the VAT metadata and
      // PeriodLockService validates the year and the lock state, and only a
      // locked VAT period is ever relaxed — a CLOSED financial year is not.
      // The resulting voucher is stamped server-side, and VAT snapshots exclude
      // the stamped vouchers, so the filed December return keeps matching the
      // ledger exactly as frozen.
      //
      // A VAT-period finalize (the pre-#207 legacy path, still supported) keeps
      // posting as ordinary system-generated activity: it has no financial year
      // to claim, and it never needed the exception.
      // WHOSE charge this is, recorded atomically with the voucher (issue
      // #208). The lines stay per class — the voucher shape, the #207
      // `annual_close_period_id` stamp and the VAT-snapshot exception are
      // unchanged — while the split behind them is now persisted, so a later
      // disposal can deduct this asset's own charge instead of re-charging it.
      //
      // The split is written only when it RECONCILES to what is being posted.
      // When a legacy unattributed close inside the same year reduced the
      // class line below the sum of the per-asset remainders, which asset the
      // reduction belongs to is unknown; attributing anyway would claim more
      // than the voucher posted. The class is then left unattributed, which is
      // reported by the unattributed-depreciation endpoint and refuses a
      // dependent disposal until an allocation is supplied — rather than
      // quietly inventing a split.
      const postedByClassLine = new Map(
        unpostedByClass.map((c) => [c.assetClass, c.chargeMinor]),
      );
      const assetSharesByClass = new Map<AssetClass, AssetAnnualCharge[]>();
      for (const a of unpostedByAsset) {
        const list = assetSharesByClass.get(a.assetClass) ?? [];
        list.push(a);
        assetSharesByClass.set(a.assetClass, list);
      }
      const attributionRows: AttributionRow[] = [];
      for (const [cls, shares] of assetSharesByClass) {
        const sum = shares.reduce((s, a) => s + a.chargeMinor, 0);
        if (sum !== (postedByClassLine.get(cls) ?? 0)) continue;
        for (const a of shares) {
          attributionRows.push({
            fixedAssetId: a.assetId,
            voucherId: 0, // replaced with the posted voucher's id below
            amountMinor: a.chargeMinor,
            chargeThroughDate: period.end_date,
            source: 'annual_close',
          });
        }
      }

      await this.postingService.postVouchersAtomic(
        [draft],
        {
          afterPost: async (trx, vouchers) => {
            if (attributionRows.length === 0) return;
            await this.attribution.attributeTx(
              trx,
              attributionRows.map((r) => ({ ...r, voucherId: vouchers[0].id })),
            );
          },
        },
        period.kind === 'annual'
          ? { kind: 'annual-close', financialYearId: period.id }
          : { kind: 'system-generated' },
      );

      if (period.kind === 'annual') {
        const filedMonths = await this.filedVatPeriodsCovering(
          period.start_date,
          period.end_date,
        );
        if (filedMonths.length > 0 && this.auditFindings) {
          // Never silent: the one route that posts into a filed VAT period says
          // so, naming the months and the amount, so the exception is visible
          // in the same queue an operator already reviews.
          await this.auditFindings.create({
            finding_type: 'statutory_report_incomplete',
            // `low`: this is a NOTICE that the narrow year-end route was used,
            // not a defect. Nothing is due and nothing is wrong — but the one
            // posting that lands behind a filed return must be visible where an
            // operator already looks.
            severity: 'low',
            description:
              `Year-end adjustment of ${totalCharge} for financial year "${period.name}" was posted on ` +
              `${period.end_date}, inside already filed VAT period(s) ${filedMonths.join(', ')}. ` +
              `It touches only depreciation accounts and carries no VAT, so those returns' frozen ` +
              `snapshots are unchanged and no correction declaration is due.`,
          });
        }
      }
    }

    // Close the year. A FINANCIAL YEAR is closed through `closeFinancialYear`,
    // which only flips the status — it must not mint a KMD snapshot or a filing
    // payload for a year whose turnover the monthly returns already declared
    // (issue #207). A VAT period keeps being FILED through `lock`, snapshot and
    // all, so the legacy annual-accounts-over-a-VAT-period path is unchanged.
    if (period.kind === 'annual') {
      await this.reportingPeriods.closeFinancialYear(periodId);
    } else {
      await this.reportingPeriods.lock(periodId);
    }

    // Re-render with the SAME assembled input → identical numbers as the draft.
    return {
      artifacts: rendered.artifacts,
      warnings: [...diagnostics, ...rendered.warnings],
    };
  }

  /**
   * The names of the FILED VAT periods that overlap a financial year — the
   * months whose returns a year-end adjustment is posted "behind" (issue #207).
   * Used only to describe the audit finding; nothing about those returns is
   * read for figures, recomputed, re-frozen or rewritten.
   */
  private async filedVatPeriodsCovering(
    startDate: string,
    endDate: string,
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom('reporting_period')
      .select('name')
      .where('kind', '=', 'vat')
      .where('status', '=', 'locked')
      .where('start_date', '<=', endDate)
      .where('end_date', '>=', startDate)
      .orderBy('start_date', 'asc')
      .execute();
    return rows.map((r) => r.name);
  }

  /**
   * The stable, period-scoped `reason` stamped on the annual-close depreciation
   * voucher that `finalize` posts. It is the idempotency key: `finalize` looks
   * for an existing voucher with exactly this reason before posting, so a retry
   * after a failed `lock` does not double-charge depreciation. Disposal catch-up
   * vouchers debit the same expense account but never carry this reason.
   */
  private annualDepreciationReason(periodName: string): string {
    return `${ANNUAL_DEPRECIATION_REASON_PREFIX}${periodName}`;
  }

  /** Test seam: run the diagnostics over a hand-built input (Task 8 unit test). */
  diagnoseInput(input: AnnualAccountsInput): AnnualAccountsWarning[] {
    return this.diagnose(input);
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
    /**
     * The part of the year's engine charge the posted ledger does NOT yet carry,
     * per class — what `finalize` posts and what the draft folds in virtually.
     */
    unpostedByClass: ClassAnnualCharge[];
    /**
     * The same remainder PER ASSET — what `finalize` records as the attribution
     * of the voucher it posts, so the next disposal knows whose charge it was.
     */
    unpostedByAsset: AssetAnnualCharge[];
    period: { id: number; name: string; start_date: string; end_date: string };
  }> {
    const period = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date', 'status', 'kind'])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }

    // The comparative column is the previous period ON THE SAME TIMELINE
    // (issue #207). For a financial year that is the previous FINANCIAL YEAR —
    // never the nearest month, which is what picking the latest earlier period
    // of any kind returned once a monthly VAT calendar existed alongside the
    // year: RIK would have received "2026 vs December 2025". For a VAT period
    // it stays the previous VAT period, exactly as before.
    const prior = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date'])
      .where('kind', '=', period.kind)
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

    // ── Explicit closing transfers: equity movement, not trading. ──
    // An operator may sweep a closed year's P&L into retained earnings by hand,
    // dated either on the closed year's last day or on the new year's opening
    // day. Both are ordinary postings, and both would otherwise distort the
    // reported result of the year they fall in — the opening-day one turning an
    // empty year into a loss. Take their P&L legs out of the affected period's
    // flow; `closingTransferResult` then adds the same amount back on the
    // brought-forward line, so the two lines still sum to the same equity.
    const closingTransfers = await this.loadClosingTransfers(period.end_date);
    this.removeClosingTransferFlows(
      balances,
      closingTransfers,
      'current',
      period.start_date,
      period.end_date,
    );
    if (prior) {
      this.removeClosingTransferFlows(
        balances,
        closingTransfers,
        'prior',
        prior.start_date,
        prior.end_date,
      );
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

    // How much of this year's charge the POSTED ledger already carries, per
    // class — the annual-close voucher for this period, netted for its
    // reversals (issue #205). The balances above are read from that same
    // ledger, so only what is still UNPOSTED may be virtualized: folding the
    // full charge on top of an already-posted close double-counted it, and a
    // second download of a finalized year showed twice the depreciation.
    const { byClass: postedByClass, closeVoucherIds } =
      await this.postedAnnualDepreciation(period);
    const postedDepreciationMinor = [...postedByClass.values()].reduce(
      (s, v) => s + v,
      0,
    );

    // Netting is now PER ASSET (issue #208): what the ledger carries for an
    // asset is read from the attribution table, not inferred from the class
    // total, so one asset's posted charge can no longer cancel a peer's
    // unposted one. Only the part of a close that is NOT attributed to
    // individual assets — a legacy close from before migration 075 — still has
    // to be netted at class level, exactly as it was before.
    const attributedByAsset = await this.attributedInPeriod(
      assetRows.map((r) => r.id),
      period.start_date,
      period.end_date,
    );
    // Depreciation posted INSIDE this year that no asset owns. Only the year's
    // own window matters: an older ambiguity sits outside the period's ledger
    // balances and outside its netting, so it neither changes these figures nor
    // has any business blocking this year.
    const unattributedInPeriod = (
      await this.attribution.unattributedDepreciation(period.end_date)
    ).filter((u) => u.taxPointDate >= period.start_date);

    const attributedCloseByClass =
      await this.attribution.attributedByClass(closeVoucherIds);
    const unattributedCloseByClass = new Map<AssetClass, number>();
    for (const [cls, postedMinor] of postedByClass) {
      const gap = postedMinor - (attributedCloseByClass.get(cls) ?? 0);
      if (gap > 0) unattributedCloseByClass.set(cls, gap);
    }

    const { byClass: unpostedByClass, byAsset: unpostedByAsset } =
      this.unpostedCharges(
        charges,
        attributedByAsset,
        unattributedCloseByClass,
      );

    // Fold the still-unposted charge into the balances so draft == final
    // numbers, and so a repeat download after finalization adds nothing:
    //   Dr DEPRECIATION_EXPENSE (debit-normal +), Cr ACCUM_DEPRECIATION_* (asset, −).
    const virtualCharge = unpostedByClass.reduce(
      (s, c) => s + c.chargeMinor,
      0,
    );
    if (virtualCharge !== 0) {
      this.addToBalance(
        balances,
        'DEPRECIATION_EXPENSE',
        'expense',
        virtualCharge,
      );
      for (const c of unpostedByClass) {
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

    // ── Brought-forward earnings, complete (issue #206). ──
    // Two components, because the design has NO year-end sweep (ADR-0034 §3):
    //  (a) the closing balance of the accumulated-result equity accounts — what
    //      an explicit sweep, a dividend or a drawing has already moved there;
    //  (b) the cumulative result of every earlier date, which without a sweep is
    //      still sitting on the revenue/expense accounts. Reading only (a) is
    //      the bug: a closed profitable year left no trace in the next year's
    //      equity, so the next year could not balance or be finalized.
    // They cannot double-count: a sweep that raises (a) zeroes the very P&L it
    // came from, which is what (b) reads. Plus (c) the closing transfers dated
    // INSIDE this period, whose P&L legs were just taken out of the period's
    // flow above and belong here instead.
    const retainedEarningsBroughtForward =
      this.accumulatedResultEquity(balances, 'current') +
      (await this.cumulativeResultBefore(period.start_date)) +
      this.closingTransferResult(
        closingTransfers,
        period.start_date,
        period.end_date,
      );
    const priorRetainedEarningsBroughtForward = prior
      ? this.accumulatedResultEquity(balances, 'prior') +
        (await this.cumulativeResultBefore(prior.start_date)) +
        this.closingTransferResult(
          closingTransfers,
          prior.start_date,
          prior.end_date,
        )
      : 0;

    const input: AnnualAccountsInput = {
      period: {
        name: period.name,
        startDate: period.start_date,
        endDate: period.end_date,
      },
      priorPeriod: prior
        ? {
            name: prior.name,
            startDate: prior.start_date,
            endDate: prior.end_date,
          }
        : null,
      mode,
      balances,
      fixedAssets,
      periodNetIncome,
      priorNetIncome,
      retainedEarningsBroughtForward,
      priorRetainedEarningsBroughtForward,
      declarant: {
        // The COMMERCIAL REGISTRY code identifies the declarant in the business
        // register the annual report is filed with. The VAT number belongs to a
        // different register and is not a substitute (issue #204); the same
        // column already backs the KMD declarant identity.
        regNumber: organization.registry_code,
        name: organization.name,
      },
    };

    const diagnostics = this.diagnose(input, {
      virtualChargeMinor: virtualCharge,
      postedChargeMinor: postedDepreciationMinor,
      unattributed: unattributedInPeriod.map((u) => ({
        voucherId: u.voucherId,
        assetClass: u.assetClass,
        unattributedMinor: u.unattributedMinor,
      })),
    });

    return {
      input,
      plugin,
      diagnostics,
      unpostedByClass,
      unpostedByAsset,
      period,
    };
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

  /**
   * What the POSTED ledger already charges as this YEAR's annual-close
   * depreciation, per asset class, in normal (credit) direction.
   *
   * Identity is an annual close dated INSIDE the reported span — either a
   * voucher this kernel stamped (`annual_close_period_id`, issue #207) or one
   * carrying the documented {@link ANNUAL_DEPRECIATION_REASON_PREFIX}. It is
   * deliberately NOT "the close posted under this period's exact name":
   * an upgraded database can hold a year already closed over a legacy full-year
   * VAT period ("Annual depreciation charge for 2026") which the operator then
   * adopts a financial year for ("FY2026") — the same twelve months, a different
   * period name. Matching the name alone made that year's charge invisible, so
   * the report added the whole charge on top of the one the ledger already
   * carried (double depreciation) and a finalize posted a second voucher.
   *
   * The account is still not the identity: disposal catch-up depreciation
   * (#208) debits the very same DEPRECIATION_EXPENSE and credits the same
   * ACCUM_* accounts, carries neither the stamp nor the reason, and must keep
   * counting as ordinary activity rather than being swept into the annual
   * total. A reversal of a recognised close is included with its own sign
   * (`voucher.reverses_id` points back at it), so a reversal booked INSIDE the
   * year nets the close back to zero and its charge becomes virtual again
   * rather than silently disappearing from the report.
   *
   * The window is the reported span [start_date, end_date] — the year whose
   * charge this nets. Closing it at the START as well as the end is what keeps
   * an EARLIER year's close (its own charge, already reflected in the opening
   * accumulated balance) from being subtracted from this year's. A reversal
   * booked in a LATER year is outside the window, so it is excluded here exactly
   * as it is excluded from the period's ledger balances — a later correction
   * does not retroactively rewrite an already-filed year's report.
   *
   * Unposted (`posted_at IS NULL`) vouchers carry no balance, so they are
   * excluded — the ledger balances this nets against only count posted lines.
   */
  private async postedAnnualDepreciation(period: {
    name: string;
    start_date: string;
    end_date: string;
  }): Promise<{ byClass: Map<AssetClass, number>; closeVoucherIds: number[] }> {
    const closeVouchers = await this.db
      .selectFrom('voucher')
      .select('id')
      .where('posted_at', 'is not', null)
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .where((eb) =>
        eb.or([
          eb('annual_close_period_id', 'is not', null),
          eb('reason', 'like', `${ANNUAL_DEPRECIATION_REASON_PREFIX}%`),
        ]),
      )
      .execute();
    const posted = new Map<AssetClass, number>();
    if (closeVouchers.length === 0)
      return { byClass: posted, closeVoucherIds: [] };

    const closeIds = closeVouchers.map((v) => v.id);
    const reversals = await this.db
      .selectFrom('voucher')
      .select('id')
      .where('reverses_id', 'in', closeIds)
      .where('posted_at', 'is not', null)
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .execute();

    const accumCodes = Object.values(ACCUM_BY_CLASS);
    const lines = await this.db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(['a.code', 'vl.base_amount', 'vl.is_debit'])
      .where('vl.voucher_id', 'in', [
        ...closeIds,
        ...reversals.map((r) => r.id),
      ])
      .where('a.code', 'in', accumCodes)
      .execute();

    for (const line of lines) {
      const cls = (Object.keys(ACCUM_BY_CLASS) as AssetClass[]).find(
        (c) => ACCUM_BY_CLASS[c] === line.code,
      );
      if (!cls) continue;
      // Credit accumulates the contra-asset; a debit (the reversal) undoes it.
      const signed = line.is_debit ? -line.base_amount : line.base_amount;
      posted.set(cls, (posted.get(cls) ?? 0) + signed);
    }
    return { byClass: posted, closeVoucherIds: closeIds };
  }

  /**
   * The part of the year's charge that is NOT yet in the ledger, computed PER
   * ASSET and then aggregated to the class the voucher posts at.
   *
   * Per asset, because the voucher's lines are per class but the charge is not:
   * netting a class total against a class total let one asset's already-posted
   * charge cancel a LIVING PEER's unposted one, so the peer silently went
   * uncharged for the year. Each asset's remainder is floored at zero on its
   * own (`charge − attributed`), so an over-charged asset can no longer absorb
   * a peer's charge — an already-posted close is immutable history and is never
   * virtually un-posted.
   *
   * `unattributedCloseByClass` is what a close inside this year posted but
   * could not be attributed to individual assets — a legacy close from before
   * migration 075 whose split would not re-derive. That part can only be netted
   * at class level, exactly as this method netted every charge before.
   *
   * Class-level netting is not a figure anyone may FILE: if the asset the
   * legacy close charged has since been retired, the netting comes off a living
   * peer's charge instead. So a year with unattributed depreciation inside it
   * raises a BLOCKING `depreciation_unattributed` diagnostic (see
   * {@link diagnose}), which stops `finalize` and marks the draft incomplete.
   * What survives here is only the DRAFT's view of such a year — the same
   * numbers it showed before — presented as blocked rather than as complete.
   */
  private unpostedCharges(
    charges: AssetAnnualCharge[],
    attributedByAsset: Map<number, number>,
    unattributedCloseByClass: Map<AssetClass, number>,
  ): { byClass: ClassAnnualCharge[]; byAsset: AssetAnnualCharge[] } {
    const byAsset: AssetAnnualCharge[] = [];
    const chargeByClass = new Map<AssetClass, number>();
    for (const c of charges) {
      const remaining = Math.max(
        0,
        c.chargeMinor - (attributedByAsset.get(c.assetId) ?? 0),
      );
      if (remaining === 0) continue;
      byAsset.push({ ...c, chargeMinor: remaining });
      chargeByClass.set(
        c.assetClass,
        (chargeByClass.get(c.assetClass) ?? 0) + remaining,
      );
    }

    const byClass: ClassAnnualCharge[] = [];
    for (const [assetClass, chargeMinor] of chargeByClass) {
      const remaining =
        chargeMinor - (unattributedCloseByClass.get(assetClass) ?? 0);
      if (remaining > 0) byClass.push({ assetClass, chargeMinor: remaining });
    }
    return { byClass, byAsset };
  }

  /**
   * Depreciation already ATTRIBUTED to each asset by a voucher dated inside
   * this period — what the ledger demonstrably carries for that asset this
   * year, reversal-netted as of the period end (issue #208).
   *
   * It covers a close posted by an earlier finalize attempt (the #205 retry)
   * and the catch-up a disposal posted during the year. The latter matters in
   * both directions: the disposed asset's own charge must not be posted a
   * second time by the close, and — because each asset nets only against its
   * own attribution — the disposal must not swallow a living peer's charge.
   */
  private async attributedInPeriod(
    assetIds: number[],
    startDate: string,
    endDate: string,
  ): Promise<Map<number, number>> {
    const throughEnd = await this.attribution.postedByAsset(assetIds, endDate);
    const beforeStart = await this.attribution.postedByAsset(
      assetIds,
      priorDay(startDate),
    );
    const inPeriod = new Map<number, number>();
    for (const id of assetIds) {
      inPeriod.set(id, (throughEnd.get(id) ?? 0) - (beforeStart.get(id) ?? 0));
    }
    return inPeriod;
  }

  /**
   * Every posted closing transfer dated up to `endDate`, plus the posted
   * reversals of those transfers — see {@link ClosingTransfer} for what
   * identifies one and why.
   *
   * The `reason`-marked vouchers are found first, their reversals are looked up
   * through `reverses_id`, and the whole set is then checked structurally: a
   * voucher counts only if every line is on a revenue/expense account or on
   * `RETAINED_EARNINGS`, with at least one of each. A reversal is kept only
   * when the transfer it reverses was itself kept, so the pair always nets.
   *
   * The `tax_point_date <= endDate` window is the same one the balances this is
   * netted against are read through, so a correction booked in a LATER year
   * does not retroactively rewrite an already-filed year's report.
   */
  private async loadClosingTransfers(
    endDate: string,
  ): Promise<ClosingTransfer[]> {
    const marked = await this.db
      .selectFrom('voucher')
      .select('id')
      .where('posted_at', 'is not', null)
      .where('tax_point_date', '<=', endDate)
      .where('reason', 'like', `${CLOSING_TRANSFER_REASON_PREFIX}%`)
      .execute();
    if (marked.length === 0) return [];
    const markedIds = marked.map((v) => v.id);

    const reversals = await this.db
      .selectFrom('voucher')
      .select(['id', 'reverses_id'])
      .where('posted_at', 'is not', null)
      .where('tax_point_date', '<=', endDate)
      .where('reverses_id', 'in', markedIds)
      .execute();

    const lines = await this.db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .select([
        'v.id as voucherId',
        'v.tax_point_date as taxPointDate',
        'a.code',
        'a.type',
        'vl.base_amount',
        'vl.is_debit',
      ])
      .where('v.id', 'in', [...markedIds, ...reversals.map((r) => r.id)])
      .execute();

    const byVoucher = new Map<
      number,
      {
        taxPointDate: string;
        pnlLines: ClosingTransfer['pnlLines'];
        /** Nothing on the voucher but P&L accounts and RETAINED_EARNINGS. */
        structural: boolean;
        /** RETAINED_EARNINGS is actually one of them. */
        hasRetainedLeg: boolean;
      }
    >();
    for (const line of lines) {
      let entry = byVoucher.get(line.voucherId);
      if (!entry) {
        entry = {
          taxPointDate: line.taxPointDate,
          pnlLines: [],
          structural: true,
          hasRetainedLeg: false,
        };
        byVoucher.set(line.voucherId, entry);
      }
      if (line.type === 'revenue' || line.type === 'expense') {
        // Normal side: revenue is credit-positive, expense debit-positive.
        const normalSide =
          line.type === 'revenue'
            ? line.is_debit
              ? -line.base_amount
              : line.base_amount
            : line.is_debit
              ? line.base_amount
              : -line.base_amount;
        entry.pnlLines.push({ code: line.code, type: line.type, normalSide });
      } else if (line.code === RETAINED_EARNINGS_CODE) {
        entry.hasRetainedLeg = true;
      } else {
        // Real money, or another equity account: an adjustment, not a sweep.
        entry.structural = false;
      }
    }

    /**
     * Marked (or reversing) AND structurally a transfer: BOTH sides present —
     * at least one P&L leg and the RETAINED_EARNINGS leg — and nothing else on
     * the voucher. Requiring the retained leg is what keeps a marked P&L-only
     * reclassification (say `Dr EXPENSE_RENT / Cr EXPENSE_OTHER`) out: it moves
     * an amount between income-statement categories and must stay in them.
     */
    const keep = (id: number): boolean => {
      const entry = byVoucher.get(id);
      return (
        entry !== undefined &&
        entry.structural &&
        entry.hasRetainedLeg &&
        entry.pnlLines.length > 0
      );
    };

    const recognised = new Set<number>(markedIds.filter(keep));
    for (const r of reversals) {
      // A reversal only counts alongside the transfer it undoes.
      if (
        r.reverses_id !== null &&
        recognised.has(r.reverses_id) &&
        keep(r.id)
      ) {
        recognised.add(r.id);
      }
    }

    return [...recognised].map((id) => {
      const entry = byVoucher.get(id) as {
        taxPointDate: string;
        pnlLines: ClosingTransfer['pnlLines'];
      };
      return { taxPointDate: entry.taxPointDate, pnlLines: entry.pnlLines };
    });
  }

  /**
   * Take the P&L legs of the closing transfers dated in [`startDate`,`endDate`]
   * out of that column's revenue/expense flows, so the reported income
   * statement is the period's own trading and its sub-items still sum to the
   * reported result (the XBRL calculation linkbase checks exactly that).
   *
   * Nothing posted is rewritten: the vouchers stay in the ledger untouched and
   * the amount reappears on the brought-forward line.
   */
  private removeClosingTransferFlows(
    balances: AccountBalanceRow[],
    transfers: ClosingTransfer[],
    field: 'current' | 'prior',
    startDate: string,
    endDate: string,
  ): void {
    for (const t of transfers) {
      if (t.taxPointDate < startDate || t.taxPointDate > endDate) continue;
      for (const line of t.pnlLines) {
        const row = balances.find((b) => b.code === line.code);
        if (row) row[field] -= line.normalSide;
      }
    }
  }

  /**
   * The net result (credit-positive) carried by the closing transfers dated in
   * [`startDate`,`endDate`] — the amount {@link removeClosingTransferFlows}
   * took off the period's trading result, which belongs on the brought-forward
   * line instead.
   */
  private closingTransferResult(
    transfers: ClosingTransfer[],
    startDate: string,
    endDate: string,
  ): number {
    let total = 0;
    for (const t of transfers) {
      if (t.taxPointDate < startDate || t.taxPointDate > endDate) continue;
      for (const line of t.pnlLines) {
        // Credit-positive result: a revenue normal-side balance adds, an
        // expense normal-side balance subtracts.
        total += line.type === 'revenue' ? line.normalSide : -line.normalSide;
      }
    }
    return total;
  }

  /**
   * The closing balance of the accumulated-result equity accounts — all equity
   * except {@link CAPITAL_ACCOUNT_CODES} — credit-positive.
   */
  private accumulatedResultEquity(
    balances: AccountBalanceRow[],
    field: 'current' | 'prior',
  ): number {
    return balances
      .filter(
        (b) => b.type === 'equity' && !CAPITAL_ACCOUNT_CODES.includes(b.code),
      )
      .reduce((sum, b) => sum + b[field], 0);
  }

  /**
   * The cumulative result (revenue − expense, credit-positive) of every posted
   * line dated strictly BEFORE `startDate` — the part of earlier years' profit
   * or loss that no closing sweep ever moved off the P&L accounts, and which
   * the balance sheet must still carry as accumulated equity.
   *
   * The window is closed at the day before `startDate` rather than at the prior
   * reporting period's end, so a voucher dated in a gap between periods — or
   * before any period was ever created — is counted exactly once instead of
   * vanishing.
   */
  private async cumulativeResultBefore(startDate: string): Promise<number> {
    return this.ledgerBalance.getLedgerNetForPeriod(
      { types: ['revenue', 'expense'] },
      { endDate: addDays(startDate, -1) },
      { creditPositive: true },
    );
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
   *  - depreciation still unposted (register has assets, charge virtualized) — soft,
   *  - depreciation already posted by a prior close — soft (positive evidence),
   *  - register-vs-ledger cost mismatch — soft.
   */
  protected diagnose(
    input: AnnualAccountsInput,
    depreciation?: {
      virtualChargeMinor: number;
      postedChargeMinor: number;
      /**
       * Depreciation posted INSIDE the reported year that is not attributed to
       * individual assets (issue #208) — see the `depreciation_unattributed`
       * diagnostic below.
       */
      unattributed?: Array<{
        voucherId: number;
        assetClass: string;
        unattributedMinor: number;
      }>;
    },
  ): DiagnosticWarning[] {
    const warnings: DiagnosticWarning[] = [];

    // 1. Balance-sheet balance. Assets (debit-normal +) must equal
    //    liabilities + equity, where equity = capital + brought-forward retained
    //    + period result (the three live lines, ADR §3).
    const sum = (pred: (b: AccountBalanceRow) => boolean): number =>
      input.balances.filter(pred).reduce((s, b) => s + b.current, 0);
    const assets = sum((b) => b.type === 'asset');
    const liabilities = sum((b) => b.type === 'liability');
    // Equity live lines (ADR-0034 §3): contributed capital + COMPLETE
    // brought-forward earnings + the period's own result. The brought-forward
    // figure already carries every non-capital equity account and the unswept
    // prior P&L, so capital here is only the contributed-capital accounts —
    // counting any other equity account here too would count it twice.
    const capital = input.balances
      .filter(
        (b) => b.type === 'equity' && CAPITAL_ACCOUNT_CODES.includes(b.code),
      )
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

    // 3. Depreciation posting status (soft). In draft the still-unposted part of
    //    the year's charge is folded in virtually, so say so — but ONLY while
    //    something really is unposted. After a successful close the charge is in
    //    the ledger and nothing is virtualized, and the report says that instead
    //    of claiming an unposted charge that does not exist (issue #205).
    const liveAssets = input.fixedAssets.filter((a) => !a.retired).length;
    // With no assembly context (the `diagnoseInput` seam) fall back to the
    // register-only signal.
    const hasUnpostedCharge = depreciation
      ? depreciation.virtualChargeMinor !== 0
      : true;
    if (liveAssets > 0 && input.mode === 'draft' && hasUnpostedCharge) {
      warnings.push({
        code: 'depreciation_not_yet_posted',
        message: `${liveAssets} asset(s) in the register; annual depreciation is computed virtually and not yet posted`,
        severity: 'soft',
      });
    }
    // 3b. Unattributed depreciation inside the reported year — BLOCKING.
    //
    // While some of the year's posted depreciation cannot be tied to
    // individual assets, this year's charge cannot be computed correctly, in
    // either direction:
    //  - a hand-posted charge is not netted at all, so the close would post
    //    the asset's FULL year on top of it and over-charge the year;
    //  - an unattributed legacy close can only be netted at class level, and
    //    if the asset it charged has since been retired, that netting comes
    //    off a LIVING PEER's charge and silently under-charges the year.
    // Neither is a figure to file, and neither is a warning to attach to one:
    // a `block` stops `finalize` outright, and the draft says the same thing
    // rather than presenting the numbers as complete. Already-finalized years
    // still render (a locked period is refused by `finalize`, not by this),
    // and nothing posted is rewritten — the fix is an allocation, through
    // POST /api/fixed-assets/depreciation-allocations.
    for (const u of depreciation?.unattributed ?? []) {
      warnings.push({
        code: 'depreciation_unattributed',
        message:
          `Voucher ${u.voucherId} posts ${u.unattributedMinor} of ${u.assetClass} ` +
          `depreciation inside ${input.period.name} that is not attributed to individual ` +
          `assets, so this year's charge cannot be computed. Allocate it ` +
          `(POST /api/fixed-assets/depreciation-allocations) and retry.`,
        severity: 'block',
      });
    }

    if (depreciation && depreciation.postedChargeMinor !== 0) {
      warnings.push({
        code: 'depreciation_already_posted',
        message: `Annual depreciation of ${depreciation.postedChargeMinor} for ${input.period.name} is already posted to the ledger; only ${depreciation.virtualChargeMinor} is added virtually`,
        severity: 'soft',
      });
    }

    // 4. Register-vs-ledger cost mismatch (soft): Σ register cost per class vs
    //    the FIXED_ASSETS_* ledger balance per class.
    const ledgerByClass: Record<string, number> = {
      vehicle:
        input.balances.find((b) => b.code === 'FIXED_ASSETS_VEHICLES')
          ?.current ?? 0,
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
