import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PostingService } from '../ledger/posting/posting.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { AccountService } from '../ledger/account/account.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import {
  DraftVoucher,
  DraftVoucherLine,
  VoucherLine,
} from '../ledger/voucher/types';
import { CorrectionRequest, CorrectionResult } from './types';
import { CorrectionParams } from './types/correction-params.type';

@Injectable()
export class CorrectionsService {
  constructor(
    private readonly postingService: PostingService,
    private readonly voucherRepository: VoucherRepository,
    private readonly voucherLineRepository: VoucherLineRepository,
    private readonly accountService: AccountService,
    private readonly periodLock: PeriodLockService,
    private readonly expensesService: ExpensesService,
    private readonly salesInvoicesService: SalesInvoicesService,
  ) {}

  async correctExpense(
    id: number,
    request: CorrectionRequest,
  ): Promise<CorrectionResult> {
    const expense = await this.expensesService.getExpenseById(id);
    return this.correctBusinessObject({
      objectType: 'expense',
      objectId: id,
      status: expense.status,
      voucherId: expense.voucher_id,
      request,
      updateDraft: (patch) => this.expensesService.updateDraft(id, patch),
      generateDraftVoucher: () => this.expensesService.generateDraftVoucher(id),
      previewPatchedDraft: (patch) =>
        this.expensesService.previewPatchedDraft(id, patch),
      patchAmountsTx: (trx, patch) =>
        this.expensesService.patchAmountsTx(trx, id, patch),
      markReversedTx: (trx, voucherId) =>
        this.expensesService.markReversedTx(trx, id, voucherId),
    });
  }

  async correctSalesInvoice(
    id: number,
    request: CorrectionRequest,
  ): Promise<CorrectionResult> {
    const invoice = await this.salesInvoicesService.getInvoiceById(id);
    return this.correctBusinessObject({
      objectType: 'sales_invoice',
      objectId: id,
      status: invoice.status,
      voucherId: invoice.voucher_id,
      request,
      updateDraft: (patch) => this.salesInvoicesService.updateDraft(id, patch),
      generateDraftVoucher: () =>
        this.salesInvoicesService.generateDraftVoucher(id),
      previewPatchedDraft: (patch) =>
        this.salesInvoicesService.previewPatchedDraft(id, patch),
      patchAmountsTx: (trx, patch) =>
        this.salesInvoicesService.patchAmountsTx(trx, id, patch),
      markReversedTx: (trx, voucherId) =>
        this.salesInvoicesService.markReversedTx(trx, id, voucherId),
    });
  }

  private async correctBusinessObject(
    params: CorrectionParams,
  ): Promise<CorrectionResult> {
    const { request, status, voucherId } = params;

    // 1. Cosmetic
    if (request.kind === 'cosmetic') {
      return { outcome: 'cosmetic_attachment_replaced' };
    }

    // 5. Credit note
    if (request.kind === 'credit_note') {
      return { outcome: 'credit_note_not_implemented' };
    }

    // 2. Financial + draft/pending
    if (status === 'draft' || status === 'pending') {
      if (request.patch) {
        await params.updateDraft(request.patch);
      }
      const draft = await params.generateDraftVoucher();
      return { outcome: 'draft_edited', draftVoucher: draft };
    }

    // 3. Financial + posted
    if (status === 'posted' && voucherId !== null) {
      const originalVoucher =
        await this.voucherRepository.getVoucherById(voucherId);
      if (!originalVoucher) {
        throw new NotFoundException(`Voucher ${voucherId} not found`);
      }

      const originalLines =
        await this.voucherLineRepository.getLinesByVoucherId(voucherId);

      // Locked-period redirect (ADR-0009): if the original voucher's period is
      // now filed (locked), the correction may not touch it. Re-date BOTH the
      // reversal and the correction into the current open period instead of
      // dead-ending — the VAT effect surfaces in that period's return.
      const lockedPeriod = await this.periodLock.findLockedPeriod(
        originalVoucher.tax_point_date,
      );
      let effectiveTaxPointDate = originalVoucher.tax_point_date;
      let redirected = false;
      let redirectedToPeriodId: number | undefined;
      if (lockedPeriod) {
        const openPeriod = await this.periodLock.getCurrentOpenPeriod();
        if (!openPeriod) {
          throw new ConflictException(
            `Cannot correct a voucher in locked period ${lockedPeriod.name}: no open period to receive the correction`,
          );
        }
        effectiveTaxPointDate = openPeriod.start_date;
        redirected = true;
        redirectedToPeriodId = openPeriod.id;
      }

      // Build reversal voucher (mirror lines), dated into the effective period.
      const reversalDraft = await this.buildReversalDraft(
        originalVoucher.voucher_number,
        effectiveTaxPointDate,
        originalLines,
        voucherId,
        request.reason,
      );

      // Build the corrected voucher from the patched-in-memory object WITHOUT
      // persisting the patch yet — all reads happen up front (the better-sqlite3
      // single connection forbids this.db reads inside the open transaction).
      const correctedDraft = await params.previewPatchedDraft(
        request.patch ?? {},
      );
      correctedDraft.voucher_number = `${originalVoucher.voucher_number}-COR`;
      correctedDraft.tax_point_date = effectiveTaxPointDate;
      correctedDraft.corrects_object_type =
        params.objectType === 'expense' ? 'expense' : 'sales_invoice';
      correctedDraft.corrects_object_id = params.objectId;
      correctedDraft.reason = request.reason;

      // The whole correction is one transaction: persist the amount patch, post
      // the reversal + correction vouchers, and flip the object to `reversed`
      // (re-pointed at the corrected voucher) — all or nothing.
      const [reversalVoucher, correctedVoucher] =
        await this.postingService.postVouchersAtomic(
          [reversalDraft, correctedDraft],
          {
            beforePost: async (trx) => {
              if (request.patch) {
                await params.patchAmountsTx(trx, request.patch);
              }
            },
            afterPost: (trx, posted) =>
              params.markReversedTx(trx, posted[1].id),
          },
        );

      return {
        outcome: 'posted_reversal_and_correction',
        reversalVoucherId: reversalVoucher.id,
        correctedVoucherId: correctedVoucher.id,
        redirected,
        redirectedToPeriodId,
      };
    }

    return { outcome: 'unsupported_status' };
  }

  private async buildReversalDraft(
    originalVoucherNumber: string,
    taxPointDate: string,
    originalLines: VoucherLine[],
    originalVoucherId: number,
    reason: string,
  ): Promise<DraftVoucher> {
    const accountIds = [...new Set(originalLines.map((l) => l.account_id))];
    const accounts = await this.accountService.getAccountsByIds(accountIds);
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const lines: DraftVoucherLine[] = originalLines.map((l) => {
      const account = byId.get(l.account_id);
      if (!account) {
        throw new Error(`Account ${l.account_id} not found`);
      }
      return {
        account_code: account.code,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        vat_code: l.vat_code,
        is_debit: !l.is_debit,
      };
    });

    return {
      voucher_number: `${originalVoucherNumber}-REV`,
      tax_point_date: taxPointDate,
      lines,
      reverses_id: originalVoucherId,
      reason,
    };
  }
}
