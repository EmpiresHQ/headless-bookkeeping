import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { CurrencyService } from '../currency/currency.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { DocumentsService } from '../documents/documents.service';
import { DocumentStorageService } from '../documents/document-storage.service';
import { IntakeWorkflowService } from '../ai/intake-workflow.service';
import { TriageService } from './triage.service';

/**
 * Integration test for the triage pipeline:
 *   TriageService -> IntakeWorkflowService (mock) -> DocumentsService
 *
 * The AI pipeline (OCR + agent + proposeDraft) has its own comprehensive
 * tests in src/ai/*.spec.ts. This test verifies TriageService's routing
 * logic against mocked workflow outcomes.
 *
 * NOTE: the Document status transition is now owned by the IntakeWorkflowService
 * (the single deep owner of "Document -> outcome"), NOT by TriageService. The
 * mock therefore performs the status move to model the real workflow, and the
 * assertions confirm TriageService no longer touches the status itself.
 */
describe('TriageService (integration)', () => {
  let db: Kysely<Database>;
  let triage: TriageService;
  let documents: DocumentsService;
  let _expenses: ExpensesService;
  let _salesInvoices: SalesInvoicesService;

  const mockWorkflow = {
    process: jest.fn(),
  };

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
        EstoniaCountryPlugin,
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        VoucherProjectionService,
        ExpensesService,
        SalesInvoicesService,
        DocumentsService,
        DocumentStorageService,
        { provide: IntakeWorkflowService, useValue: mockWorkflow },
        TriageService,
      ],
    }).compile();

    triage = module.get(TriageService);
    documents = module.get(DocumentsService);
    _expenses = module.get(ExpensesService);
    _salesInvoices = module.get(SalesInvoicesService);
  });

  afterEach(async () => {
    await db.destroy();
    mockWorkflow.process.mockReset();
  });

  it('routes draft_proposed workflow result to Expense outcome', async () => {
    const uploadResult = await documents.upload({
      filename: 'receipt-1.pdf',
      buffer: Buffer.from('fake-receipt'),
      mimeType: 'application/pdf',
      channel: 'upload',
    });
    const doc = uploadResult.document;

    // Seed an expense so we have a real expense_id to return.
    const expense = await db
      .insertInto('expense')
      .values({
        document_id: doc.id,
        supplier_id: null,
        category: 'transport',
        gross_amount: 1525,
        vat_amount: 285,
        currency: 'EUR',
        tax_point_date: '2025-01-15',
        status: 'draft',
        document_vat_marking: 'IE_INPUT_23',
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // The workflow owns the status transition; the mock models that ownership.
    mockWorkflow.process.mockImplementation(async (id: number) => {
      await documents.setStatus(id, 'triaged');
      return {
        status: 'draft_proposed',
        draft: {
          expenseId: expense.id,
          pipelineResult: {
            businessObject: expense,
            voucher: null,
            policy: { action: 'hold-for-approval', reason: 'test' },
          },
        },
      };
    });

    const outcome = await triage.route(doc.id);
    expect(outcome.kind).toBe('expense');
    if (outcome.kind !== 'expense') throw new Error('unreachable');
    expect(outcome.document_id).toBe(doc.id);
    expect(outcome.expense_id).toBe(expense.id);

    const updatedDoc = await documents.getById(doc.id);
    expect(updatedDoc.status).toBe('triaged');
  });

  it('routes needs_triage workflow result to Unknown outcome', async () => {
    const uploadResult = await documents.upload({
      filename: 'unclear.pdf',
      buffer: Buffer.from('fake'),
      mimeType: 'application/pdf',
      channel: 'upload',
    });
    const doc = uploadResult.document;

    // The workflow owns the status transition to needs_triage.
    mockWorkflow.process.mockImplementation(async (id: number) => {
      await documents.setStatus(id, 'needs_triage');
      return {
        status: 'needs_triage',
        reason: 'AI confidence too low',
        finding: {
          id: 1,
          severity: 'medium',
          finding_type: 'needs_triage',
          description: 'AI confidence too low',
          referenced_object_type: 'document',
          referenced_object_id: doc.id,
          status: 'open',
          created_at: Math.floor(Date.now() / 1000),
          resolved_at: null,
          snoozed_at: null,
          transitioned_by: null,
          transition_reason: null,
        },
      };
    });

    const outcome = await triage.route(doc.id);
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') throw new Error('unreachable');
    expect(outcome.document_id).toBe(doc.id);
    expect(outcome.reason).toBe('AI confidence too low');

    // The workflow (not TriageService) moved the Document to needs_triage.
    const updatedDoc = await documents.getById(doc.id);
    expect(updatedDoc.status).toBe('needs_triage');
  });

  it('throws NotFoundException for unknown document id', async () => {
    await expect(triage.route(999)).rejects.toThrow('Document 999 not found');
  });
});
