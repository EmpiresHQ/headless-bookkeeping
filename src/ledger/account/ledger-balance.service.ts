import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';

/**
 * LedgerBalanceService — canonical signed-balance maths over voucher lines.
 *
 * The "net signed base amount" of a voucher's lines for a set of account codes
 * is `Σ(is_debit ? +base_amount : −base_amount)`, abs'd. Netting (rather than
 * summing) means a contra/reclass voucher carrying both an AR debit and an AP
 * credit collapses to its true magnitude instead of double-counting. This was
 * duplicated verbatim across the reconciliation and realized-FX services; it
 * now lives here.
 */
@Injectable()
export class LedgerBalanceService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * The voucher's net base amount across lines whose account code is in
   * `accountCodes`, netted by debit/credit sign and abs'd. Returns 0 when the
   * voucher has no matching lines.
   */
  async getVoucherNetBase(
    voucherId: number,
    accountCodes: string[],
  ): Promise<number> {
    const lineTotal = await this.db
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
}
