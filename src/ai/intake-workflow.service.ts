import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { OcrService, OcrFailureCategory } from '../triage/ocr.service';
import { Pass2AgentService, Pass2FailureCategory } from './pass2-agent.service';
import {
  ProposeDraftService,
  DraftReplayResult,
} from './propose-draft.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { PolicyService } from '../policy/policy.service';
import { DocumentsService } from '../documents/documents.service';
import { EntitiesService } from '../entities/entities.service';
import { AuditFinding } from '../audit-findings/types';
import { DocumentDebug, PendingDraft } from '../triage/types';

/**
 * The needs_triage reason for a TriageResult `kind` the agent classifies
 * confidently but the kernel does NOT yet act on (correction, duplicate —
 * Task 43). Phrased so the route is unmistakably an "unimplemented kind", not a
 * low-confidence or genuinely-unknown classification.
 */
export function unimplementedKindReason(
  kind: 'correction' | 'duplicate',
): string {
  return `Triage kind '${kind}' is not yet implemented (Task 43): the document was classified as a ${kind}, but the kernel cannot act on it yet — held for human review.`;
}

/**
 * Which pass failed, and why, when a needs_triage route was driven by a typed
 * pass failure. The two intake passes — Pass 1 (OCR transcription) and Pass 2
 * (agent classification) — surface failures through the SAME shape, so the
 * workflow (and downstream observers) can tell a transcription fault from a
 * classification fault with one discriminant (ADR-0024).
 */
export type IntakeFailure =
  | { pass: 'ocr'; category: OcrFailureCategory }
  | { pass: 'classify'; category: Pass2FailureCategory };

/**
 * Outcome when the workflow routes to human triage.
 */
export interface NeedsTriageOutcome {
  status: 'needs_triage';
  reason: string;
  finding: AuditFinding;
  /**
   * When the route was driven by a typed pass failure, which pass failed and
   * its explicit category. Absent for routes driven by a valid-but-unactionable
   * classification (low confidence, unknown, correction, duplicate,
   * supplier-unresolved).
   */
  failure?: IntakeFailure;
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
    private readonly entities: EntitiesService,
  ) {}

  /**
   * Read-only debug: return what Pass-1 transcribed and what Pass-2 (the LLM)
   * classifies the document as, WITHOUT routing or changing the document's
   * status. OCR is idempotent (returns the stored markdown); Pass-2 is re-run
   * so the operator can see the raw classification (e.g. why kind='correction').
   */
  async debug(documentId: number): Promise<DocumentDebug> {
    const ocr = await this.ocrService.transcribe(documentId);
    if (!ocr.ok) {
      return {
        document_id: documentId,
        ocr: { ok: false, category: ocr.category, detail: ocr.detail },
        classification: null,
      };
    }
    const pass2 = await this.pass2Agent.classify(ocr.markdown);
    return {
      document_id: documentId,
      ocr: { ok: true, markdown: ocr.markdown },
      classification: pass2.ok
        ? { ok: true, result: pass2.result }
        : { ok: false, category: pass2.category, detail: pass2.detail },
    };
  }

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

    // ── Pass 1: OCR → markdown | typed failure ──────────────────
    const ocr = await this.ocrService.transcribe(documentId);

    if (!ocr.ok) {
      // Transcription failed (provider down, unreadable doc, IO blip). Route to
      // a human through the SAME seam as a Pass-2 failure — never let a Pass-1
      // fault escape and strand the Document in `pending` (ADR-0024). Pass 2 is
      // short-circuited: there is no markdown to classify.
      this.logger.warn(
        `Pass 1 failed for document ${documentId}: category=${ocr.category}`,
      );
      return this.routeNeedsTriage(
        documentId,
        `OCR transcription failed (${ocr.category}): ${ocr.detail}`,
        { pass: 'ocr', category: ocr.category },
      );
    }

    const markdown = ocr.markdown;
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
        { pass: 'classify', category: pass2.category },
      );
    }

    const triageResult = pass2.result;
    this.logger.debug(
      `Pass 2 complete for document ${documentId}: kind=${triageResult.kind}, confidence=${triageResult.confidence}`,
    );

    // ── Deterministic routing — the ONE place that decides ──────
    const threshold = (await this.policyService.getConfig())
      .auto_post_min_confidence;

    // Capture the discriminant up front: in the exhaustive `default` branch
    // `triageResult` narrows to `never`, so the unexpected value has to be read
    // from a variable widened to `string` rather than the narrowed local.
    const triageKind: string = triageResult.kind;

    switch (triageResult.kind) {
      case 'new_expense':
        if (triageResult.confidence >= threshold) {
          this.logger.log(
            `Confident new_expense (confidence=${triageResult.confidence} >= ${threshold}), proposing draft for document ${documentId}`,
          );
          // proposeDraft trusts this validated, already-routed new_expense. It
          // performs the EXPLICIT supplier-proposal → Supplier resolution: a
          // 'create' proposal cannot yet produce a draft (Task 43), so it
          // returns `supplier-unresolved` and we route to needs_triage rather
          // than silently dropping a null-supplier draft (ADR-0014/0024).
          const outcome = await this.proposeDraft.proposeDraft(
            triageResult,
            documentId,
          );
          if (outcome.outcome === 'supplier-unresolved') {
            this.logger.warn(
              `new_expense for document ${documentId} has an unresolved supplier proposal: ${outcome.reason}`,
            );
            // Keep the exact proposal that blocked us so a human can resolve the
            // supplier and replay it deterministically (no re-run of the agent).
            await this.documents.setPendingTriageResult(
              documentId,
              triageResult,
            );
            return this.routeNeedsTriage(documentId, outcome.reason);
          }
          await this.documents.setStatus(documentId, 'triaged');
          return { status: 'draft_proposed', draft: outcome };
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
      case 'duplicate':
        // These kinds are GENUINELY classified by the agent but the kernel
        // handling is NOT YET IMPLEMENTED (Task 43). The reason marks them as
        // unimplemented-kind routes — explicitly distinct from a low-confidence
        // new_expense or a genuinely-unknown classification — so a human (and
        // any later automation) can tell "we recognised this but can't act on
        // it yet" apart from "the AI was unsure".
        this.logger.warn(
          `Unimplemented kind '${triageResult.kind}' for document ${documentId} — routing to needs_triage (Task 43)`,
        );
        return this.routeNeedsTriage(
          documentId,
          unimplementedKindReason(triageResult.kind),
        );

      default: {
        // Exhaustiveness guard — should never happen with the Zod schema.
        const unexpectedKind = triageKind;
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

  /**
   * Resolve a document parked on the supplier-unresolved route. Given the
   * Supplier the operator created or picked, replay the stored TriageResult
   * through proposeDraft (explicit supplier id wins), then move the document to
   * `triaged`, resolve the open needs_triage finding, and clear the stored
   * proposal. Idempotent: a second call on an already-`triaged` document
   * replays its existing draft instead of double-posting.
   */
  async resolveSupplier(
    documentId: number,
    supplierEntityId: number,
  ): Promise<IntakeWorkflowResult> {
    const doc = await this.documents.getById(documentId);

    // Idempotent replay: already resolved into a draft.
    if (doc.status === 'triaged' || doc.status === 'processed') {
      const replay = await this.replayDraftProposed(documentId);
      if (replay) {
        return replay;
      }
    }
    if (doc.status !== 'needs_triage') {
      throw new ConflictException(
        `Document ${documentId} is not awaiting triage (status=${doc.status})`,
      );
    }

    // The exact proposal that blocked us. Absent → the needs_triage reason was
    // not supplier-unresolved, so there is nothing here to resolve.
    const triageResult =
      await this.documents.getPendingTriageResult(documentId);
    if (!triageResult) {
      throw new BadRequestException(
        `Document ${documentId} has no pending supplier proposal to resolve`,
      );
    }

    // Validate the chosen Supplier (findById throws 404 if it does not exist).
    const entity = await this.entities.findById(supplierEntityId);
    if (entity.role !== 'supplier') {
      throw new BadRequestException(
        `Entity ${supplierEntityId} is not a supplier (role=${entity.role})`,
      );
    }

    // Explicit supplier id wins in resolveSupplier → a draft is produced and the
    // full posting pipeline runs (post/hold per policy), exactly as a confident
    // intake would.
    const outcome = await this.proposeDraft.proposeDraft(
      triageResult,
      documentId,
      supplierEntityId,
    );
    if (outcome.outcome === 'supplier-unresolved') {
      // Defensive: an explicit supplier id must resolve.
      throw new Error(
        `proposeDraft returned supplier-unresolved for document ${documentId} despite explicit supplier ${supplierEntityId}`,
      );
    }

    // Settle the human-wait: triaged + resolve finding + clear the proposal.
    await this.transitionDocument(documentId, 'triaged');
    const finding = await this.auditFindings.findOpenByReference(
      'needs_triage',
      'document',
      documentId,
    );
    if (finding) {
      await this.auditFindings.resolve(finding.id, {
        reason: `supplier resolved to entity ${supplierEntityId}`,
      });
    }
    await this.documents.setPendingTriageResult(documentId, null);

    return { status: 'draft_proposed', draft: outcome };
  }

  /**
   * Build the operator-facing view of a supplier-unresolved document: the AI's
   * create-supplier proposal plus the draft figures. Throws NotFound if the
   * document has no stored proposal (its needs_triage reason is not a supplier
   * issue, or it is not parked at all).
   */
  async getPendingDraft(documentId: number): Promise<PendingDraft> {
    const tr = await this.documents.getPendingTriageResult(documentId);
    if (!tr || tr.supplier_proposal?.mode !== 'create') {
      throw new NotFoundException(
        `Document ${documentId} has no pending supplier proposal`,
      );
    }
    const finding = await this.auditFindings.findOpenByReference(
      'needs_triage',
      'document',
      documentId,
    );
    return {
      document_id: documentId,
      reason:
        finding?.description ?? 'supplier could not be resolved automatically',
      supplier_proposal: {
        create_name: tr.supplier_proposal.create_name,
        create_country: tr.supplier_proposal.create_country,
        create_registration_key: tr.supplier_proposal.create_registration_key,
      },
      draft: {
        category: tr.category,
        gross_amount: tr.gross_amount,
        vat_amount: tr.vat_amount,
        currency: tr.currency,
        tax_point_date: tr.tax_point_date,
        supplier_invoice_number: tr.supplier_invoice_number,
      },
    };
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
    failure?: IntakeFailure,
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

    return { status: 'needs_triage', reason, finding, failure };
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
