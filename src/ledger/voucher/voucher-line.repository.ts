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

  private mapRow({
    id,
    voucher_id,
    account_id,
    amount,
    currency,
    base_amount,
    fx_rate,
    vat_code,
    is_debit,
  }: {
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
      id,
      voucher_id,
      account_id,
      amount,
      currency,
      base_amount,
      fx_rate,
      vat_code,
      is_debit: is_debit === 1,
    };
  }
}
