// src/interaction/interaction.module.ts
import { Module } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { DatabaseModule } from '../database/database.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AgentConfigModule } from '../ai/agent-config.module';
import { Database } from '../database/types';
import { InteractionConfigService } from './config/interaction-config.service';
import { PrincipalResolverService } from './principal/principal-resolver.service';
import { IntentClassifierService } from './router/intent-classifier.service';
import { FlowDispatcher } from './router/flow-dispatcher';
import { RealFlowDispatcher } from './router/real-flow-dispatcher';
import { AllowanceFlow } from './router/flows/allowance-flow';
import { ApprovalFlow } from './router/flows/approval-flow';
import { AllowancesModule } from '../allowances/allowances.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { InteractionGateService } from './router/interaction-gate.service';
import { InteractionRouterService } from './router/interaction-router.service';
import {
  TransportRegistryService,
  INTERACTION_TRANSPORTS,
} from './transport/transport-registry.service';
import { TelegramApprovalSupportService } from './telegram-approval-support.service';
import { TelegramTransportService } from './channels/telegram/telegram-transport.service';
import {
  TelegramApi,
  HttpTelegramApi,
} from './channels/telegram/telegram-api.port';
import { TelegramWebhookController } from './channels/telegram/telegram-webhook.controller';
import { TelegramWebhookRegistrar } from './telegram-webhook-registrar';

@Module({
  imports: [
    DatabaseModule,
    ConversationsModule,
    DocumentsModule,
    AuditLogModule,
    AgentConfigModule,
    AllowancesModule,
    ApprovalsModule,
    ExpensesModule,
  ],
  controllers: [TelegramWebhookController],
  providers: [
    InteractionConfigService,
    PrincipalResolverService,
    IntentClassifierService,
    InteractionGateService,
    InteractionRouterService,
    TelegramWebhookRegistrar,
    TransportRegistryService,
    TelegramApprovalSupportService,
    AllowanceFlow,
    ApprovalFlow,
    RealFlowDispatcher,
    // 8b: real flow dispatcher replacing the 8a stub.
    { provide: FlowDispatcher, useClass: RealFlowDispatcher },
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
  exports: [
    InteractionConfigService,
    TransportRegistryService,
    TelegramApprovalSupportService,
  ],
})
// The intent-classifier agent is built on demand per message (settings-backed),
// so there is no boot-time initialization to perform here.
export class InteractionModule {}
