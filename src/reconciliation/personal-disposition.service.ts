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
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { OrganizationService } from '../organization/organization.service';
import { DraftVoucher, PostedVoucher } from '../ledger/voucher/types';

/** Account code for the bank (base currency). */
const BANK_EUR = 'BANK_EUR';

@Injectable()
export class PersonalDispositionService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly postingService: PostingService,
    private readonly plugin: NullCountryPlugin,
    private readonly orgService: OrganizationService,
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
   * Posts: Dr {plugin-resolved account} / Cr BANK_EUR
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

    // 3. Get org_type from organization
    const org = await this.orgService.getOrganization();
    const orgType = org.org_type;

    // 4. Resolve account via plugin (NEVER hardcoded in service)
    const dispositionAccount =
      this.plugin.resolvePersonalDispositionAccount(orgType);

    // 5. Post voucher: Dr {resolved_account} / Cr BANK_EUR
    // Personal dispositions are always outflows (money leaving the business).
    // The amount is the absolute value of the transaction.
    const absAmount = Math.abs(txn.amount);
    const currency = txn.currency;

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      reason: `Personal disposition: ${txn.description ?? 'no description'}`,
      lines: [
        {
          account_code: dispositionAccount,
          amount: absAmount,
          currency,
          base_amount: absAmount,
          fx_rate: 1.0,
          is_debit: true,
        },
        {
          account_code: BANK_EUR,
          amount: absAmount,
          currency,
          base_amount: absAmount,
          fx_rate: 1.0,
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
