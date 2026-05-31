import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import type { CountryPlugin } from '../plugins/country-plugin.interface';
import { OrganizationService } from '../organization/organization.service';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { DraftVoucher } from '../ledger/voucher/types';
import {
  DividendDeclarationDto,
  DividendDeclarationResult,
  DividendSettlementResult,
} from './types';

/** Injection token for the country plugin (allows test overrides). */
export const COUNTRY_PLUGIN_TOKEN = 'COUNTRY_PLUGIN';

/** Account codes for dividend distribution. */
const RETAINED_EARNINGS = 'RETAINED_EARNINGS';
const DIVIDEND_PAYABLE = 'DIVIDEND_PAYABLE';
const DIVIDEND_WITHHOLDING_TAX_PAYABLE = 'DIVIDEND_WITHHOLDING_TAX_PAYABLE';
const BANK_EUR = 'BANK_EUR';

@Injectable()
export class DividendsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly postingService: PostingService,
    @Inject(COUNTRY_PLUGIN_TOKEN)
    private readonly plugin: CountryPlugin,
    private readonly orgService: OrganizationService,
    private readonly transactionRepo: BankTransactionRepository,
  ) {}

  /**
   * Declare a dividend distribution.
   *
   * Posts a declaration voucher through the full pipeline (Rules → Policy → post):
   *   Dr RETAINED_EARNINGS              (gross amount)
   *   Cr DIVIDEND_PAYABLE               (net to owner, after withholding)
   *   Cr DIVIDEND_WITHHOLDING_TAX_PAYABLE  (withheld portion, if any)
   *
   * The country plugin resolves:
   * - Withholding rate (dividendWithholdingRate)
   * - Distributable-profits check (assertDistributable)
   *
   * Per ADR-0023: dividend is an equity distribution, NOT a P&L expense.
   * Per ADR-0002: withholding and profits-cap are country-plugin rules only.
   *
   * @param dto - Declaration input (gross amount, tax-point date, optional reason)
   * @returns The posted declaration voucher + breakdown
   */
  async declare(
    dto: DividendDeclarationDto,
  ): Promise<DividendDeclarationResult> {
    if (dto.gross_amount <= 0) {
      throw new BadRequestException('gross_amount must be positive');
    }

    // Get org context for plugin resolution.
    const org = await this.orgService.getOrganization();
    const orgContext = {
      country: org.country,
      vatRegistered: !!org.vat_registered,
      baseCurrency: org.base_currency,
    };

    // ── Distributable-profits check (plugin-driven) ──────────────────
    const retainedEarnings = await this.getRetainedEarningsBalance();
    const distributable = this.plugin.assertDistributable(
      dto.gross_amount,
      retainedEarnings,
      orgContext,
    );
    if (!distributable) {
      throw new BadRequestException(
        `Dividend of ${dto.gross_amount} cents exceeds distributable profits ` +
          `(retained earnings: ${retainedEarnings} cents)`,
      );
    }

    // ── Withholding rate (plugin-driven) ─────────────────────────────
    const withholdingRate = this.plugin.dividendWithholdingRate(orgContext);
    const withholdingAmount = Math.round(dto.gross_amount * withholdingRate);
    const netPayable = dto.gross_amount - withholdingAmount;

    // ── Build declaration voucher lines ──────────────────────────────
    const lines: DraftVoucher['lines'] = [
      // Dr RETAINED_EARNINGS (gross)
      {
        account_code: RETAINED_EARNINGS,
        amount: dto.gross_amount,
        currency: 'EUR',
        base_amount: dto.gross_amount,
        fx_rate: 1.0,
        is_debit: true,
      },
      // Cr DIVIDEND_PAYABLE (net to owner)
      {
        account_code: DIVIDEND_PAYABLE,
        amount: netPayable,
        currency: 'EUR',
        base_amount: netPayable,
        fx_rate: 1.0,
        is_debit: false,
      },
    ];

    // If withholding applies, add the withholding tax payable line.
    if (withholdingAmount > 0) {
      lines.push({
        account_code: DIVIDEND_WITHHOLDING_TAX_PAYABLE,
        amount: withholdingAmount,
        currency: 'EUR',
        base_amount: withholdingAmount,
        fx_rate: 1.0,
        is_debit: false,
      });
    }

    const draft: DraftVoucher = {
      tax_point_date: dto.tax_point_date,
      reason: dto.reason ?? `Dividend declaration: ${dto.gross_amount} cents`,
      lines,
    };

    const voucher = await this.postingService.postVoucher(draft);

    return {
      voucher_id: voucher.id,
      gross_amount: dto.gross_amount,
      net_payable: netPayable,
      withholding_amount: withholdingAmount,
    };
  }

  /**
   * Settle a dividend against a bank transaction.
   *
   * Posts a settlement voucher through the pipeline:
   *   Dr DIVIDEND_PAYABLE  (amount of bank outflow)
   *   Cr BANK_EUR          (same amount)
   *
   * Then creates an N:M reconciliation_match linking the bank transaction
   * to the declaration voucher, so the payable is drawn down.
   *
   * The bank transaction must have status 'dividend' (reserved in Wave 5).
   *
   * @param bankTransactionId - The bank transaction to settle against
   * @param declarationVoucherId - The declaration voucher to draw down
   * @returns Settlement result with voucher + reconciliation match
   */
  async settle(
    bankTransactionId: number,
    declarationVoucherId: number,
  ): Promise<DividendSettlementResult> {
    // 1. Look up bank transaction.
    const txn = await this.transactionRepo.findById(bankTransactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${bankTransactionId} not found`,
      );
    }

    // 2. Validate status is 'dividend'.
    if (txn.status !== 'dividend') {
      throw new BadRequestException(
        `Transaction ${bankTransactionId} is not a dividend (status: ${txn.status})`,
      );
    }

    // 3. Validate the declaration voucher exists.
    const declarationVoucher = await this.db
      .selectFrom('voucher')
      .select('id')
      .where('id', '=', declarationVoucherId)
      .executeTakeFirst();
    if (!declarationVoucher) {
      throw new NotFoundException(
        `Declaration voucher ${declarationVoucherId} not found`,
      );
    }

    // 4. Post settlement voucher: Dr DIVIDEND_PAYABLE / Cr BANK_EUR.
    // Dividend settlement is always an outflow (money leaving the business).
    const absAmount = Math.abs(txn.amount);
    const currency = txn.currency;

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      reason: `Dividend settlement for declaration voucher ${declarationVoucherId}`,
      lines: [
        {
          account_code: DIVIDEND_PAYABLE,
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

    // 5. Create N:M reconciliation_match linking bank txn to declaration voucher.
    const now = Math.floor(Date.now() / 1000);
    const [match] = await this.db
      .insertInto('reconciliation_match')
      .values({
        bank_transaction_id: bankTransactionId,
        voucher_id: declarationVoucherId,
        match_type: 'exact',
        amount_matched: absAmount,
        created_at: now,
      })
      .returningAll()
      .execute();

    // 6. Update bank transaction status to 'dividend' (already set, but
    // mark as reconciled by keeping the status — the match is the record).
    // No status change needed; the reconciliation_match is the settlement record.

    return {
      voucher_id: voucher.id,
      reconciliation_match_id: match.id,
      amount_settled: absAmount,
    };
  }

  /**
   * Get the current retained-earnings balance from the ledger.
   *
   * Retained earnings = sum of all posted lines to RETAINED_EARNINGS:
   *   credits increase equity (is_debit=0), debits decrease (is_debit=1).
   * Returns the net balance in base-currency cents.
   */
  private async getRetainedEarningsBalance(): Promise<number> {
    const account = await this.db
      .selectFrom('account')
      .select('id')
      .where('code', '=', RETAINED_EARNINGS)
      .executeTakeFirst();

    if (!account) {
      // No retained-earnings account yet — treat as 0.
      return 0;
    }

    const result = await this.db
      .selectFrom('voucher_line')
      .select((eb) =>
        eb
          .case()
          .when('is_debit', '=', 0)
          .then(eb.fn.sum<number>('base_amount'))
          .else(eb.val<number>(0))
          .end()
          .as('total_credits'),
      )
      .select((eb) =>
        eb
          .case()
          .when('is_debit', '=', 1)
          .then(eb.fn.sum<number>('base_amount'))
          .else(eb.val<number>(0))
          .end()
          .as('total_debits'),
      )
      .where('account_id', '=', account.id)
      .executeTakeFirst();

    const credits = result?.total_credits ?? 0;
    const debits = result?.total_debits ?? 0;
    return credits - debits;
  }
}
