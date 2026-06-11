import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { SalesInvoicesModule } from '../sales-invoices/sales-invoices.module';
import { CurrencyModule } from '../currency/currency.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OcrModule } from './ocr.module';
import { AiModule } from '../ai/ai.module';
import { DatabaseModule } from '../database/database.module';
import { TriageService } from './triage.service';
import { TriageController } from './triage.controller';

@Module({
  imports: [
    DatabaseModule,
    DocumentsModule,
    ExpensesModule,
    SalesInvoicesModule,
    CurrencyModule,
    ConversationsModule,
    OcrModule,
    AiModule,
  ],
  controllers: [TriageController],
  providers: [TriageService],
  exports: [TriageService],
})
export class TriageModule {}
