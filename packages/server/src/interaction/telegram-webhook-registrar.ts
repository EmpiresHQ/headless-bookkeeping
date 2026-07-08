import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { TelegramApi } from './channels/telegram/telegram-api.port';
import { InteractionConfigService } from './config/interaction-config.service';

const TELEGRAM_WEBHOOK_PATH = '/api/channels/telegram/webhook';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function deriveTelegramWebhookUrl(publicApiUrl: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(publicApiUrl);
  } catch {
    return null;
  }

  const normalizedHost = parsedUrl.hostname
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
  if (parsedUrl.protocol !== 'https:' || LOOPBACK_HOSTS.has(normalizedHost)) {
    return null;
  }

  return `${publicApiUrl.replace(/\/+$/, '')}${TELEGRAM_WEBHOOK_PATH}`;
}

@Injectable()
export class TelegramWebhookRegistrar implements OnModuleInit {
  private readonly logger = new Logger(TelegramWebhookRegistrar.name);

  constructor(
    @Inject(KYSELY_MODULE_CONNECTION_TOKEN())
    private readonly db: Kysely<Database>,
    private readonly config: InteractionConfigService,
    private readonly telegramApi: TelegramApi,
  ) {}

  onModuleInit(): void {
    void this.registerWebhook().catch((error: unknown) => {
      this.logger.warn(
        `startup: telegram webhook registration failed: ${this.describeError(error)}`,
      );
    });
  }

  private async registerWebhook(): Promise<void> {
    const [token, secret, publicApiUrl] = await Promise.all([
      this.readTelegramBotToken(),
      this.config.getTelegramWebhookSecret(),
      this.config.getPublicApiUrl(),
    ]);
    if (!token || !secret || !publicApiUrl) {
      return;
    }

    const webhookUrl = deriveTelegramWebhookUrl(publicApiUrl);
    if (!webhookUrl) {
      return;
    }

    await this.telegramApi.setWebhook(webhookUrl, secret);
  }

  private async readTelegramBotToken(): Promise<string | null> {
    const row = await this.db
      .selectFrom('setting')
      .select('value')
      .where('key', '=', 'telegram_bot_token')
      .executeTakeFirst();
    return row?.value ?? null;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
