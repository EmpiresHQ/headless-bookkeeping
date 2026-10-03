import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
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

    // 3. Get org_type + country from organization.
    //
    // The measurement basis is sampled FIRST, ahead of every other read of the
    // organisation (issue #215): a personal disposition off a bank transaction
    // can be the ledger's first voucher, and the plugin, the rate and the
    // rounding are all resolved after this point. The earliest sample is what
    // makes the guard sound — a settings edit landing anywhere in the window
    // leaves this stamp disagreeing with the row the posting transaction reads
    // and the post is refused, whereas a LATER sample would record the new
    // basis against amounts the old plugin measured.
    const { baseCurrency, basis } = await this.currencyService.getLedgerBasis();
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
    // Guard the plugin call to the cross-currency case only: same-currency is
    // an identity (rate 1.0) and the null plugin throws on a real FX pair.
    // Resolved BEFORE the transaction opens (#203: the lookup is now
    // authoritative and may reach the network; better-sqlite3's single
    // synchronous connection forbids that inside an open transaction).
    const {
      rate: fxRate,
      rateDate,
      source: rateSource,
    } = txn.currency === baseCurrency
      ? {
          rate: 1.0,
          rateDate: txn.transaction_date,
          source: IDENTITY_RATE_SOURCE,
        }
      : await plugin.getReferenceRate(
          txn.currency,
          baseCurrency,
          txn.transaction_date,
        );
    const baseAmount = Math.round(absAmount * fxRate);

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      measured_basis: basis,
      reason: `Personal disposition: ${txn.description ?? 'no description'}`,
      lines: [
        {
          account_code: dispositionAccount,
          amount: baseAmount,
          currency: baseCurrency,
          base_amount: baseAmount,
          fx_rate: 1.0,
          fx_rate_date: txn.transaction_date,
          fx_rate_source: IDENTITY_RATE_SOURCE,
          is_debit: true,
        },
        {
          account_code: resolvedBankCode,
          amount: absAmount,
          currency: txn.currency,
          base_amount: baseAmount,
          fx_rate: fxRate,
          fx_rate_date: rateDate,
          fx_rate_source: rateSource,
          is_debit: false,
        },
      ],
    };

    const prepared = await this.postingService.prepare(draft);

    return this.db.transaction().execute(async (trx) => {
      const voucher = await this.postingService.postVoucherTx(
        trx,
        prepared.draft,
        prepared.resolved,
      );
      await this.transactionRepo.updateStatus(transactionId, 'personal', trx);
      return voucher;
    });
  }
}
