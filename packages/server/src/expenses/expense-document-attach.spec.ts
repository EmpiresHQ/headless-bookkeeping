import { fxTestProviders } from '../../test/fx-fixtures';
import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerBalanceService } from '../ledger/account/ledger-balance.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { ReportingPeriodsService } from '../reporting-periods/reporting-periods.service';
import { VatReportService } from '../vat-report/vat-report.service';
import { PrepaymentAllocationRepository } from '../reconciliation/prepayment-allocation.repository';
import { StatutorySubmissionService } from '../statutory-submission/statutory-submission.service';
import { StatutoryReportService } from '../statutory-report/statutory-report.service';
import { RulesService } from '../rules/rules.service';
import { PolicyService } from '../policy/policy.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { CategoryService } from '../categories/category.service';
import { FixedAssetRegistrarService } from '../fixed-assets/fixed-asset-registrar.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import {
  DocumentStorageService,
  DOCUMENT_STORAGE_ROOT,
} from '../documents/document-storage.service';
import { PreviewRenderer } from '../documents/preview-renderer';
import { DocumentsService } from '../documents/documents.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { ExpenseDocumentAttachService } from './expense-document-attach.service';
import { ExpenseDocumentsController } from './expense-documents.controller';
import type { Expense } from './types';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { IntakeWorkflowService } from '../ai/intake-workflow.service';
import { ProcessingGate } from '../ai/processing-gate';
import { ProposeDraftService } from '../ai/propose-draft.service';

/**
 * Issue #248 — attach a late receipt to an EXISTING expense.
 * Real DI against in-memory SQLite and a temp storage root.
 */
describe('Expense document attach (integration)', () => {
  let db: Kysely<Database>;
  let root: string;
  let attach: ExpenseDocumentAttachService;
  let controller: ExpenseDocumentsController;
  let expenses: ExpensesController;
  let documents: DocumentsService;
  let storage: DocumentStorageService;
  let findings: AuditFindingsService;
  let periods: ReportingPeriodsService;
  let auditLog: AuditLogService;
  let moduleRef: TestingModule;

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

    root = await fs.mkdtemp(join(tmpdir(), 'hbk-attach-'));

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExpensesController, ExpenseDocumentsController],
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: DOCUMENT_STORAGE_ROOT, useValue: root },
        OrganizationService,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        ...fxTestProviders(),
        PluginLoader,
        OrgContextResolver,
        CurrencyService,
        AccountService,
        LedgerBalanceService,
        LedgerValidationService,
        PostingService,
        StatusTransitionService,
        PeriodLockService,
        ReportingPeriodsService,
        VatReportService,
        PrepaymentAllocationRepository,
        StatutorySubmissionService,
        StatutoryReportService,
        RulesService,
        PolicyService,
        PostingPipelineService,
        VoucherProjectionService,
        AuditLogService,
        AuditFindingsService,
        ExpensesService,
        FixedAssetRegistrarService,
        DocumentStorageService,
        {
          provide: PreviewRenderer,
          useValue: { render: jest.fn().mockResolvedValue(null) },
        },
        DocumentsService,
        ExpenseDocumentAttachService,
        {
          provide: CategoryService,
          useValue: {
            list: () => Promise.resolve([]),
            isValid: () => Promise.resolve(true),
            assertValid: () => Promise.resolve(),
          },
        },
      ],
    }).compile();

    moduleRef = module;
    attach = module.get(ExpenseDocumentAttachService);
    controller = module.get(ExpenseDocumentsController);
    expenses = module.get(ExpensesController);
    documents = module.get(DocumentsService);
    storage = module.get(DocumentStorageService);
    findings = module.get(AuditFindingsService);
    periods = module.get(ReportingPeriodsService);
    auditLog = module.get(AuditLogService);
    await module
      .get(OrganizationService)
      .updateOrganization({ vat_registered: true });
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  // Seeded period 1 is 2024-Q1.
  const newExpense = (overrides: Partial<{ tax_point_date: string }> = {}) =>
    expenses.createExpense({
      category: 'software',
      gross_amount: 12300,
      vat_amount: 2300,
      currency: 'EUR',
      tax_point_date: '2024-02-15',
      ...overrides,
    });

  const receipt = (text: string) => ({
    buffer: Buffer.from(`%PDF-1.4 receipt ${text}`),
    filename: `${text}.pdf`,
    mimeType: 'application/pdf',
  });

  /** An intake document parked for a human, as the workflow leaves it. */
  const parkedDocument = async (text: string) => {
    const { document } = await documents.upload({
      ...receipt(text),
      channel: 'telegram',
    });
    await db
      .updateTable('document')
      .set({
        status: 'needs_triage',
        pending_triage_result: '{"stale":true}',
      })
      .where('id', '=', document.id)
      .execute();
    const finding = await findings.create({
      finding_type: 'needs_triage',
      severity: 'medium',
      description: 'Possible duplicate of an expense already recorded',
      referenced_object_type: 'document',
      referenced_object_id: document.id,
    });
    return { documentId: document.id, findingId: finding.id };
  };

  const expenseRow = (id: number) =>
    db
      .selectFrom('expense')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  /** Everything the attach must leave alone on the books side. */
  const booksSnapshot = async () => ({
    vouchers: await db
      .selectFrom('voucher')
      .selectAll()
      .orderBy('id')
      .execute(),
    lines: await db
      .selectFrom('voucher_line')
      .selectAll()
      .orderBy('id')
      .execute(),
    vatReports: await db
      .selectFrom('vat_report')
      .selectAll()
      .orderBy('id')
      .execute(),
    periods: await db
      .selectFrom('reporting_period')
      .selectAll()
      .orderBy('id')
      .execute(),
    approvals: await db
      .selectFrom('approval')
      .selectAll()
      .orderBy('id')
      .execute(),
  });

  const withoutSourceFields = (e: Record<string, unknown>) => {
    const { document_id: _d, updated_at: _u, ...rest } = e;
    return rest;
  };

  describe('a new receipt upload', () => {
    it('attaches to a POSTED expense in a LOCKED period without touching the voucher, VAT snapshot or period', async () => {
      await moduleRef.get(PolicyService).updateConfig({
        auto_post_enabled: true,
        auto_post_amount_ceiling: 1_000_000,
        unknown_supplier_requires_approval: false,
      });
      const created = await newExpense();
      const posted = await expenses.postExpense(String(created.id));
      expect((posted.expense as Expense).status).toBe('posted');
      await periods.lock(1);

      const before = await expenseRow(created.id);
      const books = await booksSnapshot();
      expect(books.vatReports).toHaveLength(1);

      const res = await attach.attachNewFile(created.id, receipt('late'));

      expect(res.outcome).toBe('attached');
      expect(res.expense.id).toBe(created.id);
      expect(res.expense.document_id).toBe(res.document.id);
      const after = await expenseRow(created.id);
      expect(withoutSourceFields(after)).toEqual(withoutSourceFields(before));
      expect(await booksSnapshot()).toEqual(books);

      // Never intake work: filed, stored, and not claimable by the worker.
      expect(res.document.status).toBe('processed');
      expect(res.document.storage_path).not.toBeNull();
      expect(
        await storage.readFile(res.document.storage_path as string),
      ).toEqual(receipt('late').buffer);
      expect(await documents.claimNextPending(300, 3)).toBeNull();

      const trace = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'expense.document_attached')
        .executeTakeFirstOrThrow();
      expect(trace.target_id).toBe(created.id);
      expect(JSON.parse(trace.detail as string)).toMatchObject({
        document_id: res.document.id,
        source: 'upload',
        expense_status: 'posted',
        voucher_id: before.voucher_id,
        locked_period: expect.any(String),
      });
    });

    it('a retry with the same bytes is already_attached and creates nothing', async () => {
      const e = await newExpense();
      const first = await attach.attachNewFile(e.id, receipt('retry'));
      const docs = await db.selectFrom('document').select('id').execute();

      const again = await attach.attachNewFile(e.id, receipt('retry'));

      expect(again.outcome).toBe('already_attached');
      expect(again.document.id).toBe(first.document.id);
      expect(await db.selectFrom('document').select('id').execute()).toEqual(
        docs,
      );
    });

    it('refuses bytes that are already another expense’s source, creating nothing', async () => {
      const a = await newExpense();
      const b = await newExpense({ tax_point_date: '2024-02-16' });
      const first = await attach.attachNewFile(a.id, receipt('shared'));
      const sources = await db
        .selectFrom('document_source')
        .selectAll()
        .execute();

      await expect(
        attach.attachNewFile(b.id, receipt('shared')),
      ).rejects.toThrow(new RegExp(`already the source of expense #${a.id}`));
      expect((await expenseRow(b.id)).document_id).toBeNull();
      expect(
        await db.selectFrom('document_source').selectAll().execute(),
      ).toEqual(sources);
      expect((await expenseRow(a.id)).document_id).toBe(first.document.id);
    });

    it('never replaces an existing source', async () => {
      const e = await newExpense();
      const first = await attach.attachNewFile(e.id, receipt('one'));
      const docCount = (await db.selectFrom('document').select('id').execute())
        .length;

      await expect(attach.attachNewFile(e.id, receipt('two'))).rejects.toThrow(
        ConflictException,
      );

      expect((await expenseRow(e.id)).document_id).toBe(first.document.id);
      expect(
        (await db.selectFrom('document').select('id').execute()).length,
      ).toBe(docCount);
    });

    it('a write that stores partial bytes then fails leaves no document, no file and no link', async () => {
      const e = await newExpense();
      jest
        .spyOn(storage, 'saveFile')
        .mockImplementationOnce(async (id, filename) => {
          const p = join(root, storage.pathFor(id, filename));
          await fs.mkdir(join(p, '..'), { recursive: true });
          await fs.writeFile(p, 'partial');
          throw new Error('disk full');
        });

      await expect(
        attach.attachNewFile(e.id, receipt('partial')),
      ).rejects.toThrow('disk full');

      expect(await db.selectFrom('document').selectAll().execute()).toEqual([]);
      expect((await expenseRow(e.id)).document_id).toBeNull();
      await expect(
        fs.access(join(root, storage.pathFor(1, 'partial.pdf'))),
      ).rejects.toThrow();
    });

    it('a failure after the file is stored rolls back and removes only this call’s file before the id can be reused', async () => {
      const e = await newExpense();
      jest
        .spyOn(auditLog, 'record')
        .mockRejectedValueOnce(new Error('audit down'));

      await expect(
        attach.attachNewFile(e.id, receipt('rolled-back')),
      ).rejects.toThrow('audit down');
      expect(await db.selectFrom('document').selectAll().execute()).toEqual([]);
      expect((await expenseRow(e.id)).document_id).toBeNull();

      // The next upload reuses the rolled-back id; its bytes must survive.
      const { document } = await documents.upload({
        ...receipt('next'),
        channel: 'upload',
      });
      expect(await storage.readFile(document.storage_path as string)).toEqual(
        receipt('next').buffer,
      );
      await expect(
        fs.access(join(root, storage.pathFor(document.id, 'rolled-back.pdf'))),
      ).rejects.toThrow();
    });
  });

  describe('an existing document', () => {
    it('attaches a parked needs_triage receipt, resolves its finding and files it', async () => {
      const e = await newExpense();
      const { documentId, findingId } = await parkedDocument('parked');
      expect((await attach.listAttachable(e.id)).map((d) => d.id)).toEqual([
        documentId,
      ]);

      const res = await attach.attachExisting(e.id, documentId);

      expect(res.outcome).toBe('attached');
      expect(res.expense.document_id).toBe(documentId);
      const doc = await db
        .selectFrom('document')
        .selectAll()
        .where('id', '=', documentId)
        .executeTakeFirstOrThrow();
      expect(doc.status).toBe('processed');
      expect(doc.pending_triage_result).toBeNull();
      const finding = await db
        .selectFrom('audit_finding')
        .selectAll()
        .where('id', '=', findingId)
        .executeTakeFirstOrThrow();
      expect(finding.status).toBe('resolved');
      expect(finding.transition_reason).toContain(`expense #${e.id}`);

      // Idempotent retry; the list is empty once the expense has a source.
      expect((await attach.attachExisting(e.id, documentId)).outcome).toBe(
        'already_attached',
      );
      expect(await attach.listAttachable(e.id)).toEqual([]);
    });

    it('attaches an idle pending document so the worker can no longer claim it', async () => {
      const e = await newExpense();
      const { document } = await documents.upload({
        ...receipt('idle'),
        channel: 'email',
      });

      await attach.attachExisting(e.id, document.id);

      expect(await documents.claimNextPending(300, 3)).toBeNull();
    });

    it('refuses a document the worker already claimed', async () => {
      const e = await newExpense();
      const { document } = await documents.upload({
        ...receipt('claimed'),
        channel: 'email',
      });
      expect((await documents.claimNextPending(300, 3))?.id).toBe(document.id);

      expect(await attach.listAttachable(e.id)).toEqual([]);
      await expect(attach.attachExisting(e.id, document.id)).rejects.toThrow(
        /processing it right now/,
      );
      expect((await expenseRow(e.id)).document_id).toBeNull();
    });

    it('refuses at once while the intake workflow holds the document', async () => {
      const e = await newExpense();
      const { documentId } = await parkedDocument('held');
      let release!: () => void;
      const held = documents.runExclusive(
        documentId,
        () => new Promise<void>((r) => (release = r)),
      );

      await expect(attach.attachExisting(e.id, documentId)).rejects.toThrow(
        /being processed or changed right now/,
      );
      release();
      await held;
      expect((await expenseRow(e.id)).document_id).toBeNull();
    });

    // The candidate list and the final refusal share one rule: every case
    // below is absent from the list AND refused by the attach, unchanged.
    const uses: Array<
      [string, (docId: number, otherExpense: Expense) => Promise<void>, RegExp]
    > = [
      [
        'another expense’s source',
        async (docId, other) => {
          await db
            .updateTable('expense')
            .set({ document_id: docId })
            .where('id', '=', other.id)
            .execute();
        },
        /already the source of expense/,
      ],
      [
        'a sales invoice’s source',
        async (docId) => {
          await db
            .insertInto('sales_invoice')
            .values({
              document_id: docId,
              customer_id: null,
              invoice_number: 'INV-1',
              gross_amount: 100,
              vat_amount: 0,
              currency: 'EUR',
              tax_point_date: '2024-02-01',
              status: 'draft',
              voucher_id: null,
              created_at: 0,
              updated_at: 0,
            } as never)
            .execute();
        },
        /source of sales invoice/,
      ],
      [
        'an allowance’s evidence',
        async (docId) => {
          const claimant = await db
            .insertInto('entity')
            .values({
              name: 'Emp',
              role: 'employee',
              country: 'EE',
              created_at: 0,
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow();
          await db
            .insertInto('allowance')
            .values({
              claimant_id: claimant.id,
              type: 'health',
              gross_amount: 100,
              tax_free_amount: 100,
              taxable_amount: 0,
              period_start: '2024-02-01',
              supporting_document_id: docId,
              created_at: 0,
              updated_at: 0,
            } as never)
            .execute();
        },
        /evidence for allowance/,
      ],
      [
        'a receipt intake filed against another expense',
        async (docId, other) => {
          await auditLog.record({
            actor: 'system',
            action: 'document.duplicate_guard.receipt_matched',
            outcome: 'processed',
            target_type: 'document',
            target_id: docId,
            detail: { expense_id: other.id, reason: 'x' },
          });
        },
        /filed it as a receipt for expense #\d+/,
      ],
      [
        'a claimant submission',
        async (docId) => {
          const claimant = await db
            .insertInto('entity')
            .values({
              name: 'Emp',
              role: 'employee',
              country: 'EE',
              created_at: 0,
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow();
          await db
            .updateTable('document')
            .set({ claimant_id: claimant.id })
            .where('id', '=', docId)
            .execute();
        },
        /submitted by a claimant/,
      ],
      [
        'a document intake already triaged',
        async (docId) => {
          await db
            .updateTable('document')
            .set({ status: 'triaged' })
            .where('id', '=', docId)
            .execute();
        },
        /already turned it into a draft/,
      ],
    ];

    it.each(uses)(
      'refuses %s — absent from the list and refused unchanged',
      async (_label, use, reason) => {
        const e = await newExpense();
        const other = await newExpense({ tax_point_date: '2024-03-01' });
        const { documentId } = await parkedDocument('used');
        await use(documentId, other);
        const docBefore = await db
          .selectFrom('document')
          .selectAll()
          .where('id', '=', documentId)
          .executeTakeFirstOrThrow();

        expect(
          (await attach.listAttachable(e.id)).map((d) => d.id),
        ).not.toContain(documentId);
        await expect(attach.attachExisting(e.id, documentId)).rejects.toThrow(
          reason,
        );

        expect((await expenseRow(e.id)).document_id).toBeNull();
        expect(
          await db
            .selectFrom('document')
            .selectAll()
            .where('id', '=', documentId)
            .executeTakeFirstOrThrow(),
        ).toEqual(docBefore);
      },
    );

    it('404s an unknown expense or document', async () => {
      const e = await newExpense();
      await expect(attach.attachExisting(999, 1)).rejects.toThrow(
        NotFoundException,
      );
      await expect(attach.attachExisting(e.id, 999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('HTTP contract', () => {
    it('requires exactly one of file or document_id', async () => {
      const e = await newExpense();
      const file = {
        buffer: Buffer.from('x'),
        originalname: 'x.pdf',
        mimetype: 'application/pdf',
      } as Express.Multer.File;
      await expect(
        controller.attachDocument(String(e.id), undefined, {}),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.attachDocument(String(e.id), file, { document_id: 1 }),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([
      [[1]],
      [true],
      [{ id: 1 }],
      [0],
      [-1],
      [1.5],
      ['1.5'],
      ['1e2'],
      [''],
      [null],
    ])('rejects document_id %p without coercing it', async (bad) => {
      const e = await newExpense();
      await expect(
        controller.attachDocument(String(e.id), undefined, {
          document_id: bad,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it.each(['abc', '0', '-1', '1.5', '9007199254740993'])(
      'rejects route id %p',
      async (bad) => {
        await expect(
          controller.attachDocument(bad, undefined, { document_id: 1 }),
        ).rejects.toThrow(BadRequestException);
        await expect(controller.listAttachable(bad)).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it('refuses a string document_id (e.g. a multipart text field) — the contract is JSON integer only', async () => {
      const e = await newExpense();
      const { documentId } = await parkedDocument('multipart');
      await expect(
        controller.attachDocument(String(e.id), undefined, {
          document_id: String(documentId),
        }),
      ).rejects.toThrow(BadRequestException);
      expect((await expenseRow(e.id)).document_id).toBeNull();
    });
  });

  describe('over HTTP (multipart + JSON parsing, closed body)', () => {
    let app: INestApplication;
    beforeEach(async () => {
      app = moduleRef.createNestApplication();
      app.useGlobalPipes(new ZodValidationPipe());
      await app.init();
    });
    afterEach(async () => {
      await app.close();
    });

    it('attaches a multipart file', async () => {
      const e = await newExpense();
      const res = await request(app.getHttpServer())
        .post(`/api/expenses/${e.id}/attach-document`)
        .attach('file', receipt('http').buffer, 'http.pdf')
        .expect(200);
      const body = res.body as { outcome: string; expense: Expense };
      expect(body.outcome).toBe('attached');
      expect(body.expense.id).toBe(e.id);
    });

    it('attaches a JSON document_id and lists candidates', async () => {
      const e = await newExpense();
      const { documentId } = await parkedDocument('http-json');
      const list = await request(app.getHttpServer())
        .get(`/api/expenses/${e.id}/attachable-documents`)
        .expect(200);
      expect(
        (list.body as { documents: { id: number }[] }).documents.map(
          (d) => d.id,
        ),
      ).toEqual([documentId]);
      await request(app.getHttpServer())
        .post(`/api/expenses/${e.id}/attach-document`)
        .send({ document_id: documentId })
        .expect(200);
    });

    it.each([
      ['a JSON extra key', { document_id: 1, foo: 'bar' }],
      ['a JSON array body', [1]],
      ['a JSON boolean document_id', { document_id: true }],
    ])('rejects %s with 400 and changes nothing', async (_l, payload) => {
      const e = await newExpense();
      const { documentId } = await parkedDocument('http-bad');
      if (!Array.isArray(payload) && typeof payload.document_id === 'number') {
        payload.document_id = documentId;
      }
      await request(app.getHttpServer())
        .post(`/api/expenses/${e.id}/attach-document`)
        .send(payload as object)
        .expect(400);
      expect((await expenseRow(e.id)).document_id).toBeNull();
    });

    it.each([
      ['an extra multipart field', 'foo', 'bar'],
      ['a document_id next to the file', 'document_id', '1'],
    ])('rejects a file with %s', async (_l, field, value) => {
      const e = await newExpense();
      await request(app.getHttpServer())
        .post(`/api/expenses/${e.id}/attach-document`)
        .field(field, value)
        .attach('file', receipt('http-extra').buffer, 'x.pdf')
        .expect(400);
      expect((await expenseRow(e.id)).document_id).toBeNull();
      expect(await db.selectFrom('document').select('id').execute()).toEqual(
        [],
      );
    });
  });

  /**
   * The workflow's real entry points and the attach share the module's ONE
   * DocumentsService (and its per-document exclusion). Only the AI passes and
   * the draft proposal are stubbed; the replay lookup is the real one.
   */
  describe('racing the intake workflow', () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    };

    const buildWorkflow = (
      pause: {
        at: 'ocr' | 'propose' | 'manual';
        reached: () => void;
        until: Promise<void>;
      } | null,
    ) => {
      const draft = { outcome: 'draft', expenseId: -1, pipelineResult: {} };
      const stall = async <T>(at: string, value: T): Promise<T> => {
        if (pause?.at === at) {
          pause.reached();
          await pause.until;
        }
        return value;
      };
      const proposeDraft = {
        findExistingDraft: (id: number) =>
          ProposeDraftService.prototype.findExistingDraft.call({ db }, id),
        findExistingInvoiceDraft: jest.fn().mockResolvedValue(undefined),
        proposeDraft: jest.fn(() => stall('propose', draft)),
        manualClassifyDraft: jest.fn(() => stall('manual', draft)),
      };
      const workflow = new IntakeWorkflowService(
        {
          transcribe: jest.fn(() =>
            stall('ocr', { ok: true, markdown: '# Receipt' }),
          ),
        } as never,
        {
          classify: jest.fn().mockResolvedValue({
            ok: true,
            result: {
              kind: 'new_expense',
              confidence: 0.99,
              document_type: 'receipt',
            },
          }),
        } as never,
        proposeDraft as never,
        findings,
        {
          getConfig: jest
            .fn()
            .mockResolvedValue({ auto_post_min_confidence: 0.5 }),
        } as never,
        documents,
        {
          findById: jest.fn().mockResolvedValue({ id: 1, role: 'supplier' }),
          addIdentifierIfAbsent: jest.fn(),
        } as never,
        {
          getOrganization: jest
            .fn()
            .mockResolvedValue({ iban: null, name: null }),
        } as never,
        {} as never,
        new ProcessingGate(),
        db,
        auditLog,
      );
      return { workflow, proposeDraft };
    };

    const entries: Array<
      [
        string,
        'ocr' | 'propose' | 'manual',
        'pending' | 'needs_triage',
        (w: IntakeWorkflowService, docId: number) => Promise<unknown>,
      ]
    > = [
      ['process (pending)', 'ocr', 'pending', (w, id) => w.process(id)],
      [
        'resolveSupplier (needs_triage)',
        'propose',
        'needs_triage',
        (w, id) => w.resolveSupplier(id, 1),
      ],
      [
        'manualClassify (needs_triage)',
        'manual',
        'needs_triage',
        (w, id) =>
          w.manualClassify(id, {
            category: 'software',
            gross_amount: 100,
            vat_amount: 0,
            currency: 'EUR',
            tax_point_date: '2024-02-01',
          } as never),
      ],
    ];

    it.each(entries)(
      '%s paused after its status read: attach is refused at once and changes nothing',
      async (_label, at, status, run) => {
        const e = await newExpense();
        const { documentId } = await parkedDocument(`race-${at}`);
        await db
          .updateTable('document')
          .set({
            status,
            pending_triage_result:
              status === 'needs_triage'
                ? JSON.stringify({
                    kind: 'new_expense',
                    confidence: 0.99,
                    category: 'software',
                  })
                : null,
          })
          .where('id', '=', documentId)
          .execute();
        jest
          .spyOn(documents, 'getPendingTriageReplay')
          .mockResolvedValue({ triageResult: {} as never, enrichment: null });

        const reached = deferred();
        const release = deferred();
        const { workflow, proposeDraft } = buildWorkflow({
          at,
          reached: reached.resolve,
          until: release.promise,
        });
        const running = run(workflow, documentId);
        await reached.promise;

        await expect(attach.attachExisting(e.id, documentId)).rejects.toThrow(
          ConflictException,
        );
        expect((await expenseRow(e.id)).document_id).toBeNull();

        release.resolve();
        await running;
        // The workflow went on to its own draft step — it was never told the
        // document had been attached, because it had not been.
        expect(
          proposeDraft.proposeDraft.mock.calls.length +
            proposeDraft.manualClassifyDraft.mock.calls.length,
        ).toBe(1);
      },
    );

    it.each(entries)(
      'attach first, then %s replays the SAME expense and proposes nothing',
      async (_label, _at, status, run) => {
        const e = await newExpense();
        const { documentId } = await parkedDocument(`first-${status}`);
        await db
          .updateTable('document')
          .set({ status })
          .where('id', '=', documentId)
          .execute();
        await attach.attachExisting(e.id, documentId);

        const { workflow, proposeDraft } = buildWorkflow(null);
        const result = (await run(workflow, documentId)) as {
          status: string;
          draft: { expenseId: number };
        };

        expect(result.status).toBe('draft_proposed');
        expect(result.draft.expenseId).toBe(e.id);
        expect(proposeDraft.proposeDraft).not.toHaveBeenCalled();
        expect(proposeDraft.manualClassifyDraft).not.toHaveBeenCalled();
        expect(
          await db.selectFrom('expense').select('id').execute(),
        ).toHaveLength(1);
      },
    );
  });

  describe('concurrent uploads to one expense', () => {
    const filesOnDisk = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const dir of await fs.readdir(root)) {
        for (const f of await fs.readdir(join(root, dir))) {
          out.push(join(dir, f));
        }
      }
      return out.sort();
    };

    it('two different files: one attaches, the other is refused — no orphan row or file', async () => {
      const e = await newExpense();
      const results = await Promise.allSettled([
        attach.attachNewFile(e.id, receipt('left')),
        attach.attachNewFile(e.id, receipt('right')),
      ]);

      const ok = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );

      const docs = await db.selectFrom('document').selectAll().execute();
      expect(docs).toHaveLength(1);
      expect((await expenseRow(e.id)).document_id).toBe(docs[0].id);
      expect(await filesOnDisk()).toEqual([docs[0].storage_path]);
      expect(
        await db.selectFrom('expense').select('id').execute(),
      ).toHaveLength(1);
    });

    it('the same file twice: one attached, one already_attached — one row, one file', async () => {
      const e = await newExpense();
      const [a, b] = await Promise.all([
        attach.attachNewFile(e.id, receipt('same')),
        attach.attachNewFile(e.id, receipt('same')),
      ]);

      expect([a.outcome, b.outcome].sort()).toEqual([
        'already_attached',
        'attached',
      ]);
      expect(a.document.id).toBe(b.document.id);
      const docs = await db.selectFrom('document').selectAll().execute();
      expect(docs).toHaveLength(1);
      expect(await filesOnDisk()).toEqual([docs[0].storage_path]);
    });
  });
});
