import { Test, TestingModule } from '@nestjs/testing';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import SqliteDb from 'better-sqlite3';
import { Database } from '../database/types';
import { migrations } from '../database/migrations';
import { IntakeWorkflowService } from './intake-workflow.service';
import { OcrService } from '../triage/ocr.service';
import { Pass2AgentService } from './pass2-agent.service';
import { ProposeDraftService } from './propose-draft.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { PolicyService } from '../policy/policy.service';
import { TriageResult } from '../triage/types';

describe('IntakeWorkflowService', () => {
  let db: Kysely<Database>;
  let service: IntakeWorkflowService;
  let auditFindingsService: AuditFindingsService;

  // Mocks for external dependencies.
  const mockOcrService = {
    transcribe: jest.fn(),
  };

  const mockPass2Agent = {
    classify: jest.fn(),
  };

  const mockProposeDraft = {
    proposeDraft: jest.fn(),
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
    confidence: 0.94,
    ...overrides,
  });

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
        IntakeWorkflowService,
      ],
    }).compile();

    service = module.get(IntakeWorkflowService);
    auditFindingsService = module.get(AuditFindingsService);

    // Reset mocks.
    mockOcrService.transcribe.mockReset();
    mockPass2Agent.classify.mockReset();
    mockProposeDraft.proposeDraft.mockReset();

    // Default: OCR returns markdown.
    mockOcrService.transcribe.mockResolvedValue(
      '# Receipt\nSupplier: Test\nAmount: €15.25',
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('process', () => {
    it('creates a draft for confident new_expense (confidence >= threshold)', async () => {
      const triageResult = sampleTriageResult({ confidence: 0.94 });
      mockPass2Agent.classify.mockResolvedValue(triageResult);
      mockProposeDraft.proposeDraft.mockResolvedValue({
        expenseId: 42,
        pipelineResult: {
          businessObject: { id: 42, status: 'posted' },
          voucher: null,
          policy: { action: 'auto-post', reason: 'All rules passed' },
        },
      });

      const result = await service.process(1);

      expect(result.status).toBe('draft_proposed');
      if (result.status === 'draft_proposed') {
        expect(result.draft.expenseId).toBe(42);
      }
      expect(mockProposeDraft.proposeDraft).toHaveBeenCalledWith(
        triageResult,
        1,
      );

      // No AuditFinding should be created.
      const findings = await auditFindingsService.list();
      expect(findings).toHaveLength(0);
    });

    it('creates AuditFinding for uncertain new_expense (confidence < threshold)', async () => {
      const triageResult = sampleTriageResult({ confidence: 0.5 });
      mockPass2Agent.classify.mockResolvedValue(triageResult);

      const result = await service.process(1);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toContain('below threshold');
        expect(result.finding.finding_type).toBe('needs_triage');
        expect(result.finding.referenced_object_type).toBe('document');
        expect(result.finding.referenced_object_id).toBe(1);
      }

      // No draft should be proposed.
      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('creates AuditFinding for unknown kind', async () => {
      const triageResult = sampleTriageResult({
        kind: 'unknown',
        confidence: 0.3,
      });
      mockPass2Agent.classify.mockResolvedValue(triageResult);

      const result = await service.process(1);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toContain('could not classify');
        expect(result.finding.finding_type).toBe('needs_triage');
      }

      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('creates AuditFinding when classify returns null (agent failure)', async () => {
      mockPass2Agent.classify.mockResolvedValue(null);

      const result = await service.process(1);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toContain('failed after max retries');
        expect(result.finding.finding_type).toBe('needs_triage');
      }

      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('creates AuditFinding for correction kind (stub)', async () => {
      const triageResult = sampleTriageResult({
        kind: 'correction',
        confidence: 0.95,
      });
      mockPass2Agent.classify.mockResolvedValue(triageResult);

      const result = await service.process(1);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toContain('Correction');
        expect(result.finding.finding_type).toBe('needs_triage');
      }

      // Even with high confidence, correction is stubbed to needs_triage.
      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('creates AuditFinding for duplicate kind (stub)', async () => {
      const triageResult = sampleTriageResult({
        kind: 'duplicate',
        confidence: 0.99,
      });
      mockPass2Agent.classify.mockResolvedValue(triageResult);

      const result = await service.process(1);

      expect(result.status).toBe('needs_triage');
      if (result.status === 'needs_triage') {
        expect(result.reason).toContain('Duplicate');
        expect(result.finding.finding_type).toBe('needs_triage');
      }

      expect(mockProposeDraft.proposeDraft).not.toHaveBeenCalled();
    });

    it('calls OCR transcribe with the correct documentId', async () => {
      mockPass2Agent.classify.mockResolvedValue(
        sampleTriageResult({ confidence: 0.9 }),
      );

      await service.process(7);

      expect(mockOcrService.transcribe).toHaveBeenCalledWith(7);
    });

    it('calls classify with the markdown returned by OCR', async () => {
      const markdown = '# Test Invoice\nSupplier: Acme\nAmount: €100';
      mockOcrService.transcribe.mockResolvedValue(markdown);
      mockPass2Agent.classify.mockResolvedValue(
        sampleTriageResult({ confidence: 0.9 }),
      );

      await service.process(1);

      expect(mockPass2Agent.classify).toHaveBeenCalledWith(markdown);
    });
  });
});
