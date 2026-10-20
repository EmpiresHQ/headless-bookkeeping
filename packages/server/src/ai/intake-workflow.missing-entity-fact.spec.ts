import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { fxTestProviders } from '../../test/fx-fixtures';
import { OrganizationService } from '../organization/organization.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { PluginLoader } from '../plugins/plugin-loader.service';
import { NullCountryPlugin } from '../plugins/null-country.plugin';
import { EstoniaCountryPlugin } from '../plugins/estonia-country.plugin';
import { CurrencyService } from '../currency/currency.service';
import { AccountService } from '../ledger/account/account.service';
import { LedgerValidationService } from '../ledger/validation/ledger-validation.service';
import { PostingService } from '../ledger/posting/posting.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { PeriodLockService } from '../reporting-periods/period-lock.service';
import { RulesService } from '../rules/rules.service';
import { PolicyService } from '../policy/policy.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import { ExpensesService } from '../expenses/expenses.service';
import { ExpensesController } from '../expenses/expenses.controller';
import type { FixedAssetRegistrarService } from '../fixed-assets/fixed-asset-registrar.service';

import { VoucherProjectionService } from '../ledger/projection/voucher-projection.service';
import { EntitiesService } from '../entities/entities.service';
import { AgentConfigService } from '../ai/agent-config.service';
import { CategoryService } from '../categories/category.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ProposeDraftService } from '../ai/propose-draft.service';
import { IntakeWorkflowService } from '../ai/intake-workflow.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { DocumentsService } from '../documents/documents.service';
import { DocumentStorageService } from '../documents/document-storage.service';
import { PreviewRenderer } from '../documents/preview-renderer';
import { BankIngestionService } from '../bank/bank-ingestion.service';
import { Pass2AgentService } from '../ai/pass2-agent.service';
import { ProcessingGate } from '../ai/processing-gate';
import { OcrService } from '../triage/ocr.service';
import { DocumentTranscriber } from '../triage/document-transcriber.port';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { TriageResult } from '../triage/types';

/**
 * Issue #404 — the missing-supplier-fact hold family, end to end through the
 * REAL pipeline (real ProposeDraftService, real ExpensesService, the real EE
 * plugin, real OcrService caching): a foreign-supplier invoice whose entity
 * tax status (EU) or goods-vs-services (non-EU) is not recorded parks in
 * needs_triage WITH a minted draft. The operator must be able to see the
 * matched supplier + the missing fact through typed API data (never prose),
 * confirm the fact in one interaction through the legitimate entity-update
 * path, and have the FIRST draft of the document chain resumed — no second
 * draft, no duplicate-gating against the chain's own rows, no fresh OCR.
 */
describe('IntakeWorkflowService missing supplier facts (issue #404)', () => {
  let db: Kysely<Database>;
  let module: Awaited<ReturnType<typeof boot>>;

  /** Narrow an intake result to its needs_triage arm (asserting on the way). */
  function expectHeld(
    result: Awaited<ReturnType<IntakeWorkflowService['process']>>,
  ) {
    expect(result.status).toBe('needs_triage');
    if (result.status !== 'needs_triage') throw new Error('expected hold');
    return result;
  }
  let entities: EntitiesService;
  let documents: DocumentsService;
  let workflow: IntakeWorkflowService;

  let transcriberCalls: number;
  let classifyCalls: number;
  let proposal: TriageResult;
  let dataTemp: string;

  function sampleProposal(
    supplierId: number,
    country: 'DK' | 'US',
    overrides: Partial<TriageResult> = {},
  ): TriageResult {
    return {
      kind: 'new_expense',
      document_type: 'invoice',
      gross_amount: 10000,
      vat_amount: 0,
      currency: 'EUR',
      tax_point_date: '2026-10-02',
      category: 'software',
      document_vat_marking: null,
      supplier_invoice_number: `ROOT404-${country}`,
      confidence: 1,
      outgoing_signals: {
        org_name_is_issuer: false,
        org_vat_is_issuer: false,
        has_buyer_block: false,
        self_identifies_as_invoice: true,
      },
      supplier_proposal: { mode: 'match', match_entity_id: supplierId },
      ...overrides,
    };
  }

  async function boot() {
    dataTemp = await mkdtemp('/tmp/hbk-404-spec-');
    process.env.DATA_DIR = dataTemp;
    const raw = new SqliteDb(':memory:');
    raw.pragma('foreign_keys = ON');
    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: raw }),
    });
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: async () => migrations },
    }).migrateToLatest();
    if (error) throw error;

    const mod = await Test.createTestingModule({
      providers: [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        OrganizationService,
        OrgContextResolver,
        PluginLoader,
        NullCountryPlugin,
        EstoniaCountryPlugin,
        CurrencyService,
        AccountService,
        LedgerValidationService,
        PostingService,
        StatusTransitionService,
        PeriodLockService,
        RulesService,
        PolicyService,
        PostingPipelineService,
        ExpensesService,
        VoucherProjectionService,
        EntitiesService,
        AgentConfigService,
        CategoryService,
        AuditLogService,
        ProposeDraftService,
        IntakeWorkflowService,
        AuditFindingsService,
        DocumentsService,
        DocumentStorageService,
        ProcessingGate,
        OcrService,
        ...fxTestProviders(),
        { provide: SalesInvoicesService, useValue: {} },
        { provide: PreviewRenderer, useValue: { render: async () => null } },
        { provide: BankIngestionService, useValue: {} },
        {
          provide: Pass2AgentService,
          useValue: {
            classify: async () => {
              classifyCalls++;
              return { ok: true, result: proposal };
            },
          },
        },
        {
          provide: DocumentTranscriber,
          useValue: {
            transcribe: async () => {
              transcriberCalls++;
              return {
                ok: true,
                markdown: 'Business invoice 404 fixture 100 EUR',
              };
            },
          },
        },
      ],
    }).compile();
    return mod;
  }

  beforeEach(async () => {
    transcriberCalls = 0;
    classifyCalls = 0;
    module = await boot();
    entities = module.get(EntitiesService);
    documents = module.get(DocumentsService);
    workflow = module.get(IntakeWorkflowService);
    await module
      .get(OrganizationService)
      .updateOrganization({ country: 'EE', vat_registered: true });
  });

  afterEach(async () => {
    await module.close();
    await db.destroy();
    await rm(dataTemp, { recursive: true, force: true });
  });

  function expensesService() {
    return module.get(ExpensesService);
  }

  async function draftRows(documentId: number) {
    return db
      .selectFrom('expense')
      .select(['id', 'status', 'gross_amount', 'supplier_invoice_number'])
      .where('document_id', '=', documentId)
      .orderBy('id', 'asc')
      .execute();
  }

  // Both variants of the one missing-entity-fact family: an EU supplier
  // missing its tax status, and a US supplier missing goods-vs-services.
  const variants = [
    {
      country: 'DK' as const,
      eu: true,
      missingFact: 'taxStatus' as const,
      reasonPattern: /tax status/i,
    },
    {
      country: 'US' as const,
      eu: false,
      missingFact: 'goodsVsServices' as const,
      reasonPattern: /goods or services|goods.*services/i,
    },
  ];

  for (const variant of variants) {
    describe(`${variant.country} supplier missing ${variant.missingFact}`, () => {
      let supplierId: number;
      let documentId: number;

      beforeEach(async () => {
        supplierId = (
          await entities.onboard({
            role: 'supplier',
            country: variant.country,
            name: `Root404 ${variant.country}`,
            registrationKey: `${variant.country}ROOT404`,
            ...(variant.eu
              ? { goodsVsServices: 'services' as const }
              : { taxStatus: 'taxable_business' as const }),
          })
        ).id;
        const { document } = await documents.upload({
          buffer: Buffer.from(`invoice404 ${variant.country}`),
          filename: `invoice404-${variant.country}.pdf`,
          mimeType: 'application/pdf',
          channel: 'upload',
          sourceIdentifier: null,
        });
        documentId = document.id;
        proposal = sampleProposal(supplierId, variant.country);
      });

      it('holds on the missing fact with a first draft minted, not a fault', async () => {
        const first = await workflow.process(documentId);
        expect(first.status).toBe('needs_triage');
        expect(expectHeld(first).reason).toMatch(variant.reasonPattern);
        const rows = await draftRows(documentId);
        expect(rows).toHaveLength(1);
        expect(transcriberCalls).toBe(1);
      });

      it('exposes the matched supplier and the missing fact as typed API data (not a 404)', async () => {
        await workflow.process(documentId);
        const view = await workflow.getPendingDraft(documentId);
        expect(view.kind).toBe('missing_entity_fact');
        if (view.kind !== 'missing_entity_fact') return;
        expect(view.fact).toBe(variant.missingFact);
        expect(view.supplier.id).toBe(supplierId);
        expect(view.supplier.name).toBe(`Root404 ${variant.country}`);
        expect(view.supplier.country).toBe(variant.country);
        expect(view.draft.gross_amount).toBe(10000);
        // The view is a read: no fresh OCR to see the held document.
        expect(transcriberCalls).toBe(1);
      });

      it('retries without minting a second draft or duplicate-gating against its own chain, and without fresh OCR', async () => {
        await workflow.process(documentId);
        const firstId = (await draftRows(documentId))[0].id;
        await documents.reprocessDocument(documentId);
        const retried = await workflow.process(documentId);
        expect(retried.status).toBe('needs_triage');
        const held = expectHeld(retried);
        expect(held.reason).not.toMatch(/possible duplicate/i);
        expect(held.reason).toMatch(variant.reasonPattern);
        expect((await draftRows(documentId)).map((r) => r.id)).toEqual([
          firstId,
        ]);
        expect(transcriberCalls).toBe(1);
      });

      it('applies a fresh valid classification to the FIRST draft on retry (no second row)', async () => {
        await workflow.process(documentId);
        const firstId = (await draftRows(documentId))[0].id;
        proposal = sampleProposal(supplierId, variant.country, {
          gross_amount: 10001,
          supplier_invoice_number: `ROOT404-${variant.country}-reclassified`,
        });
        await documents.reprocessDocument(documentId);
        const retried = await workflow.process(documentId);
        expect(retried.status).toBe('needs_triage');
        expect(expectHeld(retried).reason).toMatch(variant.reasonPattern);
        const rows = await draftRows(documentId);
        expect(rows.map((r) => r.id)).toEqual([firstId]);
        expect(rows[0].gross_amount).toBe(10001);
        expect(rows[0].supplier_invoice_number).toBe(
          `ROOT404-${variant.country}-reclassified`,
        );
      });

      it('confirms the fact in one interaction: fact recorded, first draft resumed and proceeds, no fresh OCR', async () => {
        await workflow.process(documentId);
        const firstId = (await draftRows(documentId))[0].id;
        const confirmed = await workflow.confirmEntityFact(
          documentId,
          supplierId,
          variant.missingFact,
          variant.eu ? 'taxable_business' : 'services',
        );
        expect(confirmed.fact_saved).toBe(true);
        expect(confirmed.outcome.status).not.toBe('needs_triage');
        const entity = await entities.findById(supplierId);
        if (variant.eu) expect(entity.tax_status).toBe('taxable_business');
        else expect(entity.goods_vs_services).toBe('services');
        const rows = await draftRows(documentId);
        expect(rows.map((r) => r.id)).toEqual([firstId]);
        // Classification re-ran from the PERSISTED OCR artifact (ADR-0039).
        expect(transcriberCalls).toBe(1);
      });

      it('confirm is idempotent: a repeated confirmation replays the resolved draft', async () => {
        await workflow.process(documentId);
        const firstId = (await draftRows(documentId))[0].id;
        const value = variant.eu ? 'taxable_business' : 'services';
        await workflow.confirmEntityFact(
          documentId,
          supplierId,
          variant.missingFact,
          value,
        );
        const again = await workflow.confirmEntityFact(
          documentId,
          supplierId,
          variant.missingFact,
          value,
        );
        expect(again.fact_saved).toBe(true);
        expect(again.outcome.status).not.toBe('needs_triage');
        expect((await draftRows(documentId)).map((r) => r.id)).toEqual([
          firstId,
        ]);
        expect(transcriberCalls).toBe(1);
      });

      it('rejects a value that is not a legitimate fact choice', async () => {
        await workflow.process(documentId);
        await expect(
          workflow.confirmEntityFact(
            documentId,
            supplierId,
            variant.missingFact,
            'not-a-fact',
          ),
        ).rejects.toThrow(/valid/i);
      });

      it('still duplicate-gates a GENUINE vendor resend (a different document)', async () => {
        await workflow.process(documentId);
        await workflow.confirmEntityFact(
          documentId,
          supplierId,
          variant.missingFact,
          variant.eu ? 'taxable_business' : 'services',
        );
        const { document: resend } = await documents.upload({
          buffer: Buffer.from(`resend404 ${variant.country}`),
          filename: `resend404-${variant.country}.pdf`,
          mimeType: 'application/pdf',
          channel: 'upload',
          sourceIdentifier: null,
        });
        proposal = sampleProposal(supplierId, variant.country);
        const duplicate = await workflow.process(resend.id);
        expect(duplicate.status).toBe('needs_triage');
        expect(expectHeld(duplicate).reason).toMatch(/possible duplicate/i);
      });
    });
  }

  describe('protected chains and partial-save truths (issue #404)', () => {
    async function seedExtraChainRow(
      documentId: number,
      supplierId: number,
      manual: boolean,
    ): Promise<number> {
      const row = await db
        .insertInto('expense')
        .values({
          document_id: documentId,
          supplier_id: supplierId,
          category: 'software',
          gross_amount: 10000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-10-02',
          document_vat_marking: null,
          supplier_invoice_number: 'ROOT404-OLD-RETRY',
          claimant_id: null,
          company_addressed_receipt: null,
          ai_confidence: manual ? null : 1,
          ai_document_type: manual ? null : 'invoice',
          ai_kind: manual ? null : 'new_expense',
          status: 'draft',
          voucher_id: null,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    }

    async function seedHeldChain(mode: 'first-posted' | 'later-posted') {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Protected404',
        registrationKey: 'DKROOT404PROTECTED',
        goodsVsServices: 'services',
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('protected404'),
        filename: 'protected404.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplier.id, 'DK');
      const first = await workflow.process(document.id);
      expect(first.status).toBe('needs_triage');
      const originalId = (await draftRows(document.id))[0].id;
      // The pre-fix extra row; in 'later-posted' mode it is a MANUAL operator
      // row (no AI provenance) — the whole-chain guard must inspect it too.
      const extraId = await seedExtraChainRow(
        document.id,
        supplier.id,
        mode === 'later-posted',
      );
      await entities.update(supplier.id, { taxStatus: 'taxable_business' });
      // Auto-post enabled so the NORMAL operator path posts outright — the
      // production shape this locks: a direct posting that leaves the
      // document's hold stale.
      await module.get(PolicyService).updateConfig({ auto_post_enabled: true });
      // Post through the NORMAL operator path (controller + kernel), which
      // leaves the document's hold stale — the production shape.
      const controller = new ExpensesController(
        module.get(ExpensesService),
        module.get(PostingPipelineService),
        {
          registerFromVoucher: async () => undefined,
        } as unknown as FixedAssetRegistrarService,
      );
      const postedId = mode === 'first-posted' ? originalId : extraId;
      await controller.postExpense(String(postedId));
      expect(
        (await module.get(ExpensesService).getExpenseById(postedId)).status,
      ).toBe('posted');
      expect((await documents.getById(document.id)).status).toBe(
        'needs_triage',
      );
      return {
        documentId: document.id,
        supplierId: supplier.id,
        postedId,
        otherId: mode === 'first-posted' ? extraId : originalId,
      };
    }

    it.each(['first-posted', 'later-posted'] as const)(
      'a retry after some chain row was posted replays the ACTUAL protected record and never posts a replacement (%s)',
      async (mode) => {
        const { documentId, supplierId, postedId, otherId } =
          await seedHeldChain(mode);
        const vouchersBefore = (
          await db.selectFrom('voucher').select('id').execute()
        ).length;
        expect(vouchersBefore).toBe(1);

        // A VARIED classification on retry must not matter: the chain's
        // actual booked state stands — no replacement, no second voucher.
        proposal = sampleProposal(supplierId, 'DK', {
          gross_amount: 10001,
          supplier_invoice_number: 'ROOT404-PROTECTED-RECLASSIFIED',
        });
        await documents.reprocessDocument(documentId);
        const retried = await workflow.process(documentId);
        expect(retried.status).toBe('draft_proposed');
        if (retried.status === 'draft_proposed') {
          expect(retried.draft.expenseId).toBe(postedId);
        }
        const rows = await db
          .selectFrom('expense')
          .select(['id', 'status'])
          .where('document_id', '=', documentId)
          .orderBy('id', 'asc')
          .execute();
        expect(rows.map((r) => r.id)).toEqual([postedId, otherId].sort());
        expect(
          (await db.selectFrom('voucher').select('id').execute()).length,
        ).toBe(vouchersBefore);
        expect(
          (await module.get(ExpensesService).getExpenseById(otherId)).status,
        ).toBe('draft');
      },
    );

    it('preserves the KNOWN saved fact when the resume fails after it (operation result vs current state)', async () => {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Partial404',
        registrationKey: 'DKROOT404PARTIAL',
        goodsVsServices: 'services',
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('partial404'),
        filename: 'partial404.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplier.id, 'DK', {
        supplier_invoice_number: 'ROOT404-PARTIAL',
      });
      await workflow.process(document.id);

      // The resume fails AFTER the fact was persisted (an injected
      // requeue/storage fault): the receipt must still carry the saved fact.
      const reprocess = jest
        .spyOn(documents, 'reprocessDocument')
        .mockRejectedValue(new Error('injected requeue storage failure'));

      const result = await workflow.confirmEntityFact(
        document.id,
        supplier.id,
        'taxStatus',
        'taxable_business',
      );
      expect(result.fact_saved).toBe(true);
      expect(result.outcome.status).toBe('needs_triage');
      if (result.outcome.status === 'needs_triage') {
        expect(result.outcome.reason).toMatch(/fact was saved/i);
        expect(result.outcome.reason).toMatch(/failed/i);
      }
      const entity = await entities.findById(supplier.id);
      expect(entity.tax_status).toBe('taxable_business');
      expect(
        (await db.selectFrom('voucher').select('id').execute()).length,
      ).toBe(0);
      reprocess.mockRestore();
    });

    it('a repeated confirmation after the next genuine gate acknowledges the saved fact and re-surfaces the current hold', async () => {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Nontaxable404',
        registrationKey: 'DKROOT404NONTAX',
        goodsVsServices: 'services',
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('nontaxable404'),
        filename: 'nontaxable404.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplier.id, 'DK');
      await workflow.process(document.id);
      const firstId = (await draftRows(document.id))[0].id;

      // non_taxable: the kernel parks on the honest unsupported-treatment
      // gate — a GENUINE next gate, not a missing fact.
      const confirmed = await workflow.confirmEntityFact(
        document.id,
        supplier.id,
        'taxStatus',
        'non_taxable',
      );
      expect(confirmed.fact_saved).toBe(true);
      expect(confirmed.outcome.status).toBe('needs_triage');
      if (confirmed.outcome.status === 'needs_triage') {
        expect(confirmed.outcome.reason).toMatch(/non.taxable/i);
      }

      // Repeating the SAME confirmation: the recorded fact is acknowledged,
      // the current genuine hold is re-surfaced, nothing new is minted.
      const repeated = await workflow.confirmEntityFact(
        document.id,
        supplier.id,
        'taxStatus',
        'non_taxable',
      );
      expect(repeated.fact_saved).toBe(true);
      expect(repeated.outcome.status).toBe('needs_triage');
      if (repeated.outcome.status === 'needs_triage') {
        expect(repeated.outcome.reason).toMatch(/non.taxable/i);
      }
      expect((await draftRows(document.id)).map((r) => r.id)).toEqual([
        firstId,
      ]);
    });
  });

  describe('review follow-ups: stale supplier identity and strict persisted evidence', () => {
    async function artifactRow(documentId: number) {
      return db
        .selectFrom('artifact')
        .select(['id', 'storage_path', 'crc32'])
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', documentId)
        .executeTakeFirstOrThrow();
    }

    it('rejects a confirmation made against a STALE supplier view before anything changes', async () => {
      const supplierA = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Stale view A',
        registrationKey: 'DKROOT404STALEA',
        goodsVsServices: 'services',
      });
      const supplierB = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Stale view B',
        registrationKey: 'DKROOT404STALEB',
        goodsVsServices: 'services',
        // B's tax status deliberately unrecorded — the fact the operator is
        // about to confirm — so a leaked write would be observable.
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('stale404'),
        filename: 'stale404.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplierA.id, 'DK');
      await workflow.process(document.id);
      const firstId = (await draftRows(document.id))[0].id;

      // The operator SAW supplier A (the typed view's supplier)… a
      // legitimate draft edit then moves the chain to supplier B.
      const view = await workflow.getPendingDraft(document.id);
      expect(view.kind).toBe('missing_entity_fact');
      if (view.kind !== 'missing_entity_fact') return;
      expect(view.supplier.id).toBe(supplierA.id);
      await expensesService().updateDraft(firstId, {
        supplier_id: supplierB.id,
      });

      // …and confirms with the STALE identity: rejected honestly, with
      // NOTHING changed — no entity write, no OCR, no classification, no
      // new draft, no post.
      const beforeProvider = transcriberCalls;
      const beforeClassify = classifyCalls;
      await expect(
        workflow.confirmEntityFact(
          document.id,
          supplierA.id,
          'taxStatus',
          'taxable_business',
        ),
      ).rejects.toThrow(/changed since it was shown/i);
      expect((await entities.findById(supplierA.id)).tax_status).toBeNull();
      expect((await entities.findById(supplierB.id)).tax_status).toBeNull();
      expect(transcriberCalls).toBe(beforeProvider);
      expect(classifyCalls).toBe(beforeClassify);
      expect((await draftRows(document.id)).map((r) => r.id)).toEqual([
        firstId,
      ]);
      expect(
        (await db.selectFrom('voucher').select('id').execute()).length,
      ).toBe(0);
    });

    it('parks honestly (fact saved, nothing booked) when the persisted OCR artifact ROW is gone — no fresh provider call', async () => {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Missing404',
        registrationKey: 'DKROOT404MISSINGROW',
        goodsVsServices: 'services',
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('missing404'),
        filename: 'missing404.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplier.id, 'DK');
      await workflow.process(document.id);
      const firstId = (await draftRows(document.id))[0].id;
      expect((await workflow.getPendingDraft(document.id)).kind).toBe(
        'missing_entity_fact',
      );

      // The persisted evidence row disappears AFTER the hold + view.
      await db
        .deleteFrom('artifact')
        .where('kind', '=', 'ocr_markdown')
        .where('document_id', '=', document.id)
        .execute();

      const beforeProvider = transcriberCalls;
      const beforeClassify = classifyCalls;
      const result = await workflow.confirmEntityFact(
        document.id,
        supplier.id,
        'taxStatus',
        'taxable_business',
      );
      // The operation result stands; the processing is explicitly unconfirmed.
      expect(result.fact_saved).toBe(true);
      expect(result.outcome.status).toBe('needs_triage');
      if (result.outcome.status === 'needs_triage') {
        expect(result.outcome.reason).toMatch(/fact was saved/i);
        expect(result.outcome.reason).toMatch(/persisted OCR/i);
      }
      // No fresh OCR provider call, no classification, no overwrite, no
      // new draft, no voucher — and the entity fact IS recorded.
      expect(transcriberCalls).toBe(beforeProvider);
      expect(classifyCalls).toBe(beforeClassify);
      expect((await draftRows(document.id)).map((r) => r.id)).toEqual([
        firstId,
      ]);
      expect(
        (await db.selectFrom('voucher').select('id').execute()).length,
      ).toBe(0);
      expect((await entities.findById(supplier.id)).tax_status).toBe(
        'taxable_business',
      );
    });

    it('parks honestly (fact saved, nothing booked) when the persisted OCR file fails its CRC check — no overwrite, no fresh provider call', async () => {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Tamper404',
        registrationKey: 'DKROOT404TAMPER',
        goodsVsServices: 'services',
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('tamper404'),
        filename: 'tamper404.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplier.id, 'DK');
      await workflow.process(document.id);
      const firstId = (await draftRows(document.id))[0].id;
      const artifact = await artifactRow(document.id);

      // The persisted evidence is tampered on disk AFTER the hold + view.
      await writeFile(
        artifact.storage_path,
        (await readFile(artifact.storage_path, 'utf-8')) +
          '\ntampered after the hold',
        'utf-8',
      );

      const beforeProvider = transcriberCalls;
      const beforeClassify = classifyCalls;
      const result = await workflow.confirmEntityFact(
        document.id,
        supplier.id,
        'taxStatus',
        'taxable_business',
      );
      expect(result.fact_saved).toBe(true);
      expect(result.outcome.status).toBe('needs_triage');
      if (result.outcome.status === 'needs_triage') {
        expect(result.outcome.reason).toMatch(/fact was saved/i);
        expect(result.outcome.reason).toMatch(/persisted OCR/i);
      }
      // No fresh OCR, no classification, no voucher — and the stored evidence
      // is neither overwritten nor replaced: the tampered bytes and the
      // stored CRC row stand exactly as they were found.
      expect(transcriberCalls).toBe(beforeProvider);
      expect(classifyCalls).toBe(beforeClassify);
      expect((await draftRows(document.id)).map((r) => r.id)).toEqual([
        firstId,
      ]);
      expect(
        (await db.selectFrom('voucher').select('id').execute()).length,
      ).toBe(0);
      const after = await artifactRow(document.id);
      expect(after.crc32).toBe(artifact.crc32);
      expect(await readFile(artifact.storage_path, 'utf-8')).toContain(
        'tampered after the hold',
      );
      expect((await entities.findById(supplier.id)).tax_status).toBe(
        'taxable_business',
      );
    });

    it('still re-classifies from INTACT cached OCR and resumes the first draft on confirmation', async () => {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Intact404',
        registrationKey: 'DKROOT404INTACT',
        goodsVsServices: 'services',
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('intact404'),
        filename: 'intact404.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplier.id, 'DK');
      await workflow.process(document.id);
      const firstId = (await draftRows(document.id))[0].id;
      const beforeProvider = transcriberCalls;
      const beforeClassify = classifyCalls;

      const result = await workflow.confirmEntityFact(
        document.id,
        supplier.id,
        'taxStatus',
        'taxable_business',
      );
      expect(result.fact_saved).toBe(true);
      expect(result.outcome.status).not.toBe('needs_triage');
      // Re-classified from the persisted artifact — no fresh OCR.
      expect(transcriberCalls).toBe(beforeProvider);
      expect(classifyCalls).toBe(beforeClassify + 1);
      expect((await draftRows(document.id)).map((r) => r.id)).toEqual([
        firstId,
      ]);
    });
  });

  describe('already-affected production chains (legacy rows)', () => {
    it('resumes the first draft of a chain that already carries a pre-fix second draft', async () => {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Root404 DK legacy',
        registrationKey: 'DKROOT404LEGACY',
        goodsVsServices: 'services',
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('invoice404 DK legacy'),
        filename: 'invoice404-dk-legacy.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplier.id, 'DK');
      const first = await workflow.process(document.id);
      expect(first.status).toBe('needs_triage');
      const rows = await draftRows(document.id);
      expect(rows).toHaveLength(1);
      const firstId = rows[0].id;

      // Seed the pre-fix extra draft the production chain accumulated.
      const seeded = await db
        .insertInto('expense')
        .values({
          document_id: document.id,
          supplier_id: supplier.id,
          category: 'software',
          gross_amount: 10000,
          vat_amount: 0,
          currency: 'EUR',
          tax_point_date: '2026-10-02',
          document_vat_marking: null,
          supplier_invoice_number: 'ROOT404-DK-legacy-retry',
          claimant_id: null,
          company_addressed_receipt: null,
          ai_confidence: 1,
          ai_document_type: 'invoice',
          ai_kind: 'new_expense',
          status: 'draft',
          voucher_id: null,
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // A retry whose fresh classification carries the SECOND row's key: the
      // chain's own rows are the same purchase, never each other's duplicate.
      proposal = sampleProposal(supplier.id, 'DK', {
        supplier_invoice_number: 'ROOT404-DK-legacy-retry',
      });
      await documents.reprocessDocument(document.id);
      const retried = await workflow.process(document.id);
      const held = expectHeld(retried);
      expect(held.reason).toMatch(/tax status/i);

      const confirmed = await workflow.confirmEntityFact(
        document.id,
        supplier.id,
        'taxStatus',
        'taxable_business',
      );
      expect(confirmed.outcome.status).not.toBe('needs_triage');
      const after = await draftRows(document.id);
      expect(after.map((r) => r.id)).toEqual([firstId, seeded.id]);
      expect(after.find((r) => r.id === firstId)?.supplier_invoice_number).toBe(
        'ROOT404-DK-legacy-retry',
      );
    });

    it('serves a typed view and a working confirmation for an ALREADY-HELD pre-fix document with no new metadata (no fresh OCR)', async () => {
      const supplier = await entities.onboard({
        role: 'supplier',
        country: 'DK',
        name: 'Legacy matched DK',
        registrationKey: 'DKROOT404OLD',
        goodsVsServices: 'services',
      });
      const { document } = await documents.upload({
        buffer: Buffer.from('oldhold404 DK'),
        filename: 'oldhold404-dk.pdf',
        mimeType: 'application/pdf',
        channel: 'upload',
        sourceIdentifier: null,
      });
      proposal = sampleProposal(supplier.id, 'DK', {
        supplier_invoice_number: 'OLD404-DK',
      });
      // Persist the production-era artifacts (OCR artifact + classification
      // snapshot) but none of the new hold metadata; hold generically.
      await workflow.process(document.id);
      const draftId = (await draftRows(document.id))[0].id;
      await db
        .updateTable('audit_finding')
        .set({ reason_type: 'classification_failed' })
        .where('referenced_object_type', '=', 'document')
        .where('referenced_object_id', '=', document.id)
        .execute();

      const before = transcriberCalls;
      const view = await workflow.getPendingDraft(document.id);
      expect(view.kind).toBe('missing_entity_fact');
      expect(transcriberCalls).toBe(before);

      const confirmed = await workflow.confirmEntityFact(
        document.id,
        supplier.id,
        'taxStatus',
        'taxable_business',
      );
      expect(confirmed.fact_saved).toBe(true);
      expect(confirmed.outcome.status).not.toBe('needs_triage');
      expect((await draftRows(document.id)).map((r) => r.id)).toEqual([
        draftId,
      ]);
      expect(transcriberCalls).toBe(before);
    });
  });
});
