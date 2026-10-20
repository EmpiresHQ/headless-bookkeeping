import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { BankTransactionRepository } from '../bank/bank-transaction.repository';
import { PostingService } from '../ledger/posting/posting.service';
import { CurrencyService } from '../currency/currency.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { DraftVoucher, PostedVoucher } from '../ledger/voucher/types';

/**
 * The bank's separately charged FX conversion fee, booked as its own cost —
 * the fee-resolution half of issue #403's fee-separation acceptance.
 *
 * A converted card settlement debits the account for principal + fee in ONE
 * line ("DKK 60; conversion fee 0.08 EUR; total EUR 8.11"). The purchase
 * voucher books the FEE-SEPARATED principal (EUR 8.03) and claims the line as
 * its settlement evidence; the fee stays evidenced on the line — and the
 * debit does not fully reconcile until the fee is booked too, as ITSELF, in
 * its own voucher: Dr EXPENSE_BANK_FEE / Cr {the real bank account}, with an
 * active reconciliation match for the fee portion, so principal + fee = the
 * full statement debit and no expense or bank line is duplicated.
 *
 * An explicit operator action (POST /bank-transactions/:id/bank-fee), the
 * same disposition seam as the personal disposition: nothing auto-posts the
 * fee, and the fee is booked ONLY from the bank's OWN explicitly evidenced
 * `conversion_fee` — never derived, never a residual, never guessed
 * (the settle-fx derivation REFUSES unexplained residuals; this service
 * refuses them too, because `conversion_fee` NULL means "not evidenced").
 */
@Injectable()
export class BankFeeDispositionService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly transactionRepo: BankTransactionRepository,
    private readonly postingService: PostingService,
    private readonly currencyService: CurrencyService,
    private readonly orgContextResolver: OrgContextResolver,
  ) {}

  /**
   * Book the line's evidenced conversion fee as a bank fee, and reconcile its
   * portion of the line. Idempotent by state: once disposed (`bank_fee`
   * status) a repeat is refused, and the UNIQUE (bank line, voucher) match
   * guard refuses any double-match of the fee voucher.
   */
  async markAsBankFee(transactionId: number): Promise<PostedVoucher> {
    const txn = await this.transactionRepo.findById(transactionId);
    if (!txn) {
      throw new NotFoundException(
        `Bank transaction ${transactionId} not found`,
      );
    }

    // The whole line's disposition is already settled (this or another
    // disposition) — a repeat is a refused duplicate, not a second voucher.
    if (txn.status !== 'open') {
      throw new BadRequestException(
        `Transaction ${transactionId} is not open (status: ${txn.status})`,
      );
    }
    if (txn.amount >= 0) {
      throw new BadRequestException(
        `Transaction ${transactionId} is not an outflow (amount: ` +
          `${txn.amount}); conversion fees are charged on money leaving the ` +
          `business`,
      );
    }
    if (txn.conversion_fee === null) {
      throw new BadRequestException(
        `Transaction ${transactionId} carries no explicitly evidenced ` +
          `conversion fee; the bank fee disposition books the bank's own ` +
          `stated fee and never a derived residual`,
      );
    }
    const fee = txn.conversion_fee;
    if (fee <= 0) {
      throw new BadRequestException(
        `Transaction ${transactionId}'s evidenced conversion fee (${fee}) is ` +
          `not a bookable charge`,
      );
    }
    const debit = Math.abs(txn.amount);
    if (fee > debit) {
      throw new ConflictException(
        `Transaction ${transactionId}'s evidenced conversion fee (${fee}) ` +
          `exceeds its debit (${debit}); the figures conflict`,
      );
    }

    // The fee is the line's LAST unallocated part. A converted settlement
    // line mixes principal and fee in ONE debit; the purchase voucher and
    // its settlement match must reconcile the PRINCIPAL first, and the fee
    // disposition completes the line — booking it before the principal is
    // reconciled would dispose a partially-allocated line as a whole "bank
    // fee" and strand the purchase's cash leg off the books' match surface.
    // So the fee must equal exactly the UNMATCHED remainder: fee + principal
    // = the full debit, nothing else left, no over-allocation.
    // CASH units, not booked base (issue #403's valuation-policy distinction):
    // a purchase booked at the reference rate (857) that the bank actually
    // settled at 803 + 8 consumes 803 of the line's CASH — the settlement
    // match records that in `cash_base_amount` (with the booked
    // `amount_matched` as the legacy fallback) — and the fee's capacity is
    // the line's actual unallocated CASH, never the booked figure.
    const matched = await this.db
      .selectFrom('reconciliation_match')
      .select(['amount_matched', 'cash_base_amount'])
      .where('bank_transaction_id', '=', transactionId)
      .where('status', '=', 'active')
      .execute();
    const cashUsed = matched.reduce(
      (sum, r) => sum + (r.cash_base_amount ?? r.amount_matched),
      0,
    );
    const remaining = debit - cashUsed;
    if (fee !== remaining) {
      throw new ConflictException(
        `Transaction ${transactionId}'s evidenced conversion fee (${fee}) ` +
          `does not equal its unallocated remainder (${remaining}): the fee ` +
          `disposition books the line's LAST part — reconcile the purchase ` +
          `principal first (match the settlement voucher), then book the fee`,
      );
    }

    // The measurement basis is sampled FIRST, ahead of every other read of
    // the organisation (issue #215) — the same window discipline the personal
    // disposition applies; this can be the ledger's first voucher. The
    // EFFECTIVE base currency (override ?? plugin default) comes from the
    // same resolution, so an organisation inheriting the plugin's currency is
    // not required to set an override for its fees to book.
    const { baseCurrency, basis } = await this.currencyService.getLedgerBasis();
    await this.orgContextResolver.resolve();

    // The REAL bank account the line belongs to (statement → account join).
    const bankAccount = await this.db
      .selectFrom('bank_transaction')
      .innerJoin('account', 'account.id', 'bank_transaction.account_id')
      .select('account.code as account_code')
      .where('bank_transaction.id', '=', transactionId)
      .executeTakeFirstOrThrow();
    const resolvedBankCode = bankAccount.account_code;

    // The fee is charged in the line's own (settled/account) currency — for a
    // base-currency account that is the base currency, so the legs are
    // identity-converted with the provenance recorded explicitly (#203).
    if (txn.currency !== baseCurrency) {
      // A fee evidenced in a foreign-account currency would itself need a
      // valuation — refused here rather than converted on a guessed rate.
      throw new ConflictException(
        `Transaction ${transactionId}'s conversion fee is evidenced in ` +
          `${txn.currency}, not the base currency; book this fee manually`,
      );
    }

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      measured_basis: basis,
      reason: `Bank conversion fee: ${txn.description ?? 'no description'}`,
      lines: [
        {
          account_code: 'EXPENSE_BANK_FEE',
          amount: fee,
          currency: txn.currency,
          base_amount: fee,
          fx_rate: 1.0,
          fx_rate_date: txn.transaction_date,
          fx_rate_source: IDENTITY_RATE_SOURCE,
          is_debit: true,
        },
        {
          account_code: resolvedBankCode,
          amount: fee,
          currency: txn.currency,
          base_amount: fee,
          fx_rate: 1.0,
          fx_rate_date: txn.transaction_date,
          fx_rate_source: IDENTITY_RATE_SOURCE,
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
      // Reconcile the fee's portion of the line — principal + fee = the
      // full debit, no over-allocation (re-checked inside the same transaction
      // the voucher posted in, so a racing match cannot double-claim the fee).
      // `partial`: the fee voucher claims PART of the line's debit, exactly
      // the sense the existing match vocabulary gives it (the table's CHECK
      // admits exact/partial/prepayment; no new match kind is invented).
      const nowActive = await trx
        .selectFrom('reconciliation_match')
        .select(['amount_matched', 'cash_base_amount'])
        .where('bank_transaction_id', '=', transactionId)
        .where('status', '=', 'active')
        .execute();
      const nowCashUsed = nowActive.reduce(
        (sum, r) => sum + (r.cash_base_amount ?? r.amount_matched),
        0,
      );
      if (fee !== debit - nowCashUsed) {
        throw new ConflictException(
          `Transaction ${transactionId}'s remainder moved while its fee ` +
            `voucher was posting; nothing was double-booked — retry once the ` +
            `line's principal is reconciled`,
        );
      }
      await trx
        .insertInto('reconciliation_match')
        .values({
          bank_transaction_id: transactionId,
          voucher_id: voucher.id,
          match_type: 'partial',
          amount_matched: fee,
          status: 'active',
          signal: 'manual',
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();
      await this.transactionRepo.updateStatus(transactionId, 'bank_fee', trx);
      return voucher;
    });
  }
}
