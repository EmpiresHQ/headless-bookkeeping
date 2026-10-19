import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { ExpensesService } from '../expenses/expenses.service';
import { EntitiesService } from '../entities/entities.service';
import { PostingPipelineService } from '../ledger/pipeline/posting-pipeline.service';
import {
  CustomerProposal,
  SupplierProposal,
  TriageResult,
  type Pass2Enrichment,
} from '../triage/types';
import { CreateExpenseDto } from '../expenses/types';
import { normalizeIdentifier } from '../entities/identifier-normalization';
import { AgentConfigService } from './agent-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { DuplicateExpenseException } from '../expenses/duplicate-expense.exception';
import { CategoryService } from '../categories/category.service';
import {
  SalesInvoicesService,
  isInvoiceNumberConflict,
} from '../sales-invoices/sales-invoices.service';

/** The posting pipeline's result shape (Rules → Policy → post/hold). */
export type PipelineRunResult = Awaited<
  ReturnType<typeof PostingPipelineService.prototype.runPipeline>
>;

/**
 * A valid AI-extracted gross: a positive, whole minor-unit amount (issue
 * #405). The kernel's own guard (`assertCoherentPurchaseAmounts`) keeps the
 * same shape at posting; this earlier seam parks the failure BEFORE an
 * Expense row exists instead of faulting on an already-persisted junk draft.
 * Exported because the WORKFLOW's routing runs the same validation BEFORE its
 * confidence gate (a zero-total low-confidence extraction is still failed
 * evidence, not mere low confidence).
 */
export function isValidExtractedGross(gross: number): boolean {
  return Number.isSafeInteger(gross) && gross > 0;
}

/**
 * The operator-facing reason for failed PURCHASE amount evidence (issue
 * #405): WHAT was read and WHY it cannot be booked, in money terms — backend
 * field names stay out of the primary sentence. Shared by proposeDraft's
 * pre-creation guard and the workflow's pre-confidence routing guard so both
 * seams say exactly the same thing.
 */
export function invalidPurchaseEvidenceReason(
  triage: Pick<
    TriageResult,
    | 'gross_amount'
    | 'vat_amount'
    | 'currency'
    | 'tax_point_date'
    | 'supplier_invoice_number'
  >,
): string {
  const total = Number.isFinite(triage.gross_amount)
    ? `${(triage.gross_amount / 100).toFixed(2)} ${triage.currency}`
    : `${triage.gross_amount} ${triage.currency}`;
  return (
    `AI purchase extraction is invalid: nothing was booked. The AI read ` +
    `a total of ${total} for this invoice (date ` +
    `${triage.tax_point_date || 'none'}, document number ` +
    `${triage.supplier_invoice_number ?? 'none'}), and a purchase total ` +
    `must be a positive amount of money, so it cannot be booked ` +
    `automatically. The document layout may differ from what the ` +
    `extraction expected — check the document and classify it manually.`
  );
}

/**
 * A marker the idempotency replay returns instead of re-running the pipeline:
 * the draft already exists and was already posted/held on the original pass.
 */
export interface ReplayedPipelineResult {
  replayed: true;
}

/**
 * Result of a FRESH propose-draft run — the pipeline actually executed, so
 * `pipelineResult` is the concrete pipeline output (callers may read
 * `.policy.action`).
 */
export interface ProposeDraftResult {
  outcome: 'draft';
  expenseId: number;
  pipelineResult: PipelineRunResult;
}

/**
 * Result when proposeDraft could NOT produce a draft because the
 * supplier_proposal asked to CREATE a Supplier — deferred (Task 43). No draft
 * is created (no null-supplier silent drop); the caller routes to needs_triage
 * with {@link reason}.
 */
export interface SupplierUnresolvedResult {
  outcome: 'supplier-unresolved';
  reason: string;
}

/**
 * Returned when the triage `category` is not in the active country plugin's
 * category set. Like supplier-unresolved, the caller routes it to needs_triage
 * rather than silently booking to EXPENSE_OTHER (ADR-0002).
 */
export interface CategoryUnresolvedResult {
  outcome: 'category-unresolved';
  reason: string;
}

/**
 * Returned when the deterministic duplicate key (issue #195, applied inside
 * `ExpensesService.createExpense`) recognises this proposal as a re-submission
 * of an already-recorded expense — same supplier + normalised invoice number,
 * or, when the INCOMING document prints no number, same supplier + currency +
 * gross amount + tax point date + claimant.
 *
 * The guard signals by throwing {@link DuplicateExpenseException}; proposeDraft
 * translates it into this typed outcome so the caller can route the document to
 * needs_triage naming the original, instead of a 409 escaping to the intake
 * queue as an unhandled error.
 */
export interface PossibleDuplicateResult {
  outcome: 'possible-duplicate';
  reason: string;
  /** The expense this proposal appears to duplicate. */
  existingExpenseId: number;
}

/**
 * Returned when an incoming RECEIPT matches an INVOICE-derived expense that
 * already exists (issue #195). A vendor emailing the invoice and the payment
 * receipt as two attachments is the normal flow, not an anomaly: the receipt is
 * evidence for a purchase already recorded, so it must neither create a second
 * expense nor queue work for a human. The caller marks the document `processed`
 * and writes an audit_log entry.
 *
 * This is deliberately NOT "receipts never create expenses": the outcome only
 * arises when the deterministic key actually matched. A receipt that matches
 * nothing takes the ordinary draft path — in production, 4 of 5 receipt-derived
 * expenses are the only document for their purchase.
 *
 * Nor is it "a matching receipt is always filed": when the matched expense is
 * itself receipt-derived there is no invoice half to be the original, and the
 * receipt-only vendors (restaurant, cafe, car-sharing) are exactly the ones
 * that print no number and repeat an amount within a day. Two such receipts are
 * two purchases, so that case is a {@link PossibleDuplicateResult} for a human.
 */
export interface ReceiptMatchedResult {
  outcome: 'receipt-matched';
  reason: string;
  /** The expense this receipt evidences. */
  existingExpenseId: number;
}

/**
 * Discriminated outcome of a fresh proposeDraft call: either a created draft
 * or an explicit "supplier could not be resolved, route to triage" signal, an
 * explicit "category not in the active plugin's category set, route to
 * triage" signal, or an explicit "possible duplicate, route to triage" signal
 * from the duplicate gate.
 */
/**
 * Returned when the AI's purchase extraction failed in a way the schema
 * could not see (issue #405): the gross amount is zero, negative, non-finite
 * or not a whole minor unit — the columnar-layout failure that extracted the
 * gross as 0 and the next field's value as the invoice number. This is an
 * EXTRACTED-EVIDENCE failure, not an unexpected fault: it is validated
 * BEFORE the Expense row is created, so no junk draft is persisted and no
 * level-50 pipeline fault fires. The caller routes the document to
 * needs_triage with the typed evidence-invalid failure; nothing was booked.
 */
export interface EvidenceInvalidResult {
  outcome: 'evidence-invalid';
  /** Operator-facing: says WHAT was extracted and WHAT failed. */
  reason: string;
}

export type ProposeDraftOutcome =
  | ProposeDraftResult
  | SupplierUnresolvedResult
  | CategoryUnresolvedResult
  | PossibleDuplicateResult
  | ReceiptMatchedResult
  | EvidenceInvalidResult;

/**
 * Result the workflow's idempotency replay surfaces — either a fresh run or a
 * replayed marker (the pipeline did NOT re-run). The wider union; assignable
 * from {@link ProposeDraftResult}.
 */
export interface DraftReplayResult {
  outcome: 'draft';
  expenseId: number;
  pipelineResult: PipelineRunResult | ReplayedPipelineResult;
}

/**
 * Result of a FRESH proposeSalesInvoiceDraft run — the outgoing invoice was
 * booked as a SalesInvoice draft and the posting pipeline ran. The
 * sales-invoice analogue of {@link ProposeDraftResult}.
 */
export interface ProposeSalesInvoiceResult {
  outcome: 'draft';
  invoiceId: number;
  pipelineResult: PipelineRunResult;
}

/**
 * Returned when the outgoing invoice could NOT be booked because the customer
 * counterparty must be created or selected by an operator first. Unlike the
 * supplier path, v1 does NOT auto-create a customer from a 'create' proposal —
 * the caller parks the document to needs_triage with {@link reason}.
 */
export interface CustomerUnresolvedResult {
  outcome: 'customer-unresolved';
  reason: string;
}

/**
 * Returned when the document carries no printed invoice number — for an
 * outgoing invoice the document's number IS our number, so without one the
 * invoice cannot be booked. The caller routes to needs_triage.
 */
export interface InvoiceNumberMissingResult {
  outcome: 'invoice-number-missing';
  reason: string;
}

/**
 * Returned when the invoice number already exists (a UNIQUE-constraint
 * violation on sales_invoice.invoice_number) — almost always a re-upload of an
 * already-booked invoice. The caller routes to needs_triage rather than
 * surfacing a 500.
 */
export interface DuplicateNumberResult {
  outcome: 'duplicate-number';
  reason: string;
}

/**
 * Discriminated outcome of a fresh proposeSalesInvoiceDraft call: a created
 * draft, or an explicit park signal (customer must be resolved, no invoice
 * number, or a duplicate number) the caller routes to needs_triage.
 */
export type ProposeSalesInvoiceOutcome =
  | ProposeSalesInvoiceResult
  | CustomerUnresolvedResult
  | InvoiceNumberMissingResult
  | DuplicateNumberResult;

/**
 * Result the workflow's idempotency replay surfaces for a sales-invoice draft —
 * either a fresh run or a replayed marker (the pipeline did NOT re-run). The
 * sales-invoice analogue of {@link DraftReplayResult}.
 */
export interface InvoiceDraftReplayResult {
  outcome: 'draft';
  invoiceId: number;
  pipelineResult: PipelineRunResult | ReplayedPipelineResult;
}

/**
 * ProposeDraftService — deterministic post-agent step that takes a validated
 * TriageResult and runs it through the existing posting pipeline.
 *
 * Flow:
 * 1. Takes a validated TriageResult with kind='new_expense'
 * 2. Calls ExpensesService.createExpense() with the result data
 * 3. Runs the existing PostingPipelineService.runPipeline() flow
 *    (generateDraftVoucher → Rules → Policy → post/hold)
 * 4. Writes an ai_proposal row for provenance audit
 *
 * Routing is NOT decided here — the IntakeWorkflowService is the single owner
 * of the `kind` + confidence decision and only ever calls this with a
 * validated, already-routed confident `new_expense`. The `kind` check below is
 * a defensive backstop (a misuse guard), not a second routing point: it throws
 * for any non-new_expense so a bypass can never produce a garbage draft.
 */
@Injectable()
export class ProposeDraftService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly expensesService: ExpensesService,
    private readonly entitiesService: EntitiesService,
    private readonly postingPipelineService: PostingPipelineService,
    private readonly config: AgentConfigService,
    private readonly categoryService: CategoryService,
    private readonly salesInvoicesService: SalesInvoicesService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Process a TriageResult through the posting pipeline.
   *
   * Returns a discriminated {@link ProposeDraftOutcome}: a created draft, or an
   * explicit `supplier-unresolved` signal when the supplier_proposal's
   * `create` mode finds no strong identifier to anchor a Supplier (or the
   * anchor is ambiguous), a `category-unresolved` signal when the AI emits a
   * category outside the active plugin's set, or a `possible-duplicate`
   * signal from the duplicate gate (all route to needs_triage). Note: a
   * `create` proposal is NOT always unresolved — ADR-0014's multi-key
   * find-or-onboard can identifier-resolve it to an EXISTING supplier, and
   * that resolved supplier is run through the SAME duplicate gate as a
   * `match` proposal below (this is exactly the bypass a routeExpense-only
   * gate missed). None of these signals is ever a silent null-supplier draft;
   * the caller routes each to needs_triage.
   *
   * @param triageResult - The validated AI triage output
   * @param documentId - Optional document ID to associate with the expense
   * @param supplierId - Optional explicit supplier ID. When omitted, the
   *   supplier is resolved from `triageResult.supplier_proposal` (a 'match'
   *   proposal resolves to its entity id; a 'create' proposal does ADR-0014
   *   multi-key find-or-onboard, which may resolve it to an EXISTING
   *   supplier or, if no strong identifier anchors it, leave it unresolved).
   * @param claimantId - Optional claimant Entity id. When set, the expense is
   *   a personal-reimbursement claim and the Cr leg posts to CLAIMANT_PAYABLE
   *   (Task 6/VoucherProjection). Propagated from the document's claimant_id.
   */
  async proposeDraft(
    triageResult: TriageResult,
    documentId?: number | null,
    supplierId?: number | null,
    claimantId?: number | null,
    enrichmentContext?: Pass2Enrichment,
  ): Promise<ProposeDraftOutcome> {
    // Defensive backstop, NOT a routing point: the workflow already decided
    // this is a confident new_expense. Reject anything else so a bypass can
    // never create a garbage draft. (correction/duplicate wired in Task 43.)
    if (triageResult.kind !== 'new_expense') {
      throw new BadRequestException(
        `proposeDraft only supports kind='new_expense', got '${triageResult.kind}'. ` +
          `Routing is owned by IntakeWorkflowService; other kinds (correction, ` +
          `duplicate, unknown) will be wired in Task 43.`,
      );
    }

    // Extracted-evidence validation BEFORE any Expense row exists (issue
    // #405). The strict schema cannot see a failed extraction that still
    // parses: a columnar layout made the model anchor on labels and take the
    // FOLLOWING token, so the gross came out 0 (and the next field's value
    // became the invoice number). Letting that through created a junk
    // zero-amount draft and then faulted at the pipeline as an "unexpected"
    // level-50 error; the kernel's positive-gross guard stays in place — this
    // is the earlier, typed seam so nothing is persisted and no fault fires.
    // It runs for EVERY caller of proposeDraft, covering a fresh Pass-2
    // classification AND a replayed/cached proposal (resolveSupplier), since
    // both go through this one choke point.
    if (!isValidExtractedGross(triageResult.gross_amount)) {
      // Operator-facing (issue #405): WHAT was read and WHY it cannot be
      // booked, in money terms — backend field names stay out of the primary
      // sentence. The stable "AI purchase extraction is invalid" marker at
      // the start makes classifyReasonType persist the typed
      // `evidence_invalid` reason at write time (the same marker-based
      // pattern the supplier/duplicate routes use), so the SPA renders this
      // outcome's copy from the TYPE, never from parsing this prose.
      return {
        outcome: 'evidence-invalid',
        reason: invalidPurchaseEvidenceReason(triageResult),
      };
    }

    // Category guard: the model is given the closed category set (Task 4) but
    // Zod admits any string. If the emitted category is not in the active
    // plugin's set, return an explicit signal so the caller routes to
    // needs_triage rather than letting createExpense throw a 500 or silently
    // booking to EXPENSE_OTHER (ADR-0002/0024).
    if (!(await this.categoryService.isValid(triageResult.category))) {
      return {
        outcome: 'category-unresolved',
        reason: `new_expense has an unknown category '${triageResult.category}'`,
      };
    }

    // Step 0: EXPLICIT supplier resolution. A 'match' proposal resolves to its
    // entity id; a 'create' proposal find-or-onboards the Supplier from the
    // document evidence (ADR-0014). Only a genuine onboard failure stays
    // unresolved → needs_triage; we never silently produce a null-supplier draft.
    const resolved = await this.resolveSupplier(
      triageResult.supplier_proposal,
      supplierId,
      enrichmentContext,
    );
    if (resolved.outcome === 'supplier-unresolved') {
      return resolved;
    }
    const resolvedSupplierId = resolved.supplierId;

    // Legacy recovery (issue #405 follow-up): withdraw the pre-fix junk
    // drafts a failed extraction left on THIS document before the healthy
    // one is created — otherwise the junk row stays the document's EARLIEST
    // draft and the idempotency replay / details() keep preferring it over
    // the recovered healthy draft. Doc-local, protected and audited; see
    // {@link withdrawInvalidPurchaseDrafts}.
    await this.withdrawInvalidPurchaseDrafts(documentId);

    // Step 1: Create the Expense via ExpensesService. The duplicate gate lives
    // THERE (issue #195), at the single choke point every creation path goes
    // through, so no path — auto, explicit-supplier or manual — can slip past
    // it. Note the DTO below deliberately has no `allow_duplicate` key: the
    // escape hatch is an operator decision and the AI must never take it.
    const createExpenseDto: CreateExpenseDto = {
      document_id: documentId ?? null,
      supplier_id: resolvedSupplierId,
      category: triageResult.category,
      gross_amount: triageResult.gross_amount,
      vat_amount: triageResult.vat_amount,
      currency: triageResult.currency,
      tax_point_date: triageResult.tax_point_date,
      document_vat_marking: triageResult.document_vat_marking,
      supplier_invoice_number: triageResult.supplier_invoice_number,
      claimant_id: claimantId ?? null,
      company_addressed_receipt: triageResult.company_addressed_receipt ?? null,
      // Persist LLM classification facts so Details (Task 8) can render them
      // without re-invoking the model (ADR-0039).
      ai_confidence: triageResult.confidence,
      ai_document_type: triageResult.document_type,
      ai_kind: triageResult.kind,
    };

    let expense;
    try {
      expense = await this.expensesService.createExpense(createExpenseDto);
    } catch (e) {
      if (!(e instanceof DuplicateExpenseException)) throw e;
      // The deterministic key recognised this document. Translate the 409 into
      // a typed outcome rather than letting it escape as an unhandled error on
      // the intake queue.
      //
      // A RECEIPT that matches an INVOICE-derived expense is the normal
      // invoice+receipt email pair: it evidences a purchase already recorded,
      // so the caller files it away silently.
      //
      // A receipt that matches ANOTHER RECEIPT is not that pair. The receipt-
      // only population is exactly the restaurant/cafe/car-sharing vendors that
      // print no invoice number and repeat identical amounts on one day, so the
      // amount+date fallback fires on two genuinely distinct purchases. Filing
      // the second one silently would drop a deductible expense with no
      // expense, no voucher and no work item — only an audit_log line. Those
      // go to a human like any other suspected duplicate.
      if (
        triageResult.document_type === 'receipt' &&
        e.existingDocumentType !== 'receipt'
      ) {
        return {
          outcome: 'receipt-matched',
          reason: `receipt for expense #${e.existingExpenseId}: ${e.message}`,
          existingExpenseId: e.existingExpenseId,
        };
      }
      return {
        outcome: 'possible-duplicate',
        reason: e.message,
        existingExpenseId: e.existingExpenseId,
      };
    }

    // Step 2: Run the existing posting pipeline (generateDraftVoucher → Rules → Policy → post).
    // Thread confidence and supplier-known status to Policy.
    const pipelineResult = await this.postingPipelineService.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () =>
        this.expensesService.generateDraftVoucher(expense.id),
      // Same staleness guard as the HTTP post path: the supplier's country and
      // tax status decide the VAT treatment and the KMD acquisition row, so a
      // draft prepared against facts that have since moved must not post
      // (issues #209, #210).
      assertFactsUnchanged: await this.expenseFactsGuard(expense.id),
      category: expense.category,
      refetch: () => this.expensesService.getExpenseById(expense.id),
      confidence: triageResult.confidence,
      supplierKnown: resolvedSupplierId !== null,
    });

    // Step 3: Write AI provenance row (operational audit, NOT hash-chained).
    await this.writeAiProvenance(expense.id, triageResult);

    return {
      outcome: 'draft',
      expenseId: expense.id,
      pipelineResult,
    };
  }

  /**
   * Withdraw the invalid unposted AI purchase drafts a pre-fix failed
   * extraction left on a document (issue #405 follow-up, legacy recovery).
   *
   * Scope — deliberately narrow, all conditions required:
   * - SAME document only (nothing global);
   * - AI PURCHASE provenance only (`ai_kind = 'new_expense'` with an
   *   invoice/receipt `ai_document_type`) — exactly the metadata the
   *   pre-fix proposeDraft persisted, so a manually entered incomplete
   *   draft (`ai_kind` null) or any other provenance is never touched;
   * - `status = 'draft'` AND `voucher_id IS NULL` — posted, pending and
   *   reversed expenses are never touched (a posted voucher is immutable;
   *   correct via reversal; reject an approval first), and an expense that
   *   already minted a voucher is out of reach;
   * - no open approval references the row (a pending approval must not be
   *   orphaned);
   * - an INVALID gross (not a positive whole minor-unit amount — the same
   *   validity rule as the extraction seam).
   *
   * Called on BOTH outcomes of a retry: when a healthy proposal creates the
   * recovered draft (proposeDraft) AND when the retry fails again
   * (the workflow's evidence-invalid routes) — a failed extraction must not
   * leave or prefer a junk invalid draft for this document either way.
   * No blind migration: production junk rows are only ever removed through
   * this operator-driven retry path, one document at a time.
   *
   * One transaction; every withdrawal writes an audit_log entry (ADR-0026)
   * so the act and its trace commit or roll back together.
   */
  async withdrawInvalidPurchaseDrafts(
    documentId: number | null | undefined,
  ): Promise<void> {
    if (documentId == null) return;
    await this.db.transaction().execute(async (trx) => {
      const drafts = await trx
        .selectFrom('expense')
        .select([
          'id',
          'gross_amount',
          'supplier_invoice_number',
          'ai_kind',
          'ai_document_type',
        ])
        .where('document_id', '=', documentId)
        .where('status', '=', 'draft')
        .where('voucher_id', 'is', null)
        .execute();
      for (const row of drafts) {
        // Only the AI purchase path's own rows — the metadata the pre-fix
        // proposeDraft persisted. Manual or otherwise-sourced drafts stay.
        if (row.ai_kind !== 'new_expense') continue;
        if (
          row.ai_document_type !== 'invoice' &&
          row.ai_document_type !== 'receipt'
        ) {
          continue;
        }
        if (isValidExtractedGross(row.gross_amount)) continue;
        // A pending approval references the row — it must not be orphaned.
        const approval = await trx
          .selectFrom('approval')
          .select('id')
          .where('object_type', '=', 'expense')
          .where('object_id', '=', row.id)
          .where('status', '=', 'pending')
          .executeTakeFirst();
        if (approval) continue;
        await trx.deleteFrom('expense').where('id', '=', row.id).execute();
        await this.auditLog.record(
          {
            actor: 'system',
            action: 'expense.invalid_purchase_draft.withdrawn',
            outcome: 'allowed',
            target_type: 'expense',
            target_id: row.id,
            detail: {
              document_id: documentId,
              gross_amount: row.gross_amount,
              supplier_invoice_number: row.supplier_invoice_number,
              reason:
                'pre-fix failed AI extraction left an unbookable invalid-gross ' +
                'draft on this document; withdrawn when the document was ' +
                'retried (issue #405)',
            },
          },
          trx,
        );
      }
    });
  }

  /**
   * Resolve a supplier_proposal (plus any explicit override) to a concrete
   * Supplier id — the EXPLICIT proposal→Supplier step (ADR-0014, ADR-0024).
   *
   * - An explicit `supplierId` (already resolved by the caller) wins.
   * - A `{ mode: 'match', match_entity_id }` proposal resolves to that id.
   * - A `{ mode: 'create', ... }` proposal does MULTI-KEY find-or-onboard on the
   *   strong identifiers present (registration key / email / phone; address is
   *   stored on a new supplier but is never a match key — false-merge risk).
   *   With no strong identifier the call returns `supplier-unresolved` (operator
   *   triage); a single existing match is reused and enriched with any new
   *   identifiers; multiple distinct matches are ambiguous and also return
   *   `supplier-unresolved`; no match onboards a new Supplier with all
   *   identifiers.
   * - No proposal at all resolves to a null supplier (Policy gates unknown
   *   suppliers downstream), preserving the prior behavior.
   */
  private async resolveSupplier(
    proposal: SupplierProposal | undefined,
    explicitSupplierId?: number | null,
    enrichmentContext?: Pass2Enrichment,
  ): Promise<
    | { outcome: 'resolved'; supplierId: number | null }
    | SupplierUnresolvedResult
  > {
    if (explicitSupplierId != null) {
      return { outcome: 'resolved', supplierId: explicitSupplierId };
    }
    if (!proposal) {
      return { outcome: 'resolved', supplierId: null };
    }
    if (proposal.mode === 'match') {
      const deterministicMatchEntityId =
        enrichmentContext?.supplier?.matchEntityId;
      if (
        deterministicMatchEntityId !== undefined &&
        deterministicMatchEntityId !== proposal.match_entity_id
      ) {
        return {
          outcome: 'supplier-unresolved',
          reason: `match proposal references entity ${proposal.match_entity_id}, but deterministic enrichment resolved supplier ${deterministicMatchEntityId}`,
        };
      }

      // Validate the agent-proposed entity BEFORE trusting it. A hallucinated id
      // (field case: match_entity_id 500001) or a wrong-role match would feed a
      // phantom/incorrect supplier_id into createExpense — an FK violation that
      // strands the document in `pending` with no recovery path. A miss routes to
      // operator triage instead, exactly like the `create` branch, so the
      // document stays recoverable (resolve-supplier / manual-classify).
      let matched;
      try {
        matched = await this.entitiesService.findById(proposal.match_entity_id);
      } catch (e) {
        if (e instanceof NotFoundException) {
          return {
            outcome: 'supplier-unresolved',
            reason: `match proposal references entity ${proposal.match_entity_id}, which does not exist`,
          };
        }
        throw e;
      }
      if (matched.role !== 'supplier') {
        return {
          outcome: 'supplier-unresolved',
          reason: `match proposal references entity ${proposal.match_entity_id}, which is a '${matched.role}', not a supplier`,
        };
      }

      // Corroborate the match against the identity the agent OBSERVED on the
      // document (ADR-0014). We reject ONLY on a positive contradiction — an
      // absent observed value never forces a false reject. This catches a
      // plausible-but-wrong semantic match (an EE rent invoice resolved to a US
      // software vendor) that existence + role validation cannot.
      const observedCountry = proposal.observed_country?.trim();
      if (
        observedCountry &&
        observedCountry.toUpperCase() !== matched.country.trim().toUpperCase()
      ) {
        return {
          outcome: 'supplier-unresolved',
          reason: `match to entity ${proposal.match_entity_id} (country ${matched.country}) contradicts the document's observed country ${observedCountry}`,
        };
      }
      const observedRegKey = proposal.observed_registration_key
        ? normalizeIdentifier(
            'registration_key',
            proposal.observed_registration_key,
          )
        : null;
      if (observedRegKey) {
        const entityRegKeys = matched.identifiers
          .filter((i) => i.kind === 'registration_key')
          .map((i) => normalizeIdentifier('registration_key', i.value));
        // Only a contradiction (the entity carries reg keys, none of which is
        // the observed one) rejects; an entity with no reg key cannot disprove.
        if (
          entityRegKeys.length > 0 &&
          !entityRegKeys.includes(observedRegKey)
        ) {
          return {
            outcome: 'supplier-unresolved',
            reason: `match to entity ${proposal.match_entity_id} contradicts the document's observed registration key ${proposal.observed_registration_key}`,
          };
        }
      }
      return { outcome: 'resolved', supplierId: proposal.match_entity_id };
    }
    // mode === 'create' — multi-key find-or-onboard (ADR-0014).
    // Match candidates are the STRONG identifiers (reg/email/phone); address is
    // stored on a new supplier but is never a match key (false-merge risk).
    const matchCandidates: { kind: string; value: string }[] = [];
    if (proposal.create_registration_key)
      matchCandidates.push({
        kind: 'registration_key',
        value: proposal.create_registration_key,
      });
    if (proposal.create_email)
      matchCandidates.push({ kind: 'email', value: proposal.create_email });
    if (proposal.create_phone)
      matchCandidates.push({ kind: 'phone', value: proposal.create_phone });

    // No strong identifier to anchor on → route to operator triage rather than
    // spawning an unanchored duplicate.
    if (matchCandidates.length === 0) {
      return {
        outcome: 'supplier-unresolved',
        reason:
          'create proposal carries no strong identifier (registration key / email / phone) to match or anchor a supplier',
      };
    }

    try {
      const matches =
        await this.entitiesService.resolveByIdentifiers(matchCandidates);

      if (matches.length > 1) {
        // Ambiguous: identifiers point at distinct existing suppliers (possibly
        // a sign they should be merged). Never guess.
        return {
          outcome: 'supplier-unresolved',
          reason: `ambiguous supplier: identifiers match ${matches.length} existing entities (${matches.join(', ')})`,
        };
      }

      if (matches.length === 1) {
        const supplierId = matches[0];
        // Enrich: backfill any identifier this supplier does not yet carry.
        // A null field is passed as '' which normalizes to null → addIdentifierIfAbsent no-ops,
        // so absent identifiers are simply skipped. At least one candidate matched here, so the
        // supplier always keeps a real anchor.
        await this.entitiesService.addIdentifierIfAbsent(
          supplierId,
          'registration_key',
          proposal.create_registration_key ?? '',
        );
        await this.entitiesService.addIdentifierIfAbsent(
          supplierId,
          'email',
          proposal.create_email ?? '',
        );
        await this.entitiesService.addIdentifierIfAbsent(
          supplierId,
          'phone',
          proposal.create_phone ?? '',
        );
        await this.entitiesService.addIdentifierIfAbsent(
          supplierId,
          'address',
          proposal.create_address ?? '',
        );
        return { outcome: 'resolved', supplierId };
      }

      // No match — onboard a new supplier with ALL present identifiers (incl. address).
      const identifiers = [
        ...matchCandidates,
        ...(proposal.create_address
          ? [{ kind: 'address', value: proposal.create_address }]
          : []),
      ];
      const created = await this.entitiesService.onboardWithIdentifiers({
        role: 'supplier',
        country: proposal.create_country,
        name: proposal.create_name,
        identifiers,
      });
      return { outcome: 'resolved', supplierId: created.id };
    } catch (e) {
      return {
        outcome: 'supplier-unresolved',
        reason: `supplier resolution failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Create an expense and run the posting pipeline from operator-supplied data,
   * bypassing the AI classification passes. Used by the manual-classify endpoint
   * when a human operator fills in all fields directly (no AI confidence gate).
   *
   * Deliberately does NOT translate a {@link DuplicateExpenseException} into a
   * typed outcome the way `proposeDraft` does: this call has a human on the
   * other end of it, so the 409 travels back to them naming the original, and
   * they either drop the document or re-submit with `allow_duplicate: true`.
   */
  async manualClassifyDraft(
    documentId: number,
    dto: {
      supplier_id: number;
      category: string;
      document_vat_marking: string | null;
      gross_amount: number;
      vat_amount: number;
      currency: string;
      tax_point_date: string;
      supplier_invoice_number?: string | null;
      allow_duplicate?: boolean;
    },
  ): Promise<ProposeDraftResult> {
    const createExpenseDto: CreateExpenseDto = {
      document_id: documentId,
      supplier_id: dto.supplier_id,
      category: dto.category,
      gross_amount: dto.gross_amount,
      vat_amount: dto.vat_amount,
      currency: dto.currency,
      tax_point_date: dto.tax_point_date,
      document_vat_marking: dto.document_vat_marking,
      supplier_invoice_number: dto.supplier_invoice_number ?? null,
      // Operator override for the duplicate guard (issue #195). Unlike
      // proposeDraft's AI-built DTO, this one is filled in by a human who is
      // looking at the document, so it may carry the escape hatch. Absent
      // unless the operator explicitly asked for it; createExpense records the
      // override in audit_log when it actually overrode a detection.
      allow_duplicate: dto.allow_duplicate,
    };

    const expense = await this.expensesService.createExpense(createExpenseDto);

    const pipelineResult = await this.postingPipelineService.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () =>
        this.expensesService.generateDraftVoucher(expense.id),
      // Same staleness guard as the HTTP post path (issues #209, #210).
      assertFactsUnchanged: await this.expenseFactsGuard(expense.id),
      category: expense.category,
      refetch: () => this.expensesService.getExpenseById(expense.id),
      supplierKnown: true,
      requestedBy: 'operator',
      // confidence intentionally omitted: skip AI confidence gate for manual entry
    });

    // Construct a TriageResult-compatible provenance record for the audit row.
    const provenanceResult: TriageResult = {
      kind: 'new_expense',
      gross_amount: dto.gross_amount,
      vat_amount: dto.vat_amount,
      tax_point_date: dto.tax_point_date,
      category: dto.category,
      supplier_proposal: { mode: 'match', match_entity_id: dto.supplier_id },
      document_type: 'invoice',
      currency: dto.currency,
      document_vat_marking: dto.document_vat_marking,
      supplier_invoice_number: dto.supplier_invoice_number ?? null,
      confidence: 1.0,
      outgoing_signals: {
        org_name_is_issuer: false,
        org_vat_is_issuer: false,
        has_buyer_block: false,
        self_identifies_as_invoice: false,
      },
    };
    await this.writeAiProvenance(expense.id, provenanceResult);

    return { outcome: 'draft', expenseId: expense.id, pipelineResult };
  }

  /**
   * Book a SalesInvoice draft from operator-supplied data, bypassing the AI
   * classification passes — the sales-invoice analogue of
   * {@link manualClassifyDraft}. Used by the manual-classify endpoint when an
   * operator classifies a parked document as an OUTGOING invoice and fills in
   * all fields directly (no AI confidence gate).
   *
   * Returns a {@link ProposeSalesInvoiceResult} on success, or a
   * {@link DuplicateNumberResult} when the invoice number collides (a UNIQUE
   * violation, almost always a re-upload). `invoice-number-missing` cannot
   * happen here — the DTO requires `invoice_number`.
   */
  async manualClassifyInvoiceDraft(
    documentId: number,
    dto: {
      customer_id?: number | null;
      invoice_number: string;
      gross_amount: number;
      vat_amount: number;
      currency: string;
      tax_point_date: string;
      document_vat_marking?: string | null;
    },
  ): Promise<ProposeSalesInvoiceResult | DuplicateNumberResult> {
    let invoice;
    try {
      invoice = await this.salesInvoicesService.createInvoice({
        document_id: documentId,
        customer_id: dto.customer_id ?? null,
        invoice_number: dto.invoice_number,
        gross_amount: dto.gross_amount,
        vat_amount: dto.vat_amount,
        currency: dto.currency,
        tax_point_date: dto.tax_point_date,
        document_vat_marking: dto.document_vat_marking ?? null,
      });
    } catch (err) {
      if (isInvoiceNumberConflict(err)) {
        return {
          outcome: 'duplicate-number',
          reason: `invoice number ${dto.invoice_number} already exists (likely a duplicate of an already-booked invoice)`,
        };
      }
      throw err;
    }

    const pipelineResult = await this.postingPipelineService.runPipeline({
      businessObjectId: invoice.id,
      businessObjectType: 'sales_invoice',
      draftGenerator: () =>
        this.salesInvoicesService.generateDraftVoucher(invoice.id),
      // Same staleness guard as the HTTP post path (issue #209).
      assertFactsUnchanged: await this.salesInvoiceFactsGuard(invoice.id),
      category: 'revenue',
      refetch: () => this.salesInvoicesService.getInvoiceById(invoice.id),
      requestedBy: 'operator',
    });

    return { outcome: 'draft', invoiceId: invoice.id, pipelineResult };
  }

  /**
   * The pipeline's optimistic-concurrency guard for an expense: capture the
   * facts now — the expense's own amounts AND the supplier facts that decide
   * its VAT treatment and acquisition row — and refuse inside the posting
   * transaction if they moved (issues #209, #210).
   */
  private async expenseFactsGuard(
    expenseId: number,
  ): Promise<(trx: Kysely<Database>) => Promise<void>> {
    const captured =
      await this.expensesService.draftFactsFingerprint(expenseId);
    return (trx) =>
      this.expensesService.assertDraftFactsUnchangedTx(
        trx,
        expenseId,
        captured,
      );
  }

  /**
   * The pipeline's optimistic-concurrency guard for a sales invoice: capture the
   * facts now, refuse inside the posting transaction if they moved (issue #209).
   */
  private async salesInvoiceFactsGuard(
    invoiceId: number,
  ): Promise<(trx: Kysely<Database>) => Promise<void>> {
    const captured =
      await this.salesInvoicesService.draftFactsFingerprint(invoiceId);
    return (trx) =>
      this.salesInvoicesService.assertDraftFactsUnchangedTx(
        trx,
        invoiceId,
        captured,
      );
  }

  /**
   * Find an Expense already drafted from a Document, if any. Used by the
   * IntakeWorkflowService idempotency guard to replay an already-triaged
   * Document's draft instead of creating a second one. Returns the lightweight
   * identity (expenseId) wrapped so an idempotent re-run is observably a no-op;
   * the full pipeline is NOT re-run.
   */
  async findExistingDraft(
    documentId: number,
  ): Promise<DraftReplayResult | undefined> {
    const expense = await this.db
      .selectFrom('expense')
      .select('id')
      .where('document_id', '=', documentId)
      .orderBy('id', 'asc')
      .executeTakeFirst();

    if (!expense) {
      return undefined;
    }

    return {
      outcome: 'draft',
      expenseId: expense.id,
      // The pipeline already ran on the original pass; a replay does not
      // re-post. `replayed` marks this as an idempotent surfacing, not a
      // fresh pipeline run.
      pipelineResult: { replayed: true },
    };
  }

  /**
   * Book a detected OUTGOING invoice as a SalesInvoice draft and run the
   * posting pipeline — the sales-invoice analogue of {@link proposeDraft}.
   *
   * Returns a discriminated {@link ProposeSalesInvoiceOutcome}: a created
   * draft, or an explicit park signal the caller routes to needs_triage —
   * `invoice-number-missing` (no printed number to use as ours),
   * `customer-unresolved` (the customer must be created/selected by an
   * operator — v1 never auto-creates a customer), or `duplicate-number` (the
   * number already exists, almost always a re-upload).
   *
   * @param triageResult - The validated AI triage output (kind
   *   'new_sales_invoice'). Routing is owned by IntakeWorkflowService.
   * @param documentId - The Document this outgoing invoice was detected on.
   * @param customerId - Optional explicit customer id (operator-resolved). When
   *   omitted, the customer is resolved from `triageResult.customer_proposal`.
   */
  async proposeSalesInvoiceDraft(
    triageResult: TriageResult,
    documentId: number,
    customerId?: number | null,
  ): Promise<ProposeSalesInvoiceOutcome> {
    // The document's printed invoice number IS our number for an outgoing
    // invoice. Without one there is nothing to book under.
    const invoiceNumber = triageResult.supplier_invoice_number;
    if (!invoiceNumber) {
      return {
        outcome: 'invoice-number-missing',
        reason: 'no invoice number found on the document',
      };
    }

    const resolved = await this.resolveCustomer(
      triageResult.customer_proposal,
      customerId,
    );
    if (resolved.outcome === 'customer-unresolved') {
      return resolved;
    }

    let invoice;
    try {
      invoice = await this.salesInvoicesService.createInvoice({
        document_id: documentId,
        customer_id: resolved.customerId,
        invoice_number: invoiceNumber,
        gross_amount: triageResult.gross_amount,
        vat_amount: triageResult.vat_amount,
        currency: triageResult.currency,
        tax_point_date: triageResult.tax_point_date,
        document_vat_marking: triageResult.document_vat_marking,
      });
    } catch (err) {
      if (isInvoiceNumberConflict(err)) {
        return {
          outcome: 'duplicate-number',
          reason: `invoice number ${invoiceNumber} already exists (likely a duplicate of an already-booked invoice)`,
        };
      }
      throw err;
    }

    const pipelineResult = await this.postingPipelineService.runPipeline({
      businessObjectId: invoice.id,
      businessObjectType: 'sales_invoice',
      draftGenerator: () =>
        this.salesInvoicesService.generateDraftVoucher(invoice.id),
      // Same staleness guard as the HTTP post path (issue #209).
      assertFactsUnchanged: await this.salesInvoiceFactsGuard(invoice.id),
      category: 'revenue',
      refetch: () => this.salesInvoicesService.getInvoiceById(invoice.id),
    });

    return { outcome: 'draft', invoiceId: invoice.id, pipelineResult };
  }

  /**
   * Resolve a customer_proposal (plus any explicit override) to a concrete
   * Customer id for an outgoing invoice.
   *
   * - An explicit `explicitCustomerId` (operator-resolved) wins.
   * - No proposal at all resolves to a null customer (the projection maps the
   *   standard domestic rate without a customer).
   * - A `{ mode: 'match', match_entity_id }` proposal resolves to that id.
   * - A `{ mode: 'create', ... }` proposal is NOT auto-created in v1 (unlike the
   *   supplier path): an outgoing invoice's customer is a known counterparty, so
   *   we park for an operator to create/select the customer and replay.
   */
  private async resolveCustomer(
    proposal: CustomerProposal | undefined,
    explicitCustomerId?: number | null,
  ): Promise<
    | { outcome: 'resolved'; customerId: number | null }
    | CustomerUnresolvedResult
  > {
    if (explicitCustomerId != null) {
      return { outcome: 'resolved', customerId: explicitCustomerId };
    }
    if (!proposal) {
      return { outcome: 'resolved', customerId: null };
    }
    if (proposal.mode === 'match') {
      return { outcome: 'resolved', customerId: proposal.match_entity_id };
    }
    // mode 'create' → v1 does NOT auto-create a customer (unlike supplier). Park
    // for an operator to create/select the customer, then resolve.
    return {
      outcome: 'customer-unresolved',
      reason:
        'customer must be created or selected by an operator before this outgoing invoice can be booked',
    };
  }

  /**
   * Find a SalesInvoice already drafted from a Document, if any. The
   * sales-invoice analogue of {@link findExistingDraft}, used by the
   * IntakeWorkflowService idempotency guard to replay an already-triaged
   * outgoing invoice's draft instead of creating a second one. The full
   * pipeline is NOT re-run (`replayed` marker).
   */
  async findExistingInvoiceDraft(
    documentId: number,
  ): Promise<InvoiceDraftReplayResult | undefined> {
    const invoice =
      await this.salesInvoicesService.findByDocumentId(documentId);
    if (!invoice) {
      return undefined;
    }
    return {
      outcome: 'draft',
      invoiceId: invoice.id,
      pipelineResult: { replayed: true },
    };
  }

  /**
   * Persist an ai_proposal row for audit provenance.
   * Looks up the ocr_markdown artifact for the expense's document.
   */
  private async writeAiProvenance(
    expenseId: number,
    triageResult: TriageResult,
  ): Promise<void> {
    // Look up the expense's document_id to find the ocr_markdown artifact.
    const expense = await this.db
      .selectFrom('expense')
      .select('document_id')
      .where('id', '=', expenseId)
      .executeTakeFirst();

    let ocrArtifactId: number | null = null;
    if (expense?.document_id) {
      const artifact = await this.db
        .selectFrom('artifact')
        .select('id')
        .where('document_id', '=', expense.document_id)
        .where('kind', '=', 'ocr_markdown')
        .executeTakeFirst();
      ocrArtifactId = artifact?.id ?? null;
    }

    const now = Math.floor(Date.now() / 1000);
    await this.db
      .insertInto('ai_proposal')
      .values({
        business_object_type: 'expense',
        business_object_id: expenseId,
        // The model that ACTUALLY ran classification (issue #179 review): the
        // strict TriageResult is produced by the `triage_classification`
        // agent, not the legacy combined `triage` agent (dead code, removed).
        // The `ai_proposal` row has no second model_id column for the
        // enrichment model, so this records the classification model — the
        // one that determined the persisted TriageResult.
        model_id: await this.config.resolveModel('triage_classification'),
        model_version: 'v1',
        raw_triage_result: JSON.stringify(triageResult),
        ocr_artifact_id: ocrArtifactId,
        confidence: triageResult.confidence,
        created_at: now,
      })
      .execute();
  }
}
