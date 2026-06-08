import { Injectable, Logger } from '@nestjs/common';
import { OcrService } from '../triage/ocr.service';
import { Pass2AgentService, Pass2FailureCategory } from './pass2-agent.service';
import {
  ProposeDraftService,
  DraftReplayResult,
} from './propose-draft.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { PolicyService } from '../policy/policy.service';
import { DocumentsService } from '../documents/documents.service';
import { AuditFinding } from '../audit-findings/types';

/**
 * Outcome when the workflow routes to human triage.
 */
export interface NeedsTriageOutcome {
  status: 'needs_triage';
  reason: string;
  finding: AuditFinding;
  /**
   * When the route was driven by a Pass-2 failure, the explicit category
   * (agent-unavailable | invalid-output | transient). Absent for routes driven
   * by a valid-but-unactionable classification (low confidence, unknown,
   * correction, duplicate).
   */
  pass2FailureCategory?: Pass2FailureCategory;
}

/**
 * Outcome when the workflow successfully proposes a draft.
 */
export interface DraftProposedOutcome {
  status: 'draft_proposed';
  draft: DraftReplayResult;
}

/**
 * The result of running the intake workflow for a single document.
 */
export type IntakeWorkflowResult = NeedsTriageOutcome | DraftProposedOutcome;

/**
 * IntakeWorkflowService — the single DEEP owner of "Document -> outcome".
 *
 *   Pass 1 (OCR) → Pass 2 (agent classify) → deterministic routing → status
 *
 * It owns three things no caller may do behind its back:
 *
 * 1. The routing decision (the `kind` + confidence switch) lives ONLY here.
 *    `proposeDraft` trusts an already-routed, confident `new_expense`.
 * 2. The Document status transition moves WITH the routing, inside the one
 *    owning step — not in TriageService after the fact. Routing + status are
 *    a single unit, so a crash cannot leave a Document half-routed.
 *    State machine: pending -> triaged (draft proposed)
 *                   pending -> needs_triage (routed to a human)
 *                   needs_triage -> triaged (a human re-triaged into a draft)
 * 3. Idempotency. A re-run for a Document that already routed is a safe no-op:
 *    it reuses the existing `needs_triage` AuditFinding / existing draft rather
 *    than double-creating. Guarded by the Document status + a deterministic
 *    finding/draft lookup before any create.
 *
 * The workflow ends after routing — no Mastra suspend() in v1 (ADR-0024).
 * Human wait is carried by the durable AuditFinding + Approval aggregates.
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
    private readonly documents: DocumentsService,
  ) {}

  /**
   * Process a document through the full intake workflow.
   *
   * @param documentId - The Document to transcribe, classify, route, and
   *   transition. Idempotent: a re-run of an already-routed Document returns
   *   its existing outcome without creating a second finding or draft.
   * @returns IntakeWorkflowResult indicating the routing outcome.
   */
  async process(documentId: number): Promise<IntakeWorkflowResult> {
    // ── Idempotency guard: has this Document already routed? ─────
    // The Document status is the single source of truth for "already routed".
    const doc = await this.documents.getById(documentId);
    if (doc.status === 'needs_triage') {
      return this.replayNeedsTriage(documentId);
    }
    if (doc.status === 'triaged' || doc.status === 'processed') {
      const replay = await this.replayDraftProposed(documentId);
      if (replay) {
        return replay;
      }
      // Status says routed but no draft exists — fall through and re-route
      // (a partially-applied legacy state). New work is still guarded below.
    }

    // ── Pass 1: OCR → markdown ──────────────────────────────────
    const markdown = await this.ocrService.transcribe(documentId);
    this.logger.debug(`Pass 1 complete for document ${documentId}`);

    // ── Pass 2: Agent → TriageResult | typed failure ────────────
    const pass2 = await this.pass2Agent.classify(markdown);

    if (!pass2.ok) {
      // Bounded-retry exhausted / agent unavailable → needs_triage, but with
      // the explicit failure category surfaced (ADR-0024).
      this.logger.warn(
        `Pass 2 failed for document ${documentId}: category=${pass2.category}`,
      );
      return this.routeNeedsTriage(
        documentId,
        `AI classification failed (${pass2.category}): ${pass2.detail}`,
        pass2.category,
      );
    }

    const triageResult = pass2.result;
    this.logger.debug(
      `Pass 2 complete for document ${documentId}: kind=${triageResult.kind}, confidence=${triageResult.confidence}`,
    );

    // ── Deterministic routing — the ONE place that decides ──────
    const threshold = this.policyService.getConfig().auto_post_min_confidence;

    switch (triageResult.kind) {
      case 'new_expense':
        if (triageResult.confidence >= threshold) {
          this.logger.log(
            `Confident new_expense (confidence=${triageResult.confidence} >= ${threshold}), proposing draft for document ${documentId}`,
          );
          // proposeDraft trusts this validated, already-routed new_expense.
          const draft = await this.proposeDraft.proposeDraft(
            triageResult,
            documentId,
          );
          await this.documents.setStatus(documentId, 'triaged');
          return { status: 'draft_proposed', draft };
        }
        this.logger.warn(
          `new_expense below confidence threshold (${triageResult.confidence} < ${threshold}) for document ${documentId}`,
        );
        return this.routeNeedsTriage(
          documentId,
          `AI confidence ${triageResult.confidence} below threshold ${threshold}`,
        );

      case 'unknown':
        this.logger.warn(
          `Unknown classification for document ${documentId}, routing to needs_triage`,
        );
        return this.routeNeedsTriage(
          documentId,
          'AI could not classify the document',
        );

      case 'correction':
        this.logger.warn(
          `Correction kind for document ${documentId} — stub: routing to needs_triage`,
        );
        return this.routeNeedsTriage(
          documentId,
          'Correction kind detected — requires human review (stub, Task 43)',
        );

      case 'duplicate':
        this.logger.warn(
          `Duplicate kind for document ${documentId} — stub: routing to needs_triage`,
        );
        return this.routeNeedsTriage(
          documentId,
          'Duplicate kind detected — requires human review (stub, Task 43)',
        );

      default: {
        // Exhaustiveness guard — should never happen with the Zod schema.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        const unexpectedKind = (triageResult as any).kind;
        this.logger.error(
          `Unexpected triage kind "${unexpectedKind}" for document ${documentId}`,
        );
        return this.routeNeedsTriage(
          documentId,
          `Unexpected triage kind: ${unexpectedKind}`,
        );
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Route a Document to human triage: create (or reuse) the `needs_triage`
   * AuditFinding and move the Document into `needs_triage`, atomically as one
   * owning step. Idempotent — a re-run reuses the existing open finding via
   * the deterministic reference lookup rather than double-creating.
   */
  private async routeNeedsTriage(
    documentId: number,
    reason: string,
    pass2FailureCategory?: Pass2FailureCategory,
  ): Promise<NeedsTriageOutcome> {
    // Deterministic idempotency guard: reuse an existing open finding.
    let finding = await this.auditFindings.findOpenByReference(
      'needs_triage',
      'document',
      documentId,
    );

    if (!finding) {
      finding = await this.auditFindings.create({
        finding_type: 'needs_triage',
        severity: 'medium',
        description: reason,
        referenced_object_type: 'document',
        referenced_object_id: documentId,
      });
    }

    await this.transitionDocument(documentId, 'needs_triage');

    return { status: 'needs_triage', reason, finding, pass2FailureCategory };
  }

  /**
   * Replay an already-routed `needs_triage` Document: surface the existing
   * open finding without creating a second one. Safe no-op on re-run.
   */
  private async replayNeedsTriage(
    documentId: number,
  ): Promise<NeedsTriageOutcome> {
    const finding = await this.auditFindings.findOpenByReference(
      'needs_triage',
      'document',
      documentId,
    );
    if (finding) {
      this.logger.debug(
        `Document ${documentId} already routed to needs_triage — replaying existing finding ${finding.id}`,
      );
      return {
        status: 'needs_triage',
        reason: finding.description,
        finding,
      };
    }
    // Status says needs_triage but the finding was resolved/snoozed — re-route
    // fresh (guarded create will not duplicate an open one).
    this.logger.warn(
      `Document ${documentId} status=needs_triage but no open finding — re-routing`,
    );
    return this.routeNeedsTriage(
      documentId,
      'Re-routed to triage (prior finding no longer open)',
    );
  }

  /**
   * Replay an already-`triaged` Document by surfacing its existing draft
   * Expense. Returns undefined if no draft exists (caller falls through to
   * re-route). Safe no-op on re-run.
   */
  private async replayDraftProposed(
    documentId: number,
  ): Promise<DraftProposedOutcome | undefined> {
    const draft = await this.proposeDraft.findExistingDraft(documentId);
    if (!draft) {
      return undefined;
    }
    this.logger.debug(
      `Document ${documentId} already triaged — replaying existing draft expense ${draft.expenseId}`,
    );
    return { status: 'draft_proposed', draft };
  }

  /**
   * Guarded Document status transition owned by the workflow. Only the legal
   * moves of the Document state machine are allowed; an illegal move is a
   * no-op (the Document already reached a routed state) rather than a blind
   * overwrite.
   */
  private async transitionDocument(
    documentId: number,
    to: 'triaged' | 'needs_triage',
  ): Promise<void> {
    const current = await this.documents.getById(documentId);
    const allowed: Record<string, readonly string[]> = {
      pending: ['triaged', 'needs_triage'],
      needs_triage: ['triaged', 'needs_triage'],
      triaged: ['triaged'],
      processed: [],
      error: [],
    };
    if (!allowed[current.status]?.includes(to)) {
      this.logger.debug(
        `Document ${documentId} status transition ${current.status} -> ${to} is a no-op (guarded)`,
      );
      return;
    }
    await this.documents.setStatus(documentId, to);
  }
}
