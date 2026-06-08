import { Injectable, Logger } from '@nestjs/common';
import { OcrService } from '../triage/ocr.service';
import { Pass2AgentService } from './pass2-agent.service';
import { ProposeDraftService, ProposeDraftResult } from './propose-draft.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { PolicyService } from '../policy/policy.service';
import { AuditFinding } from '../audit-findings/types';

/**
 * Outcome when the workflow routes to human triage.
 */
export interface NeedsTriageOutcome {
  status: 'needs_triage';
  reason: string;
  finding: AuditFinding;
}

/**
 * Outcome when the workflow successfully proposes a draft.
 */
export interface DraftProposedOutcome {
  status: 'draft_proposed';
  draft: ProposeDraftResult;
}

/**
 * The result of running the intake workflow for a single document.
 */
export type IntakeWorkflowResult = NeedsTriageOutcome | DraftProposedOutcome;

/**
 * IntakeWorkflowService — orchestrates the full AI intake pipeline:
 *
 *   Pass 1 (OCR) → Pass 2 (agent classify) → deterministic routing
 *
 * Flow:
 * 1. OcrService.transcribe(documentId) → markdown
 * 2. Pass2AgentService.classify(markdown) → TriageResult | null
 * 3. Route based on result:
 *    - null (agent failure)          → AuditFinding(needs_triage)
 *    - unknown                       → AuditFinding(needs_triage)
 *    - new_expense, confidence >= threshold → ProposeDraftService.proposeDraft()
 *    - new_expense, confidence < threshold  → AuditFinding(needs_triage)
 *    - correction / duplicate        → AuditFinding(needs_triage) [stub]
 *
 * The workflow ends after routing — no Mastra suspend() in v1.
 * Human wait is handled via AuditFinding + Approval aggregates (ADR-0018).
 */
@Injectable()
export class IntakeWorkflowService {
  private readonly logger = new Logger(IntakeWorkflowService.name);

  constructor(
    private readonly ocrService: OcrService,
    private readonly pass2Agent: Pass2AgentService,
    private readonly proposeDraft: ProposeDraftService,
    private readonly auditFindings: AuditFindingsService,
    private readonly policyService: PolicyService,
  ) {}

  /**
   * Process a document through the full intake workflow.
   *
   * @param documentId - The Document to transcribe and classify.
   * @returns IntakeWorkflowResult indicating the routing outcome.
   */
  async process(documentId: number): Promise<IntakeWorkflowResult> {
    // ── Pass 1: OCR → markdown ──────────────────────────────────
    const markdown = await this.ocrService.transcribe(documentId);
    this.logger.debug(`Pass 1 complete for document ${documentId}`);

    // ── Pass 2: Agent → TriageResult ────────────────────────────
    const triageResult = await this.pass2Agent.classify(markdown);

    // Agent returned null after max retries → needs_triage.
    if (triageResult === null) {
      this.logger.warn(
        `Pass 2 agent returned null for document ${documentId}, creating needs_triage finding`,
      );
      return this.needsTriage(
        documentId,
        'AI classification failed after max retries',
      );
    }

    this.logger.debug(
      `Pass 2 complete for document ${documentId}: kind=${triageResult.kind}, confidence=${triageResult.confidence}`,
    );

    // ── Deterministic routing ───────────────────────────────────
    const threshold = this.policyService.getConfig().auto_post_min_confidence;

    switch (triageResult.kind) {
      case 'new_expense':
        if (triageResult.confidence >= threshold) {
          // Confident → propose draft through the posting pipeline.
          this.logger.log(
            `Confident new_expense (confidence=${triageResult.confidence} >= ${threshold}), proposing draft for document ${documentId}`,
          );
          const draft = await this.proposeDraft.proposeDraft(
            triageResult,
            documentId,
          );
          return { status: 'draft_proposed', draft };
        } else {
          // Below confidence threshold → needs_triage.
          this.logger.warn(
            `new_expense below confidence threshold (${triageResult.confidence} < ${threshold}) for document ${documentId}`,
          );
          return this.needsTriage(
            documentId,
            `AI confidence ${triageResult.confidence} below threshold ${threshold}`,
          );
        }

      case 'unknown':
        this.logger.warn(
          `Unknown classification for document ${documentId}, creating needs_triage finding`,
        );
        return this.needsTriage(documentId, 'AI could not classify the document');

      case 'correction':
        this.logger.warn(
          `Correction kind for document ${documentId} — stub: routing to needs_triage`,
        );
        return this.needsTriage(
          documentId,
          'Correction kind detected — requires human review (stub, Task 43)',
        );

      case 'duplicate':
        this.logger.warn(
          `Duplicate kind for document ${documentId} — stub: routing to needs_triage`,
        );
        return this.needsTriage(
          documentId,
          'Duplicate kind detected — requires human review (stub, Task 43)',
        );

      default:
        // Exhaustiveness guard — should never happen with the Zod schema.
        this.logger.error(
          `Unexpected triage kind "${(triageResult as any).kind}" for document ${documentId}`,
        );
        return this.needsTriage(
          documentId,
          `Unexpected triage kind: ${(triageResult as any).kind}`,
        );
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Create a needs_triage AuditFinding and return the workflow outcome.
   */
  private async needsTriage(
    documentId: number,
    reason: string,
  ): Promise<NeedsTriageOutcome> {
    const finding = await this.auditFindings.create({
      finding_type: 'needs_triage',
      severity: 'medium',
      description: reason,
      referenced_object_type: 'document',
      referenced_object_id: documentId,
    });

    return { status: 'needs_triage', reason, finding };
  }
}
