import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { Voucher } from './types';

@Injectable()
export class VoucherRepository {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async getVoucherById(id: number): Promise<Voucher | null> {
    const row = await this.db
      .selectFrom('voucher')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  async getVouchers(): Promise<Voucher[]> {
    const rows = await this.db
      .selectFrom('voucher')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: {
    id: number;
    voucher_number: string;
    tax_point_date: string;
    posted_at: number | null;
    previous_hash: string | null;
    reverses_id: number | null;
    corrects_object_type: string | null;
    corrects_object_id: number | null;
    reason: string | null;
  }): Voucher {
    return {
      id: row.id,
      voucher_number: row.voucher_number,
      tax_point_date: row.tax_point_date,
      posted_at: row.posted_at,
      previous_hash: row.previous_hash,
      reverses_id: row.reverses_id,
      corrects_object_type: row.corrects_object_type,
      corrects_object_id: row.corrects_object_id,
      reason: row.reason,
    };
  }
}
