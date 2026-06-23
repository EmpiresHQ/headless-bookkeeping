import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocumentsModule } from '../documents/documents.module';
import { IntakeQueueModule } from '../intake-queue/intake-queue.module';
import { AdminModule } from '../admin/admin.module';
import { MailboxConnectorService } from './mailbox-connector.service';
import { OAuthService } from './oauth.service';
import { HarvestService } from './harvest.service';
import { MailSyncWorker } from './mail-sync.worker';
import { ImapClient } from './imap-client.port';
import { ImapflowImapClient } from './imapflow-imap-client';
import { MailboxController } from './mailbox.controller';

@Module({
  imports: [DatabaseModule, DocumentsModule, IntakeQueueModule, AdminModule],
  controllers: [MailboxController],
  providers: [
    MailboxConnectorService,
    OAuthService,
    HarvestService,
    MailSyncWorker,
    { provide: ImapClient, useClass: ImapflowImapClient },
    { provide: 'HARVEST', useExisting: HarvestService },
    { provide: 'OAUTH', useExisting: OAuthService },
  ],
  exports: [MailboxConnectorService],
})
export class MailboxModule {}
