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
import { DraftVoucher, PostedVoucher } from '../ledger/voucher/types';

@Injectable()
export class PersonalDispositionService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly postingService: PostingService,
    private readonly currencyService: CurrencyService,
    private readonly orgContextResolver: OrgContextResolver,
  ) {}

  /**
   * Mark a bank transaction as personal (non-business) and post the voucher.
   *
   * Per ADR-0017:
   * - NOT a business expense: no input VAT, not deductible
   * - Booking account resolved by country plugin via resolvePersonalDispositionAccount(orgType)
   * - sole_proprietor → OWNERS_DRAWINGS (equity contra)
   * - company → SHAREHOLDER_LOAN (receivable-from-owner, asset)
   *
   * Posts: Dr {plugin-resolved account} / Cr {real bank account}
   *
   * The bank leg resolves the transaction's actual bank account (via the
   * statement → account join) and carries the transaction's own currency,
   * converted to base currency via the country plugin's reference rate
   * (D4). The disposition leg is denominated in base currency.
   *
   * @param transactionId - The bank transaction to mark as personal
   * @returns The posted voucher
   */
  async markAsPersonal(transactionId: number): Promise<PostedVoucher> {
    // 1. Look up bank transaction
    const txn = await this.transactionRepo.findById(transactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${transactionId} not found`,
      );
    }

    // 2. Validate status is 'open'
    if (txn.status !== 'open') {
      throw new BadRequestException(
        `Transaction ${transactionId} is not open (status: ${txn.status})`,
      );
    }

    // 2b. Validate transaction is an outflow (money leaving the business).
    // Per ADR-0017, personal dispositions are outflows only. An incoming
    // (positive-amount) transaction is not a personal disposition.
    if (txn.amount >= 0) {
      throw new BadRequestException(
        `Transaction ${transactionId} is not an outflow (amount: ${txn.amount}); ` +
          `personal dispositions only apply to money leaving the business`,
      );
    }

    // 3. Get org_type + country from organization
    const { organization: org, plugin } =
      await this.orgContextResolver.resolve();
    const orgType = org.org_type;

    // 4. Resolve disposition account via plugin (NEVER hardcoded in service)
    const dispositionAccount =
      plugin.resolvePersonalDispositionAccount(orgType);

    // 4b. Resolve the REAL bank account code for this transaction by joining
    // statement → account (same join FXRealizedService uses).
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

    // 5. Post voucher: Dr {disposition account} / Cr {real bank account}.
    // Personal dispositions are always outflows; amount is the absolute value.
    // The bank leg carries the transaction's currency converted to base
    // currency via the plugin reference rate (1.0 for same-currency).
    const absAmount = Math.abs(txn.amount);
    const baseCurrency = await this.currencyService.getBaseCurrency();
    // Guard the plugin call to the cross-currency case only: same-currency is
    // an identity (rate 1.0) and the null plugin throws on a real FX pair.
    const fxRate =
      txn.currency === baseCurrency
        ? 1.0
        : plugin.getReferenceRate(
            txn.currency,
            baseCurrency,
            txn.transaction_date,
          );
    const baseAmount = Math.round(absAmount * fxRate);

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      reason: `Personal disposition: ${txn.description ?? 'no description'}`,
      lines: [
        {
          account_code: dispositionAccount,
          amount: baseAmount,
          currency: baseCurrency,
          base_amount: baseAmount,
          fx_rate: 1.0,
          is_debit: true,
        },
        {
          account_code: resolvedBankCode,
          amount: absAmount,
          currency: txn.currency,
          base_amount: baseAmount,
          fx_rate: fxRate,
          is_debit: false,
        },
      ],
    };

    const voucher = await this.postingService.postVoucher(draft);

    // 6. Update transaction status to 'personal'
    await this.transactionRepo.updateStatus(transactionId, 'personal');

    return voucher;
  }
}
