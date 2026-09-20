import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { VatReportService } from '../vat-report/vat-report.service';
import type { VatSummaryLine } from '../vat-report/types';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NULL_VAT_CODE } from '../ledger/posting/vat-constants';
import { PrepaymentAllocationRepository } from '../reconciliation/prepayment-allocation.repository';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import {
  StatutoryDocLine,
  StatutoryFormat,
  StatutoryReportInput,
  StatutoryReportResult,
  StatutoryWarning,
  normalizeFrozenStatutoryInput,
} from '../plugins/statutory-report.types';

/** The reporting-period fields every assembly path needs. */
interface PeriodRow {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  kind: string;
  vat_report_snapshot_id: number | null;
}

/**
 * The statutory VAT filing belongs to the VAT calendar (issue #207). A FINANCIAL
 * YEAR has no KMD, no filing payload and no submission lifecycle of its own —
 * its statutory artifact is the annual report — so an annual id is refused here
 * rather than rendering or freezing a second return for turnover the monthly
 * periods already declared.
 */
function assertVatPeriod(period: { id: number; kind: string }): void {
  if (period.kind === 'annual') {
    throw new ConflictException(
      `Reporting period ${period.id} is a financial year — it has no VAT filing.`,
    );
  }
}

/**
 * v1 files one report kind. Kept as a named constant so the filing payload and
 * the submission event log agree on what a payload belongs to.
 */
const REPORT_KIND = 'EE_KMD';

/**
 * A single voucher line read for amount assembly — its account role (code) plus
 * the signed-base inputs LedgerBalanceService consumes.
 */
interface AssemblyLine {
  account_code: string;
  vat_code: string | null;
  base_amount: number;
  is_debit: number;
}

/**
 * StatutoryReportService — assembles a NEUTRAL {@link StatutoryReportInput} from
 * the period's posted documents and delegates ALL jurisdiction rendering to the
 * active country plugin (ADR-0002). The service stays read-only over the ledger;
 * its only write is the audit-finding it raises for each plugin warning.
 *
 * The VAT boxes/totals are NOT recomputed here. A DRAFT takes them from
 * {@link VatReportService.preview} — read-only, storing nothing, so downloading
 * a draft can never freeze the filing state (issue #200). A FINAL takes them,
 * with the declarant identity, the signed declaration bases and the INF detail,
 * from the frozen `statutory_filing_snapshot` the period's filing state pins,
 * so the filed document stays reproducible no matter how the organization,
 * counterparties or document metadata change afterwards.
 *
 * Sign convention (LedgerBalanceService): output-side amounts (sales,
 * VAT_PAYABLE) are read credit-positive; input-side amounts (purchases,
 * VAT_RECEIVABLE) are read debit-positive (the default). Credit notes are
 * sign-flipped mirror vouchers, so their net/vat fall out NEGATIVE without any
 * special-casing.
 */
@Injectable()
export class StatutoryReportService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly ledgerBalance: LedgerBalanceService,
    private readonly vatReport: VatReportService,
    private readonly orgResolver: OrgContextResolver,
    private readonly auditFindings: AuditFindingsService,
    private readonly submissions: StatutorySubmissionService,
    private readonly pluginLoader: PluginLoader,
    // The advance documents a filing must be able to name (issue #213).
    private readonly advances: PrepaymentAllocationRepository,
  ) {}

  /**
   * Render the period's statutory report.
   *
   * An OPEN period yields a `draft` built entirely from a READ-ONLY projection
   * of the live ledger — it freezes nothing (issue #200). Downloading a draft
   * used to call the permanent `VatReportService.generate`, which froze a
   * snapshot that a later lock then filed as if it were complete.
   *
   * A LOCKED period yields a `final` replayed from the frozen filing payload
   * the period's filing state pins — declarant identity, signed declaration
   * bases, VAT boxes and INF lines all as of the filing, never recomputed from
   * today's mutable organization/entity/document metadata. `filingVersionId`
   * renders one specific historical payload version instead (what a given
   * submission event identifies).
   *
   * A locked period with NO frozen filing state (filed before migration 067)
   * has no reproducible final, so the export REFUSES (409) and points at the
   * reconciliation endpoint. It deliberately offers no "reconstructed" variant:
   * neither the KMD XML nor the CSV has a field that would mark an artifact as
   * a rebuild, so any file handed out here would be indistinguishable from a
   * real filing to a caller that reads only `artifact.content`.
   */
  async generate(
    periodId: number,
    opts: { formats: StatutoryFormat[]; filingVersionId?: number },
  ): Promise<StatutoryReportResult> {
    const period = await this.db
      .selectFrom('reporting_period')
      .select([
        'id',
        'name',
        'start_date',
        'end_date',
        'status',
        'kind',
        'vat_report_snapshot_id',
      ])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }
    assertVatPeriod(period);

    const locked = period.status === 'locked';

    if (!locked && opts.filingVersionId !== undefined) {
      throw new BadRequestException(
        `Reporting period ${periodId} is open — a filing payload version can only be rendered for a locked period`,
      );
    }

    const warnings: StatutoryWarning[] = [];
    let input: StatutoryReportInput;
    let country: string;

    if (!locked) {
      ({ input, country } = await this.liveInput(period));
    } else {
      const frozen = await this.frozenInput(
        period,
        opts.filingVersionId,
        warnings,
      );
      if (frozen) {
        input = frozen.input;
        country = frozen.country;
      } else {
        // Locked, but nothing was frozen for it (filed before issue #200 was
        // fixed). Live data is NOT the filed state and the artifact formats
        // carry no "this is a reconstruction" marker, so there is no honest way
        // to hand one out here: refuse, and point at the repair. The operator
        // can still read the live figures through the VAT-report preview.
        throw new ConflictException(
          `Reporting period "${period.name}" (#${period.id}) is locked but has no frozen filing state ` +
            `(it was filed before the filing payload was frozen, issue #200), so a final export cannot be ` +
            `reproduced. Run POST /api/reporting-periods/${period.id}/filing/reconcile to freeze one; ` +
            `GET /api/reporting-periods/${period.id}/vat-report/preview shows the current figures meanwhile.`,
        );
      }
    }

    // A final filing must identify the declarant by its commercial registry
    // code — read off the INPUT, so a replayed filing is judged on what was
    // frozen, not on what the organization record says today.
    if (input.mode === 'final' && !input.declarant.regNumber) {
      throw new BadRequestException(
        'Cannot generate a final KMD without a declarant registry code',
      );
    }

    // Render with the jurisdiction that is FROZEN for a replayed filing, and
    // only with the organization's current one for a live draft.
    const plugin = this.pluginLoader.resolve(country);
    const result = plugin.generateStatutoryReports(input, {
      formats: opts.formats,
    });
    result.warnings = [...warnings, ...result.warnings];

    if (input.mode === 'final') {
      const invalidIdentity = result.warnings.find(
        (w) => w.code === 'invalid_declarant_reg_number',
      );
      if (invalidIdentity)
        throw new BadRequestException(invalidIdentity.message);

      // The jurisdiction can refuse to put figures on a FILED document that it
      // would still show on a draft (issue #210). The kernel does not know what
      // makes a return unfilable — it only honours the plugin's mark, and only
      // for a final, so the draft stays available as the diagnostic.
      const blocking = result.warnings.find((w) => w.blocksFinal);
      if (blocking) {
        await this.auditFindings.create({
          finding_type: 'statutory_report_incomplete',
          severity: 'high',
          description: blocking.message,
        });
        throw new ConflictException(blocking.message);
      }
    }

    for (const w of result.warnings) {
      await this.auditFindings.create({
        finding_type: 'statutory_report_incomplete',
        severity: 'medium',
        description: w.message,
      });
    }

    return result;
  }

  // ── Filing payload: freeze, replay, reconcile ─────────────────────────────

  /**
   * Freeze the COMPLETE filing state for `vatReportId` as an append-only
   * `statutory_filing_snapshot` row, and return its version id.
   *
   * Idempotent by content: if the newest payload for that snapshot is already
   * byte-identical, nothing is appended and the existing version is returned —
   * so re-running the reconciliation on a healthy period writes nothing. A
   * differing payload is APPENDED; earlier versions are never edited or deleted
   * (append-only triggers) and stay addressable via `filingVersionId`, which is
   * what keeps an already-submitted event reproducible.
   *
   * Runs on the caller's `executor` so the lock transaction rolls the payload
   * back together with the snapshot and the status flip.
   */
  async freezeFilingSnapshot(
    periodId: number,
    vatReportId: number,
    reason: 'lock' | 'reconcile',
    executor: Kysely<Database> = this.db,
  ): Promise<{ payloadId: number; appended: boolean }> {
    const period = await executor
      .selectFrom('reporting_period')
      .select([
        'id',
        'name',
        'start_date',
        'end_date',
        'status',
        'kind',
        'vat_report_snapshot_id',
      ])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }
    assertVatPeriod(period);

    const { organization } = await this.orgResolver.resolve(executor);
    const country = organization.country;
    const input = await this.buildFilingInput(period, vatReportId, executor);
    const payload = JSON.stringify(input);

    const latest = await executor
      .selectFrom('statutory_filing_snapshot')
      .select(['id', 'payload', 'country'])
      .where('vat_report_id', '=', vatReportId)
      .orderBy('id', 'desc')
      .executeTakeFirst();

    if (latest && latest.payload === payload && latest.country === country) {
      return { payloadId: latest.id, appended: false };
    }

    // Nothing that records no acquisition origin (issue #210) is ever FROZEN
    // as a filing state. The refusal sits here, on the creation of a NEW
    // payload, so it covers every route into one — the period lock and the
    // reconciliation repair alike — and it runs on the caller's transaction:
    // the lock rolls back whole, leaving the period OPEN, unbound, with no
    // submission event, which is the only state from which the documented
    // correction can still land in this period. Freezing first and refusing at
    // render time would do the opposite: lock the period, then redirect the
    // correction into a LATER one (ADR-0009), stranding the frozen payload.
    //
    // Existing snapshots are untouched: an identical payload returned above is
    // never re-frozen, and no already-filed payload is rewritten or re-judged.
    const unresolved = input.declaration.unresolved_acquisition_vouchers;
    if (unresolved.length > 0) {
      throw new ConflictException(
        `Reporting period "${period.name}" (#${period.id}) cannot be filed: voucher(s) ` +
          `${unresolved.join(', ')} carry reverse-charge acquisition base that records no ` +
          `acquisition origin, so it belongs to KMD row 6 or row 7 and the return cannot ` +
          `say which. Record the supplier's tax status (PATCH /api/entities/{supplierId}) ` +
          `and correct each expense (POST /api/expenses/{id}/correct ` +
          `{"kind":"financial","reason":"..."}), then file the period again. ` +
          `GET /api/reporting-periods/${period.id}/kmd lists them meanwhile.`,
      );
    }

    // The same refusal, for the other unknown (issue #213): a customer receipt
    // in this period that nobody has classified either declared VAT it should
    // not have or omitted VAT it owed, and the books do not say which. It is
    // not frozen into a filing state on either reading. Like the gate above,
    // this runs on the caller's transaction, so a period lock rolls back whole
    // and the classification can still land in the period it belongs to.
    const heldAdvances = input.declaration.unresolved_advance_receipts;
    if (heldAdvances.length > 0) {
      throw new ConflictException(
        `Reporting period "${period.name}" (#${period.id}) cannot be filed: customer ` +
          `advance(s) ${heldAdvances.join(', ')} ` +
          `(${input.declaration.unresolved_advance_base} cents) were received in it and carry ` +
          `no tax treatment. A payment for an identified taxable supply declares VAT on the ` +
          `day it arrives (KMS §11 lg 1), so the return cannot say whether that VAT belongs ` +
          `in it. Classify each receipt (POST /api/prepayments/{voucherId}/tax-treatment) and ` +
          `file the period again. GET /api/reporting-periods/${period.id}/kmd lists them ` +
          `meanwhile.`,
      );
    }

    const unsupportedReversals =
      input.declaration.unsupported_advance_reversals;
    if (unsupportedReversals.length > 0) {
      throw new ConflictException(
        `Reporting period "${period.name}" (#${period.id}) cannot be filed: advance ` +
          `voucher(s) ${unsupportedReversals.join(', ')} are reversed in a way this return ` +
          `cannot show as documents — a counter-voucher that does not mirror them completely ` +
          `or was itself reversed, or the reversal of an advance draw-down or refund whose ` +
          `own document belongs to an earlier period. Their VAT is in this period's boxes ` +
          `with no document behind it. Resolve those vouchers, then file the period again. ` +
          `GET /api/reporting-periods/${period.id}/kmd lists them meanwhile.`,
      );
    }

    const row = await executor
      .insertInto('statutory_filing_snapshot')
      .values({
        reporting_period_id: periodId,
        vat_report_id: vatReportId,
        report_kind: REPORT_KIND,
        country,
        payload,
        reason,
        created_at: Math.floor(Date.now() / 1000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { payloadId: row.id, appended: true };
  }

  /**
   * Assemble the filing input to FREEZE: VAT boxes and totals taken verbatim
   * from the frozen snapshot (never recomputed), declaration bases and INF
   * lines read through the same executor so they see exactly the ledger the
   * snapshot committed to, and the declarant identity as of this moment.
   */
  private async buildFilingInput(
    period: PeriodRow,
    vatReportId: number,
    executor: Kysely<Database>,
  ): Promise<StatutoryReportInput> {
    const snapshot = await executor
      .selectFrom('vat_report')
      .selectAll()
      .where('id', '=', vatReportId)
      .executeTakeFirst();
    if (!snapshot) {
      throw new NotFoundException(`VAT report ${vatReportId} not found`);
    }

    const { organization } = await this.orgResolver.resolve(executor);

    return {
      declarant: {
        regNumber: organization.registry_code,
        name: organization.name,
      },
      period: {
        name: period.name,
        startDate: period.start_date,
        endDate: period.end_date,
      },
      mode: 'final',
      boxes: JSON.parse(snapshot.vat_summary) as VatSummaryLine[],
      declaration: await this.vatReport.buildDeclaration(period.id, executor),
      totals: {
        totalInputVat: snapshot.total_input_vat,
        totalOutputVat: snapshot.total_output_vat,
        totalPayable: snapshot.total_payable,
      },
      salesLines: await this.assembleSalesLines(
        period.start_date,
        period.end_date,
        executor,
      ),
      purchaseLines: await this.assemblePurchaseLines(
        period.start_date,
        period.end_date,
        executor,
      ),
    };
  }

  /**
   * The frozen filing state for a locked period, or `null` when none exists —
   * the caller decides what to do about that, and never silently substitutes
   * live data for a `final` artifact.
   */
  private async frozenInput(
    period: PeriodRow,
    requestedVersionId: number | undefined,
    warnings: StatutoryWarning[],
  ): Promise<{ input: StatutoryReportInput; country: string } | null> {
    if (period.vat_report_snapshot_id === null) {
      if (requestedVersionId !== undefined) {
        throw new NotFoundException(
          `Reporting period ${period.id} is bound to no frozen VAT snapshot`,
        );
      }
      return null;
    }

    const bound = await this.vatReport.getById(period.vat_report_snapshot_id);
    const version = await this.resolveFilingVersion(
      period,
      bound.id,
      requestedVersionId,
    );

    if (!version) return null;

    if (version.vat_report_id !== bound.id) {
      warnings.push({
        code: 'filing_payload_superseded',
        message:
          `Rendering filing payload version ${version.id}, frozen against VAT snapshot ${version.vat_report_id}; ` +
          `reporting period "${period.name}" is now bound to VAT snapshot ${bound.id}. ` +
          `This reproduces an earlier filing, not the current bound state.`,
      });
    }

    await this.warnOnDrift(period, bound, warnings);

    return {
      // A payload frozen by an older version of this code may predate a
      // declaration field the renderers now read (issue #209). It is immutable,
      // so it is normalized on READ — never rewritten — and still renders the
      // exact figures it was filed with.
      input: {
        ...normalizeFrozenStatutoryInput(
          JSON.parse(version.payload) as StatutoryReportInput,
        ),
        mode: 'final',
      },
      country: version.country,
    };
  }

  /**
   * Which frozen payload to render: an explicitly requested version, else the
   * one the period's filing state pins (the snapshot/payload named by the last
   * `prepared`/`submitted` event), else — for events recorded before migration
   * 068 — the newest payload frozen against the bound snapshot.
   */
  private async resolveFilingVersion(
    period: PeriodRow,
    boundSnapshotId: number,
    requestedVersionId: number | undefined,
  ): Promise<{
    id: number;
    vat_report_id: number;
    payload: string;
    country: string;
  } | null> {
    if (requestedVersionId !== undefined) {
      const row = await this.db
        .selectFrom('statutory_filing_snapshot')
        .select([
          'id',
          'vat_report_id',
          'payload',
          'country',
          'reporting_period_id',
        ])
        .where('id', '=', requestedVersionId)
        .executeTakeFirst();
      if (!row || row.reporting_period_id !== period.id) {
        throw new NotFoundException(
          `Filing payload version ${requestedVersionId} not found for reporting period ${period.id}`,
        );
      }
      return row;
    }

    const state = await this.submissions.getState(period.id);
    if (state.currentPayloadId !== null) {
      const row = await this.db
        .selectFrom('statutory_filing_snapshot')
        .select(['id', 'vat_report_id', 'payload', 'country'])
        .where('id', '=', state.currentPayloadId)
        .executeTakeFirst();
      if (row) return row;
    }

    const latest = await this.db
      .selectFrom('statutory_filing_snapshot')
      .select(['id', 'vat_report_id', 'payload', 'country'])
      .where('vat_report_id', '=', boundSnapshotId)
      .orderBy('id', 'desc')
      .executeTakeFirst();

    return latest ?? null;
  }

  /**
   * A locked period's ledger cannot move, so its bound snapshot should still
   * describe it exactly. If it does not — the classic symptom of a snapshot
   * frozen early by a draft export — say so loudly rather than exporting a
   * figure that disagrees with the books.
   */
  private async warnOnDrift(
    period: PeriodRow,
    bound: {
      id: number;
      total_output_vat: number;
      total_input_vat: number;
      voucher_ids: number[];
      merkle_root: string | null;
    },
    warnings: StatutoryWarning[],
  ): Promise<void> {
    const live = await this.vatReport.preview(period.id);
    const drifted =
      live.total_output_vat !== bound.total_output_vat ||
      live.total_input_vat !== bound.total_input_vat ||
      live.merkle_root !== bound.merkle_root ||
      JSON.stringify(live.voucher_ids) !== JSON.stringify(bound.voucher_ids);

    if (!drifted) return;

    warnings.push({
      code: 'filing_snapshot_drift',
      message:
        `VAT snapshot ${bound.id} bound to locked period "${period.name}" does not match the period's posted vouchers: ` +
        `snapshot output VAT ${bound.total_output_vat} / ${bound.voucher_ids.length} voucher(s) vs ledger ` +
        `${live.total_output_vat} / ${live.voucher_ids.length} voucher(s). ` +
        `Run POST /api/reporting-periods/${period.id}/filing/reconcile to bind a complete snapshot.`,
    });
  }

  /**
   * Assemble the DRAFT filing input from live tables, with the organization's
   * current jurisdiction. There is deliberately no live `final` path: a final
   * is always replayed from a frozen payload.
   */
  private async liveInput(
    period: PeriodRow,
  ): Promise<{ input: StatutoryReportInput; country: string }> {
    const { organization } = await this.orgResolver.resolve();
    // READ-ONLY: preview computes exactly what a freeze would, and stores nothing.
    const live = await this.vatReport.preview(period.id);

    const input: StatutoryReportInput = {
      declarant: {
        regNumber: organization.registry_code,
        name: organization.name,
      },
      period: {
        name: period.name,
        startDate: period.start_date,
        endDate: period.end_date,
      },
      mode: 'draft',
      boxes: live.vat_summary,
      declaration: await this.vatReport.buildDeclaration(period.id),
      totals: {
        totalInputVat: live.total_input_vat,
        totalOutputVat: live.total_output_vat,
        totalPayable: live.total_payable,
      },
      salesLines: await this.assembleSalesLines(
        period.start_date,
        period.end_date,
      ),
      purchaseLines: await this.assemblePurchaseLines(
        period.start_date,
        period.end_date,
      ),
    };

    return { input, country: organization.country };
  }

  // ── Sales (output side) ───────────────────────────────────────────────────

  /**
   * One {@link StatutoryDocLine} per posted sales document dated in the period:
   * every `sales_invoice` plus every sales `credit_note`. The output side is
   * read credit-positive; the VAT-control role is `VAT_PAYABLE` and the
   * counterparty receivable role is `AR` (excluded from the taxable base).
   */
  /**
   * PUBLIC so the sales documents a filing would report can be read without
   * rendering (and asserted directly): the advance netting in here is a
   * statutory representation rule, not a rendering detail.
   */
  async assembleSalesLines(
    start: string,
    end: string,
    executor: Kysely<Database> = this.db,
  ): Promise<StatutoryDocLine[]> {
    const lines: StatutoryDocLine[] = [];
    /** Invoice rows by voucher, so an advance can be netted INTO its own. */
    const invoiceLineByVoucher = new Map<number, StatutoryDocLine>();

    const invoices = await executor
      .selectFrom('sales_invoice as si')
      .innerJoin('voucher as v', 'v.id', 'si.voucher_id')
      .select([
        'si.invoice_number',
        'si.customer_id',
        'v.id as voucher_id',
        'v.tax_point_date',
      ])
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '>=', start)
      .where('v.tax_point_date', '<=', end)
      .execute();

    for (const inv of invoices) {
      const counterparty = await this.loadCounterparty(
        inv.customer_id,
        executor,
      );
      const amounts = await this.voucherAmounts(
        inv.voucher_id,
        {
          vatControlCode: 'VAT_PAYABLE',
          counterpartyCode: 'AR',
          creditPositive: true,
        },
        executor,
      );
      lines.push({
        documentKind: 'invoice',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: inv.invoice_number || null,
        creditsInvoiceNumber: null,
        date: inv.tax_point_date,
        ...amounts,
      });
      invoiceLineByVoucher.set(inv.voucher_id, lines[lines.length - 1]);
    }

    const creditNotes = await executor
      .selectFrom('credit_note as cn')
      .innerJoin('voucher as v', 'v.id', 'cn.voucher_id')
      .innerJoin('sales_invoice as si', 'si.id', 'cn.credits_object_id')
      .select([
        'cn.credit_note_number',
        'si.invoice_number as credits_invoice_number',
        'si.customer_id',
        'v.id as voucher_id',
        'v.tax_point_date',
      ])
      .where('cn.kind', '=', 'sales')
      .where('cn.credits_object_type', '=', 'sales_invoice')
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '>=', start)
      .where('v.tax_point_date', '<=', end)
      .execute();

    for (const cn of creditNotes) {
      const counterparty = await this.loadCounterparty(
        cn.customer_id,
        executor,
      );
      const amounts = await this.voucherAmounts(
        cn.voucher_id,
        {
          vatControlCode: 'VAT_PAYABLE',
          counterpartyCode: 'AR',
          creditPositive: true,
        },
        executor,
      );
      lines.push({
        documentKind: 'credit_note',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: cn.credit_note_number,
        creditsInvoiceNumber: cn.credits_invoice_number,
        date: cn.tax_point_date,
        ...amounts,
      });
    }

    lines.push(
      ...(await this.assembleAdvanceLines(
        start,
        end,
        invoiceLineByVoucher,
        executor,
      )),
    );

    return lines;
  }

  /**
   * The ADVANCE documents of a period (issue #213), for the sales assembly.
   *
   * A payment received for an identified taxable supply is turnover on the day
   * it arrives, under an advance invoice (ettemaksuarve) of its own — EMTA
   * requires that document within 7 calendar days of the receipt — so the
   * advance is an INF sales document in the period it was received, with its
   * own number, customer and amounts.
   *
   * What the final invoice then reports is where this gets specific. EMTA's
   * KMD INF part A instructions work it through: an advance invoice of 2000
   * (net) declared last month, a transaction of 5000 with the 2000 advance
   * deducted, is reported as an invoice of 3000 — NOT 5000 alongside a
   * fictitious 2000 credit. So a draw-down does not become a document here: it
   * is netted INTO the final invoice's own row, before the €1000 per-partner
   * threshold is measured, which is exactly what makes a 1500 invoice against
   * a 600 advance fall BELOW the threshold as a 900 row. The invoice's own
   * business record and its ledger legs are untouched; only the statutory
   * representation is the lawful one.
   *
   * A genuine REFUND is different: money went back under a cancellation or
   * credit document, and it stays its own credit line.
   *
   * Every figure is the one that was posted, read from the advance /
   * allocation / refund record written with the voucher. No document number is
   * invented: an advance with none carries `invoiceNumber: null`, which the
   * plugin turns into a blocking warning when the row would otherwise qualify
   * for INF, rather than a made-up reference on a filed return.
   */
  private async assembleAdvanceLines(
    start: string,
    end: string,
    invoiceLineByVoucher: Map<number, StatutoryDocLine>,
    executor: Kysely<Database> = this.db,
  ): Promise<StatutoryDocLine[]> {
    const lines: StatutoryDocLine[] = [];

    for (const advance of await this.advances.listTaxableCustomerAdvances(
      start,
      end,
      executor,
    )) {
      const counterparty = await this.loadCounterparty(
        advance.entityId,
        executor,
      );
      lines.push({
        documentKind: 'advance_receipt',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: advance.documentNumber,
        creditsInvoiceNumber: null,
        date: advance.receiptDate,
        vatCode: advance.vatCode ?? NULL_VAT_CODE,
        netAmount: advance.netBaseAmount,
        vatAmount: advance.vatBaseAmount,
      });
    }

    for (const relief of await this.advances.listAdvanceReliefs(
      start,
      end,
      executor,
    )) {
      const invoiceLine = invoiceLineByVoucher.get(relief.invoiceVoucherId);
      if (invoiceLine) {
        // The lawful representation: the final invoice reports the
        // transaction LESS the advance already invoiced.
        invoiceLine.netAmount -= relief.netBaseAmount;
        invoiceLine.vatAmount -= relief.vatBaseAmount;
        continue;
      }

      // No invoice row to net into — the relief is dated at the invoice's own
      // tax point, so this means the target is not a sales invoice of this
      // period (a repaired historical link, say). The declaration is still
      // taken back somewhere visible rather than dropped.
      const counterparty = await this.loadCounterparty(
        relief.entityId,
        executor,
      );
      lines.push({
        documentKind: 'advance_relief',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: relief.invoiceNumber,
        creditsInvoiceNumber: relief.advanceDocumentNumber,
        date: relief.date,
        vatCode: relief.vatCode ?? NULL_VAT_CODE,
        netAmount: -relief.netBaseAmount,
        vatAmount: -relief.vatBaseAmount,
      });
    }

    for (const refund of await this.advances.listAdvanceRefunds(
      start,
      end,
      executor,
    )) {
      const counterparty = await this.loadCounterparty(
        refund.entityId,
        executor,
      );
      lines.push({
        documentKind: 'advance_refund',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: refund.creditReference,
        creditsInvoiceNumber: refund.advanceDocumentNumber,
        date: refund.date,
        vatCode: refund.vatCode ?? NULL_VAT_CODE,
        netAmount: -refund.netBaseAmount,
        vatAmount: -refund.vatBaseAmount,
      });
    }

    return lines;
  }

  // ── Purchases (input side) ─────────────────────────────────────────────────

  /**
   * One {@link StatutoryDocLine} per posted purchase document dated in the
   * period: every `expense` plus every purchase `credit_note`. The input side
   * is read debit-positive (the default); the VAT-control role is
   * `VAT_RECEIVABLE` and the counterparty payable role is `AP`.
   */
  private async assemblePurchaseLines(
    start: string,
    end: string,
    executor: Kysely<Database> = this.db,
  ): Promise<StatutoryDocLine[]> {
    const lines: StatutoryDocLine[] = [];

    const expenses = await executor
      .selectFrom('expense as e')
      .innerJoin('voucher as v', 'v.id', 'e.voucher_id')
      .select([
        'e.supplier_invoice_number',
        'e.supplier_id',
        // The DOCUMENT's own amounts (issue #211). They are what KMD INF part B
        // reports and thresholds on, and once irrecoverable VAT is booked into
        // the cost the ledger legs no longer state them.
        'e.gross_amount',
        'e.vat_amount',
        'v.id as voucher_id',
        'v.tax_point_date',
      ])
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '>=', start)
      .where('v.tax_point_date', '<=', end)
      .execute();

    for (const exp of expenses) {
      const counterparty = await this.loadCounterparty(
        exp.supplier_id,
        executor,
      );
      const amounts = await this.voucherAmounts(
        exp.voucher_id,
        {
          vatControlCode: 'VAT_RECEIVABLE',
          counterpartyCode: 'AP',
          creditPositive: false,
        },
        executor,
      );
      lines.push({
        documentKind: 'invoice',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: exp.supplier_invoice_number || null,
        creditsInvoiceNumber: null,
        date: exp.tax_point_date,
        ...amounts,
        ...(await this.documentAmounts(
          exp.voucher_id,
          exp.gross_amount,
          exp.vat_amount,
          amounts,
          executor,
        )),
      });
    }

    const creditNotes = await executor
      .selectFrom('credit_note as cn')
      .innerJoin('voucher as v', 'v.id', 'cn.voucher_id')
      .innerJoin('expense as e', 'e.id', 'cn.credits_object_id')
      .select([
        'cn.credit_note_number',
        // The credit note's OWN amounts (issue #211) — a refund mirrors the
        // invoice it credits, so its document figures must come from it rather
        // than falling back to a cost that no longer states them.
        'cn.gross_amount',
        'cn.vat_amount',
        'e.supplier_invoice_number as credits_invoice_number',
        'e.supplier_id',
        'v.id as voucher_id',
        'v.tax_point_date',
      ])
      .where('cn.kind', '=', 'purchase')
      .where('cn.credits_object_type', '=', 'expense')
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '>=', start)
      .where('v.tax_point_date', '<=', end)
      .execute();

    for (const cn of creditNotes) {
      const counterparty = await this.loadCounterparty(
        cn.supplier_id,
        executor,
      );
      const amounts = await this.voucherAmounts(
        cn.voucher_id,
        {
          vatControlCode: 'VAT_RECEIVABLE',
          counterpartyCode: 'AP',
          creditPositive: false,
        },
        executor,
      );
      lines.push({
        documentKind: 'credit_note',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: cn.credit_note_number,
        creditsInvoiceNumber: cn.credits_invoice_number,
        date: cn.tax_point_date,
        ...amounts,
        ...(await this.documentAmounts(
          cn.voucher_id,
          cn.gross_amount,
          cn.vat_amount,
          amounts,
          executor,
          -1,
        )),
      });
    }

    return lines;
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  /**
   * Derive a document's signed net + VAT (EUR minor units) and its booked VAT
   * code from one voucher's lines, via {@link LedgerBalanceService.signedBaseAmount}.
   *
   * `vatAmount` is the signed base of the VAT-control line (VAT_PAYABLE on sales,
   * VAT_RECEIVABLE on purchases). `netAmount` sums every OTHER line that is
   * neither the VAT-control account nor the counterparty settlement account
   * (AR/AP) — i.e. the taxable base. A zero-rated voucher carries no VAT-control
   * line, so vatAmount = 0 and vatCode falls back to a base line's code.
   */
  /**
   * The DOCUMENT's own net and VAT in base currency (issue #211).
   *
   * The ledger legs stopped stating them the moment irrecoverable input VAT
   * started being booked into the cost: the base legs then carry
   * `net + irrecoverable VAT` while the VAT-control leg carries only what was
   * reclaimed. KMD INF part B reports the INVOICE — its €1000 threshold is the
   * invoice value WITHOUT VAT, and `invoiceSumVat` is the invoice's own total —
   * so it has to read the document, not our cost.
   *
   * The figures come from the immutable business object (its own gross and VAT,
   * in its own currency) converted at the rate the VOUCHER was posted at, and
   * the VAT is then taken as the REMAINDER of the base-currency gross. So the
   * two always sum back to the gross the voucher actually carries, whatever the
   * rate or rounding — no second rounding rule to drift against the first.
   *
   * It is computed for EVERY new purchase line, including fully deductible
   * ones, so that the presence of these fields is itself the marker that a line
   * was assembled by this code. A payload frozen earlier has neither field and
   * is rendered exactly as it was filed.
   *
   * `sign` is -1 for a credit note, whose ledger figures are already negative:
   * its document figures must be negative too, or a refund would raise the
   * partner's threshold instead of lowering it.
   */
  private async documentAmounts(
    voucherId: number,
    grossAmount: number,
    vatAmount: number,
    ledger: { netAmount: number; vatAmount: number },
    executor: Kysely<Database>,
    sign: 1 | -1 = 1,
  ): Promise<{ documentNetAmount: number; documentVatAmount: number }> {
    const grossBase = ledger.netAmount + ledger.vatAmount;
    const rateRow = await executor
      .selectFrom('voucher_line')
      .select(['fx_rate'])
      .where('voucher_id', '=', voucherId)
      .executeTakeFirst();
    const rate = rateRow?.fx_rate ?? 1;

    const { organization } = await this.orgResolver.resolve(executor);
    const plugin = this.pluginLoader.resolve(organization.country);
    const documentNetAmount =
      sign *
      plugin.roundToBaseMinorUnits(Math.abs(grossAmount - vatAmount) * rate);
    return {
      documentNetAmount,
      documentVatAmount: grossBase - documentNetAmount,
    };
  }

  private async voucherAmounts(
    voucherId: number,
    opts: {
      vatControlCode: string;
      counterpartyCode: string;
      creditPositive: boolean;
    },
    executor: Kysely<Database> = this.db,
  ): Promise<{ vatCode: string; netAmount: number; vatAmount: number }> {
    const lines: AssemblyLine[] = await executor
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select([
        'a.code as account_code',
        'vl.vat_code',
        'vl.base_amount',
        'vl.is_debit',
      ])
      .where('vl.voucher_id', '=', voucherId)
      .execute();

    const sign = { creditPositive: opts.creditPositive };

    let vatAmount = 0;
    let vatCodeFromControl: string | null = null;
    let netAmount = 0;
    let vatCodeFromBase: string | null = null;

    // Exclude BOTH VAT-control accounts (VAT_PAYABLE and VAT_RECEIVABLE) and the
    // counterparty settlement account (AR/AP) from the taxable net base.  This
    // prevents a stray reverse-charge VAT-control line (opposite side) from ever
    // leaking into the net calculation.
    const vatControlCodes = new Set(['VAT_PAYABLE', 'VAT_RECEIVABLE']);

    for (const line of lines) {
      if (line.account_code === opts.vatControlCode) {
        vatAmount += this.ledgerBalance.signedBaseAmount(line, sign);
        if (line.vat_code) vatCodeFromControl = line.vat_code;
        continue;
      }
      if (
        vatControlCodes.has(line.account_code) ||
        line.account_code === opts.counterpartyCode
      )
        continue;
      // Taxable-base line.
      netAmount += this.ledgerBalance.signedBaseAmount(line, sign);
      if (line.vat_code) vatCodeFromBase = line.vat_code;
    }

    return {
      vatCode: vatCodeFromControl ?? vatCodeFromBase ?? '',
      netAmount,
      vatAmount,
    };
  }

  /**
   * Resolve a counterparty's display name + registration_key value (the
   * authoritative VAT/registration number, ADR-0014). A null `entityId` (no
   * recorded counterparty) yields an empty name and a null reg number — which
   * the plugin treats as a non-taxable (B2C) party and excludes from the INF.
   */
  private async loadCounterparty(
    entityId: number | null,
    executor: Kysely<Database> = this.db,
  ): Promise<{ name: string; regNumber: string | null }> {
    if (entityId === null) {
      return { name: '', regNumber: null };
    }
    const row = await executor
      .selectFrom('entity as e')
      .leftJoin('entity_identifier as ei', (join) =>
        join
          .onRef('ei.entity_id', '=', 'e.id')
          .on('ei.kind', '=', 'registration_key'),
      )
      .select(['e.name', 'ei.value as reg_number'])
      .where('e.id', '=', entityId)
      .executeTakeFirst();

    return {
      name: row?.name ?? '',
      regNumber: row?.reg_number ?? null,
    };
  }
}
