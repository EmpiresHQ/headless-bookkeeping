import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import {
  IntakeWorkflowService,
  unimplementedKindReason,
} from './intake-workflow.service';
import { OcrService } from '../triage/ocr.service';
import { Pass2AgentService } from './pass2-agent.service';
import { ProposeDraftService } from './propose-draft.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { PolicyService } from '../policy/policy.service';
import { DocumentsService } from '../documents/documents.service';
import { DocumentStorageService } from '../documents/document-storage.service';
import { TriageResult } from '../triage/types';

describe('IntakeWorkflowService', () => {
  let db: Kysely<Database>;
  let service: IntakeWorkflowService;
  let auditFindingsService: AuditFindingsService;
  let documentsService: DocumentsService;

  // Mocks for external dependencies.
  const mockOcrService = {
    transcribe: jest.fn(),
  };

  const mockPass2Agent = {
    classify: jest.fn(),
  };

  const mockProposeDraft = {
    proposeDraft: jest.fn(),
    findExistingDraft: jest.fn(),
  };

  const sampleTriageResult = (
    overrides: Partial<TriageResult> = {},
  ): TriageResult => ({
    kind: 'new_expense',
    document_type: 'receipt',
    gross_amount: 1525,
    vat_amount: 285,
    currency: 'EUR',
    tax_point_date: '2026-03-15',
    category: 'transport',
    document_vat_marking: '23%',
    supplier_invoice_number: null,
    confidence: 0.94,
    ...overrides,
  });

  // Seed a pending Document and return its id.
  async function seedDocument(filename = 'receipt.pdf'): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const doc = await db
      .insertInto('document')
      .values({
        hash: `hash-${filename}-${Math.random()}`,
        filename,
        mime_type: 'application/pdf',
        size_bytes: 1000,
        storage_path: `/tmp/${filename}`,
        status: 'pending',
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return doc.id;
  }

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
        { provide: OcrService, useValue: mockOcrService },
        { provide: Pass2AgentService, useValue: mockPass2Agent },
        { provide: ProposeDraftService, useValue: mockProposeDraft },
        AuditFindingsService,
        PolicyService,
        DocumentsService,
        DocumentStorageService,
        IntakeWorkflowService,
      ],
    }).compile();

    service = module.get(IntakeWorkflowService);
    auditFindingsService = module.get(AuditFindingsService);
    documentsService = module.get(DocumentsService);

    // Reset mocks.
    mockOcrService.transcribe.mockReset();
    mockPass2Agent.classify.mockReset();
    mockProposeDraft.proposeDraft.mockReset();
    mockProposeDraft.findExistingDraft.mockReset();

    // Defaults.
    mockOcrService.transcribe.mockResolvedValue({
      ok: true,
      markdown: '# Receipt\nSupplier: Test\nAmount: €15.25',
    });
    mockProposeDraft.findExistingDraft.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('process — routing', () => {
    it('creates a draft for confident new_expense (confidence >= threshold)', async () => {
      const docId = await seedDocument();
      const triageResult = sampleTriageResult({ confidence: 0.94 });
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: triageResult,
      });
      mockProposeDraft.proposeDraft.mockResolvedValue({
        outcome: 'draft',
        expenseId: 42,
        pipelineResult: {
          businessObject: { id: 42, status: 'posted' },
          voucher: null,
          policy: { action: 'auto-post', reason: 'All rules passed' },
        },
      });

      const result = await service.process(docId);

      expect(result.status).toBe('draft_proposed');
      if (result.status === 'draft_proposed') {
        expect(result.draft.expenseId).toBe(42);
      }
      expect(mockProposeDraft.proposeDraft).toHaveBeenCalledWith(
        triageResult,
        docId,
      );

      // No AuditFinding should be created.
      const findings = await auditFindingsService.list();
      expect(findings).toHaveLength(0);

      // The workflow owns the status transition: pending -> triaged.
      const doc = await documentsService.getById(docId);
      expect(doc.status).toBe('triaged');
    });

    it('creates AuditFinding for uncertain new_expense (confidence < threshold)', async () => {
      const docId = await seedDocument();
      const triageResult = sampleTriageResult({ confidence: 0.5 });
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: triageResult,
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toContain('below threshold');
        expect(result.finding.finding_type).toBe('needs_triage');
        expect(result.finding.referenced_object_type).toBe('document');
        expect(result.finding.referenced_object_id).toBe(docId);
      }

      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();

      // The workflow owns the status transition: pending -> needs_triage.
      const doc = await documentsService.getById(docId);
      expect(doc.status).toBe('needs_triage');
    });

    it('creates AuditFinding for unknown kind', async () => {
      const docId = await seedDocument();
      const triageResult = sampleTriageResult({
        kind: 'unknown',
        confidence: 0.3,
      });
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: triageResult,
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toContain('could not classify');
        expect(result.finding.finding_type).toBe('needs_triage');
      }

      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('routes correction kind to needs_triage with an explicit unimplemented-kind reason', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: sampleTriageResult({ kind: 'correction', confidence: 0.95 }),
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        // The reason marks this as a not-yet-implemented kind — distinct from a
        // low-confidence new_expense or a genuinely-unknown classification.
        expect(result.reason).toBe(unimplementedKindReason('correction'));
        expect(result.reason).toContain('not yet implemented');
        expect(result.reason).toContain("'correction'");
        // High confidence: it is NOT a low-confidence route.
        expect(result.reason).not.toContain('below threshold');
        // No failure: it was a valid, confident classification.
        expect(result.failure).toBeUndefined();
      }
      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('routes duplicate kind to needs_triage with an explicit unimplemented-kind reason', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: sampleTriageResult({ kind: 'duplicate', confidence: 0.99 }),
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toBe(unimplementedKindReason('duplicate'));
        expect(result.reason).toContain('not yet implemented');
        expect(result.reason).toContain("'duplicate'");
        expect(result.reason).not.toContain('could not classify');
      }
      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('routes a create supplier_proposal to needs_triage (supplier-unresolved, Task 43)', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: sampleTriageResult({
          kind: 'new_expense',
          confidence: 0.97,
          supplier_proposal: {
            mode: 'create',
            create_name: 'Fresh Supplier Ltd',
            create_country: 'IE',
          },
        }),
      });
      // proposeDraft performs the explicit resolution and reports the create
      // proposal as unresolved (no draft).
      mockProposeDraft.proposeDraft.mockResolvedValue({
        outcome: 'supplier-unresolved',
        reason: 'supplier creation not yet implemented (Task 43)',
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toContain(
          'supplier creation not yet implemented',
        );
      }
      // proposeDraft WAS consulted (it owns the resolution) but produced no draft.
      expect(mockProposeDraft.proposeDraft).toHaveBeenCalledTimes(1);

      // The Document still moves to needs_triage — not triaged (no draft).
      const doc = await documentsService.getById(docId);
      expect(doc.status).toBe('needs_triage');
    });

    it('calls OCR transcribe with the correct documentId', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: sampleTriageResult({ confidence: 0.9 }),
      });
      mockProposeDraft.proposeDraft.mockResolvedValue({
        outcome: 'draft',
        expenseId: 1,
        pipelineResult: { replayed: true },
      });

      await service.process(docId);

      expect(mockOcrService.transcribe).toHaveBeenCalledWith(docId);
    });

    it('calls classify with the markdown returned by OCR', async () => {
      const docId = await seedDocument();
      const markdown = '# Test Invoice\nSupplier: Acme\nAmount: €100';
      mockOcrService.transcribe.mockResolvedValue({ ok: true, markdown });
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: sampleTriageResult({ confidence: 0.9 }),
      });
      mockProposeDraft.proposeDraft.mockResolvedValue({
        outcome: 'draft',
        expenseId: 1,
        pipelineResult: { replayed: true },
      });

      await service.process(docId);

      expect(mockPass2Agent.classify).toHaveBeenCalledWith(markdown);
    });
  });

  // ── (c) Pass-2 failure category surfaced ──────────────────────
  describe('process — Pass-2 failure category', () => {
    it('routes needs_triage and surfaces agent-unavailable', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: false,
        category: 'agent-unavailable',
        detail: 'Mastra agent not initialized',
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.failure).toEqual({
          pass: 'classify',
          category: 'agent-unavailable',
        });
        expect(result.reason).toContain('agent-unavailable');
        expect(result.finding.finding_type).toBe('needs_triage');
      }
      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('routes needs_triage and surfaces invalid-output', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: false,
        category: 'invalid-output',
        detail: 'schema parse failed',
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.failure).toEqual({
          pass: 'classify',
          category: 'invalid-output',
        });
      }
    });

    it('routes needs_triage and surfaces transient', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: false,
        category: 'transient',
        detail: 'LLM timeout',
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.failure).toEqual({
          pass: 'classify',
          category: 'transient',
        });
      }
      // The Document still moves to needs_triage (durable wait, ADR-0024).
      const doc = await documentsService.getById(docId);
      expect(doc.status).toBe('needs_triage');
    });
  });

  // ── (c') Pass-1 (OCR) failure routes through the SAME seam ────
  describe('process — Pass-1 (OCR) failure', () => {
    it('routes needs_triage with a pass=ocr failure and never calls classify', async () => {
      const docId = await seedDocument();
      mockOcrService.transcribe.mockResolvedValue({
        ok: false,
        category: 'transient',
        detail: 'stored artifact file is missing',
      });

      const result = await service.process(docId);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.failure).toEqual({ pass: 'ocr', category: 'transient' });
        expect(result.reason).toContain('transient');
        expect(result.finding.finding_type).toBe('needs_triage');
      }
      // Pass 2 must NOT run when Pass 1 failed — the failure short-circuits.
      expect(mockPass2Agent.classify).not.toHaveBeenCalled();
      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();

      // The Document still moves to needs_triage (durable wait, ADR-0024).
      const doc = await documentsService.getById(docId);
      expect(doc.status).toBe('needs_triage');
    });
  });

  // ── (a)+(b) Idempotent re-run owned by the workflow ───────────
  describe('process — idempotency', () => {
    it('re-running a needs_triage Document does NOT double-create the finding', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: false,
        category: 'invalid-output',
        detail: 'bad output',
      });

      const first = await service.process(docId);
      expect(first.status).toBe('needs_triage');

      // Re-run (e.g. a retry after a crash). OCR/Pass2 should NOT be re-invoked
      // because the Document already routed.
      mockOcrService.transcribe.mockClear();
      mockPass2Agent.classify.mockClear();

      const second = await service.process(docId);
      expect(second.status).toBe('needs_triage');

      // Exactly ONE needs_triage finding for this document.
      const findings = await auditFindingsService.findOpenByReference(
        'needs_triage',
        'document',
        docId,
      );
      expect(findings).toBeDefined();
      const all = await auditFindingsService.list();
      const forDoc = all.filter(
        (f) =>
          f.referenced_object_type === 'document' &&
          f.referenced_object_id === docId &&
          f.finding_type === 'needs_triage',
      );
      expect(forDoc).toHaveLength(1);

      // The replay short-circuits before OCR/Pass2.
      expect(mockOcrService.transcribe).not.toHaveBeenCalled();
      expect(mockPass2Agent.classify).not.toHaveBeenCalled();

      if (first.status === 'needs_triage' && second.status === 'needs_triage') {
        expect(second.finding.id).toBe(first.finding.id);
      }
    });

    it('re-running a triaged Document does NOT create a second draft', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: true,
        result: sampleTriageResult({ confidence: 0.94 }),
      });
      mockProposeDraft.proposeDraft.mockResolvedValue({
        outcome: 'draft',
        expenseId: 77,
        pipelineResult: {
          businessObject: { id: 77, status: 'posted' },
          voucher: null,
          policy: { action: 'auto-post', reason: 'ok' },
        },
      });

      const first = await service.process(docId);
      expect(first.status).toBe('draft_proposed');
      expect(mockProposeDraft.proposeDraft).toHaveBeenCalledTimes(1);

      // The Document is now 'triaged'; a replay should surface the existing
      // draft via findExistingDraft, NOT call proposeDraft again.
      mockProposeDraft.findExistingDraft.mockResolvedValue({
        outcome: 'draft',
        expenseId: 77,
        pipelineResult: { replayed: true },
      });
      mockOcrService.transcribe.mockClear();

      const second = await service.process(docId);
      expect(second.status).toBe('draft_proposed');
      if (second.status === 'draft_proposed') {
        expect(second.draft.expenseId).toBe(77);
      }

      // proposeDraft was NOT called a second time (no duplicate pipeline run).
      expect(mockProposeDraft.proposeDraft).toHaveBeenCalledTimes(1);
      // OCR/Pass2 were skipped on the replay.
      expect(mockOcrService.transcribe).not.toHaveBeenCalled();
    });

    it('Document status transition is a guarded no-op on a routed Document', async () => {
      const docId = await seedDocument();
      mockPass2Agent.classify.mockResolvedValue({
        ok: false,
        category: 'transient',
        detail: 'x',
      });

      await service.process(docId);
      const afterFirst = await documentsService.getById(docId);
      expect(afterFirst.status).toBe('needs_triage');

      // Re-run is a safe no-op; status stays needs_triage.
      await service.process(docId);
      const afterSecond = await documentsService.getById(docId);
      expect(afterSecond.status).toBe('needs_triage');
    });
  });
});
