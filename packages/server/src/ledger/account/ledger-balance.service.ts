import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction, sql } from 'kysely';
import { Database } from '../../database/types';
import { AccountType } from './types';

/**
 * The minimal Kysely executor a net read runs through — a top-level connection
 * or an open {@link Transaction}. Lets a caller that must read-then-write
 * atomically (recording a **ReconciliationMatch**) route the net read through
 * its own transaction.
 */
type DbExecutor = Kysely<Database> | Transaction<Database>;

/**
 * LedgerBalanceService — the ONE authoritative place that computes
 * "the net of a set of Account kinds, in base currency", over voucher lines.
 *
 * ── The single sign convention ──────────────────────────────────────────
 * Every signed sum in the ledger reduces to ONE primitive: the
 * **debit-positive signed base amount** of a line:
 *
 *     signed(line) = line.is_debit ? +base_amount : −base_amount
 *
 * A net is `Σ signed(line)` over the lines of interest. The *other*
 * convention used elsewhere (credit-positive) is just its negation, so it is
 * NOT a second rule — it is the same rule read with `creditPositive: true`.
 * Per-account-type normal balances therefore fall out of this one definition:
 *
 *   - asset / expense  → debit-normal: a positive debit-positive net means a
 *     normal (asset/expense) balance. AR (asset) outstanding is debit-positive;
 *     VAT_RECEIVABLE (asset) input VAT is debit-positive.
 *   - liability / equity / revenue → credit-normal: read credit-positive.
 *     AP (liability) outstanding, RETAINED_EARNINGS (equity) + net income
 *     (revenue − expense) for distributable profits, and VAT_PAYABLE
 *     (liability) output VAT are all credit-positive.
 *
 * Callers never re-derive the debit/credit sign in raw SQL; they pick a
 * convention flag and a filter (account codes and/or types). This logic was
 * previously hand-written in reconciliation, realized-FX, dividends, and the
 * VAT report; it now lives only here.
 */

/** Which direction counts as positive in a signed net. */
export interface SignedNetOptions {
  /**
   * When true, credits are positive and debits negative (credit-normal
   * accounts: liability / equity / revenue). When false/omitted, debits are
   * positive (debit-normal accounts: asset / expense). Default: debit-positive.
   */
  creditPositive?: boolean;
}

/** Filter selecting which lines participate in a ledger-wide net. */
export interface LedgerNetFilter {
  /** Match lines whose account.code is in this list. */
  codes?: string[];
  /** Match lines whose account.type is in this list. */
  types?: AccountType[];
}

/** A tax-point-date window. `startDate` omitted ⇒ from the beginning of time. */
export interface PeriodRange {
  startDate?: string;
  endDate: string;
}

@Injectable()
export class LedgerBalanceService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * The signed base amount of a single voucher line under the chosen
   * convention — the one place the debit/credit sign decision is made for
   * callers that must group lines themselves (e.g. the VAT report groups by
   * vat_code) and so cannot use an aggregate query.
   *
   * @returns `+base_amount` for the positive direction, `−base_amount` otherwise.
   */
  signedBaseAmount(
    line: { is_debit: number | boolean; base_amount: number },
    options: SignedNetOptions = {},
  ): number {
    const isDebit = line.is_debit === 1 || line.is_debit === true;
    const debitPositive = isDebit ? line.base_amount : -line.base_amount;
    return options.creditPositive ? -debitPositive : debitPositive;
  }

  /**
   * The voucher's net base amount across lines whose account code is in
   * `accountCodes`, netted by debit/credit sign and abs'd. Returns 0 when the
   * voucher has no matching lines.
   *
   * Netting (rather than summing magnitudes) means a contra/reclass voucher
   * carrying both an AR debit and an AP credit collapses to its true magnitude
   * instead of double-counting. Abs'd because the *outstanding* balance of an
   * AR (debit) or AP (credit) voucher is a magnitude regardless of side — this
   * is the receivable/payable-outstanding primitive used by reconciliation and
   * realized-FX. A reversal voucher (a single mirrored AR/AP credit) therefore
   * nets to its full magnitude, NOT to zero.
   */
  async getVoucherNetBase(
    voucherId: number,
    accountCodes: string[],
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const lineTotal = await executor
      .selectFrom('voucher_line')
      .innerJoin('account', 'account.id', 'voucher_line.account_id')
      .select((eb) =>
        eb.fn
          .sum<number>(
            eb
              .case()
              .when('voucher_line.is_debit', '=', 1)
              .then(eb.ref('voucher_line.base_amount'))
              .else(eb.neg(eb.ref('voucher_line.base_amount')))
              .end(),
          )
          .as('net'),
      )
      .where('voucher_line.voucher_id', '=', voucherId)
      .where('account.code', 'in', accountCodes)
      .executeTakeFirst();

    return Math.abs(lineTotal?.net ?? 0);
  }

  /**
   * Ledger-wide signed net (NOT abs'd) over every posted-or-unposted voucher
   * line matching `filter`, under the chosen sign convention. Used for
   * aggregate equity/P&L figures such as distributable profits, where the sign
   * is meaningful (a loss is genuinely negative).
   *
   * The filter combines `codes` and `types` with OR (a line matches if its
   * account code is in `codes` OR its account type is in `types`), mirroring
   * the distributable-profits rule: `RETAINED_EARNINGS` (by code) plus all
   * revenue/expense accounts (by type).
   */
  async getLedgerNet(
    filter: LedgerNetFilter,
    options: SignedNetOptions = {},
  ): Promise<number> {
    const codes = filter.codes ?? [];
    const types = filter.types ?? [];
    if (codes.length === 0 && types.length === 0) return 0;

    let query = this.db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .select(
        sql<number>`COALESCE(SUM(CASE WHEN vl.is_debit = 1 THEN vl.base_amount ELSE -vl.base_amount END), 0)`.as(
          'net',
        ),
      );

    query = query.where((eb) =>
      eb.or([
        ...(codes.length > 0 ? [eb('a.code', 'in', codes)] : []),
        ...(types.length > 0 ? [eb('a.type', 'in', types)] : []),
      ]),
    );

    const result = await query.executeTakeFirst();
    const debitPositive = Number(result?.net ?? 0);
    return options.creditPositive ? -debitPositive : debitPositive;
  }

  /**
   * Period-scoped signed net: like {@link getLedgerNet} but restricted to
   * voucher lines whose voucher.tax_point_date falls in `[startDate, endDate]`
   * (startDate optional → cumulative-to-date for closing-balance reads of
   * balance-sheet accounts; both bounds set → a period flow for P&L accounts).
   * Only posted vouchers are counted.
   */
  async getLedgerNetForPeriod(
    filter: LedgerNetFilter,
    range: PeriodRange,
    options: SignedNetOptions = {},
  ): Promise<number> {
    const codes = filter.codes ?? [];
    const types = filter.types ?? [];
    if (codes.length === 0 && types.length === 0) return 0;

    let query = this.db
      .selectFrom('voucher_line as vl')
      .innerJoin('account as a', 'a.id', 'vl.account_id')
      .innerJoin('voucher as v', 'v.id', 'vl.voucher_id')
      .select(
        sql<number>`COALESCE(SUM(CASE WHEN vl.is_debit = 1 THEN vl.base_amount ELSE -vl.base_amount END), 0)`.as(
          'net',
        ),
      )
      .where('v.posted_at', 'is not', null)
      .where('v.tax_point_date', '<=', range.endDate);

    if (range.startDate !== undefined) {
      query = query.where('v.tax_point_date', '>=', range.startDate);
    }

    query = query.where((eb) =>
      eb.or([
        ...(codes.length > 0 ? [eb('a.code', 'in', codes)] : []),
        ...(types.length > 0 ? [eb('a.type', 'in', types)] : []),
      ]),
    );

    const result = await query.executeTakeFirst();
    const debitPositive = Number(result?.net ?? 0);
    return options.creditPositive ? -debitPositive : debitPositive;
  }
}
