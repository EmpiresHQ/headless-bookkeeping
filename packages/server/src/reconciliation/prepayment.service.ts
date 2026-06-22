import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { PostingService } from '../ledger/posting/posting.service';
import { CurrencyService } from '../currency/currency.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import {
  DraftVoucher,
  DraftVoucherLine,
  PostedVoucher,
} from '../ledger/voucher/types';

/** Accounts used for prepayment vouchers. */
const CUSTOMER_PREPAYMENTS = 'CUSTOMER_PREPAYMENTS';
const SUPPLIER_PREPAYMENTS = 'SUPPLIER_PREPAYMENTS';
const AR = 'AR';
const AP = 'AP';

/** Result of looking up a prepayment voucher's remaining balance. */
interface PrepaymentBalance {
  voucherId: number;
  accountCode: string;
  originalAmount: number;
  drawnDown: number;
  remaining: number;
  currency: string;
  taxPointDate: string;
}

@Injectable()
export class PrepaymentService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly postingService: PostingService,
    private readonly currencyService: CurrencyService,
    private readonly orgContextResolver: OrgContextResolver,
  ) {}

  /**
   * Build the bank leg + prepayment leg for a prepayment voucher.
   *
   * The bank leg resolves the transaction's REAL bank account (via the
   * statement → account join) and carries the transaction's own currency,
   * converted to base currency via the country plugin's reference rate (D4,
   * 1.0 for same-currency). The prepayment leg is denominated in base
   * currency.
   *
   * Returns the two lines in [bank, prepayment] order; callers set is_debit
   * via the direction flags.
   */
  private async buildBankAndPrepaymentLegs(
    transactionId: number,
    txn: { amount: number; currency: string; transaction_date: string },
    opts: {
      prepaymentAccountCode: string;
      bankIsDebit: boolean;
    },
  ): Promise<[DraftVoucherLine, DraftVoucherLine]> {
    const absAmount = Math.abs(txn.amount);

    // Resolve the REAL bank account code for this transaction by joining
    // statement → account.
    const bankAccount = await this.db
      .selectFrom('bank_transaction')
      .innerJoin(
        'bank_statement',
        'bank_statement.id',
        'bank_transaction.statement_id',
      )
      .innerJoin('account', 'account.id', 'bank_statement.account_id')
      .select('account.code as account_code')
      .where('bank_transaction.id', '=', transactionId)
      .executeTakeFirstOrThrow();
    const resolvedBankCode = bankAccount.account_code;

    const { plugin } = await this.orgContextResolver.resolve();
    const baseCurrency = await this.currencyService.getBaseCurrency();
    const fxRate = plugin.getReferenceRate(
      txn.currency,
      baseCurrency,
      txn.transaction_date,
    );
    const baseAmount = Math.round(absAmount * fxRate);

    const bankLeg: DraftVoucherLine = {
      account_code: resolvedBankCode,
      amount: absAmount,
      currency: txn.currency,
      base_amount: baseAmount,
      fx_rate: fxRate,
      is_debit: opts.bankIsDebit,
    };

    const prepaymentLeg: DraftVoucherLine = {
      account_code: opts.prepaymentAccountCode,
      amount: baseAmount,
      currency: baseCurrency,
      base_amount: baseAmount,
      fx_rate: 1.0,
      is_debit: !opts.bankIsDebit,
    };

    return [bankLeg, prepaymentLeg];
  }

  // ── Creation ──────────────────────────────────────────────────────

  /**
   * Create a prepayment from a bank transaction, dispatching based on amount sign.
   * Incoming (positive) → customer prepayment; outgoing (negative) → supplier prepayment.
   */
  async createPrepaymentFromTransaction(
    transactionId: number,
  ): Promise<PostedVoucher> {
    const txn = await this.transactionRepo.findById(transactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${transactionId} not found`,
      );
    }
    if (txn.amount > 0) {
      return this.createCustomerPrepayment(transactionId);
    }
    if (txn.amount < 0) {
      return this.createSupplierPrepayment(transactionId);
    }
    throw new BadRequestException(
      `Transaction ${transactionId} has zero amount — cannot create prepayment`,
    );
  }

  /**
   * Create a customer prepayment from an unmatched incoming bank payment.
   *
   * Posts: Dr {resolved real bank account} / Cr CUSTOMER_PREPAYMENTS (liability)
   *
   * The bank transaction amount must be positive (incoming).
   */
  async createCustomerPrepayment(
    transactionId: number,
  ): Promise<PostedVoucher> {
    const txn = await this.transactionRepo.findById(transactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${transactionId} not found`,
      );
    }
    if (txn.status !== 'open') {
      throw new BadRequestException(
        `Transaction ${transactionId} is not open (status: ${txn.status})`,
      );
    }
    if (txn.amount <= 0) {
      throw new BadRequestException(
        `Customer prepayment requires a positive (incoming) amount, got ${txn.amount}`,
      );
    }

    // Money received → Dr bank / Cr CUSTOMER_PREPAYMENTS (liability).
    const lines = await this.buildBankAndPrepaymentLegs(transactionId, txn, {
      prepaymentAccountCode: CUSTOMER_PREPAYMENTS,
      bankIsDebit: true,
    });

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      lines,
    };

    const prepared = await this.postingService.prepare(draft);

    return this.db.transaction().execute(async (trx) => {
      const voucher = await this.postingService.postVoucherTx(
        trx,
        prepared.draft,
        prepared.resolved,
      );
      await this.transactionRepo.updateStatus(
        transactionId,
        'prepayment',
        trx,
      );
      return voucher;
    });
  }

  /**
   * Create a supplier prepayment from an unmatched outgoing bank payment.
   *
   * Posts: Dr SUPPLIER_PREPAYMENTS / Cr {resolved real bank account} (asset)
   *
   * The bank transaction amount must be negative (outgoing).
   */
  async createSupplierPrepayment(
    transactionId: number,
  ): Promise<PostedVoucher> {
    const txn = await this.transactionRepo.findById(transactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${transactionId} not found`,
      );
    }
    if (txn.status !== 'open') {
      throw new BadRequestException(
        `Transaction ${transactionId} is not open (status: ${txn.status})`,
      );
    }
    if (txn.amount >= 0) {
      throw new BadRequestException(
        `Supplier prepayment requires a negative (outgoing) amount, got ${txn.amount}`,
      );
    }

    // Money sent → Dr SUPPLIER_PREPAYMENTS (asset) / Cr bank.
    const lines = await this.buildBankAndPrepaymentLegs(transactionId, txn, {
      prepaymentAccountCode: SUPPLIER_PREPAYMENTS,
      bankIsDebit: false,
    });

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      lines,
    };

    const prepared = await this.postingService.prepare(draft);

    return this.db.transaction().execute(async (trx) => {
      const voucher = await this.postingService.postVoucherTx(
        trx,
        prepared.draft,
        prepared.resolved,
      );
      await this.transactionRepo.updateStatus(
        transactionId,
        'prepayment',
        trx,
      );
      return voucher;
    });
  }

  // ── Draw-down ─────────────────────────────────────────────────────

  /**
   * Draw down a prepayment against an invoice.
   *
   * For customer prepayments: Dr CUSTOMER_PREPAYMENTS / Cr AR
   * For supplier prepayments: Dr AP / Cr SUPPLIER_PREPAYMENTS
   *
   * The actual amount drawn is min(prepayment remaining, invoice remaining, requested).
   */
  async drawDownPrepayment(
    prepaymentVoucherId: number,
    invoiceVoucherId: number,
    amount: number,
  ): Promise<PostedVoucher> {
    if (amount <= 0) {
      throw new BadRequestException('Draw-down amount must be positive');
    }

    // Look up the prepayment voucher and identify its type.
    const prepaymentBalance =
      await this.getPrepaymentBalance(prepaymentVoucherId);
    if (!prepaymentBalance) {
      throw new NotFoundException(
        `Prepayment voucher ${prepaymentVoucherId} not found`,
      );
    }
    if (prepaymentBalance.remaining <= 0) {
      throw new BadRequestException(
        `Prepayment voucher ${prepaymentVoucherId} has no remaining balance`,
      );
    }

    // Look up the invoice voucher and find its AR/AP line.
    const invoiceBalance = await this.getInvoiceBalance(invoiceVoucherId);
    if (!invoiceBalance) {
      throw new NotFoundException(
        `Invoice voucher ${invoiceVoucherId} not found`,
      );
    }
    if (invoiceBalance.remaining <= 0) {
      throw new BadRequestException(
        `Invoice voucher ${invoiceVoucherId} has no remaining balance`,
      );
    }

    // Validate that prepayment type matches invoice type.
    const isCustomer = prepaymentBalance.accountCode === CUSTOMER_PREPAYMENTS;
    const isSupplier = prepaymentBalance.accountCode === SUPPLIER_PREPAYMENTS;
    const invoiceIsAR = invoiceBalance.accountCode === AR;
    const invoiceIsAP = invoiceBalance.accountCode === AP;

    if (isCustomer && !invoiceIsAR) {
      throw new BadRequestException(
        'Customer prepayment can only be drawn down against an AR invoice',
      );
    }
    if (isSupplier && !invoiceIsAP) {
      throw new BadRequestException(
        'Supplier prepayment can only be drawn down against an AP invoice',
      );
    }

    // Clamp the draw-down amount.
    const drawAmount = Math.min(
      amount,
      prepaymentBalance.remaining,
      invoiceBalance.remaining,
    );

    if (drawAmount <= 0) {
      throw new BadRequestException('No amount available to draw down');
    }

    // Relief is computed in BASE currency (D3-family). `drawAmount` is the min
    // of base-tracked remaining balances, so both legs are booked explicitly in
    // base currency at fx 1.0. This balances in base and relieves AR/AP and the
    // prepayment by the same base amount. Any residual invoice balance (because
    // the invoice was booked at a different rate than the prepayment was
    // received) correctly remains OPEN AR/AP, to be settled later by cash —
    // realized FX is recognised at that settlement, NOT here at draw-down.
    const currency = await this.currencyService.getBaseCurrency();
    const taxPointDate = new Date().toISOString().slice(0, 10);

    let draft: DraftVoucher;

    if (isCustomer) {
      // Dr CUSTOMER_PREPAYMENTS / Cr AR
      draft = {
        tax_point_date: taxPointDate,
        reason: `Draw-down of prepayment V-${prepaymentVoucherId} against invoice V-${invoiceVoucherId}`,
        lines: [
          {
            account_code: CUSTOMER_PREPAYMENTS,
            amount: drawAmount,
            currency,
            base_amount: drawAmount,
            fx_rate: 1.0,
            is_debit: true,
          },
          {
            account_code: AR,
            amount: drawAmount,
            currency,
            base_amount: drawAmount,
            fx_rate: 1.0,
            is_debit: false,
          },
        ],
      };
    } else {
      // Dr AP / Cr SUPPLIER_PREPAYMENTS
      draft = {
        tax_point_date: taxPointDate,
        reason: `Draw-down of prepayment V-${prepaymentVoucherId} against invoice V-${invoiceVoucherId}`,
        lines: [
          {
            account_code: AP,
            amount: drawAmount,
            currency,
            base_amount: drawAmount,
            fx_rate: 1.0,
            is_debit: true,
          },
          {
            account_code: SUPPLIER_PREPAYMENTS,
            amount: drawAmount,
            currency,
            base_amount: drawAmount,
            fx_rate: 1.0,
            is_debit: false,
          },
        ],
      };
    }

    return this.postingService.postVoucher(draft);
  }

  // ── Listing ───────────────────────────────────────────────────────

  /**
   * List all outstanding prepayment vouchers with their remaining balances.
   */
  async listOutstandingPrepayments(): Promise<PrepaymentBalance[]> {
    const rows = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
      .select('voucher_line.voucher_id as voucher_id')
      .select('account.code as account_code')
      .select('voucher_line.base_amount as original_amount')
      .select('voucher_line.currency as currency')
      .select('voucher.tax_point_date as tax_point_date')
      .where('account.code', 'in', [CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS])
      .execute();

    const results: PrepaymentBalance[] = [];

    for (const row of rows) {
      const drawnDown = await this.getDrawnDownForPrepayment(row.voucher_id);
      const remaining = row.original_amount - drawnDown;

      if (remaining > 0) {
        results.push({
          voucherId: row.voucher_id,
          accountCode: row.account_code,
          originalAmount: row.original_amount,
          drawnDown,
          remaining,
          currency: row.currency,
          taxPointDate: row.tax_point_date,
        });
      }
    }

    return results;
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Get the remaining balance of a prepayment voucher.
   * Looks for the CUSTOMER_PREPAYMENTS (credit) or SUPPLIER_PREPAYMENTS (debit) line.
   */
  private async getPrepaymentBalance(
    voucherId: number,
  ): Promise<PrepaymentBalance | null> {
    const line = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .innerJoin('voucher', 'voucher.id', 'voucher_line.voucher_id')
      .select('voucher_line.voucher_id as voucher_id')
      .select('account.code as account_code')
      .select('voucher_line.base_amount as original_amount')
      .select('voucher_line.currency as currency')
      .select('voucher.tax_point_date as tax_point_date')
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', 'in', [CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS])
      .executeTakeFirst();

    if (!line) return null;

    const drawnDown = await this.getDrawnDownForPrepayment(voucherId);

    return {
      voucherId: line.voucher_id,
      accountCode: line.account_code,
      originalAmount: line.original_amount,
      drawnDown,
      remaining: line.original_amount - drawnDown,
      currency: line.currency,
      taxPointDate: line.tax_point_date,
    };
  }

  /**
   * Get the remaining balance of an invoice voucher.
   * Looks for the AR (debit) or AP (credit) line.
   */
  private async getInvoiceBalance(voucherId: number): Promise<{
    accountCode: string;
    remaining: number;
  } | null> {
    const line = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select('account.code as account_code')
      .select('voucher_line.base_amount as original_amount')
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', 'in', [AR, AP])
      .executeTakeFirst();

    if (!line) return null;

    const alreadyDrawn = await this.getAlreadyDrawnForInvoice(voucherId);

    return {
      accountCode: line.account_code,
      remaining: line.original_amount - alreadyDrawn,
    };
  }

  /**
   * Get the total amount already drawn down from a prepayment voucher.
   * A draw-down voucher has a line that debits/credits the prepayment account
   * in the opposite direction of the original.
   */
  private async getDrawnDownForPrepayment(voucherId: number): Promise<number> {
    // Find draw-down vouchers that reference this prepayment via their reason
    // or by having an opposite-direction line on the same prepayment account.
    // For simplicity, we look for vouchers that have a line on the same
    // prepayment account but in the opposite direction.
    const line = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select('voucher_line.is_debit as original_is_debit')
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', 'in', [CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS])
      .executeTakeFirst();

    if (!line) return 0;

    // The opposite direction: if original was credit (0), look for debits (1).
    const oppositeDebit = line.original_is_debit === 1 ? 0 : 1;

    // Find all draw-down vouchers that have a line on this prepayment account
    // in the opposite direction. We identify them by having BOTH the prepayment
    // account line AND an AR/AP line.
    const drawDownVoucherIds = await this.db
      .selectFrom('voucher_line as vl1')
      .innerJoin('account as a1', 'a1.id', 'vl1.account_id')
      .innerJoin('voucher_line as vl2', 'vl2.voucher_id', 'vl1.voucher_id')
      .innerJoin('account as a2', 'a2.id', 'vl2.account_id')
      .select('vl1.voucher_id as voucher_id')
      .select((eb) => eb.fn.sum<number>('vl1.base_amount').as('total'))
      .where('a1.code', 'in', [CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS])
      .where('vl1.is_debit', '=', oppositeDebit)
      .where('a2.code', 'in', [AR, AP])
      .where('vl1.voucher_id', '!=', voucherId)
      .groupBy('vl1.voucher_id')
      .execute();

    let total = 0;
    for (const row of drawDownVoucherIds) {
      total += row.total;
    }

    return total;
  }

  /**
   * Get the total amount already drawn down against an invoice voucher.
   */
  private async getAlreadyDrawnForInvoice(voucherId: number): Promise<number> {
    const line = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select('voucher_line.is_debit as original_is_debit')
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', 'in', [AR, AP])
      .executeTakeFirst();

    if (!line) return 0;

    // The opposite direction: if original AR was debit (1), look for credits (0).
    const oppositeDebit = line.original_is_debit === 1 ? 0 : 1;

    const drawDownVoucherIds = await this.db
      .selectFrom('voucher_line as vl1')
      .innerJoin('account as a1', 'a1.id', 'vl1.account_id')
      .innerJoin('voucher_line as vl2', 'vl2.voucher_id', 'vl1.voucher_id')
      .innerJoin('account as a2', 'a2.id', 'vl2.account_id')
      .select((eb) => eb.fn.sum<number>('vl1.base_amount').as('total'))
      .where('a1.code', 'in', [AR, AP])
      .where('vl1.is_debit', '=', oppositeDebit)
      .where('a2.code', 'in', [CUSTOMER_PREPAYMENTS, SUPPLIER_PREPAYMENTS])
      .where('vl1.voucher_id', '!=', voucherId)
      .executeTakeFirst();

    return drawDownVoucherIds?.total ?? 0;
  }
}
