import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { VoucherRepository } from '../ledger/voucher/voucher.repository';
import { VoucherLineRepository } from '../ledger/voucher/voucher-line.repository';
import { AccountService } from '../ledger/account/account.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import {
  DraftVoucher,
  DraftVoucherLine,
  PostedVoucher,
  Voucher,
  VoucherLine,
} from '../ledger/voucher/types';
import { CorrectionRequest, CorrectionResult } from './types';
import { CorrectionParams } from './types/correction-params.type';

/**
 * The effective reporting target for a posted correction: the tax-point date
 * the reversal + corrected vouchers will carry, plus whether that date was
 * REDIRECTED out of a locked period into the current open one (ADR-0009).
 */
interface CorrectionTarget {
  taxPointDate: string;
  redirected: boolean;
  redirectedToPeriodId?: number;
}

/**
 * The reversal + correction Voucher pair, identified by ROLE rather than by
 * array position. {@link CorrectionsService.postReversalAndCorrection} returns
 * this so the caller never reaches for `posted[1]` — the corrected voucher is
 * named, so it cannot be confused with the reversal.
 */
interface ReversalAndCorrection {
  reversal: PostedVoucher;
  corrected: PostedVoucher;
}

/**
 * CorrectionsService — the DEEP module whose interface is "correct a posted
 * object" ({@link correctExpense} / {@link correctSalesInvoice}, both reducing
 * to {@link correctBusinessObject}). Behind that small surface live the moving
 * parts a caller must NOT have to know about:
 *
 *  1. The reversal + repost as a semantically-NAMED pair
 *     ({@link postReversalAndCorrection} → `{ reversal, corrected }`). The
 *     corrected voucher is identified by role, never by `posted[1]`.
 *  2. Locked-period REDIRECTION (ADR-0009): {@link resolveCorrectionTarget}
 *     re-dates both vouchers into the current open period when the original's
 *     tax-point date sits in a locked Reporting period, carrying the
 *     reverses / corrects_object references back.
 *  3. The reversed-marking (`posted → reversed` + `voucher_id`) through the
 *     {@link StatusTransitionService} seam, keyed to the `corrected` role.
 *  4. An explicit CORRECT-A-CORRECTION policy: an object whose live Voucher is
 *     itself a reversal or correction (or whose status is the terminal
 *     `reversed`) is REJECTED — a correction is reversed exactly once; a
 *     further change starts from the corrected object, not by re-correcting the
 *     already-superseded one (ADR-0006: `reversed` is terminal).
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly postingService: PostingService,
    private readonly statusTransition: StatusTransitionService,
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
      return this.correctPostedObject(params, voucherId);
    }

    // 4. Correct-a-correction policy (ADR-0006): a corrected object is left in
    // the terminal `reversed` state, re-pointed at its corrected Voucher. It is
    // NOT re-correctable — `reversed` has no outgoing transition. A second
    // correction request therefore lands here, and we reject it EXPLICITLY
    // rather than silently no-op-ing, so the caller gets a clear signal.
    return { outcome: 'unsupported_status' };
  }

  /**
   * The "correct a posted object" core: reverse the original Voucher and post
   * its corrected replacement as a single atomic unit, flipping the object to
   * `reversed` and re-pointing it at the corrected Voucher.
   */
  private async correctPostedObject(
    params: CorrectionParams,
    voucherId: number,
  ): Promise<CorrectionResult> {
    const { request } = params;

    const originalVoucher =
      await this.voucherRepository.getVoucherById(voucherId);
    if (!originalVoucher) {
      throw new NotFoundException(`Voucher ${voucherId} not found`);
    }

    // Correct-a-correction policy (ADR-0006), defensive arm: a `posted` object
    // should never point at a reversal/correction Voucher (that pairing leaves
    // the object `reversed`). If it somehow does, refuse rather than stack a
    // correction on a correction.
    if (this.isCorrectionArtifact(originalVoucher)) {
      throw new ConflictException(
        `Voucher ${voucherId} is itself a reversal/correction and cannot be corrected again`,
      );
    }

    const originalLines =
      await this.voucherLineRepository.getLinesByVoucherId(voucherId);

    const target = await this.resolveCorrectionTarget(originalVoucher);

    // Build the reversal (mirror lines) and the corrected voucher as a named
    // pair, both dated into the effective (possibly redirected) period and
    // carrying the reverses / corrects_object references back to the original.
    const reversalDraft = await this.buildReversalDraft(
      originalVoucher.voucher_number,
      target.taxPointDate,
      originalLines,
      voucherId,
      request.reason,
    );

    // The corrected voucher is built from the patched-in-memory object WITHOUT
    // persisting the patch yet — all reads happen up front (the better-sqlite3
    // single connection forbids this.db reads inside the open transaction).
    const correctedDraft = await params.previewPatchedDraft(
      request.patch ?? {},
    );
    correctedDraft.voucher_number = `${originalVoucher.voucher_number}-COR`;
    correctedDraft.tax_point_date = target.taxPointDate;
    correctedDraft.corrects_object_type = params.objectType;
    correctedDraft.corrects_object_id = params.objectId;
    correctedDraft.reason = request.reason;

    const { reversal, corrected } = await this.postReversalAndCorrection(
      { reversal: reversalDraft, corrected: correctedDraft },
      params,
    );

    return {
      outcome: 'posted_reversal_and_correction',
      reversalVoucherId: reversal.id,
      correctedVoucherId: corrected.id,
      redirected: target.redirected,
      redirectedToPeriodId: target.redirectedToPeriodId,
    };
  }

  /**
   * True iff the Voucher is itself a correction artifact — a reversal
   * (`reverses_id`) or a corrected voucher (`corrects_object_*`). Used by the
   * correct-a-correction policy.
   */
  private isCorrectionArtifact(voucher: Voucher): boolean {
    return voucher.reverses_id !== null || voucher.corrects_object_id !== null;
  }

  /**
   * Resolve which Reporting period the correction lands in (ADR-0009). If the
   * original Voucher's tax-point date is in a LOCKED period, the correction may
   * not touch it: both the reversal and corrected vouchers are REDIRECTED into
   * the current open period (re-dated to its start), and the VAT effect
   * surfaces in that period's return. Otherwise the original date stands.
   */
  private async resolveCorrectionTarget(
    originalVoucher: Voucher,
  ): Promise<CorrectionTarget> {
    const lockedPeriod = await this.periodLock.findLockedPeriod(
      originalVoucher.tax_point_date,
    );
    if (!lockedPeriod) {
      return {
        taxPointDate: originalVoucher.tax_point_date,
        redirected: false,
      };
    }

    const openPeriod = await this.periodLock.getCurrentOpenPeriod();
    if (!openPeriod) {
      throw new ConflictException(
        `Cannot correct a voucher in locked period ${lockedPeriod.name}: no open period to receive the correction`,
      );
    }

    return {
      taxPointDate: openPeriod.start_date,
      redirected: true,
      redirectedToPeriodId: openPeriod.id,
    };
  }

  /**
   * Post the reversal + corrected Voucher as one atomic unit and flip the
   * object to `reversed`, re-pointed at the CORRECTED voucher. The whole thing
   * is one transaction (all or nothing): the amount patch, both voucher
   * inserts, and the status flip.
   *
   * The corrected voucher is identified by ROLE — the helper threads the
   * `corrected` draft through and returns the matching posted voucher by name,
   * so the reversed-marking re-points the object at `corrected.id` without any
   * positional `posted[1]` indexing (a swapped order would be a type/role
   * mismatch, not a silent wrong-voucher pointer).
   */
  private async postReversalAndCorrection(
    drafts: { reversal: DraftVoucher; corrected: DraftVoucher },
    params: CorrectionParams,
  ): Promise<ReversalAndCorrection> {
    const { request } = params;

    // Fixed order: reversal first (nets the original), corrected second. We
    // keep the order local to this helper and re-derive the roles from the
    // returned vouchers by their back-references, so no caller depends on it.
    const posted = await this.postingService.postVouchersAtomic(
      [drafts.reversal, drafts.corrected],
      {
        beforePost: async (trx) => {
          if (request.patch) {
            await params.patchAmountsTx(trx, request.patch);
          }
        },
        // Flip the object posted → reversed and re-point it at the CORRECTED
        // voucher, through the single status-transition seam (ADR-0006). The
        // corrected voucher is resolved by role (its corrects_object back-ref),
        // not by array index — see resolveRoles.
        afterPost: (trx, postedVouchers) =>
          this.markReversed(trx, params, this.resolveRoles(postedVouchers)),
      },
    );

    return this.resolveRoles(posted);
  }

  /**
   * Identify the reversal and corrected vouchers from a posted pair by ROLE,
   * not by position: the reversal carries `reverses_id`, the corrected carries
   * `corrects_object_id`. This is the seam that kills the `posted[1]` magic
   * index — swap the two and this still picks the right one (and throws if the
   * roles aren't both present).
   */
  private resolveRoles(posted: PostedVoucher[]): ReversalAndCorrection {
    const reversal = posted.find((v) => v.reverses_id !== null);
    const corrected = posted.find((v) => v.corrects_object_id !== null);
    if (!reversal || !corrected) {
      throw new Error(
        'Correction post did not yield a reversal + corrected voucher pair',
      );
    }
    return { reversal, corrected };
  }

  /**
   * Flip the object posted → reversed and re-point it at the CORRECTED voucher,
   * through the StatusTransitionService seam (ADR-0006). The seam co-writes
   * voucher_id with the status flip and rejects an illegal transition.
   */
  private markReversed(
    trx: Kysely<Database>,
    params: CorrectionParams,
    roles: ReversalAndCorrection,
  ): Promise<void> {
    return this.statusTransition.transition(
      trx,
      params.objectType,
      params.objectId,
      'posted',
      'reversed',
      { extras: { voucher_id: roles.corrected.id } },
    );
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
