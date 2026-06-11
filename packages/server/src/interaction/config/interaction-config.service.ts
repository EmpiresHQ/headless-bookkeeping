// src/interaction/config/interaction-config.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../database/types';

export type IngestPolicy = 'known-only' | 'quarantine' | 'open';

@Injectable()
export class InteractionConfigService {
  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
  ) {}

  private async read(key: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  private async readIdSet(key: string): Promise<Set<string>> {
    const raw = await this.read(key);
    if (!raw) return new Set();
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }

  async getIngestPolicy(): Promise<IngestPolicy> {
    const raw = await this.read('ingest_policy');
    if (raw === 'quarantine' || raw === 'open') return raw;
    return 'known-only';
  }

  async getTelegramAllowlist(): Promise<Set<string>> {
    return this.readIdSet('telegram_allowlist');
  }

  async getApprovers(): Promise<Set<string>> {
    return this.readIdSet('approvers');
  }

  async getEmailWhitelist(): Promise<Set<string>> {
    return this.readIdSet('email_whitelist');
  }

  async getTelegramWebhookSecret(): Promise<string | null> {
    return this.read('telegram_webhook_secret');
  }
}
