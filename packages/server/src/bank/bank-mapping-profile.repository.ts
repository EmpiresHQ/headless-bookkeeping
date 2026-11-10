import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Selectable } from 'kysely';
import { Database, BankMappingProfileTable } from '../database/types';
import {
  mappingRulesetSchema,
  type MappingRuleset,
} from './bank-mapping.types';

/** A persisted column mapping for one (account, export format). */
export interface BankMappingProfile {
  id: number;
  account_code: string;
  header_hash: string;
  header_json: string;
  ruleset: MappingRuleset;
  source_job_id: number | null;
  created_at: number;
  last_used_at: number;
}

/** The lightweight list projection returned by the reset endpoint. */
export interface BankMappingProfileListItem {
  id: number;
  account_code: string;
  header_json: string;
  source_job_id: number | null;
  created_at: number;
  last_used_at: number;
}

export interface SaveBankMappingProfileInput {
  accountCode: string;
  headerHash: string;
  headerColumns: string[];
  ruleset: MappingRuleset;
  sourceJobId?: number | null;
}

/**
 * Store and retrieve successful bank-CSV column mappings. A profile is keyed
 * by `(account_code, header_hash)` — the account plus the export format — so a
 * repeat upload from the same bank can apply the stored ruleset without an LLM
 * call. Rows are only written after an import has succeeded.
 */
@Injectable()
export class BankMappingProfileRepository {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * The full stored profile for this account + header signature, or null when
   * absent. A profile whose JSON no longer satisfies the ruleset schema is
   * treated as absent (never applied blindly): the import falls back to a
   * fresh inference and the stale row is overwritten only on success.
   */
  async findProfile(
    accountCode: string,
    headerHash: string,
  ): Promise<BankMappingProfile | null> {
    const row = await this.db
      .selectFrom('bank_mapping_profile')
      .selectAll()
      .where('account_code', '=', accountCode)
      .where('header_hash', '=', headerHash)
      .executeTakeFirst();
    if (!row) return null;
    const ruleset = this.parseRuleset(row);
    return ruleset ? this.mapRow(row, ruleset) : null;
  }

  /** The stored ruleset for this account + header signature, or null. */
  async find(
    accountCode: string,
    headerHash: string,
  ): Promise<MappingRuleset | null> {
    return (await this.findProfile(accountCode, headerHash))?.ruleset ?? null;
  }

  /**
   * Upsert a profile on the unique `(account_code, header_hash)` key. A repeat
   * success for the same format refreshes the ruleset and `last_used_at` but
   * preserves the original `created_at`.
   */
  async save(input: SaveBankMappingProfileInput): Promise<BankMappingProfile> {
    const now = Math.floor(Date.now() / 1000);
    const headerJson = JSON.stringify(input.headerColumns);
    const rulesetJson = JSON.stringify(input.ruleset);
    const row = await this.db
      .insertInto('bank_mapping_profile')
      .values({
        account_code: input.accountCode,
        header_hash: input.headerHash,
        header_json: headerJson,
        ruleset_json: rulesetJson,
        source_job_id: input.sourceJobId ?? null,
        created_at: now,
        last_used_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['account_code', 'header_hash']).doUpdateSet({
          header_json: headerJson,
          ruleset_json: rulesetJson,
          source_job_id: input.sourceJobId ?? null,
          last_used_at: now,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.mapRow(row, input.ruleset);
  }

  /** Record that a stored profile was used for an import. */
  async touch(id: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .updateTable('bank_mapping_profile')
      .set({ last_used_at: now })
      .where('id', '=', id)
      .execute();
  }

  /** Delete one profile by its natural key; returns the number deleted. */
  async delete(accountCode: string, headerHash: string): Promise<number> {
    const result = await this.db
      .deleteFrom('bank_mapping_profile')
      .where('account_code', '=', accountCode)
      .where('header_hash', '=', headerHash)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Delete one profile by id (the reset endpoint); returns the number deleted. */
  async deleteById(id: number): Promise<number> {
    const result = await this.db
      .deleteFrom('bank_mapping_profile')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** List stored profiles, optionally scoped to one account. */
  async list(accountCode?: string): Promise<BankMappingProfileListItem[]> {
    const base = this.db
      .selectFrom('bank_mapping_profile')
      .select([
        'id',
        'account_code',
        'header_json',
        'source_job_id',
        'created_at',
        'last_used_at',
      ]);
    const rows = accountCode
      ? await base
          .where('account_code', '=', accountCode)
          .orderBy('id', 'asc')
          .execute()
      : await base.orderBy('id', 'asc').execute();
    return rows.map((row) => ({
      id: row.id,
      account_code: row.account_code,
      header_json: row.header_json,
      source_job_id: row.source_job_id,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    }));
  }

  private parseRuleset(
    row: Selectable<BankMappingProfileTable>,
  ): MappingRuleset | null {
    try {
      const parsed = mappingRulesetSchema.safeParse(
        JSON.parse(row.ruleset_json),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private mapRow(
    row: Selectable<BankMappingProfileTable>,
    ruleset: MappingRuleset,
  ): BankMappingProfile {
    return {
      id: row.id,
      account_code: row.account_code,
      header_hash: row.header_hash,
      header_json: row.header_json,
      ruleset,
      source_job_id: row.source_job_id,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    };
  }
}
