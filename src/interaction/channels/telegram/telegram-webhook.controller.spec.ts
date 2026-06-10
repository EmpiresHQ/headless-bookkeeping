// src/interaction/channels/telegram/telegram-webhook.controller.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import SqliteDb from 'better-sqlite3';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { Database } from '../../../database/types';
import { migrations } from '../../../database/migrations';
import { ConversationsService } from '../../../conversations/conversations.service';
import { DocumentsService } from '../../../documents/documents.service';
import {
  DocumentStorageService,
  DOCUMENT_STORAGE_ROOT,
} from '../../../documents/document-storage.service';
import { InteractionConfigService } from '../../config/interaction-config.service';
import { PrincipalResolverService } from '../../principal/principal-resolver.service';
import { IntentClassifierService } from '../../router/intent-classifier.service';
import { AgentConfigService } from '../../../ai/agent-config.service';
import {
  FlowDispatcher,
  RecordingFlowDispatcher,
} from '../../router/flow-dispatcher';
import {
  TransportRegistryService,
  INTERACTION_TRANSPORTS,
} from '../../transport/transport-registry.service';
import { InteractionGateService } from '../../router/interaction-gate.service';
import { InteractionRouterService } from '../../router/interaction-router.service';
import { TelegramTransportService } from './telegram-transport.service';
import { TelegramApi } from './telegram-api.port';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { promises as fs } from 'fs';
import { join } from 'path';

class FakeTelegramApi implements TelegramApi {
  sendMessage(): Promise<void> {
    return Promise.resolve();
  }
}

describe('TelegramWebhookController (integration)', () => {
  let db: Kysely<Database>;
  let controller: TelegramWebhookController;
  let classifier: IntentClassifierService;
  let storageRoot: string;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: new SqliteDb(':memory:') }),
    });
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('migrate failed');

    storageRoot = join('/tmp', 'telegram-webhook-test', `${Date.now()}`);
    await fs.mkdir(storageRoot, { recursive: true });

    const api = new FakeTelegramApi();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TelegramWebhookController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: DOCUMENT_STORAGE_ROOT, useValue: storageRoot },
        DocumentStorageService,
        ConversationsService,
        DocumentsService,
        InteractionConfigService,
        PrincipalResolverService,
        AgentConfigService,
        IntentClassifierService,
        { provide: FlowDispatcher, useClass: RecordingFlowDispatcher },
        { provide: TelegramApi, useValue: api },
        TelegramTransportService,
        {
          provide: INTERACTION_TRANSPORTS,
          useFactory: (t: TelegramTransportService) => [t],
          inject: [TelegramTransportService],
        },
        TransportRegistryService,
        AuditLogService,
        InteractionGateService,
        InteractionRouterService,
      ],
    }).compile();

    controller = module.get(TelegramWebhookController);
    classifier = module.get(IntentClassifierService);
    await classifier.initialize();
    jest.spyOn(classifier, 'classify').mockResolvedValue({ kind: 'advisory' });

    await db
      .insertInto('setting')
      .values({ key: 'telegram_webhook_secret', value: 'sek', updated_at: 0 })
      .execute();
    await db
      .insertInto('setting')
      .values({ key: 'telegram_allowlist', value: '999', updated_at: 0 })
      .execute();
    await db
      .insertInto('setting')
      .values({ key: 'approvers', value: '999', updated_at: 0 })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  const update = {
    update_id: 1,
    message: {
      message_id: 5,
      chat: { id: 999 },
      from: { id: 999 },
      text: 'hi',
    },
  };

  it('rejects a webhook with a wrong secret token and audit-logs the failure', async () => {
    await expect(controller.handle('nope', update)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'interaction.webhook.auth_failed')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied');
  });

  it('accepts a correct secret token and routes to a persisted Conversation', async () => {
    const res = await controller.handle('sek', update);
    expect(res).toEqual({ ok: true });
    const convo = await db
      .selectFrom('conversation')
      .selectAll()
      .where('thread_key', '=', 'tg:999')
      .executeTakeFirst();
    expect(convo).toBeDefined();
  });
});
