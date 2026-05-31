import { Injectable, NotFoundException } from '@nestjs/common';
import { OcrService } from './ocr.service';
import { DocumentsService } from '../documents/documents.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { CurrencyService } from '../currency/currency.service';
import { TriageOutcome } from './types';

@Injectable()
export class TriageService {
  constructor(
    private readonly ocr: OcrService,
    private readonly documents: DocumentsService,
    private readonly expenses: ExpensesService,
    private readonly salesInvoices: SalesInvoicesService,
    private readonly currencyService: CurrencyService,
  ) {}

  async route(documentId: number): Promise<TriageOutcome> {
    const doc = await this.documents.getById(documentId);
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found`);
    }

    const ocrResult = this.ocr.extract(documentId);
    const currency = await this.currencyService.getBaseCurrency();
    const taxPointDate = new Date(doc.created_at * 1000)
      .toISOString()
      .slice(0, 10);

    if (ocrResult.document_type === 'receipt') {
      const expense = await this.expenses.createExpense({
        document_id: documentId,
        category: ocrResult.category,
        gross_amount: ocrResult.gross_amount,
        vat_amount: ocrResult.vat_amount,
        currency,
        tax_point_date: taxPointDate,
      });

      await this.documents.setStatus(documentId, 'triaged');

      return {
        kind: 'expense',
        document_id: documentId,
        expense_id: expense.id,
      };
    }

    if (ocrResult.document_type === 'invoice') {
      const invoice = await this.salesInvoices.createInvoice({
        invoice_number: `INV-${doc.id}`,
        gross_amount: ocrResult.gross_amount,
        vat_amount: ocrResult.vat_amount,
        currency,
        tax_point_date: taxPointDate,
      });

      await this.documents.setStatus(documentId, 'triaged');

      return {
        kind: 'invoice',
        document_id: documentId,
        invoice_id: invoice.id,
      };
    }

    return {
      kind: 'unknown',
      document_id: documentId,
      reason: `Unrecognized document type: ${ocrResult.document_type}`,
    };
  }
}
