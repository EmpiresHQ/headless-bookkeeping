import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { KNOWN_SETTINGS, isKnownSettingKey } from './settings.registry';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
  ) {}

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  async get(key: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  async list(): Promise<{ key: string; value: string }[]> {
    return this.db
      .selectFrom('setting')
      .select(['key', 'value'])
      .orderBy('key')
      .execute();
  }

  async set(key: string, value: string): Promise<void> {
    if (!isKnownSettingKey(key)) {
      throw new BadRequestException(`Unknown setting key: ${key}`);
    }
    if (!KNOWN_SETTINGS[key].validate(value)) {
      throw new BadRequestException(`Invalid value for setting ${key}`);
    }
    await this.db
      .insertInto('setting')
      .values({ key, value, updated_at: this.now() })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value, updated_at: this.now() }),
      )
      .execute();
  }

  async delete(key: string): Promise<void> {
    await this.db.deleteFrom('setting').where('key', '=', key).execute();
  }
}
