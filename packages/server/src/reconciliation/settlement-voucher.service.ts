import { Injectable, ConflictException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import {
  PostingService,
  PreparedVoucher,
} from '../ledger/posting/posting.service';
import { CurrencyService } from '../currency/currency.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { FXRealizedService } from './fx-realized.service';
import {
  DraftVoucher,
  DraftVoucherLine,
  PostedVoucher,
} from '../ledger/voucher/types';

/** The single net account realized FX is booked to (migration 002). */
const FX_GAIN_LOSS = 'FX_GAIN_LOSS';

/** The AR/AP leg a settlement clears, read off the settled Voucher itself. */
interface SettledLeg {
  code: 'AR' | 'AP';
  /** 1 when the settled voucher OPENED the item as a debit (AR). */
  openedAsDebit: boolean;
}

/**
 * SettlementVoucherService — the **settlement Voucher** a cash match posts, and
 * its reversal (issue #202).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * ADR-0008: "Payment is a separate settlement Voucher that clears the AR/AP
 * balance." Until now activation only flipped `reconciliation_match.status`,
 * and `unmatch` was documented as ledger-neutral, so cash settled a subledger
 * open item while the AR/AP CONTROL account kept carrying it. The subledger
 * and the general ledger could therefore never reconcile by construction.
 *
 * One settlement, one voucher:
 *
 *   incoming (AR): Dr {statement bank account} / Cr AR
 *   outgoing (AP): Dr AP / Cr {statement bank account}
 *
 * ── The three things a caller must not have to know ─────────────────────
 *  1. POLARITY is read from the settled Voucher's own AR/AP leg, never from
 *     the bank line's sign: an AR voucher opened the item as a debit, so the
 *     settlement credits it. A voucher carrying no AR/AP leg has nothing to
 *     clear and yields no settlement at all.
 *  2. The BASE / CASH SPLIT. The AR/AP leg clears the BOOKED base — the
 *     obligation as the ledger recorded it — while the bank leg carries the
 *     cash the line ACTUALLY delivered for this slice, on the statement's OWN
 *     account (a `BANK_USD` statement moves USD). When a foreign settlement
 *     makes those differ, the residual IS the realized FX and rides on the
 *     SAME voucher, against `FX_GAIN_LOSS` — so the cash never lands on a bank
 *     account the money never touched, and a settlement can never be posted
 *     without the FX that belongs to it. The slice arithmetic itself is
 *     {@link FXRealizedService.computeSettlementSlice}, shared with the
 *     standalone FX path so the two cannot divide a bank line differently.
 *  3. Locked periods (ADR-0009): a settlement dated into a locked period is
 *     re-dated into the current open period, exactly as a credit note or an FX
 *     reversal is; if none is open, it refuses rather than breaking the lock.
 *
 * Preparation (all the reads) is separated from the write so the caller can
 * post INSIDE its own transaction — better-sqlite3's single connection forbids
 * reads through `this.db` once a transaction is open, and the match activation
 * must flip the link and post its settlement atomically.
 */
@Injectable()
export class SettlementVoucherService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly postingService: PostingService,
    private readonly currencyService: CurrencyService,
    private readonly periodLock: PeriodLockService,
    private readonly fx: FXRealizedService,
  ) {}

  /**
   * Resolve + validate the settlement for one match, WITHOUT writing anything.
   * Returns null when the match settles nothing in the ledger: a prepayment
   * match (the advance voucher already booked that cash — re-booking it would
   * double the bank) or a voucher with no AR/AP leg to clear.
   */
  async prepareSettlement(args: {
    voucherId: number;
    bankTransactionId: number;
    amountMatched: number;
    matchType: string;
  }): Promise<PreparedVoucher | null> {
    const { voucherId, bankTransactionId, amountMatched, matchType } = args;
    if (matchType === 'prepayment') return null;
    if (amountMatched <= 0) return null;

    const leg = await this.settledLeg(voucherId);
    if (!leg) return null;

    const txn = await this.db
      .selectFrom('bank_transaction')
      .innerJoin(
        'bank_statement',
        'bank_statement.id',
        'bank_transaction.statement_id',
      )
      .innerJoin('account', 'account.id', 'bank_statement.account_id')
      .select([
        'bank_transaction.amount',
        'bank_transaction.currency',
        'bank_transaction.transaction_date',
        'account.code as account_code',
        'account.currency as account_currency',
      ])
      .where('bank_transaction.id', '=', bankTransactionId)
      .executeTakeFirstOrThrow();

    // How much cash this slice really delivered, from the ONE shared slice
    // arithmetic — so the settlement and its FX leg cannot disagree about how
    // the bank line was divided.
    const slice = await this.fx.computeSettlementSlice(
      voucherId,
      bankTransactionId,
      amountMatched,
    );

    const { baseCurrency } = await this.currencyService.toBase(
      0,
      txn.currency,
      txn.transaction_date,
    );

    const bankAmount = Math.max(1, slice.actualInTxnCurrency);
    const bankLine: DraftVoucherLine = {
      account_code: txn.account_code,
      amount: bankAmount,
      currency: txn.account_currency ?? txn.currency,
      base_amount: slice.actualBase,
      fx_rate: slice.actualBase / bankAmount,
      is_debit: leg.openedAsDebit, // an AR receipt debits the bank
    };

    const arApLine: DraftVoucherLine = {
      account_code: leg.code,
      amount: amountMatched,
      currency: baseCurrency,
      base_amount: amountMatched,
      fx_rate: 1,
      is_debit: !leg.openedAsDebit, // clears the side the item was opened on
    };

    const lines: DraftVoucherLine[] = [bankLine, arApLine];

    // The cash and the booked obligation differ by exactly the realized FX, so
    // the residual IS the FX leg — derived from the two legs rather than from a
    // second sign rule, which makes it right in all four quadrants
    // (incoming/outgoing × gain/loss) by construction.
    const residual =
      (bankLine.is_debit ? bankLine.base_amount : -bankLine.base_amount) +
      (arApLine.is_debit ? arApLine.base_amount : -arApLine.base_amount);
    if (residual !== 0) {
      lines.push({
        account_code: FX_GAIN_LOSS,
        amount: Math.abs(residual),
        currency: baseCurrency,
        base_amount: Math.abs(residual),
        fx_rate: 1,
        is_debit: residual < 0,
      });
    }

    const draft: DraftVoucher = {
      tax_point_date: await this.resolveTaxPointDate(txn.transaction_date),
      lines,
      reason:
        `Settlement of voucher ${voucherId} by bank transaction ` +
        `${bankTransactionId}`,
    };

    return this.postingService.prepare(draft);
  }

  /** Post a prepared settlement on the caller's OWN transaction. */
  postSettlementTx(
    trx: Kysely<Database>,
    prepared: PreparedVoucher,
  ): Promise<PostedVoucher> {
    return this.postingService.postVoucherTx(
      trx,
      prepared.draft,
      prepared.resolved,
    );
  }

  /**
   * Reverse a settlement voucher when its match is undone. The original is
   * immutable (ADR-0006), so it is reversed by a mirrored counter-voucher
   * carrying `reverses_id`, redirected out of a locked period (ADR-0009) —
   * the same shape as {@link FXRealizedService.reverseFxVoucher}.
   */
  async reverseSettlement(settlementVoucherId: number): Promise<PostedVoucher> {
    return this.postingService.postVoucher(
      await this.prepareSettlementReversal(settlementVoucherId),
    );
  }

  /**
   * The reversal DRAFT for a settlement voucher, without posting it — so the
   * caller can post it, any FX reversal it owes, and the link deletion in ONE
   * transaction (issue #202).
   */
  async prepareSettlementReversal(
    settlementVoucherId: number,
  ): Promise<DraftVoucher> {
    const voucher = await this.db
      .selectFrom('voucher')
      .select(['id', 'voucher_number', 'tax_point_date'])
      .where('id', '=', settlementVoucherId)
      .executeTakeFirstOrThrow();

    const lines = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as account_code',
        'voucher_line.amount',
        'voucher_line.currency',
        'voucher_line.base_amount',
        'voucher_line.fx_rate',
        'voucher_line.vat_code',
        'voucher_line.is_debit',
      ])
      .where('voucher_line.voucher_id', '=', settlementVoucherId)
      .execute();

    return {
      voucher_number: `${voucher.voucher_number}-REV`,
      tax_point_date: await this.resolveTaxPointDate(voucher.tax_point_date),
      lines: lines.map((l) => ({
        account_code: l.account_code,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        vat_code: l.vat_code,
        is_debit: !l.is_debit,
      })),
      reverses_id: settlementVoucherId,
      reason: `Reversal of settlement voucher ${settlementVoucherId} on unmatch`,
    };
  }

  /**
   * The AR/AP side the settled Voucher opened, read from its own lines. Netted
   * by side so a voucher carrying both legs (a contra/reclass) resolves to the
   * side it actually opened rather than to whichever line came first.
   */
  private async settledLeg(voucherId: number): Promise<SettledLeg | null> {
    const rows = await this.db
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select([
        'account.code as code',
        'voucher_line.base_amount as base_amount',
        'voucher_line.is_debit as is_debit',
      ])
      .where('account.code', 'in', ['AR', 'AP'])
      .where('voucher_line.voucher_id', '=', voucherId)
      .execute();
    if (rows.length === 0) return null;

    const net = new Map<'AR' | 'AP', number>();
    for (const row of rows) {
      const code = row.code === 'AP' ? 'AP' : 'AR';
      const signed = row.is_debit === 1 ? row.base_amount : -row.base_amount;
      net.set(code, (net.get(code) ?? 0) + signed);
    }

    // AR opens as a debit, AP as a credit; pick whichever side carries a net.
    const ar = net.get('AR') ?? 0;
    const ap = net.get('AP') ?? 0;
    if (ar !== 0) return { code: 'AR', openedAsDebit: ar > 0 };
    if (ap !== 0) return { code: 'AP', openedAsDebit: ap > 0 };
    return null;
  }

  /**
   * The effective tax-point date (ADR-0009): the requested date unless it sits
   * in a LOCKED period, in which case the settlement is redirected into the
   * current open period. Refuses when no open period can receive it.
   */
  private async resolveTaxPointDate(requested: string): Promise<string> {
    const locked = await this.periodLock.findLockedPeriod(requested);
    if (!locked) return requested;

    const open = await this.periodLock.getCurrentOpenPeriod();
    if (!open) {
      throw new ConflictException(
        `Cannot post a settlement into locked period ${locked.name}: ` +
          `no open period to receive it`,
      );
    }
    return open.start_date;
  }
}
