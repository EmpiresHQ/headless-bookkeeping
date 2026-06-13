import { Injectable, BadRequestException } from '@nestjs/common';
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
} from '../triage/types';
import { CreateExpenseDto } from '../expenses/types';
import { AgentConfigService } from './agent-config.service';
import { CategoryService } from '../categories/category.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';

/**
 * Whether a thrown error is the SQLite UNIQUE-constraint violation on
 * sales_invoice.invoice_number — a duplicate invoice number. Mirrors the check
 * the SalesInvoicesController uses to map createInvoice conflicts to 409; here
 * it lets proposeSalesInvoiceDraft return an explicit `duplicate-number`
 * outcome instead of a 500.
 */
export function isInvoiceNumberConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('UNIQUE constraint failed') &&
    err.message.includes('invoice_number')
  );
}

/** The posting pipeline's result shape (Rules → Policy → post/hold). */
export type PipelineRunResult = Awaited<
  ReturnType<typeof PostingPipelineService.prototype.runPipeline>
>;

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
 * Discriminated outcome of a fresh proposeDraft call: either a created draft
 * or an explicit "supplier could not be resolved, route to triage" signal, or
 * an explicit "category not in the active plugin's category set, route to
 * triage" signal.
 */
export type ProposeDraftOutcome =
  | ProposeDraftResult
  | SupplierUnresolvedResult
  | CategoryUnresolvedResult;

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
  ) {}

  /**
   * Process a TriageResult through the posting pipeline.
   *
   * Returns a discriminated {@link ProposeDraftOutcome}: a created draft, or an
   * explicit `supplier-unresolved` signal when the supplier_proposal asks to
   * CREATE a Supplier (deferred — Task 43), or a `category-unresolved` signal
   * when the AI emits a category outside the active plugin's set (both route to
   * needs_triage). The former is NEVER a silent null-supplier draft; the caller
   * routes it to needs_triage.
   *
   * @param triageResult - The validated AI triage output
   * @param documentId - Optional document ID to associate with the expense
   * @param supplierId - Optional explicit supplier ID. When omitted, the
   *   supplier is resolved from `triageResult.supplier_proposal` (a 'match'
   *   proposal resolves to its entity id; a 'create' proposal is unresolved).
   */
  async proposeDraft(
    triageResult: TriageResult,
    documentId?: number | null,
    supplierId?: number | null,
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
    );
    if (resolved.outcome === 'supplier-unresolved') {
      return resolved;
    }
    const resolvedSupplierId = resolved.supplierId;

    // Step 1: Create the Expense via ExpensesService.
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
    };

    const expense = await this.expensesService.createExpense(createExpenseDto);

    // Step 2: Run the existing posting pipeline (generateDraftVoucher → Rules → Policy → post).
    // Thread confidence and supplier-known status to Policy.
    const pipelineResult = await this.postingPipelineService.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () =>
        this.expensesService.generateDraftVoucher(expense.id),
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
    };

    const expense = await this.expensesService.createExpense(createExpenseDto);

    const pipelineResult = await this.postingPipelineService.runPipeline({
      businessObjectId: expense.id,
      businessObjectType: 'expense',
      draftGenerator: () => this.expensesService.generateDraftVoucher(expense.id),
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
      category: 'revenue',
      refetch: () => this.salesInvoicesService.getInvoiceById(invoice.id),
      requestedBy: 'operator',
    });

    return { outcome: 'draft', invoiceId: invoice.id, pipelineResult };
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
    const invoice = await this.salesInvoicesService.findByDocumentId(documentId);
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
        model_id: await this.config.resolveModel('triage'),
        model_version: 'v1',
        raw_triage_result: JSON.stringify(triageResult),
        ocr_artifact_id: ocrArtifactId,
        confidence: triageResult.confidence,
        created_at: now,
      })
      .execute();
  }
}
