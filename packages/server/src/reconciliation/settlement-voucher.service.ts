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
import {
  DraftVoucher,
  DraftVoucherLine,
  PostedVoucher,
} from '../ledger/voucher/types';

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
 *  2. The BASE / FX SPLIT. The settlement books exactly `amountMatched` — the
 *     BOOKED base of the settled slice. The realized-FX voucher
 *     ({@link FXRealizedService}) separately books the difference between
 *     booked and actual cash against the base bank account. Booking actual
 *     cash here as well would double-count that difference; together the two
 *     vouchers move the bank by the cash that really arrived.
 *     The bank leg carries the statement account's OWN currency (so a
 *     `BANK_USD` statement moves USD), sliced from the bank line in proportion
 *     to the matched base, with `fx_rate` set from that pair — the AR/AP leg
 *     stays in base currency, and both legs' `base_amount` are equal, so the
 *     voucher balances (balance is a base-amount rule, ADR-0004).
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

    const { baseAmount: lineBase, baseCurrency } =
      await this.currencyService.toBase(
        Math.abs(txn.amount),
        txn.currency,
        txn.transaction_date,
      );

    // The bank leg in the bank ACCOUNT's own currency: the matched slice of
    // this line. A base-denominated account makes this the identity.
    const bankAmount =
      lineBase > 0
        ? Math.max(
            1,
            Math.round((Math.abs(txn.amount) * amountMatched) / lineBase),
          )
        : amountMatched;

    const bankLine: DraftVoucherLine = {
      account_code: txn.account_code,
      amount: bankAmount,
      currency: txn.account_currency ?? txn.currency,
      base_amount: amountMatched,
      fx_rate: amountMatched / bankAmount,
      is_debit: leg.openedAsDebit, // AR receipt debits the bank
    };

    const arApLine: DraftVoucherLine = {
      account_code: leg.code,
      amount: amountMatched,
      currency: baseCurrency,
      base_amount: amountMatched,
      fx_rate: 1,
      is_debit: !leg.openedAsDebit, // clears the side the item was opened on
    };

    const draft: DraftVoucher = {
      tax_point_date: await this.resolveTaxPointDate(txn.transaction_date),
      lines: [bankLine, arApLine],
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

    const draft: DraftVoucher = {
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

    return this.postingService.postVoucher(draft);
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
