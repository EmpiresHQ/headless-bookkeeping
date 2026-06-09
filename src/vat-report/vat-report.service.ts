import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { VatReport, VatSummaryLine } from './types';
import { computeVoucherHash } from '../ledger/posting/voucher-hash';
import { computeMerkleRoot } from './merkle';

@Injectable()
export class VatReportService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
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
  async generate(
    periodId: number,
    executor: Kysely<Database> = this.db,
  ): Promise<VatReport> {
    // Check if a snapshot already exists for this period
    const existing = await executor
      .selectFrom('vat_report')
      .selectAll()
      .where('reporting_period_id', '=', periodId)
      .executeTakeFirst();

    if (existing) {
      return this.mapRow(existing);
    }

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

    const generatedAt = Math.floor(Date.now() / 1000);

    // Insert the snapshot
    const row = await executor
      .insertInto('vat_report')
      .values({
        reporting_period_id: periodId,
        period_name: period.name,
        start_date: period.start_date,
        end_date: period.end_date,
        vat_summary: JSON.stringify(vatSummary),
        total_input_vat,
        total_output_vat,
        total_payable,
        total_receivable,
        voucher_ids: JSON.stringify(voucherIds),
        merkle_root: merkleRoot,
        generated_at: generatedAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapRow(row);
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
   * Fetch the list of voucher IDs included in a VAT report.
   */
  async getVoucherIds(id: number): Promise<number[]> {
    const report = await this.getById(id);
    return report.voucher_ids;
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
