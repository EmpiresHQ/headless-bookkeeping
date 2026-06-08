import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { SalesInvoicesModule } from '../sales-invoices/sales-invoices.module';
import { CurrencyModule } from '../currency/currency.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OcrService } from './ocr.service';
import { TriageService } from './triage.service';
import { TriageController } from './triage.controller';

@Module({
  imports: [
    DocumentsModule,
    ExpensesModule,
    SalesInvoicesModule,
    CurrencyModule,
    ConversationsModule,
  ],
  controllers: [TriageController],
  providers: [OcrService, TriageService],
  exports: [TriageService, OcrService],
})
export class TriageModule {}
