import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { TelegramApi } from './channels/telegram/telegram-api.port';
import { InteractionConfigService } from './config/interaction-config.service';
import {
  deriveTelegramWebhookUrl,
  TelegramWebhookRegistrar,
} from './telegram-webhook-registrar';

class FakeTelegramApi extends TelegramApi {
  readonly webhookCalls: Array<{
    readonly url: string;
    readonly secretToken: string;
  }> = [];

  setWebhookError: Error | null = null;

  sendMessage(): Promise<void> {
    return Promise.resolve();
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    this.webhookCalls.push({ url, secretToken });
    if (this.setWebhookError) {
      throw this.setWebhookError;
    }
  }

  answerCallbackQuery(): Promise<void> {
    return Promise.resolve();
  }

  editMessageReplyMarkup(): Promise<void> {
    return Promise.resolve();
  }
}

async function flushBackgroundWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('TelegramWebhookRegistrar', () => {
  let db: Kysely<Database>;
  let registrar: TelegramWebhookRegistrar;
  let api: FakeTelegramApi;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) {
      throw error instanceof Error ? error : new Error('migrate failed');
    }

    api = new FakeTelegramApi();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        InteractionConfigService,
        TelegramWebhookRegistrar,
        { provide: TelegramApi, useValue: api },
      ],
    }).compile();

    registrar = module.get(TelegramWebhookRegistrar);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function setSetting(key: string, value: string): Promise<void> {
    await db
      .insertInto('setting')
      .values({ key, value, updated_at: 0 })
      .execute();
  }

  describe('deriveTelegramWebhookUrl', () => {
    it('derives the Telegram webhook path from an https public_api_url', () => {
      expect(deriveTelegramWebhookUrl('https://app.example/')).toBe(
        'https://app.example/api/channels/telegram/webhook',
      );
    });

    it.each([
      'http://app.example',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
    ])('returns null for %s', (publicApiUrl) => {
      expect(deriveTelegramWebhookUrl(publicApiUrl)).toBeNull();
    });
  });

  it('skips cleanly at startup when required settings are absent', async () => {
    expect(() => registrar.onModuleInit()).not.toThrow();

    await flushBackgroundWork();

    expect(api.webhookCalls).toEqual([]);
  });

  it('registers the Telegram webhook at startup from public_api_url', async () => {
    await setSetting('telegram_bot_token', 'bot-token');
    await setSetting('telegram_webhook_secret', 'sek');
    await setSetting('public_api_url', 'https://app.example/');

    registrar.onModuleInit();
    await flushBackgroundWork();

    expect(api.webhookCalls).toEqual([
      {
        url: 'https://app.example/api/channels/telegram/webhook',
        secretToken: 'sek',
      },
    ]);
  });

  it.each([
    {
      name: 'telegram bot token is absent',
      settings: [
        ['telegram_webhook_secret', 'sek'],
        ['public_api_url', 'https://app.example'],
      ],
    },
    {
      name: 'telegram webhook secret is absent',
      settings: [
        ['telegram_bot_token', 'bot-token'],
        ['public_api_url', 'https://app.example'],
      ],
    },
    {
      name: 'public_api_url is absent',
      settings: [
        ['telegram_bot_token', 'bot-token'],
        ['telegram_webhook_secret', 'sek'],
      ],
    },
    {
      name: 'public_api_url is localhost',
      settings: [
        ['telegram_bot_token', 'bot-token'],
        ['telegram_webhook_secret', 'sek'],
        ['public_api_url', 'https://localhost:3000'],
      ],
    },
    {
      name: 'public_api_url is loopback ipv4',
      settings: [
        ['telegram_bot_token', 'bot-token'],
        ['telegram_webhook_secret', 'sek'],
        ['public_api_url', 'https://127.0.0.1:3000'],
      ],
    },
    {
      name: 'public_api_url is loopback ipv6',
      settings: [
        ['telegram_bot_token', 'bot-token'],
        ['telegram_webhook_secret', 'sek'],
        ['public_api_url', 'https://[::1]:3000'],
      ],
    },
    {
      name: 'public_api_url is non-https',
      settings: [
        ['telegram_bot_token', 'bot-token'],
        ['telegram_webhook_secret', 'sek'],
        ['public_api_url', 'http://app.example'],
      ],
    },
  ])('skips startup registration when $name', async ({ settings }) => {
    for (const [key, value] of settings) {
      await setSetting(key, value);
    }

    registrar.onModuleInit();
    await flushBackgroundWork();

    expect(api.webhookCalls).toEqual([]);
  });

  it('logs webhook registration failures without blocking startup', async () => {
    await setSetting('telegram_bot_token', 'bot-token');
    await setSetting('telegram_webhook_secret', 'sek');
    await setSetting('public_api_url', 'https://app.example');
    api.setWebhookError = new Error('boom');
    const warnSpy = jest
      .spyOn(registrar['logger'], 'warn')
      .mockImplementation(() => undefined);

    expect(() => registrar.onModuleInit()).not.toThrow();
    await flushBackgroundWork();

    expect(api.webhookCalls).toEqual([
      {
        url: 'https://app.example/api/channels/telegram/webhook',
        secretToken: 'sek',
      },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      'startup: telegram webhook registration failed: boom',
    );
  });
});
