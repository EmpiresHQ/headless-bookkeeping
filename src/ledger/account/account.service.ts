import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { toBool } from '../../database/helpers';
import { Account, AccountType } from './types';

@Injectable()
export class AccountService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async getAccounts(): Promise<Account[]> {
    const rows = await this.db
      .selectFrom('account')
      .selectAll()
      .orderBy('code')
      .execute();
    return rows.map((r) => this.mapRow(r));
  }

  async getAccountsByCodes(codes: string[]): Promise<Account[]> {
    if (codes.length === 0) return [];
    const rows = await this.db
      .selectFrom('account')
      .selectAll()
      .where('code', 'in', codes)
      .execute();
    return rows.map((r) => this.mapRow(r));
  }

  async getAccountByCode(code: string): Promise<Account | null> {
    const row = await this.db
      .selectFrom('account')
      .selectAll()
      .where('code', '=', code)
      .executeTakeFirst();
    return row ? this.mapRow(row) : null;
  }

  private validateAccountType(type: string): AccountType {
    if (type === 'asset') return type;
    if (type === 'liability') return type;
    if (type === 'equity') return type;
    if (type === 'revenue') return type;
    if (type === 'expense') return type;
    throw new Error(`Invalid account type: ${type}`);
  }

  private mapRow(row: {
    id: number;
    code: string;
    name: string;
    type: string;
    currency: string | null;
    parent_id: number | null;
    is_system: number;
  }): Account {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: this.validateAccountType(row.type),
      currency: row.currency,
      parent_id: row.parent_id,
      is_system: toBool(row.is_system),
    };
  }
}
