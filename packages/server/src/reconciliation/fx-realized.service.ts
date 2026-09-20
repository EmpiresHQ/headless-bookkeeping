import { IDENTITY_RATE_SOURCE } from '../fx/fx-rate.types';
import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import {
  PostingService,
  PreparedVoucher,
} from '../ledger/posting/posting.service';
import { CurrencyService } from '../currency/currency.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { DraftVoucher, PostedVoucher } from '../ledger/voucher/types';
import { determineFXDirection } from './fx-direction';

/**
 * How much cash one settlement slice REALLY delivered, beside what the ledger
 * booked for it — the shared arithmetic behind both the standalone realized-FX
 * voucher and the settlement voucher's own FX leg (issue #202).
 */
export interface SettlementSlice {
  /** The base the settlement clears on AR/AP: the BOOKED figure (matchedAmount). */
  bookedBase: number;
  /** The base the cash actually delivered for exactly this slice. */
  actualBase: number;
  /**
   * The cash this booked amount WOULD need if the line had it — the same
   * figure as {@link actualBase} but WITHOUT the clip to what the line
   * carries. The clip exists so a settlement can never post more cash than
   * arrived; this is what a guard must measure, because a booked amount
   * larger than the line can pay for is silently clipped otherwise, clearing
   * a receivable nobody paid and writing the rest off as fictional FX.
   */
  cashDemanded: number;
  /** The cash for this slice in the bank line's own currency. */
  actualInTxnCurrency: number;
  /** `bookedBase − actualBase` (ADR-0004). Zero when there is no difference. */
  realized: number;
  /** Direction of a non-zero `realized`, per the ADR-0004 invariant. */
  direction: 'gain' | 'loss' | null;
  /**
   * False when the line declares a foreign leg but carries neither
   * `source_amount` nor `fx_rate`: the actual cash cannot be valued, so
   * `actualBase` falls back to the booked figure and NO difference is invented.
   */
  computable: boolean;
}

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
    private readonly periodLock: PeriodLockService,
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
    const slice = await this.computeSettlementSlice(
      voucherId,
      bankTransactionId,
      matchedAmount,
    );
    if (!slice.computable) {
      return {
        status: 'missing_data',
        message:
          `Bank transaction ${bankTransactionId} lacks both source_amount ` +
          `and fx_rate — cannot compute realized FX; flag for user feedback`,
      };
    }

    const draft = await this.buildRealizedFxDraft(
      voucherId,
      bankTransactionId,
      matchedAmount,
    );
    if (!draft) {
      const txn = await this.loadBankLine(bankTransactionId);
      return {
        status: 'no_fx',
        message:
          txn.source_currency === null || txn.source_currency === txn.currency
            ? 'Same currency — no realized FX'
            : 'Booked base equals actual base — no FX difference',
      };
    }

    const posted = await this.postingService.postVoucher(draft);
    return { status: 'posted', voucher: posted };
  }

  /**
   * The standalone realized-FX draft, or null when there is nothing to book.
   *
   * Realized FX is booked entirely in BASE currency (D3): FX_GAIN_LOSS vs the
   * BASE bank account (seed convention 'BANK_' + baseCurrency). This is the
   * STANDALONE path, used where no settlement voucher is posted (a prepayment
   * match, whose advance voucher already booked the cash, and the manual FX
   * endpoint). A settlement posted through {@link SettlementVoucherService}
   * carries its FX leg on its OWN voucher, against the statement's own bank
   * account, so the cash never lands on a bank the money never touched.
   */
  private async buildRealizedFxDraft(
    voucherId: number,
    bankTransactionId: number,
    matchedAmount: number,
  ): Promise<DraftVoucher | null> {
    const txn = await this.loadBankLine(bankTransactionId);
    const slice = await this.computeSettlementSlice(
      voucherId,
      bankTransactionId,
      matchedAmount,
    );
    if (!slice.computable || slice.realized === 0) return null;

    const { baseCurrency } = await this.currencyService.toBase(
      0,
      txn.currency,
      txn.transaction_date,
    );
    const absRealized = Math.abs(slice.realized);
    const isGain = slice.direction === 'gain';

    const bankLine = {
      account_code: 'BANK_' + baseCurrency,
      amount: absRealized,
      currency: baseCurrency,
      base_amount: absRealized,
      // Realized FX is booked wholly in base currency; no rate is applied.
      fx_rate: 1.0,
      fx_rate_date: txn.transaction_date,
      fx_rate_source: IDENTITY_RATE_SOURCE,
      is_debit: isGain,
    };
    const fxLine = {
      account_code: 'FX_GAIN_LOSS',
      amount: absRealized,
      currency: baseCurrency,
      base_amount: absRealized,
      fx_rate: 1.0,
      fx_rate_date: txn.transaction_date,
      fx_rate_source: IDENTITY_RATE_SOURCE,
      is_debit: !isGain,
    };

    return {
      tax_point_date: txn.transaction_date,
      // Gain: Dr BANK / Cr FX_GAIN_LOSS. Loss: Dr FX_GAIN_LOSS / Cr BANK.
      lines: isGain ? [bankLine, fxLine] : [fxLine, bankLine],
      reason: `Realized FX on settlement of voucher ${voucherId}`,
    };
  }

  /**
   * The standalone realized-FX voucher as a PREPARED voucher rather than a
   * posted one — so an activation can post it inside its own transaction
   * instead of in a second, uncovered commit (issue #202). Null when there is
   * no FX to book (same currency, no difference, or unvaluable cash).
   */
  async prepareRealizedFx(
    voucherId: number,
    bankTransactionId: number,
    matchedAmount: number,
  ): Promise<PreparedVoucher | null> {
    const draft = await this.buildRealizedFxDraft(
      voucherId,
      bankTransactionId,
      matchedAmount,
    );
    return draft ? this.postingService.prepare(draft) : null;
  }

  /**
   * The CASH a bank line really carries, in base currency — the capacity every
   * settlement on that line draws from (issue #202).
   *
   * This is deliberately NOT `toBase(|txn.amount|)`, the figure the
   * over-allocation guard used to cap booked match amounts with. For a line
   * with a foreign leg the two differ, and they are not even in the same unit:
   * a match amount is BOOKED base (the invoice's rate) while the line carries
   * CASH (the bank's rate). Comparing them let a full settlement be refused
   * for want of cash it did not need, and let extra matches through after the
   * cash was already spent. Cash is compared with cash here; the booked side
   * keeps its own guard against the voucher's outstanding.
   */
  async lineCashBase(bankTransactionId: number): Promise<number> {
    const txn = await this.loadBankLine(bankTransactionId);
    const actualInTxnCcy =
      txn.source_amount !== null && txn.fx_rate !== null
        ? Math.round(Math.abs(txn.source_amount * txn.fx_rate))
        : Math.abs(txn.amount);
    const { baseAmount } = await this.currencyService.toBase(
      actualInTxnCcy,
      txn.currency,
      txn.transaction_date,
    );
    return baseAmount;
  }

  /**
   * The largest BOOKED amount of `voucherId` that `cashBase` of this line can
   * settle — the same rate quotient as {@link computeSettlementSlice}, read
   * the other way round.
   *
   * It is what turns "how much cash is left on this line" into "how much of
   * THIS invoice may still be matched against it", so a proposal, a candidate
   * offer and the activation guard all speak the invoice's own units. A USD
   * invoice booked at 0.92 and settled by cash that arrived at 0.90 needs
   * 9 000 of cash to clear 9 200 of receivable; capping the match at the cash
   * figure would leave 200 of the invoice permanently unsettleable.
   */
  async bookedCapacityForCash(
    voucherId: number,
    bankTransactionId: number,
    cashBase: number,
  ): Promise<number> {
    if (cashBase <= 0) return 0;
    const txn = await this.loadBankLine(bankTransactionId);
    const isForeignLeg =
      txn.source_currency !== null && txn.source_currency !== txn.currency;
    if (!isForeignLeg || txn.source_amount === null) return cashBase;

    const bookedRate = await this.settledLineRate(
      voucherId,
      txn.source_currency,
    );
    if (bookedRate === null || bookedRate <= 0) return cashBase;

    const cashTotal = await this.lineCashBase(bankTransactionId);
    if (cashTotal <= 0) return cashBase;
    const actualRate = cashTotal / Math.abs(txn.source_amount);
    if (actualRate <= 0) return cashBase;

    // cash → foreign units → this invoice's booked amount. Floored, so the
    // booked capacity can never claim more cash than the line has.
    return Math.floor((cashBase / actualRate) * bookedRate);
  }

  /**
   * THE slice arithmetic: what one match of `matchedAmount` (booked base)
   * actually cost or delivered in cash, and the realized difference between
   * the two. Shared by the standalone FX voucher above and by the settlement
   * voucher's FX leg, so a settlement and its FX can never disagree about how
   * a bank line was divided.
   *
   * ── How a slice is valued ───────────────────────────────────────────────
   * A match consumes part of an invoice AND part of a bank line, and the two
   * are measured on DIFFERENT rates — that is the whole point of realized FX.
   * Dividing one by the other (the previous `matched / voucherBookedBase`
   * scaling) silently mixes the two bases: it is right only when the line
   * happens to deliver the invoice's ENTIRE foreign amount, and fabricates a
   * difference whenever it does not. A partial receipt of 4 000 against a
   * 10 000 invoice at an unchanged rate was read as 40% of the cash — a
   * 2 400 "loss" out of thin air.
   *
   * So the slice is valued in the FOREIGN currency the cash was actually
   * denominated in, whenever the two sides agree on it:
   *
   *   foreignSettled = matchedAmount / bookedRate   (capped at the line's own)
   *   actualBase     = foreignSettled × actualRate
   *
   * where `bookedRate` is the fx_rate stored on the settled Voucher's own
   * AR/AP line and `actualRate` is the cash the line delivered per foreign
   * unit. Both rates are per ONE unit of the same currency, so the quotient is
   * the genuine rate movement and nothing else.
   *
   * When the settled item is not denominated in the line's source currency
   * (a base-currency invoice paid out of a foreign-currency line, say), there
   * is no common unit to divide by, and the slice falls back to the share of
   * the LINE the match consumes — which for a wholly-consumed line is the
   * whole of its cash, and never invents a rate movement where the amounts
   * agree.
   */
  async computeSettlementSlice(
    voucherId: number,
    bankTransactionId: number,
    matchedAmount: number,
  ): Promise<SettlementSlice> {
    const txn = await this.loadBankLine(bankTransactionId);
    const isForeignLeg =
      txn.source_currency !== null && txn.source_currency !== txn.currency;
    const hasValuation = txn.source_amount !== null || txn.fx_rate !== null;

    // The cash this line delivered, in its own currency and in base.
    const actualInTxnCcyFull =
      txn.source_amount !== null && txn.fx_rate !== null
        ? Math.round(Math.abs(txn.source_amount * txn.fx_rate))
        : Math.abs(txn.amount);
    const { baseAmount: actualBaseFull } = await this.currencyService.toBase(
      actualInTxnCcyFull,
      txn.currency,
      txn.transaction_date,
    );
    const { baseAmount: lineBookedBase } = await this.currencyService.toBase(
      Math.abs(txn.amount),
      txn.currency,
      txn.transaction_date,
    );

    if (isForeignLeg && !hasValuation) {
      // Cannot value the cash — book the settlement at its booked figure and
      // invent no difference. The caller reports this rather than guessing.
      return {
        bookedBase: matchedAmount,
        actualBase: matchedAmount,
        cashDemanded: matchedAmount,
        actualInTxnCurrency: this.sliceOfLine(
          Math.abs(txn.amount),
          matchedAmount,
          lineBookedBase,
        ),
        realized: 0,
        direction: null,
        computable: false,
      };
    }

    const bookedRate = await this.settledLineRate(
      voucherId,
      txn.source_currency,
    );

    let actualBase: number;
    let cashDemanded: number;
    if (
      isForeignLeg &&
      bookedRate !== null &&
      bookedRate > 0 &&
      txn.source_amount !== null
    ) {
      const foreignDemanded = matchedAmount / bookedRate;
      const foreignSettled = Math.min(
        Math.abs(txn.source_amount),
        foreignDemanded,
      );
      const actualRate = actualBaseFull / Math.abs(txn.source_amount);
      actualBase = Math.round(foreignSettled * actualRate);
      // What the match ASKED for, before the clip to the line's own foreign
      // amount: matching 20 000 USD of invoice against a 10 000 USD receipt
      // demands twice the cash the line has, and must be refused rather than
      // quietly settled for half.
      cashDemanded = Math.round(foreignDemanded * actualRate);
    } else {
      actualBase = this.sliceOfLine(
        actualBaseFull,
        matchedAmount,
        lineBookedBase,
      );
      cashDemanded =
        lineBookedBase > 0
          ? Math.round((actualBaseFull * matchedAmount) / lineBookedBase)
          : actualBaseFull;
    }

    const realized = matchedAmount - actualBase;
    const isIncoming = txn.amount >= 0;

    return {
      bookedBase: matchedAmount,
      actualBase,
      cashDemanded,
      actualInTxnCurrency: this.sliceOfLine(
        actualInTxnCcyFull,
        actualBase,
        actualBaseFull,
      ),
      realized,
      direction:
        realized === 0 ? null : determineFXDirection(realized, isIncoming),
      computable: true,
    };
  }

  /** `whole × (part / total)`, guarded for a zero/absent total. */
  private sliceOfLine(whole: number, part: number, total: number): number {
    if (total <= 0) return whole;
    return Math.round(whole * Math.min(1, part / total));
  }

  /**
   * The booked FX rate of the settled Voucher's own AR/AP line, when that line
   * is denominated in the bank line's source currency — the denominator that
   * turns a booked base amount back into foreign units. Null when the two are
   * not comparable (or the Voucher carries no AR/AP line at all, e.g. a
   * prepayment advance), which sends the caller to the line-share fallback.
   */
  private async settledLineRate(
    voucherId: number,
    sourceCurrency: string | null,
  ): Promise<number | null> {
    if (sourceCurrency === null) return null;
    const line = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select(['voucher_line.fx_rate as fx_rate'])
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', 'in', ['AR', 'AP'])
      .where('voucher_line.currency', '=', sourceCurrency)
      .executeTakeFirst();
    return line?.fx_rate ?? null;
  }

  /** The bank line plus its statement's account, as every FX read needs it. */
  private async loadBankLine(bankTransactionId: number) {
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
        'account.currency as account_currency',
      ])
      .where('bank_transaction.id', '=', bankTransactionId)
      .executeTakeFirst();

    if (!txn) {
      throw new BadRequestException(
        `Bank transaction ${bankTransactionId} not found`,
      );
    }
    return txn;
  }

  /**
   * Reverse a previously-posted realized-FX voucher when its match is undone.
   *
   * The original FX voucher is immutable (ADR-0006), so it is reversed by a
   * mirror voucher (every line's debit/credit flipped) that carries
   * `reverses_id`. If the original voucher's date sits in a LOCKED period the
   * reversal is REDIRECTED into the current open period (ADR-0009), mirroring
   * the corrections flow — the lock is never violated. Throws if no open period
   * exists to receive a redirected reversal.
   */
  async reverseFxVoucher(fxVoucherId: number): Promise<PostedVoucher> {
    return this.postingService.postVoucher(
      await this.prepareFxReversal(fxVoucherId),
    );
  }

  /**
   * The reversal DRAFT for an FX voucher, without posting it — so a caller
   * undoing a settlement can post every reversal it owes, and delete the link,
   * in ONE transaction (issue #202: three separate commits could leave the
   * ledger changed with the match still active).
   */
  async prepareFxReversal(fxVoucherId: number): Promise<DraftVoucher> {
    const voucher = await this.db
      .selectFrom('voucher')
      .select(['id', 'voucher_number', 'tax_point_date'])
      .where('id', '=', fxVoucherId)
      .executeTakeFirst();
    if (!voucher) {
      throw new BadRequestException(`FX voucher ${fxVoucherId} not found`);
    }

    const lines = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as account_code',
        'voucher_line.amount',
        'voucher_line.currency',
        'voucher_line.base_amount',
        'voucher_line.fx_rate',
        'voucher_line.fx_rate_date',
        'voucher_line.fx_rate_source',
        'voucher_line.vat_code',
        'voucher_line.is_debit',
      ])
      .where('voucher_line.voucher_id', '=', fxVoucherId)
      .execute();

    // Redirect into the current open period if the FX voucher's date is locked.
    let taxPointDate = voucher.tax_point_date;
    const locked = await this.periodLock.findLockedPeriod(
      voucher.tax_point_date,
    );
    if (locked) {
      const open = await this.periodLock.getCurrentOpenPeriod();
      if (!open) {
        throw new ConflictException(
          `Cannot reverse FX voucher ${fxVoucherId} dated in locked period ` +
            `${locked.name}: no open period to receive the reversal`,
        );
      }
      taxPointDate = open.start_date;
    }

    return {
      voucher_number: `${voucher.voucher_number}-REV`,
      tax_point_date: taxPointDate,
      lines: lines.map((l) => ({
        account_code: l.account_code,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        // Provenance travels with the line it mirrors (issue #203): a reversal
        // must be explicable by the same rate evidence as the original, and a
        // legacy line's NULL provenance stays NULL rather than being invented.
        fx_rate_date: l.fx_rate_date,
        fx_rate_source: l.fx_rate_source,
        vat_code: l.vat_code,
        is_debit: !l.is_debit,
      })),
      reverses_id: fxVoucherId,
      reason: `Reversal of realized-FX voucher ${fxVoucherId} on unmatch`,
    };
  }
}
