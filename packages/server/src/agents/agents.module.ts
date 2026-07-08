import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditFindingsModule } from '../audit-findings/audit-findings.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { InteractionModule } from '../interaction/interaction.module';
import { AccountingAgent } from './accounting.agent';
import { ReconciliationAgent } from './reconciliation.agent';
import { AuditAgent } from './audit.agent';
import { SecretaryAgent } from './secretary.agent';
import { DevAgent } from './dev.agent';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuditFindingsModule,
    InteractionModule,
    ConversationsModule,
  ],
  providers: [
    AccountingAgent,
    ReconciliationAgent,
    AuditAgent,
    SecretaryAgent,
    DevAgent,
  ],
  exports: [
    AccountingAgent,
    ReconciliationAgent,
    AuditAgent,
    SecretaryAgent,
    DevAgent,
  ],
})
export class AgentsModule {}
