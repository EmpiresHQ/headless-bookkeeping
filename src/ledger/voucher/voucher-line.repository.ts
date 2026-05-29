import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { VoucherLine } from './types';

@Injectable()
export class VoucherLineRepository {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async getLinesByVoucherId(voucherId: number): Promise<VoucherLine[]> {
    const rows = await this.db
      .selectFrom('voucher_line')
      .selectAll()
      .where('voucher_id', '=', voucherId)
      .orderBy('id')
      .execute();
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: {
    id: number;
    voucher_id: number;
    account_id: number;
    amount: number;
    currency: string;
    base_amount: number;
    fx_rate: number;
    vat_code: string | null;
    is_debit: number;
  }): VoucherLine {
    return {
      id: row.id,
      voucher_id: row.voucher_id,
      account_id: row.account_id,
      amount: row.amount,
      currency: row.currency,
      base_amount: row.base_amount,
      fx_rate: row.fx_rate,
      vat_code: row.vat_code,
      is_debit: row.is_debit === 1,
    };
  }
}
