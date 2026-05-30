import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { DocumentsService } from '../documents/documents.service';
import { DocumentStorageService } from '../documents/document-storage.service';
import { OcrService } from './ocr.service';
import { TriageService } from './triage.service';

/**
 * Integration test for the triage pipeline:
 *   TriageService -> OcrService (stub) -> DocumentsService ->
 *   ExpensesService | SalesInvoicesService + CurrencyService
 *
 * Exercises the REAL DI graph against an in-memory SQLite DB seeded by the
 * real migration. Proves odd document ids route to Expense and even ids
 * route to SalesInvoice.
 */
describe('TriageService (integration)', () => {
  let db: Kysely<Database>;
  let triage: TriageService;
  let documents: DocumentsService;
  let expenses: ExpensesService;
  let salesInvoices: SalesInvoicesService;

  beforeEach(async () => {
    const rawDb = new SqliteDb(':memory:');
    rawDb.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: rawDb }),
    });

    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error)
      throw error instanceof Error ? error : new Error('Migration failed');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        NullCountryPlugin,
        PluginLoader,
        CurrencyService,
        ExpensesService,
        SalesInvoicesService,
        DocumentsService,
        DocumentStorageService,
        OcrService,
        TriageService,
      ],
    }).compile();

    triage = module.get(TriageService);
    documents = module.get(DocumentsService);
    expenses = module.get(ExpensesService);
    salesInvoices = module.get(SalesInvoicesService);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('routes odd document id to Expense (transport, 1525, EUR, draft)', async () => {
    const uploadResult = await documents.upload({
      filename: 'receipt-1.pdf',
      buffer: Buffer.from('fake-receipt'),
      mimeType: 'application/pdf',
      channel: 'upload',
    });
    const doc = uploadResult.document;
    expect(doc.id).toBe(1); // odd

    const outcome = await triage.route(doc.id);
    expect(outcome.kind).toBe('expense');
    if (outcome.kind !== 'expense') throw new Error('unreachable');
    expect(outcome.document_id).toBe(doc.id);
    expect(outcome.expense_id).toBeDefined();

    const expense = await expenses.getExpenseById(outcome.expense_id);
    expect(expense.category).toBe('transport');
    expect(expense.gross_amount).toBe(1525);
    expect(expense.vat_amount).toBe(275);
    expect(expense.currency).toBe('EUR');
    expect(expense.status).toBe('draft');
    expect(expense.document_id).toBe(doc.id);

    const updatedDoc = await documents.getById(doc.id);
    expect(updatedDoc.status).toBe('triaged');
  });

  it('routes even document id to SalesInvoice (10000, EUR, draft)', async () => {
    // Upload two documents so the second gets id 2 (even)
    await documents.upload({
      filename: 'dummy.pdf',
      buffer: Buffer.from('dummy'),
      mimeType: 'application/pdf',
      channel: 'upload',
    });
    const uploadResult2 = await documents.upload({
      filename: 'invoice-2.pdf',
      buffer: Buffer.from('fake-invoice'),
      mimeType: 'application/pdf',
      channel: 'upload',
    });
    const doc = uploadResult2.document;
    expect(doc.id % 2).toBe(0); // even

    const outcome = await triage.route(doc.id);
    expect(outcome.kind).toBe('invoice');
    if (outcome.kind !== 'invoice') throw new Error('unreachable');
    expect(outcome.document_id).toBe(doc.id);
    expect(outcome.invoice_id).toBeDefined();

    const invoice = await salesInvoices.getInvoiceById(outcome.invoice_id);
    expect(invoice.gross_amount).toBe(10000);
    expect(invoice.vat_amount).toBe(2500);
    expect(invoice.currency).toBe('EUR');
    expect(invoice.status).toBe('draft');
    expect(invoice.invoice_number).toBe(`INV-${doc.id}`);

    const updatedDoc = await documents.getById(doc.id);
    expect(updatedDoc.status).toBe('triaged');
  });

  it('throws NotFoundException for unknown document id', async () => {
    await expect(triage.route(999)).rejects.toThrow('Document 999 not found');
  });
});
