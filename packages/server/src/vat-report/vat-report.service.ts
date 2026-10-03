import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import {
  VatReport,
  VatSummaryLine,
  KmdDeclaration,
  ComputedVatReport,
  VatReportPreview,
} from './types';
import { computeVoucherHash } from '../ledger/posting/voucher-hash';
import { computeMerkleRoot } from './merkle';
import { PrepaymentAllocationRepository } from '../reconciliation/prepayment-allocation.repository';

/**
 * What one {@link VatReportService.freeze} did: the snapshot the period should
 * now be filed against, whether it was newly inserted, and the drifted snapshot
 * it replaced (retained, immutable, simply no longer current).
 */
export interface FreezeResult {
  report: VatReport;
  created: boolean;
  superseded: VatReport | null;
}

/**
 * One voucher's contribution to the reverse-charge acquisition base whose
 * ORIGIN row the ledger does not record (issue #210), with the links a
 * resolution can travel: the voucher it reverses, if it is a reversal.
 */
interface AmbiguousVoucher {
  voucherNumber: string;
  reversesId: number | null;
  base: number;
}

/**
 * A VAT declaration exists for the VAT calendar only (issue #207). A FINANCIAL
 * YEAR declares nothing of its own — its turnover was already declared by the
 * monthly returns inside it — so every VAT entry point refuses an annual id
 * rather than manufacturing a second, overlapping return for the same turnover.
 * This is the same refusal `ReportingPeriodsService.lock` makes, placed on the
 * paths that reach a snapshot or a declaration without going through it.
 */
function assertVatPeriod(period: { id: number; kind: string }): void {
  if (period.kind === 'annual') {
    throw new ConflictException(
      `Reporting period ${period.id} is a financial year — it carries no VAT declaration.`,
    );
  }
}

@Injectable()
export class VatReportService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
    private readonly pluginLoader: PluginLoader,
    private readonly organization: OrganizationService,
    private readonly prepaymentAdvances: PrepaymentAllocationRepository,
  ) {}

  /**
   * Generate an immutable VAT report snapshot for a reporting period.
   *
   * Queries all posted vouchers whose tax_point_date falls within the period
   * range, joins voucher_line, groups by vat_code summing base_amount into
   * input (debit) vs output (credit), computes total_payable/total_receivable,
   * and stores the snapshot with a Merkle root over the covered Vouchers.
   *
   * Year-end adjustments posted by a financial-year close
   * (`voucher.annual_close_period_id`, issue #207) belong to neither set: they
   * carry no VAT and are excluded from both the boxes and the covered set.
   *
   * Two distinct Voucher sets are involved (ADR-0009 / ADR-0013):
   *  - the COVERED set = every Voucher whose tax-point date falls in the
   *    Reporting period (regardless of whether it carries a VAT-control line).
   *    This is what `voucher_ids` records and what the Merkle root commits to.
   *  - the VAT-BOX contributors = only the VAT-control lines
   *    (VAT_RECEIVABLE / VAT_PAYABLE) within those vouchers. Only these feed
   *    the declaration box amounts.
   *
   * Idempotent: if a snapshot already exists for this period, returns the
   * existing frozen report unchanged (same Merkle root, never recomputed).
   */
  /**
   * Freeze the snapshot a period is FILED against, and hand back what changed.
   *
   * Reuse-if-identical, append-if-drifted (issue #200):
   *  - recompute the period's current figures;
   *  - compare them against the period's CANDIDATE snapshot — the one the
   *    period is bound to if it has one, else the most recent row;
   *  - identical ⇒ return that row untouched (so filing stays idempotent and
   *    no duplicate rows accumulate);
   *  - different (or none) ⇒ INSERT a new snapshot and report the drifted one
   *    as `superseded`.
   *
   * A drifted row is never edited and never deleted — `vat_report` is immutable
   * by trigger (ADR-0009) and the submission events that pin it keep pointing at
   * the exact artifact they filed. It is simply no longer the current one, which
   * is what stops a snapshot frozen by an earlier draft export from being filed
   * as if it were complete.
   */
  async freeze(
    periodId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<FreezeResult> {
    const computed = await this.compute(periodId, executor);
    const candidate = await this.candidateSnapshot(periodId, executor);

    if (candidate && this.matchesComputed(candidate, computed)) {
      return { report: candidate, created: false, superseded: null };
    }

    const row = await executor
      .insertInto('vat_report')
      .values({
        reporting_period_id: periodId,
        period_name: computed.period_name,
        start_date: computed.start_date,
        end_date: computed.end_date,
        vat_summary: JSON.stringify(computed.vat_summary),
        total_input_vat: computed.total_input_vat,
        total_output_vat: computed.total_output_vat,
        total_payable: computed.total_payable,
        total_receivable: computed.total_receivable,
        voucher_ids: JSON.stringify(computed.voucher_ids),
        merkle_root: computed.merkle_root,
        generated_at: Math.floor(Date.now() / 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      report: this.mapRow(row),
      created: true,
      superseded: candidate,
    };
  }

  /**
   * FREEZES a snapshot for the period and returns it.
   *
   * A `locked` period returns the exact snapshot it was filed against, always
   * and unchanged — a filed return must stay reproducible (ADR-0009) and no
   * later call may repoint it (use {@link ReportingPeriodsService.reconcileFilingSnapshot}
   * for the audited repair path). An OPEN period delegates to {@link freeze}:
   * an identical existing snapshot is returned as-is, a drifted one is
   * superseded by a fresh, complete snapshot.
   *
   * Because the freeze is permanent, do NOT call this just to look at the
   * figures: use {@link preview}, which computes the same numbers and stores
   * nothing.
   */
  async generate(
    periodId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<VatReport> {
    const period = await executor
      .selectFrom('reporting_period')
      .select(['id', 'name', 'status', 'kind', 'vat_report_snapshot_id'])
      .where('id', '=', periodId)
      .executeTakeFirst();

    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }
    assertVatPeriod(period);

    if (period.status === 'locked' && period.vat_report_snapshot_id !== null) {
      const bound = await executor
        .selectFrom('vat_report')
        .selectAll()
        .where('id', '=', period.vat_report_snapshot_id)
        .executeTakeFirst();
      if (bound) return this.mapRow(bound);
    }

    return (await this.freeze(periodId, executor)).report;
  }

  /**
   * The snapshot a fresh freeze is measured against: the one the period is
   * bound to, else the most recently frozen row for the period.
   */
  private async candidateSnapshot(
    periodId: number,
    executor: Kysely<Database>,
  ): Promise<VatReport | null> {
    const period = await executor
      .selectFrom('reporting_period')
      .select(['vat_report_snapshot_id'])
      .where('id', '=', periodId)
      .executeTakeFirst();

    const row = period?.vat_report_snapshot_id
      ? await executor
          .selectFrom('vat_report')
          .selectAll()
          .where('id', '=', period.vat_report_snapshot_id)
          .executeTakeFirst()
      : await executor
          .selectFrom('vat_report')
          .selectAll()
          .where('reporting_period_id', '=', periodId)
          .orderBy('id', 'desc')
          .executeTakeFirst();

    return row ? this.mapRow(row) : null;
  }

  /**
   * Does a stored snapshot still say exactly what the period says now? Compares
   * every filed figure AND the covered-voucher commitment — a snapshot with the
   * same totals but a different voucher set is NOT the same filing.
   */
  private matchesComputed(
    snapshot: VatReport,
    computed: ComputedVatReport,
  ): boolean {
    const boxes = (lines: VatSummaryLine[]): string =>
      JSON.stringify(
        [...lines].sort((a, b) =>
          (a.vat_code ?? '').localeCompare(b.vat_code ?? ''),
        ),
      );

    return (
      snapshot.period_name === computed.period_name &&
      snapshot.start_date === computed.start_date &&
      snapshot.end_date === computed.end_date &&
      snapshot.total_input_vat === computed.total_input_vat &&
      snapshot.total_output_vat === computed.total_output_vat &&
      snapshot.total_payable === computed.total_payable &&
      snapshot.total_receivable === computed.total_receivable &&
      snapshot.merkle_root === computed.merkle_root &&
      JSON.stringify(snapshot.voucher_ids) ===
        JSON.stringify(computed.voucher_ids) &&
      boxes(snapshot.vat_summary) === boxes(computed.vat_summary)
    );
  }

  /**
   * Read-only view of what the period currently declares. Computes exactly what
   * {@link generate} would freeze, but stores nothing — safe to call as often as
   * you like while the period is still open and vouchers keep moving.
   *
   * `frozen_snapshot_id` names the snapshot this period would be measured
   * against right now — the one it is BOUND to if it has been filed, else the
   * most recently frozen row. When it is non-null the live figures below may
   * differ from that snapshot's. For a locked period that difference is a real
   * problem (a filed period's ledger cannot move) and the statutory export
   * raises `filing_snapshot_drift` for it; for an open period it just means a
   * snapshot was frozen early, and the next freeze will supersede it rather
   * than hand it back.
   */
  async preview(
    periodId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<VatReportPreview> {
    const computed = await this.compute(periodId, executor);

    const frozen = await this.candidateSnapshot(periodId, executor);

    return { ...computed, frozen_snapshot_id: frozen?.id ?? null };
  }

  /**
   * The pure computation behind both {@link generate} and {@link preview}:
   * aggregate the period's posted vouchers into VAT boxes and a Merkle root.
   * Reads only — it never writes.
   */
  private async compute(
    periodId: number,
    executor: Kysely<Database>,
  ): Promise<ComputedVatReport> {
    // Fetch the period to get its date range
    const period = await executor
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date', 'kind'])
      .where('id', '=', periodId)
      .executeTakeFirst();

    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }
    assertVatPeriod(period);

    // Query all voucher lines from posted vouchers within the period range,
    // joined to the account so we can isolate the VAT-control lines.
    const lines = await executor
      .selectFrom('voucher_line as vl')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select([
        'vl.vat_code',
        'vl.base_amount',
        'vl.is_debit',
        'a.code as account_code',
      ])
      .where('v.tax_point_date', '>=', period.start_date)
      .where('v.tax_point_date', '<=', period.end_date)
      .where('v.posted_at', 'is not', null)
      .where('v.annual_close_period_id', 'is', null)
      .execute();

    // Group by vat_code. The VAT *amount* per code is the balance of the
    // VAT-control accounts only (VAT_RECEIVABLE = input, VAT_PAYABLE = output);
    // the taxable-base lines (expense/revenue) and non-VAT control lines (AP,
    // AR, BANK — which the pipeline tags 'NULL_STANDARD') must NOT be summed
    // here or the report counts the base as VAT. Netting is signed so a
    // reversal of a VAT line correctly subtracts.
    const summaryMap = new Map<string, VatSummaryLine>();

    for (const line of lines) {
      if (line.vat_code === null || line.vat_code === undefined) continue;

      const isInputVat = line.account_code === 'VAT_RECEIVABLE';
      const isOutputVat = line.account_code === 'VAT_PAYABLE';
      if (!isInputVat && !isOutputVat) continue;

      const key = line.vat_code;
      const existing_line = summaryMap.get(key) ?? {
        vat_code: key,
        input_vat: 0,
        output_vat: 0,
        line_count: 0,
      };

      if (isInputVat) {
        // VAT_RECEIVABLE is debit-normal: input VAT = debits − credits. The
        // signed-sum convention lives in LedgerBalanceService.
        existing_line.input_vat += this.ledgerBalance.signedBaseAmount(line);
      } else {
        // VAT_PAYABLE is credit-normal: output VAT = credits − debits.
        existing_line.output_vat += this.ledgerBalance.signedBaseAmount(line, {
          creditPositive: true,
        });
      }
      existing_line.line_count += 1;

      summaryMap.set(key, existing_line);
    }

    const vatSummary: VatSummaryLine[] = Array.from(summaryMap.values());

    // Compute totals
    const total_input_vat = vatSummary.reduce((sum, l) => sum + l.input_vat, 0);
    const total_output_vat = vatSummary.reduce(
      (sum, l) => sum + l.output_vat,
      0,
    );
    const total_payable = total_output_vat - total_input_vat;
    const total_receivable = total_input_vat - total_output_vat;

    // COVERED set: every posted Voucher whose tax-point date falls in the
    // period — queried directly from `voucher`, NOT derived from the
    // VAT-control lines above. A Voucher with no VAT_RECEIVABLE / VAT_PAYABLE
    // line (e.g. a non-VAT cash transfer) still belongs to the period and must
    // be covered by the snapshot and its Merkle root (CONTEXT.md: "the exact
    // set of included Vouchers"). Ordered by id ascending — this is the fixed,
    // deterministic Merkle leaf order (ADR-0013).
    const coveredVouchers = await executor
      .selectFrom('voucher')
      .select([
        'id',
        'voucher_number',
        'tax_point_date',
        'posted_at',
        'previous_hash',
      ])
      .where('tax_point_date', '>=', period.start_date)
      .where('tax_point_date', '<=', period.end_date)
      .where('posted_at', 'is not', null)
      // YEAR-END ADJUSTMENTS ARE NOT VAT ACTIVITY (issue #207). A voucher
      // carrying `annual_close_period_id` was posted by the close of a
      // financial year through the narrowly validated route that cannot touch a
      // VAT-control account or carry VAT metadata — so it moves no declaration
      // box, by construction. It is excluded here, uniformly, on every read of
      // every period: which is what lets the annual close post the December
      // depreciation charge months after the December KMD was filed WITHOUT the
      // filed snapshot drifting away from the ledger. Nothing about the frozen
      // return is touched, recomputed or superseded — it simply keeps matching.
      // The adjustment's own integrity is carried by the voucher hash chain
      // (ADR-0013) and by the annual accounts it was posted for.
      .where('annual_close_period_id', 'is', null)
      .orderBy('id', 'asc')
      .execute();

    const voucherIds = coveredVouchers.map((v) => v.id);

    // Merkle root over exactly the covered Vouchers. Each leaf is the
    // per-Voucher hash of the hash-chained voucher log (REUSED via
    // computeVoucherHash) — not a second hashing scheme. Empty period ⇒ null;
    // single Voucher ⇒ its own leaf hash (handled in computeMerkleRoot).
    const leafHashes: string[] = [];
    for (const v of coveredVouchers) {
      const voucherLines = await executor
        .selectFrom('voucher_line')
        .select([
          'account_id',
          'amount',
          'currency',
          'base_amount',
          'fx_rate',
          'is_debit',
        ])
        .where('voucher_id', '=', v.id)
        .orderBy('id', 'asc')
        .execute();

      leafHashes.push(
        computeVoucherHash(
          v,
          voucherLines.map((l) => ({
            account_id: l.account_id,
            amount: l.amount,
            currency: l.currency,
            base_amount: l.base_amount,
            fx_rate: l.fx_rate,
            is_debit: l.is_debit === 1,
          })),
        ),
      );
    }

    const merkleRoot = computeMerkleRoot(leafHashes);

    return {
      reporting_period_id: periodId,
      period_name: period.name,
      start_date: period.start_date,
      end_date: period.end_date,
      vat_summary: vatSummary,
      total_input_vat,
      total_output_vat,
      total_payable,
      total_receivable,
      voucher_ids: voucherIds,
      merkle_root: merkleRoot,
    };
  }

  /**
   * Fetch a VAT report by its ID.
   */
  async getById(id: number): Promise<VatReport> {
    const row = await this.db
      .selectFrom('vat_report')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`VAT report ${id} not found`);
    }

    return this.mapRow(row);
  }

  /**
   * List all VAT report snapshots, ordered by reporting period (then id for
   * a stable order when a period has more than one snapshot, e.g. an amended
   * return).
   */
  async list(): Promise<VatReport[]> {
    const rows = await this.db
      .selectFrom('vat_report')
      .selectAll()
      .orderBy('reporting_period_id')
      .orderBy('id')
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Fetch the list of voucher IDs included in a VAT report.
   */
  async getVoucherIds(id: number): Promise<number[]> {
    const report = await this.getById(id);
    return report.voucher_ids;
  }

  /**
   * Build the jurisdiction VAT-return (KMD) declaration for a period — a
   * DERIVED, read-only view over the period's posted vouchers (not the stored
   * snapshot, which only carries VAT amounts; the declaration also needs the
   * taxable BASE per line).
   *
   * Division of labour (ADR-0002): the country plugin classifies each taxable
   * base VAT code onto its return rows ({@link CountryPluginRetrieval.classifyKmd});
   * this method stays jurisdiction-agnostic — it routes the VAT-control lines to
   * the output/input VAT totals by account code and the base lines to the rows
   * the plugin names, then collects the plugin's review notes.
   */
  async buildDeclaration(
    periodId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<KmdDeclaration> {
    const period = await executor
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date', 'kind'])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }
    assertVatPeriod(period);

    const org = await this.organization.getOrganization(executor);
    const plugin = this.pluginLoader.resolve(org.country);

    const lines = await executor
      .selectFrom('voucher_line as vl')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select([
        'vl.vat_code',
        'vl.base_amount',
        'vl.is_debit',
        'a.code as account_code',
        'v.id as voucher_id',
        'v.voucher_number',
        'v.reverses_id',
      ])
      .where('v.tax_point_date', '>=', period.start_date)
      .where('v.tax_point_date', '<=', period.end_date)
      .where('v.posted_at', 'is not', null)
      .where('v.annual_close_period_id', 'is', null)
      .execute();

    const d: KmdDeclaration = {
      reporting_period_id: period.id,
      period_name: period.name,
      start_date: period.start_date,
      end_date: period.end_date,
      row1_base_24: 0,
      row2_base_reduced: 0,
      row2_base_9: 0,
      row2_base_13: 0,
      row3_base_zero: 0,
      row3_1_intra_eu_supply: 0,
      row4_output_vat: 0,
      row5_input_vat: 0,
      row6_intra_eu_acquisition: 0,
      row7_other_acquisition: 0,
      row6_7_unresolved_acquisition: 0,
      unresolved_acquisition_vouchers: [],
      unresolved_advance_receipts: [],
      unresolved_advance_base: 0,
      unsupported_advance_reversals: [],
      net_vat_due: 0,
      vd_intra_eu_services: 0,
      review_flags: [],
    };
    const flags = new Set<string>();
    // Per-VOUCHER bookkeeping for the acquisition-origin ambiguity (issue
    // #210). A signed period total is not evidence about it: two unrelated
    // legacy movements of +100 and −100 net to zero while the rows they belong
    // to are still +100 and −100. So the ambiguity is resolved per voucher and
    // per reversal chain, not by cancellation.
    const legacyByVoucher = new Map<number, AmbiguousVoucher>();
    // Originals (outside this period) that a line here reverses and that were
    // already FILED under a payload frozen before the acquisition origin was
    // recorded. Removing such an acquisition is not a new classification — it
    // comes back out of the row that filing actually declared it in, which is
    // recorded evidence rather than a guess. The plugin decides which row that
    // is; the kernel only establishes the fact.
    const filedWithoutOrigin = await this.originalsFiledWithoutOrigin(
      lines,
      executor,
    );

    for (const line of lines) {
      // VAT-control lines feed the VAT-amount totals (rows 4 / 5), keyed on
      // account code — independent of jurisdiction.
      if (line.account_code === 'VAT_PAYABLE') {
        d.row4_output_vat += this.ledgerBalance.signedBaseAmount(line, {
          creditPositive: true,
        });
        continue;
      }
      if (line.account_code === 'VAT_RECEIVABLE') {
        d.row5_input_vat += this.ledgerBalance.signedBaseAmount(line);
        continue;
      }

      if (!line.vat_code) continue;
      const k = plugin.classifyKmd(line.vat_code, {
        reversesVoucherFiledWithoutAcquisitionOrigin:
          line.reverses_id !== null && filedWithoutOrigin.has(line.reverses_id),
      });
      // Fix the normal side by classification: acquisitions are debit-positive,
      // supplies credit-positive. Reversals must subtract from the same base.
      const base = this.ledgerBalance.signedBaseAmount(line, {
        creditPositive: k.acquisitionRow === null,
      });
      // An acquisition whose ROW the plugin cannot decide is still an
      // acquisition (hence debit-positive above): it lands in its own bucket
      // rather than in whichever row happens to be the default (issue #210).
      if (k.review) flags.add(k.review);

      switch (k.outputBaseRow) {
        case 1:
          d.row1_base_24 += base;
          break;
        case 2:
          d.row2_base_reduced += base;
          if (plugin.getVatRate(line.vat_code) === 0.09) d.row2_base_9 += base;
          if (plugin.getVatRate(line.vat_code) === 0.13) d.row2_base_13 += base;
          break;
        case 3:
          d.row3_base_zero += base;
          // Within row 3, the plugin names the sub-row (EE: '3.1') when the
          // supply is an intra-Community one. A third-country export names none.
          if (k.outputSubRow === '3.1') d.row3_1_intra_eu_supply += base;
          break;
      }
      if (k.acquisitionRow === 6) d.row6_intra_eu_acquisition += base;
      if (k.acquisitionRow === 7) d.row7_other_acquisition += base;
      if (k.acquisitionRow === 'unresolved') {
        d.row6_7_unresolved_acquisition += base;
        const seen = legacyByVoucher.get(line.voucher_id) ?? {
          voucherNumber: line.voucher_number,
          reversesId: line.reverses_id,
          base: 0,
        };
        seen.base += base;
        legacyByVoucher.set(line.voucher_id, seen);
      }
      if (k.vdCode === '3S') d.vd_intra_eu_services += base;
    }

    // Customer advances RECEIVED in this period that nobody has classified
    // (issue #213). A payment for an identified taxable supply is a tax point
    // in ITSELF, so an unclassified receipt is an open question about THIS
    // return: it either declared VAT it should have, or left out VAT it owed,
    // and the books do not say which. It is reported and named, never quietly
    // assumed non-taxable — the same treatment #210 gives an acquisition whose
    // row is unknown.
    const heldAdvances = await this.prepaymentAdvances.listHeldCustomerAdvances(
      period.start_date,
      period.end_date,
      executor,
    );
    d.unresolved_advance_receipts = heldAdvances.map((a) => a.voucherNumber);
    d.unresolved_advance_base = heldAdvances.reduce(
      (sum, a) => sum + a.grossBaseAmount,
      0,
    );
    if (heldAdvances.length > 0) {
      flags.add(
        `Customer advance(s) ${d.unresolved_advance_receipts.join(', ')} ` +
          `(${d.unresolved_advance_base} cents received in this period) carry no tax ` +
          `treatment. A payment for an identified taxable supply declares VAT on the day it ` +
          `arrives (KMS §11 lg 1), so this return cannot be filed until each receipt says ` +
          `whether it is a taxable advance or a non-taxable deposit: POST ` +
          `/api/prepayments/{voucherId}/tax-treatment.`,
      );
    }

    // Advance documents whose counter-voucher shape cannot be reported
    // coherently against these boxes (issue #213). Held, not guessed.
    d.unsupported_advance_reversals =
      await this.prepaymentAdvances.listUnsupportedAdvanceReversals(
        period.start_date,
        period.end_date,
        executor,
      );
    if (d.unsupported_advance_reversals.length > 0) {
      flags.add(
        `Advance voucher(s) ${d.unsupported_advance_reversals.join(', ')} are reversed in a way ` +
          `this return cannot show as documents: a counter-voucher that does not mirror them ` +
          `completely or was itself reversed, or the reversal of an advance draw-down or refund ` +
          `whose own document belongs to an earlier period. Their VAT is in these boxes with no ` +
          `document behind it, so the return is held rather than filed with a paper nobody ` +
          `issued. Resolve those vouchers before filing.`,
      );
    }

    d.net_vat_due = d.row4_output_vat - d.row5_input_vat;
    d.unresolved_acquisition_vouchers =
      this.unresolvedAcquisitionVouchers(legacyByVoucher);
    if (d.unresolved_acquisition_vouchers.length > 0) {
      flags.add(
        `Voucher(s) ${d.unresolved_acquisition_vouchers.join(', ')} carry reverse-charge ` +
          `acquisition base that belongs in KMD row 6 or row 7, and do not record which. ` +
          `It is counted in NEITHER row. Record the supplier's facts and correct each ` +
          `expense (POST /api/expenses/{id}/correct {"kind":"financial","reason":"..."}) ` +
          `— locking the period and a final statutory export are refused until then.`,
      );
    }
    if (d.vd_intra_eu_services > 0) {
      flags.add(
        `File the VD koondaruanne manually (tähis 3S) for ${d.vd_intra_eu_services} ` +
          `cents of 0% intra-EU services — the system does not submit it.`,
      );
    }
    d.review_flags = [...flags];
    return d;
  }

  /**
   * Which vouchers' reverse-charge acquisitions are still of UNKNOWN origin
   * (issue #210) — the vouchers, not an amount. Cancellation is not resolution:
   * a +100 legacy acquisition from one supplier and a −100 from an unrelated
   * one net to zero while both rows they belong to are still wrong. Nor is an
   * equal amount somewhere else in the period: only the chain a voucher is
   * actually part of says anything about it.
   *
   * So the vouchers are grouped into CONNECTED COMPONENTS over their
   * `reverses_id` links, and a component clears only when it is neutral as a
   * whole — its legacy bases sum to zero. That is the one honest reading: a
   * component that nets out declares nothing, so no row has to be chosen for
   * it, and no replacement voucher is needed merely to cancel. Anything else
   * leaves EVERY voucher in the component named.
   *
   * Per-pair matching would not do: nothing in the ledger makes `reverses_id`
   * unique, so an original with two mirrored reversals — or a
   * reversal-of-a-reversal — would find a partner for every node and clear a
   * chain whose base is plainly nonzero. Component arithmetic also gives the
   * invariant the filing gate depends on: a nonzero unresolved base always
   * comes with at least one named voucher.
   *
   * A reversal whose original is NOT in this period is a component of its own.
   * It is either assigned a row before it gets here — when the original was
   * filed under a payload that recorded which row it used, so the removal comes
   * out of that row (see {@link originalsFiledWithoutOrigin}) — or it stays
   * unresolved. This is computed per period, so nothing posted later reaches
   * back and re-judges a period that was already filed.
   *
   * Voucher numbers come back sorted, so the declaration — and the filing
   * payload frozen from it — is byte-stable across recomputation.
   */
  private unresolvedAcquisitionVouchers(
    legacyByVoucher: Map<number, AmbiguousVoucher>,
  ): string[] {
    const nodes = new Map(
      [...legacyByVoucher.entries()].filter(([, v]) => v.base !== 0),
    );

    // Undirected adjacency over the reversal links that stay inside this set.
    const neighbours = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
      neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
    };
    for (const [id, v] of nodes) {
      if (v.reversesId !== null && nodes.has(v.reversesId))
        link(id, v.reversesId);
    }

    const ambiguous: string[] = [];
    const visited = new Set<number>();
    for (const start of nodes.keys()) {
      if (visited.has(start)) continue;

      const component: number[] = [];
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const id = queue.shift() as number;
        component.push(id);
        for (const next of neighbours.get(id) ?? []) {
          if (visited.has(next)) continue;
          visited.add(next);
          queue.push(next);
        }
      }

      const net = component.reduce(
        (sum, id) => sum + (nodes.get(id) as AmbiguousVoucher).base,
        0,
      );
      if (net === 0) continue;
      for (const id of component) {
        ambiguous.push((nodes.get(id) as AmbiguousVoucher).voucherNumber);
      }
    }

    return ambiguous.sort((a, b) => a.localeCompare(b));
  }

  /**
   * The vouchers OUTSIDE this period that lines here reverse AND that a filed
   * return provably declared under the old, origin-less classifier (issue
   * #210).
   *
   * This is the one piece of real evidence about an origin-less acquisition, so
   * the proof is held to the filing itself, not to dates:
   *  1. the original's period is LOCKED and bound to a frozen VAT snapshot;
   *  2. that snapshot's COVERED SET actually contains the original voucher —
   *     a period's dates covering it proves nothing, because a snapshot frozen
   *     early by a draft export could leave it out entirely (issue #200), and
   *     an amount that was never filed cannot be taken back out of a filed row;
   *  3. the filing payload the period's filing state PINS (not merely the
   *     newest one) was frozen against that same snapshot; and
   *  4. that payload has no `row6_7_unresolved_acquisition` field — the mark of
   *     the classifier that put every reverse-charge acquisition in one row.
   *
   * Anything short of all four leaves the reversal unresolved. Which row the
   * removal comes out of stays the jurisdiction's call: this only establishes
   * the fact and hands it to `classifyKmd`. Frozen artifacts are read here,
   * never rewritten.
   */
  private async originalsFiledWithoutOrigin(
    lines: { voucher_id: number; reverses_id: number | null }[],
    executor: Kysely<Database>,
  ): Promise<Set<number>> {
    const inPeriod = new Set(lines.map((l) => l.voucher_id));
    const reversedElsewhere = [
      ...new Set(
        lines
          .map((l) => l.reverses_id)
          .filter((id): id is number => id !== null && !inPeriod.has(id)),
      ),
    ];
    const filed = new Set<number>();

    for (const originalId of reversedElsewhere) {
      const original = await executor
        .selectFrom('voucher')
        .select(['id', 'tax_point_date'])
        .where('id', '=', originalId)
        .executeTakeFirst();
      if (!original) continue;

      const originalPeriod = await executor
        .selectFrom('reporting_period')
        .select(['id', 'status', 'vat_report_snapshot_id'])
        .where('kind', '!=', 'annual')
        .where('start_date', '<=', original.tax_point_date)
        .where('end_date', '>=', original.tax_point_date)
        .executeTakeFirst();
      if (
        !originalPeriod ||
        originalPeriod.status !== 'locked' ||
        originalPeriod.vat_report_snapshot_id === null
      ) {
        continue;
      }

      // The filed snapshot must actually COVER this voucher.
      const snapshot = await executor
        .selectFrom('vat_report')
        .select(['id', 'voucher_ids'])
        .where('id', '=', originalPeriod.vat_report_snapshot_id)
        .executeTakeFirst();
      if (!snapshot) continue;
      const covered = JSON.parse(snapshot.voucher_ids) as number[];
      if (!covered.includes(originalId)) continue;

      const payload = await this.pinnedFilingPayload(
        originalPeriod.id,
        snapshot.id,
        executor,
      );
      if (!payload) continue;

      const declaration = (
        JSON.parse(payload) as {
          declaration?: { row6_7_unresolved_acquisition?: number };
        }
      ).declaration;
      // A payload that already HAS the bucket was frozen under the rules that
      // refuse to file an unresolved origin, so it proves nothing about one.
      if (
        declaration &&
        declaration.row6_7_unresolved_acquisition === undefined
      ) {
        filed.add(originalId);
      }
    }

    return filed;
  }

  /**
   * The filing payload a locked period is FILED against: the version its last
   * submission event pins, else — for events recorded before payload versions
   * were pinned — the newest payload frozen against the bound snapshot. Either
   * way it must belong to `snapshotId`, so a payload frozen against some other
   * snapshot is never read as evidence about this one.
   */
  private async pinnedFilingPayload(
    periodId: number,
    snapshotId: number,
    executor: Kysely<Database>,
  ): Promise<string | null> {
    const pinned = await executor
      .selectFrom('statutory_submission_event')
      .select(['source_payload_id'])
      .where('reporting_period_id', '=', periodId)
      .where('source_payload_id', 'is not', null)
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    const row = pinned?.source_payload_id
      ? await executor
          .selectFrom('statutory_filing_snapshot')
          .select(['payload', 'vat_report_id'])
          .where('id', '=', pinned.source_payload_id)
          .executeTakeFirst()
      : await executor
          .selectFrom('statutory_filing_snapshot')
          .select(['payload', 'vat_report_id'])
          .where('vat_report_id', '=', snapshotId)
          .orderBy('id', 'desc')
          .executeTakeFirst();

    if (!row || row.vat_report_id !== snapshotId) return null;
    return row.payload;
  }

  private mapRow(row: {
    id: number;
    reporting_period_id: number;
    period_name: string;
    start_date: string;
    end_date: string;
    vat_summary: string;
    total_input_vat: number;
    total_output_vat: number;
    total_payable: number;
    total_receivable: number;
    voucher_ids: string;
    merkle_root: string | null;
    generated_at: number;
  }): VatReport {
    return {
      id: row.id,
      reporting_period_id: row.reporting_period_id,
      period_name: row.period_name,
      start_date: row.start_date,
      end_date: row.end_date,
      vat_summary: JSON.parse(row.vat_summary) as VatSummaryLine[],
      total_input_vat: row.total_input_vat,
      total_output_vat: row.total_output_vat,
      total_payable: row.total_payable,
      total_receivable: row.total_receivable,
      voucher_ids: JSON.parse(row.voucher_ids) as number[],
      merkle_root: row.merkle_root,
      generated_at: row.generated_at,
    };
  }
}
