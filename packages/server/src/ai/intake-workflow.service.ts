import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { OcrService, OcrFailureCategory } from '../triage/ocr.service';
import { Pass2AgentService, Pass2FailureCategory } from './pass2-agent.service';
import {
  ProposeDraftService,
  DraftReplayResult,
} from './propose-draft.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { DuplicateGuardService } from './duplicate-guard.service';
import { PolicyService } from '../policy/policy.service';
import { DocumentsService } from '../documents/documents.service';
import { EntitiesService } from '../entities/entities.service';
import { OrganizationService } from '../organization/organization.service';
import { BankIngestionService } from '../bank/bank-ingestion.service';
import { AuditFinding } from '../audit-findings/types';
import {
  DocumentDebug,
  ManualClassifyDto,
  TriageResult,
  Pass2Enrichment,
  TriageReasonType,
  classifyReasonType,
} from '../triage/types';
import {
  buildPendingSupplierProposal,
  type PendingDraft,
} from '../triage/pending-draft';
import { matchesOrgIban } from '../intake/iban-match';
import { classifyDocumentClass } from '../intake/document-class';
import { composeOutgoingConfidence } from '../intake/outgoing-confidence';
import { ProcessingGate } from './processing-gate';

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
 * The needs_triage reason for a file the relevance gate judged is NOT a business
 * accounting document (spam, marketing, personal correspondence, a blank/garbled
 * page, an unrelated screenshot). Phrased with the stable marker "not a business
 * accounting document" so classifyReasonType tags it `not_a_document`. Such a
 * file is filtered out BEFORE any voucher attempt — it must never reach
 * proposeDraft / the posting pipeline, where it would fail structural validation
 * and surface as a confusing "Unexpected error during intake".
 */
export function notADocumentReason(): string {
  return 'Not a business accounting document — the file does not look like an invoice, receipt, or statement, so intake did not attempt to book it. Held for human review (delete it or classify it manually).';
}

/**
 * The needs_triage reason for a document classified as `order_confirmation` or
 * `proforma` — a document that is NOT a primary tax document in either
 * direction because it precedes or estimates a real invoice. Phrased with the
 * stable marker "not a primary tax document" so classifyReasonType tags it
 * `non_postable_document`. Such a document must never be auto-posted; the
 * real invoice will be booked separately when it arrives.
 */
export function nonPostableReason(docType: string): string {
  return `This is not a primary tax document (classified as ${docType} — e.g. an order confirmation, proforma, or quote). Intake did not book it; the real invoice will be booked when it arrives. Held for human review.`;
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

/** Map a typed pass failure to its persisted TriageReasonType: Pass 1 (OCR)
 * failures are ocr_failed regardless of category (none of the OCR categories
 * means "not a document" — that routes via notADocumentReason() with no
 * failure); Pass 2 failures are classification_failed. */
export function failureToReasonType(failure: IntakeFailure): TriageReasonType {
  return failure.pass === 'ocr' ? 'ocr_failed' : 'classification_failed';
}

export function pass2FailureReason(
  category: Pass2FailureCategory,
  detail: string,
): string {
  switch (category) {
    case 'enrichment-failed':
    case 'enrichment-incomplete':
    case 'enrichment-tool-not-called':
      return `AI classification failed during enrichment (${category}): ${detail}`;
    case 'invalid-output':
    case 'transient':
      return `AI classification failed during strict classification (${category}): ${detail}`;
    case 'agent-unavailable':
      return `AI classification failed (${category}): ${detail}`;
    default: {
      const unreachable: never = category;
      return unreachable;
    }
  }
}

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
 * Outcome when the workflow successfully books a detected OUTGOING invoice as a
 * SalesInvoice draft (the sales-invoice analogue of {@link DraftProposedOutcome}).
 */
export interface DraftProposedInvoiceOutcome {
  status: 'draft_proposed_invoice';
  invoiceId: number;
}

/**
 * Outcome when a CSV bank statement is handed to BankIngestionService for
 * background processing. The jobId can be polled via the bank-import endpoint.
 */
export interface BankImportStartedOutcome {
  status: 'bank_import_started';
  jobId: number;
}

/**
 * The result of running the intake workflow for a single document.
 */
export type IntakeWorkflowResult =
  | NeedsTriageOutcome
  | DraftProposedOutcome
  | DraftProposedInvoiceOutcome
  | BankImportStartedOutcome;

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
    private readonly organizationService: OrganizationService,
    @Inject(forwardRef(() => BankIngestionService))
    private readonly bankIngestion: BankIngestionService,
    private readonly gate: ProcessingGate,
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly duplicateGuard: DuplicateGuardService,
  ) {}

  /**
   * Re-classification path for the manual-triage work queue: re-runs OCR +
   * LLM (Pass-1 + Pass-2) for a given document so the operator sees a fresh
   * classification when filling the TriageManualForm. Unlike {@link details},
   * which reads persisted Expense data without re-invoking the LLM (ADR-0039),
   * this method deliberately re-runs the full AI pipeline to give the operator
   * up-to-date signal. Does NOT route or change the document's status.
   */
  async debug(documentId: number): Promise<DocumentDebug> {
    return this.gate.run(async () => {
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
          ? {
              ok: true,
              result: pass2.result,
              ...(pass2.enrichment == null
                ? {}
                : { enrichment: pass2.enrichment }),
            }
          : { ok: false, category: pass2.category, detail: pass2.detail },
      };
    });
  }

  /**
   * Read-only details: returns the cached OCR markdown (via ocrService.transcribe,
   * which is idempotent — reads from the stored ocr_markdown artifact) and the
   * classification facts from the linked draft Expense. NEVER re-invokes
   * pass2Agent (ADR-0039). The classification fields are sourced from the Expense
   * columns: ai_kind → kind, ai_document_type → document_type,
   * ai_confidence → confidence; the remaining fields (amounts, category, etc.)
   * come from the Expense's own columns.
   *
   * A document with no linked Expense (e.g. needs_triage or OCR-only) returns
   * OCR text with classification: null. A missing OCR artifact returns the OCR
   * failure shape with classification: null.
   */
  // Not gated: details() is read-only and does not run the OCR/LLM pipeline,
  // so it does not need ProcessingGate serialization (unlike process() which
  // does gate its inner pipeline to prevent concurrent runs).
  async details(documentId: number): Promise<DocumentDebug> {
    const ocr = await this.ocrService.transcribe(documentId);
    if (!ocr.ok) {
      return {
        document_id: documentId,
        ocr: { ok: false, category: ocr.category, detail: ocr.detail },
        classification: null,
      };
    }

    // Read classification from the linked draft Expense — never re-run the LLM.
    const expense = await this.db
      .selectFrom('expense')
      .where('document_id', '=', documentId)
      .select([
        'category',
        'gross_amount',
        'vat_amount',
        'currency',
        'tax_point_date',
        'document_vat_marking',
        'supplier_invoice_number',
        'ai_confidence',
        'ai_document_type',
        'ai_kind',
      ])
      .executeTakeFirst();

    if (!expense) {
      const pendingReplay =
        await this.documents.getPendingTriageReplay(documentId);
      if (pendingReplay) {
        return {
          document_id: documentId,
          ocr: { ok: true, markdown: ocr.markdown },
          classification: {
            ok: true,
            result: pendingReplay.triageResult,
            ...(pendingReplay.enrichment == null
              ? {}
              : { enrichment: pendingReplay.enrichment }),
          },
        };
      }

      return {
        document_id: documentId,
        ocr: { ok: true, markdown: ocr.markdown },
        classification: null,
      };
    }

    return {
      document_id: documentId,
      ocr: { ok: true, markdown: ocr.markdown },
      classification: {
        ok: true,
        result: {
          kind: (expense.ai_kind ?? 'unknown') as TriageResult['kind'],
          document_type: (expense.ai_document_type ??
            'other') as TriageResult['document_type'],
          confidence: expense.ai_confidence ?? 0,
          gross_amount: expense.gross_amount,
          vat_amount: expense.vat_amount,
          currency: expense.currency,
          tax_point_date: expense.tax_point_date,
          category: expense.category,
          document_vat_marking: expense.document_vat_marking,
          supplier_invoice_number: expense.supplier_invoice_number,
          // Fields not stored on the Expense — supply safe defaults.
          outgoing_signals: {
            org_name_is_issuer: false,
            org_vat_is_issuer: false,
            has_buyer_block: false,
            self_identifies_as_invoice: false,
          },
        },
      },
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
  /**
   * Run the full intake pipeline for one document, serialized through the
   * ProcessingGate so only one OCR/LLM pipeline runs at a time across the whole
   * process (worker-driven and manual triage alike).
   */
  async process(
    documentId: number,
    claimantId?: number | null,
  ): Promise<IntakeWorkflowResult> {
    return this.gate.run(() => this.processInner(documentId, claimantId));
  }

  private async processInner(
    documentId: number,
    claimantId?: number | null,
  ): Promise<IntakeWorkflowResult> {
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
      // Also replay an already-booked OUTGOING-invoice draft (the sales-invoice
      // analogue) before falling through.
      const invoiceReplay =
        await this.proposeDraft.findExistingInvoiceDraft(documentId);
      if (invoiceReplay) {
        return {
          status: 'draft_proposed_invoice',
          invoiceId: invoiceReplay.invoiceId,
        };
      }
      // Status says routed but no draft exists — fall through and re-route
      // (a partially-applied legacy state). New work is still guarded below.
    }

    // ── Stamp processing_since so the operator SPA can show "Processing…"
    //    across refreshes (triage can take a minute or two).
    await this.documents.markProcessing(documentId);
    try {
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

      // ── Deterministic relevance pre-filter ─────────────────────
      // OCR succeeded but produced no readable text (a blank scan, an image with
      // no words). There is nothing to classify, so don't spend an LLM call on
      // it — route straight to human review as "not a document". This is the
      // cheap, no-LLM half of the relevance gate; the LLM verdict (kind ===
      // 'not_a_document') is the content-aware half, handled after Pass 2.
      if (markdown.trim().length === 0) {
        this.logger.warn(
          `Document ${documentId} produced empty OCR text — routing to needs_triage as not-a-document`,
        );
        return this.routeNeedsTriage(documentId, notADocumentReason());
      }

      // ── Org identity + deterministic direction gate ────────────
      // Computed BEFORE Pass 2 so the agent can extract direction-appropriate
      // fields. The IBAN match alone decides direction; the agent's
      // outgoing_signals are confidence inputs only (ADR-0024).
      const org = await this.organizationService.getOrganization();
      const ibanMatched = matchesOrgIban(markdown, org.iban);

      // ── Pass 2: Agent → TriageResult | typed failure ────────────
      const pass2 = await this.pass2Agent.classify(markdown, {
        orgContext: {
          iban: org.iban,
          name: org.name,
          vatNumber: org.vat_registration_number,
        },
        directionHint: ibanMatched ? 'outgoing' : 'incoming',
      });

      if (!pass2.ok) {
        // Bounded-retry exhausted / agent unavailable → needs_triage, but with
        // the explicit failure category surfaced (ADR-0024).
        this.logger.warn(
          `Pass 2 failed for document ${documentId}: category=${pass2.category}`,
        );
        return this.routeNeedsTriage(
          documentId,
          pass2FailureReason(pass2.category, pass2.detail),
          { pass: 'classify', category: pass2.category },
        );
      }

      const triageResult = pass2.result;
      const pass2Enrichment = pass2.enrichment ?? null;
      this.logger.debug(
        `Pass 2 complete for document ${documentId}: kind=${triageResult.kind}, confidence=${triageResult.confidence}`,
      );

      // ── Relevance gate (content-aware) ─────────────────────────
      // The agent judged this file is not a business accounting document at all.
      // Filter it out HERE — before document-class routing and any voucher
      // attempt — so junk never reaches proposeDraft / the posting pipeline
      // (where it fails structural validation and surfaces as a confusing
      // "Unexpected error during intake"). High confidence does NOT post it.
      if (triageResult.kind === 'not_a_document') {
        this.logger.warn(
          `Document ${documentId} classified as not_a_document — routing to needs_triage (relevance gate)`,
        );
        return this.routeNeedsTriage(documentId, notADocumentReason());
      }

      // ── Deterministic document-class routing — the ONE place ────
      // Direction + document type decide WHICH intake route owns this document.
      // The expense path is unchanged; sales/bank/unsupported routes are parked
      // pending later tasks.
      const documentClass = classifyDocumentClass({
        documentType: triageResult.document_type,
        ibanMatched,
      });

      // Claimant override: runs AFTER Pass-2 so all artefacts (amounts, supplier,
      // company_addressed_receipt) are stored before routing to needs_triage.
      // Approver must confirm payment regardless of AI confidence.
      if (claimantId != null) {
        return this.routeNeedsTriage(
          documentId,
          `Document submitted by Claimant (entity ${claimantId}) — approver must confirm payment.`,
        );
      }

      switch (documentClass.route) {
        // `return await` (not a bare `return`) so a rejection from a routing
        // helper is caught by the safety-net catch below rather than escaping
        // and stranding the document in `pending` (ADR-0024).
        case 'expense':
          return await this.routeExpense(
            documentId,
            triageResult,
            claimantId,
            pass2Enrichment,
          );
        case 'sales_invoice':
          return await this.routeSalesInvoice(
            documentId,
            triageResult,
            ibanMatched,
            pass2Enrichment,
          );
        case 'bank_statement':
          return await this.routeBankStatement(documentId);
        case 'non_postable':
          return this.routeNeedsTriage(
            documentId,
            nonPostableReason(documentClass.docType),
          );
        case 'unsupported':
          return this.routeNeedsTriage(
            documentId,
            `Document type '${documentClass.docType}' is not supported by intake yet`,
          );
      }
    } catch (err) {
      // Safety net (ADR-0024): no fault may leave the document stranded in
      // `pending`. Any unforeseen throw during OCR / classification / routing
      // routes the document to needs_triage with the error surfaced, so a human
      // can recover it — rather than escaping and stranding the document.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Unexpected fault processing document ${documentId}: ${message}`,
      );
      return this.routeNeedsTriage(
        documentId,
        `Unexpected error during intake: ${message}`,
      );
    } finally {
      await this.documents.clearProcessing(documentId);
    }
  }

  /**
   * Route a confident, deterministically-classified incoming-expense document.
   * This is the existing expense path, relocated verbatim from `process()`'s
   * kind-switch: confidence gate → proposeDraft → supplier/category resolution
   * → draft_proposed | needs_triage. Behavior is byte-for-byte equivalent.
   */
  private async routeExpense(
    documentId: number,
    triageResult: TriageResult,
    claimantId?: number | null,
    enrichment?: Pass2Enrichment | null,
  ): Promise<IntakeWorkflowResult> {
    // ── Kind-level routing within the expense (incoming) path ──────
    // This handles ALL incoming kinds (new_expense / unknown / correction /
    // duplicate), not only new_expense — the kind switch below dispatches each.
    // The document-class decision (which path owns this doc) already happened
    // in process(); this is the second, narrower routing tier.
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
          // performs the EXPLICIT supplier-proposal → Supplier resolution (a
          // 'match' proposal resolves to its entity id; a 'create' proposal
          // identifier-resolves via ADR-0014 find-or-onboard, or returns
          // `supplier-unresolved` when no strong identifier anchors it — we
          // never silently drop a null-supplier draft), then runs the
          // duplicate gate over whichever supplier it resolved to, covering
          // BOTH a 'match' proposal and a 'create' proposal that resolved to
          // an existing supplier.
          const outcome = await this.proposeDraft.proposeDraft(
            triageResult,
            documentId,
            undefined,
            claimantId,
            enrichment ?? undefined,
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
              enrichment,
            );
            return this.routeNeedsTriage(documentId, outcome.reason);
          }
          if (outcome.outcome === 'category-unresolved') {
            this.logger.warn(
              `new_expense for document ${documentId} has an unresolved category: ${outcome.reason}`,
            );
            return this.routeNeedsTriage(documentId, outcome.reason);
          }
          if (outcome.outcome === 'possible-duplicate') {
            this.logger.warn(
              `Duplicate gate blocked auto-post for document ${documentId}: ${outcome.reason}`,
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
   * Route a deterministically-classified OUTGOING (sales) invoice — our IBAN is
   * on the document. Confidence here is composed in code from the IBAN match
   * plus the agent's outgoing_signals (NOT the agent's own `confidence`, which
   * is an incoming-expense notion). Below threshold → needs_triage; above →
   * book a SalesInvoice draft via proposeSalesInvoiceDraft and run the pipeline.
   * A create-customer proposal, a missing number, or a duplicate number park to
   * needs_triage rather than booking a bad draft.
   */
  private async routeSalesInvoice(
    documentId: number,
    triageResult: TriageResult,
    ibanMatched: boolean,
    enrichment?: Pass2Enrichment | null,
  ): Promise<IntakeWorkflowResult> {
    const threshold = (await this.policyService.getConfig())
      .auto_post_min_confidence;
    const confidence = composeOutgoingConfidence(
      ibanMatched,
      triageResult.outgoing_signals,
    );
    if (confidence < threshold) {
      this.logger.warn(
        `Outgoing-invoice confidence ${confidence} below threshold ${threshold} for document ${documentId}`,
      );
      // EVERY routeSalesInvoice park reason carries the uniform
      // `Outgoing invoice — ` prefix so classifyReasonType tags it
      // `outgoing_invoice` and the SPA reaches the manual classify-as-sales-
      // invoice form (the marker must survive: "Outgoing invoice —" contains it).
      return this.routeNeedsTriage(
        documentId,
        `Outgoing invoice — AI confidence ${confidence} below threshold ${threshold}`,
      );
    }
    const outcome = await this.proposeDraft.proposeSalesInvoiceDraft(
      triageResult,
      documentId,
    );
    if (outcome.outcome === 'customer-unresolved') {
      this.logger.warn(
        `Outgoing invoice for document ${documentId} has an unresolved customer: ${outcome.reason}`,
      );
      // Keep the exact triage result so an operator can create/select the
      // customer and replay it deterministically (no re-run of the agent).
      await this.documents.setPendingTriageResult(
        documentId,
        triageResult,
        enrichment,
      );
      return this.routeNeedsTriage(
        documentId,
        `Outgoing invoice — ${outcome.reason}`,
      );
    }
    if (
      outcome.outcome === 'invoice-number-missing' ||
      outcome.outcome === 'duplicate-number'
    ) {
      this.logger.warn(
        `Outgoing invoice for document ${documentId} not booked (${outcome.outcome}): ${outcome.reason}`,
      );
      return this.routeNeedsTriage(
        documentId,
        `Outgoing invoice — ${outcome.reason}`,
      );
    }
    await this.documents.setStatus(documentId, 'triaged');
    return { status: 'draft_proposed_invoice', invoiceId: outcome.invoiceId };
  }

  /**
   * Route a bank statement: CSV files are handed to BankIngestionService for
   * background import; PDF/image statements are parked to needs_triage (OCR-of-
   * statements is deferred). The document moves to 'processed' on a successful
   * CSV handoff.
   */
  private async routeBankStatement(
    documentId: number,
  ): Promise<IntakeWorkflowResult> {
    const doc = await this.documents.getById(documentId);
    const isCsv =
      doc.mime_type === 'text/csv' ||
      doc.filename.toLowerCase().endsWith('.csv');
    if (!isCsv) {
      return this.routeNeedsTriage(
        documentId,
        'Bank statement is not a CSV; PDF/image statements are not yet supported by intake — import it via the bank screen',
      );
    }
    const file = await this.documents.getFile(documentId);
    const org = await this.organizationService.getOrganization();
    if (!org.iban) {
      this.logger.warn(
        'No org IBAN configured; bank import will run without an account hint',
      );
    }
    const { jobId } = await this.bankIngestion.startImport(
      file.buffer.toString('utf-8'),
      org.iban ?? '',
    );
    await this.documents.setStatus(documentId, 'processed');
    return { status: 'bank_import_started', jobId };
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
    const pendingReplay =
      await this.documents.getPendingTriageReplay(documentId);
    if (!pendingReplay) {
      throw new BadRequestException(
        `Document ${documentId} has no pending supplier proposal to resolve`,
      );
    }
    const triageResult = pendingReplay.triageResult;

    // Validate the chosen Supplier (findById throws 404 if it does not exist).
    const entity = await this.entities.findById(supplierEntityId);
    if (entity.role !== 'supplier') {
      throw new BadRequestException(
        `Entity ${supplierEntityId} is not a supplier (role=${entity.role})`,
      );
    }

    // Teach the operator-chosen supplier the identifiers this document carried,
    // so a later document with the same email/phone/reg auto-resolves instead of
    // re-triaging (mirrors the auto-path's enrichment). No-ops on null fields.
    const sp = triageResult.supplier_proposal;
    if (sp?.mode === 'create') {
      await this.entities.addIdentifierIfAbsent(
        supplierEntityId,
        'registration_key',
        sp.create_registration_key ?? '',
      );
      await this.entities.addIdentifierIfAbsent(
        supplierEntityId,
        'email',
        sp.create_email ?? '',
      );
      await this.entities.addIdentifierIfAbsent(
        supplierEntityId,
        'phone',
        sp.create_phone ?? '',
      );
      await this.entities.addIdentifierIfAbsent(
        supplierEntityId,
        'address',
        sp.create_address ?? '',
      );
    }

    // The operator just chose this supplier explicitly — still run it through
    // the same duplicate gate as the auto-post path so a human-resolved
    // supplier can't book a second posting for a purchase already recorded.
    const dup = await this.duplicateGuard.check({
      supplierId: supplierEntityId,
      supplierInvoiceNumber: triageResult.supplier_invoice_number,
      grossAmount: triageResult.gross_amount,
      taxPointDate: triageResult.tax_point_date,
    });
    if (dup) {
      this.logger.warn(
        `Duplicate gate (tier ${dup.tier}) blocked resolveSupplier for document ${documentId}: ${dup.reason}`,
      );
      return this.routeNeedsTriage(documentId, dup.reason);
    }

    // Explicit supplier id wins in resolveSupplier → a draft is produced and the
    // full posting pipeline runs (post/hold per policy), exactly as a confident
    // intake would.
    const outcome = await this.proposeDraft.proposeDraft(
      triageResult,
      documentId,
      supplierEntityId,
      doc.claimant_id,
      pendingReplay.enrichment ?? undefined,
    );
    if (outcome.outcome === 'supplier-unresolved') {
      // Defensive: an explicit supplier id must resolve.
      throw new Error(
        `proposeDraft returned supplier-unresolved for document ${documentId} despite explicit supplier ${supplierEntityId}`,
      );
    }
    if (outcome.outcome === 'category-unresolved') {
      // Defensive: proposeDraft validates the category BEFORE supplier
      // resolution, so a document that was held as supplier-unresolved already
      // passed category validation — re-running it on the same triageResult
      // cannot regress to an unknown category.
      throw new Error(
        `proposeDraft returned category-unresolved for document ${documentId} during supplier resolution: ${outcome.reason}`,
      );
    }
    if (outcome.outcome === 'possible-duplicate') {
      // Defensive: proposeDraft's duplicate gate only runs on the AUTO path
      // (no explicit supplierId). This call passes `supplierEntityId`
      // explicitly, so the gate is always skipped here — this call already
      // ran its OWN pre-call duplicate check above. This arm exists only to
      // satisfy the ProposeDraftOutcome type; it should be unreachable.
      throw new Error(
        `proposeDraft returned possible-duplicate for document ${documentId} despite an explicit supplier id — this should be unreachable`,
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
   * Manually classify a document: the operator supplies all fields directly,
   * bypassing the AI passes. Creates an expense and runs the posting pipeline.
   * Idempotent: a second call on an already-triaged document replays its
   * existing draft instead of creating a second expense.
   */
  async manualClassify(
    documentId: number,
    dto: ManualClassifyDto,
  ): Promise<IntakeWorkflowResult> {
    const doc = await this.documents.getById(documentId);

    if (doc.status === 'triaged' || doc.status === 'processed') {
      const replay = await this.replayDraftProposed(documentId);
      if (replay) return replay;
    }
    if (doc.status !== 'needs_triage') {
      throw new ConflictException(
        `Document ${documentId} is not awaiting triage (status=${doc.status})`,
      );
    }

    // Branch on the operator's chosen target. A 'sales_invoice' target books an
    // outgoing-invoice draft; an absent/'expense' target keeps the existing
    // expense path unchanged. Both branches settle the human-wait identically:
    // triaged + resolve the open finding + clear any pending proposal.
    if (dto.target === 'sales_invoice') {
      const outcome = await this.proposeDraft.manualClassifyInvoiceDraft(
        documentId,
        dto,
      );
      if (outcome.outcome === 'duplicate-number') {
        this.logger.warn(
          `Manual classify-as-invoice for document ${documentId} not booked (duplicate-number): ${outcome.reason}`,
        );
        return this.routeNeedsTriage(documentId, outcome.reason);
      }
      await this.settleManualClassify(documentId);
      return {
        status: 'draft_proposed_invoice',
        invoiceId: outcome.invoiceId,
      };
    }

    const outcome = await this.proposeDraft.manualClassifyDraft(
      documentId,
      dto,
    );
    await this.settleManualClassify(documentId);
    return { status: 'draft_proposed', draft: outcome };
  }

  /**
   * Settle the human-wait after a successful manual classification: move the
   * document to `triaged`, resolve the open needs_triage finding, and clear any
   * stored pending proposal. Shared by the expense and sales-invoice branches
   * of {@link manualClassify} so both behave consistently.
   */
  private async settleManualClassify(documentId: number): Promise<void> {
    await this.transitionDocument(documentId, 'triaged');
    const finding = await this.auditFindings.findOpenByReference(
      'needs_triage',
      'document',
      documentId,
    );
    if (finding) {
      await this.auditFindings.resolve(finding.id, {
        reason: 'manually classified by operator',
      });
    }
    await this.documents.setPendingTriageResult(documentId, null);
  }

  /**
   * Build the operator-facing view of a supplier-unresolved document: the AI's
   * create-supplier proposal plus the draft figures. Throws NotFound if the
   * document has no stored proposal (its needs_triage reason is not a supplier
   * issue, or it is not parked at all).
   */
  async getPendingDraft(documentId: number): Promise<PendingDraft> {
    const tr = await this.documents.getPendingTriageResult(documentId);
    if (!tr?.supplier_proposal) {
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
      supplier_proposal: await buildPendingSupplierProposal(
        tr.supplier_proposal,
        this.entities,
      ),
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
    const reasonType: TriageReasonType = failure
      ? failureToReasonType(failure)
      : classifyReasonType(reason);

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
        reason_type: reasonType,
        referenced_object_type: 'document',
        referenced_object_id: documentId,
      });
    } else {
      // Update the description AND reason_type so a retry that fails for a
      // DIFFERENT reason surfaces the new reason (and correct bucket) to the
      // operator, not the stale original.
      await this.auditFindings.updateTriageReason(
        finding.id,
        reason,
        reasonType,
      );
      finding = { ...finding, description: reason, reason_type: reasonType };
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
