import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import {
  StatutoryDocLine,
  StatutoryFormat,
  StatutoryReportInput,
  StatutoryReportResult,
} from '../plugins/statutory-report.types';

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
 * The VAT boxes/totals are NOT recomputed here — they are taken verbatim from
 * {@link VatReportService.generate} (the single authoritative VAT projection).
 * This service adds only the per-document INF detail (sales/purchase lines) the
 * declaration annexes need, keyed by document role and account code.
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
  ) {}

  async generate(
    periodId: number,
    opts: { formats: StatutoryFormat[] },
  ): Promise<StatutoryReportResult> {
    const period = await this.db
      .selectFrom('reporting_period')
      .select(['id', 'name', 'start_date', 'end_date', 'status'])
      .where('id', '=', periodId)
      .executeTakeFirst();
    if (!period) {
      throw new NotFoundException(`Reporting period ${periodId} not found`);
    }

    const mode: 'final' | 'draft' =
      period.status === 'locked' ? 'final' : 'draft';

    // Boxes/totals: REUSE the authoritative VAT projection — never recomputed.
    const report = await this.vatReport.generate(periodId);

    const { organization, plugin } = await this.orgResolver.resolve();

    // Hard block: a final filing must carry a declarant VAT registration number.
    if (mode === 'final' && !organization.vat_registration_number) {
      throw new BadRequestException(
        'Cannot generate a final KMD without a declarant VAT registration number',
      );
    }

    const salesLines = await this.assembleSalesLines(
      period.start_date,
      period.end_date,
    );
    const purchaseLines = await this.assemblePurchaseLines(
      period.start_date,
      period.end_date,
    );

    const input: StatutoryReportInput = {
      declarant: {
        regNumber: organization.vat_registration_number,
        name: organization.name,
      },
      period: {
        name: period.name,
        startDate: period.start_date,
        endDate: period.end_date,
      },
      mode,
      boxes: report.vat_summary,
      totals: {
        totalInputVat: report.total_input_vat,
        totalOutputVat: report.total_output_vat,
        totalPayable: report.total_payable,
      },
      salesLines,
      purchaseLines,
    };

    const result = plugin.generateStatutoryReports(input, opts);

    for (const w of result.warnings) {
      await this.auditFindings.create({
        finding_type: 'statutory_report_incomplete',
        severity: 'medium',
        description: w.message,
      });
    }

    return result;
  }

  // ── Sales (output side) ───────────────────────────────────────────────────

  /**
   * One {@link StatutoryDocLine} per posted sales document dated in the period:
   * every `sales_invoice` plus every sales `credit_note`. The output side is
   * read credit-positive; the VAT-control role is `VAT_PAYABLE` and the
   * counterparty receivable role is `AR` (excluded from the taxable base).
   */
  private async assembleSalesLines(
    start: string,
    end: string,
  ): Promise<StatutoryDocLine[]> {
    const lines: StatutoryDocLine[] = [];

    const invoices = await this.db
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
      const counterparty = await this.loadCounterparty(inv.customer_id);
      const amounts = await this.voucherAmounts(inv.voucher_id, {
        vatControlCode: 'VAT_PAYABLE',
        counterpartyCode: 'AR',
        creditPositive: true,
      });
      lines.push({
        documentKind: 'invoice',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: inv.invoice_number || null,
        creditsInvoiceNumber: null,
        date: inv.tax_point_date,
        ...amounts,
      });
    }

    const creditNotes = await this.db
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
      const counterparty = await this.loadCounterparty(cn.customer_id);
      const amounts = await this.voucherAmounts(cn.voucher_id, {
        vatControlCode: 'VAT_PAYABLE',
        counterpartyCode: 'AR',
        creditPositive: true,
      });
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
  ): Promise<StatutoryDocLine[]> {
    const lines: StatutoryDocLine[] = [];

    const expenses = await this.db
      .selectFrom('expense as e')
      .innerJoin('voucher as v', 'v.id', 'e.voucher_id')
      .select([
        'e.supplier_invoice_number',
        'e.supplier_id',
        'v.id as voucher_id',
        'v.tax_point_date',
      ])
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '>=', start)
      .where('v.tax_point_date', '<=', end)
      .execute();

    for (const exp of expenses) {
      const counterparty = await this.loadCounterparty(exp.supplier_id);
      const amounts = await this.voucherAmounts(exp.voucher_id, {
        vatControlCode: 'VAT_RECEIVABLE',
        counterpartyCode: 'AP',
        creditPositive: false,
      });
      lines.push({
        documentKind: 'invoice',
        counterpartyName: counterparty.name,
        counterpartyRegNumber: counterparty.regNumber,
        invoiceNumber: exp.supplier_invoice_number || null,
        creditsInvoiceNumber: null,
        date: exp.tax_point_date,
        ...amounts,
      });
    }

    const creditNotes = await this.db
      .selectFrom('credit_note as cn')
      .innerJoin('voucher as v', 'v.id', 'cn.voucher_id')
      .innerJoin('expense as e', 'e.id', 'cn.credits_object_id')
      .select([
        'cn.credit_note_number',
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
      const counterparty = await this.loadCounterparty(cn.supplier_id);
      const amounts = await this.voucherAmounts(cn.voucher_id, {
        vatControlCode: 'VAT_RECEIVABLE',
        counterpartyCode: 'AP',
        creditPositive: false,
      });
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
  private async voucherAmounts(
    voucherId: number,
    opts: {
      vatControlCode: string;
      counterpartyCode: string;
      creditPositive: boolean;
    },
  ): Promise<{ vatCode: string; netAmount: number; vatAmount: number }> {
    const lines: AssemblyLine[] = await this.db
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
  ): Promise<{ name: string; regNumber: string | null }> {
    if (entityId === null) {
      return { name: '', regNumber: null };
    }
    const row = await this.db
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
