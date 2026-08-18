import { Injectable, NotFoundException } from '@nestjs/common';
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

@Injectable()
export class VatReportService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
    private readonly pluginLoader: PluginLoader,
    private readonly organization: OrganizationService,
  ) {}

  /**
   * Generate an immutable VAT report snapshot for a reporting period.
   *
   * Queries all posted vouchers whose tax_point_date falls within the period
   * range, joins voucher_line, groups by vat_code summing base_amount into
   * input (debit) vs output (credit), computes total_payable/total_receivable,
   * and stores the snapshot with a Merkle root over the covered Vouchers.
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
   * FREEZES a snapshot. If one already exists for the period it is returned
   * unchanged (same Merkle root, never recomputed) — the filed return must stay
   * reproducible (ADR-0009). Because the freeze is permanent and `vat_report`
   * rows are immutable by trigger, do NOT call this just to look at the
   * figures: use {@link preview}, which computes the same numbers and stores
   * nothing.
   */
  async generate(
    periodId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<VatReport> {
    const existing = await executor
      .selectFrom('vat_report')
      .selectAll()
      .where('reporting_period_id', '=', periodId)
      .executeTakeFirst();

    if (existing) {
      return this.mapRow(existing);
    }

    const computed = await this.compute(periodId, executor);

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

    return this.mapRow(row);
  }

  /**
   * Read-only view of what the period currently declares. Computes exactly what
   * {@link generate} would freeze, but stores nothing — safe to call as often as
   * you like while the period is still open and vouchers keep moving.
   *
   * `frozen_snapshot_id` is non-null when a snapshot already exists: the live
   * figures below may then differ from the frozen ones, and `generate` would
   * hand back the frozen copy rather than these. That drift is the thing this
   * endpoint exists to make visible.
   */
  async preview(
    periodId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<VatReportPreview> {
    const computed = await this.compute(periodId, executor);

    const frozen = await executor
      .selectFrom('vat_report')
      .select('id')
      .where('reporting_period_id', '=', periodId)
      .executeTakeFirst();

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
      .select(['id', 'name', 'start_date', 'end_date'])
      .where('id', '=', periodId)
      .executeTakeFirst();

    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }

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
      .select(['id', 'name', 'start_date', 'end_date'])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }

    const org = await this.organization.getOrganization();
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
      ])
      .where('v.tax_point_date', '>=', period.start_date)
      .where('v.tax_point_date', '<=', period.end_date)
      .where('v.posted_at', 'is not', null)
      .execute();

    const d: KmdDeclaration = {
      reporting_period_id: period.id,
      period_name: period.name,
      start_date: period.start_date,
      end_date: period.end_date,
      row1_base_24: 0,
      row2_base_reduced: 0,
      row3_base_zero: 0,
      row4_output_vat: 0,
      row5_input_vat: 0,
      row6_intra_eu_acquisition: 0,
      row7_other_acquisition: 0,
      net_vat_due: 0,
      vd_intra_eu_services: 0,
      review_flags: [],
    };
    const flags = new Set<string>();

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

      // Everything else with a VAT code is a taxable-base line. Its magnitude is
      // signed by its own normal side, so a reversal subtracts.
      if (!line.vat_code) continue;
      const base = line.is_debit
        ? this.ledgerBalance.signedBaseAmount(line)
        : this.ledgerBalance.signedBaseAmount(line, { creditPositive: true });

      const k = plugin.classifyKmd(line.vat_code);
      if (k.review) flags.add(k.review);

      switch (k.outputBaseRow) {
        case 1:
          d.row1_base_24 += base;
          break;
        case 2:
          d.row2_base_reduced += base;
          break;
        case 3:
          d.row3_base_zero += base;
          break;
      }
      if (k.acquisitionRow === 6) d.row6_intra_eu_acquisition += base;
      if (k.acquisitionRow === 7) d.row7_other_acquisition += base;
      if (k.vdCode === '3S') d.vd_intra_eu_services += base;
    }

    d.net_vat_due = d.row4_output_vat - d.row5_input_vat;
    if (d.vd_intra_eu_services > 0) {
      flags.add(
        `File the VD koondaruanne manually (tähis 3S) for ${d.vd_intra_eu_services} ` +
          `cents of 0% intra-EU services — the system does not submit it.`,
      );
    }
    d.review_flags = [...flags];
    return d;
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
