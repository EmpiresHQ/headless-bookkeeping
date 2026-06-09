// src/interaction/interaction.module.ts
import { Module } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { DatabaseModule } from '../database/database.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { Database } from '../database/types';
import { InteractionConfigService } from './config/interaction-config.service';
import { PrincipalResolverService } from './principal/principal-resolver.service';
import { IntentClassifierService } from './router/intent-classifier.service';
import { FlowDispatcher, NoopFlowDispatcher } from './router/flow-dispatcher';
import { InteractionRouterService } from './router/interaction-router.service';
import {
  TransportRegistryService,
  INTERACTION_TRANSPORTS,
} from './transport/transport-registry.service';
import { TelegramTransportService } from './channels/telegram/telegram-transport.service';
import {
  TelegramApi,
  HttpTelegramApi,
} from './channels/telegram/telegram-api.port';
import { TelegramWebhookController } from './channels/telegram/telegram-webhook.controller';

@Module({
  imports: [
    DatabaseModule,
    ConversationsModule,
    DocumentsModule,
    AuditLogModule,
  ],
  controllers: [TelegramWebhookController],
  providers: [
    InteractionConfigService,
    PrincipalResolverService,
    IntentClassifierService,
    InteractionRouterService,
    TransportRegistryService,
    // 8a: non-recording production stub; 8b binds the real flows here.
    { provide: FlowDispatcher, useClass: NoopFlowDispatcher },
    // Live Bot API edge — reads the bot token lazily from settings.
    {
      provide: TelegramApi,
      useFactory: (db: Kysely<Database>) =>
        new HttpTelegramApi(async () => {
          const row = await db
            .selectFrom('setting')
            .select('value')
            .where('key', '=', 'telegram_bot_token')
            .executeTakeFirst();
          return row?.value ?? null;
        }),
      inject: [KYSELY_MODULE_CONNECTION_TOKEN()],
    },
    TelegramTransportService,
    {
      provide: INTERACTION_TRANSPORTS,
      useFactory: (t: TelegramTransportService) => [t],
      inject: [TelegramTransportService],
    },
  ],
})
export class InteractionModule {
  // IntentClassifierService must be initialized at boot; do it in onModuleInit.
  constructor(private readonly classifier: IntentClassifierService) {}
  async onModuleInit(): Promise<void> {
    await this.classifier.initialize();
  }
}
