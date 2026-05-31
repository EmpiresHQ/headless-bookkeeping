import { Injectable, NotFoundException } from '@nestjs/common';
import { PostingService } from '../ledger/posting/posting.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { AccountService } from '../ledger/account/account.service';
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
      patchAmounts: (patch) => this.expensesService.patchAmounts(id, patch),
      generateDraftVoucher: () => this.expensesService.generateDraftVoucher(id),
      markReversed: (voucherId) =>
        this.expensesService.markReversed(id, voucherId),
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
      patchAmounts: (patch) =>
        this.salesInvoicesService.patchAmounts(id, patch),
      generateDraftVoucher: () =>
        this.salesInvoicesService.generateDraftVoucher(id),
      markReversed: (voucherId) =>
        this.salesInvoicesService.markReversed(id, voucherId),
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

    // 4. Locked period (stub)
    if (this.isLockedPeriod(voucherId)) {
      return { outcome: 'locked_period_not_implemented' };
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

      // Build reversal voucher (mirror lines)
      const reversalDraft = await this.buildReversalDraft(
        originalVoucher.voucher_number,
        originalVoucher.tax_point_date,
        originalLines,
        voucherId,
        request.reason,
      );
      const reversalVoucher =
        await this.postingService.postVoucher(reversalDraft);

      // Update business object with patch if provided
      if (request.patch) {
        await params.patchAmounts(request.patch);
      }

      // Build corrected voucher
      const correctedDraft = await params.generateDraftVoucher();
      correctedDraft.voucher_number = `${originalVoucher.voucher_number}-COR`;
      correctedDraft.corrects_object_type =
        params.objectType === 'expense' ? 'expense' : 'sales_invoice';
      correctedDraft.corrects_object_id = params.objectId;
      correctedDraft.reason = request.reason;

      const correctedVoucher =
        await this.postingService.postVoucher(correctedDraft);

      await params.markReversed(correctedVoucher.id);

      return {
        outcome: 'posted_reversal_and_correction',
        reversalVoucherId: reversalVoucher.id,
        correctedVoucherId: correctedVoucher.id,
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

  private isLockedPeriod(_voucherId: number | null): boolean {
    // Stub: period lock enforcement is deferred
    return false;
  }
}
