import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import { CurrencyService } from '../currency/currency.service';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { OrganizationService } from '../organization/organization.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { DraftVoucher, PostedVoucher } from '../ledger/voucher/types';

/**
 * Result of a realized-FX computation attempt.
 */
export interface FXRealizedResult {
  /** 'posted' = FX voucher created; 'no_fx' = same currency or zero diff; 'missing_data' = cannot compute. */
  status: 'posted' | 'no_fx' | 'missing_data';
  /** The posted FX voucher (only when status === 'posted'). */
  voucher?: PostedVoucher;
  /** Human-readable explanation (only when status !== 'posted'). */
  message?: string;
}

@Injectable()
export class FXRealizedService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly postingService: PostingService,
    private readonly currencyService: CurrencyService,
    private readonly pluginLoader: PluginLoader,
    private readonly orgService: OrganizationService,
    private readonly ledgerBalance: LedgerBalanceService,
  ) {}

  /**
   * Compute realized FX for a foreign-currency settlement and post a
   * system-generated voucher to the single net FX_GAIN_LOSS account.
   *
   * Formula (ADR-0004):
   *   realized = booked_base (matchedAmount) − actual_settled_base
   *   actual_settled_base = |source_amount| × fx_rate   (foreign leg)
   *                       = |amount|                    (same currency)
   *
   * Direction (D1): derived from the bank-transaction sign.
   *   isIncoming = txn.amount >= 0   (AR / receipt)  vs  outgoing (AP / payment)
   * The realized-FX sign meaning is direction-dependent:
   *   incoming (AR): realized < 0 → gain  (received more base than booked)
   *   outgoing (AP): realized > 0 → gain  (paid less base than booked)
   *   ⇒ isGain = isIncoming ? realized < 0 : realized > 0
   *
   * Posting:
   *   gain → Dr BANK / Cr FX_GAIN_LOSS
   *   loss → Dr FX_GAIN_LOSS / Cr BANK
   *
   * @param voucherId         The voucher being settled.
   * @param bankTransactionId The bank transaction that settled it.
   * @param matchedAmount     Base-currency cents of the settled portion.
   * @returns FXRealizedResult — never throws for "no FX" cases; throws
   *          BadRequestException only when the bank line lacks BOTH
   *          source_amount AND fx_rate (cannot compute).
   */
  async computeAndPost(
    voucherId: number,
    bankTransactionId: number,
    matchedAmount: number,
  ): Promise<FXRealizedResult> {
    // ── Fetch bank transaction with statement + account info ──────────
    const txn = await this.db
      .selectFrom('bank_transaction')
      .innerJoin(
        'bank_statement',
        'bank_statement.id',
        'bank_transaction.statement_id',
      )
      .innerJoin('account', 'account.id', 'bank_statement.account_id')
      .select([
        'bank_transaction.id',
        'bank_transaction.amount',
        'bank_transaction.currency',
        'bank_transaction.source_currency',
        'bank_transaction.source_amount',
        'bank_transaction.fx_rate',
        'bank_transaction.transaction_date',
        'account.code as account_code',
      ])
      .where('bank_transaction.id', '=', bankTransactionId)
      .executeTakeFirst();

    if (!txn) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} not found`,
      );
    }

    // ── Is this a foreign-currency settlement? ────────────────────────
    const isForeignLeg =
      txn.source_currency !== null && txn.source_currency !== txn.currency;

    if (!isForeignLeg) {
      return { status: 'no_fx', message: 'Same currency — no realized FX' };
    }

    // ── Missing-data gate (ADR-0004) ─────────────────────────────────
    if (txn.source_amount === null && txn.fx_rate === null) {
      return {
        status: 'missing_data',
        message:
          `Bank transaction ${bankTransactionId} lacks both source_amount ` +
          `and fx_rate — cannot compute realized FX; flag for user feedback`,
      };
    }

    // ── Compute actual settled cash in the TXN currency ──────────────
    let actualInTxnCcy: number;
    if (txn.source_amount !== null && txn.fx_rate !== null) {
      actualInTxnCcy = Math.round(Math.abs(txn.source_amount * txn.fx_rate));
    } else {
      // One leg missing — fall back to the bank-line amount (already in
      // the account / txn currency).
      actualInTxnCcy = Math.abs(txn.amount);
    }

    // ── Convert the full-line actual cash to BASE currency (Bug B) ────
    // When the bank account is denominated in the base currency (the common
    // case) the cash IS the base amount — and we must NOT call the plugin,
    // since NullCountryPlugin throws on real cross-currency pairs.
    const baseCurrency = await this.currencyService.getBaseCurrency();
    let actualBaseFull: number;
    if (txn.currency === baseCurrency) {
      actualBaseFull = actualInTxnCcy;
    } else {
      const org = await this.orgService.getOrganization();
      const plugin = this.pluginLoader.resolve(org.country);
      const refRate = plugin.getReferenceRate(
        txn.currency,
        baseCurrency,
        txn.transaction_date,
      );
      actualBaseFull = Math.round(actualInTxnCcy * refRate);
    }

    // ── Scale to the matched proportion of the voucher (Bug A) ───────
    // matchedAmount is only PART of the voucher's full booked AR/AP base on a
    // partial match. Scale the full-line actual base by that proportion so the
    // realized FX reflects only the settled slice (not the entire bank line).
    const fullBookedBase = await this.getVoucherBookedBase(voucherId);
    const proportion =
      fullBookedBase > 0 ? Math.min(1, matchedAmount / fullBookedBase) : 1;
    const actualBaseForMatch = Math.round(actualBaseFull * proportion);

    // ── Realized FX ──────────────────────────────────────────────────
    const bookedBase = matchedAmount;
    const realized = bookedBase - actualBaseForMatch;

    if (realized === 0) {
      return {
        status: 'no_fx',
        message: 'Booked base equals actual base — no FX difference',
      };
    }

    // ── Build & post system-generated FX voucher ─────────────────────
    const absRealized = Math.abs(realized);
    // Direction (D1): incoming (AR) settlements have a non-negative bank
    // amount; outgoing (AP) settlements are negative. The sign of `realized`
    // means opposite things in each direction.
    const isIncoming = txn.amount >= 0;
    const isGain = isIncoming ? realized < 0 : realized > 0;

    // Realized FX is booked entirely in BASE currency (D3): FX_GAIN_LOSS vs the
    // BASE bank account (seed convention 'BANK_' + baseCurrency). When the txn
    // is already in base currency this equals txn.account_code anyway.
    const baseBankCode = 'BANK_' + baseCurrency;

    const lines: DraftVoucher['lines'] = [];

    if (isGain) {
      // Gain: Dr BANK / Cr FX_GAIN_LOSS
      lines.push({
        account_code: baseBankCode,
        amount: absRealized,
        currency: baseCurrency,
        base_amount: absRealized,
        fx_rate: 1.0,
        is_debit: true,
      });
      lines.push({
        account_code: 'FX_GAIN_LOSS',
        amount: absRealized,
        currency: baseCurrency,
        base_amount: absRealized,
        fx_rate: 1.0,
        is_debit: false,
      });
    } else {
      // Loss: Dr FX_GAIN_LOSS / Cr BANK
      lines.push({
        account_code: 'FX_GAIN_LOSS',
        amount: absRealized,
        currency: baseCurrency,
        base_amount: absRealized,
        fx_rate: 1.0,
        is_debit: true,
      });
      lines.push({
        account_code: baseBankCode,
        amount: absRealized,
        currency: baseCurrency,
        base_amount: absRealized,
        fx_rate: 1.0,
        is_debit: false,
      });
    }

    const draft: DraftVoucher = {
      tax_point_date: txn.transaction_date,
      lines,
      reason: `Realized FX on settlement of voucher ${voucherId}`,
    };

    const posted = await this.postingService.postVoucher(draft);
    return { status: 'posted', voucher: posted };
  }

  /**
   * The voucher's total booked AR/AP base amount, netted by sign and abs'd —
   * the denominator for scaling a partial match to its proportion of the
   * voucher. Delegates to the canonical LedgerBalanceService.
   */
  private getVoucherBookedBase(voucherId: number): Promise<number> {
    return this.ledgerBalance.getVoucherNetBase(voucherId, ['AR', 'AP']);
  }
}
