import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { ValidationError } from '../ledger/posting/types';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import {
  AllowanceLimitService,
  AllowanceSplit,
} from '../allowances/allowance-limit.service';
import {
  AllowanceProjectionService,
  AllowanceRow,
} from '../allowances/allowance-projection.service';
import { healthFactsFromRow } from '../allowances/health-facts';
import { OrgContextResolver } from '../organization/org-context.resolver';
import type { AllowanceType } from '../plugins/allowance-rates.types';
import {
  Approval,
  ApprovalStatus,
  ApprovalObjectType,
  CreateApprovalDto,
  ListApprovalsQuery,
} from './types';
import { PostedVoucher } from '../ledger/voucher/types';

/** One row of an {@link ApprovalsService.approveBatch} result — success carries
 *  the approved approval + posted voucher; failure carries the error message. */
export type BatchApproveRow =
  | { id: number; ok: true; approval: Approval; voucher: PostedVoucher | null }
  | { id: number; ok: false; error: string };

/**
 * ApprovalsService — manages the lifecycle of approvals created when Policy
 * holds a Rules-valid voucher for human decision.
 *
 * States: pending → approved | rejected | superseded
 * Never auto-resolves (ADR-0012).
 *
 * Idempotent posting: approving an already-approved approval returns the
 * existing posted voucher without double-posting.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly postingService: PostingService,
    private readonly statusTransition: StatusTransitionService,
    private readonly expensesService: ExpensesService,
    private readonly salesInvoicesService: SalesInvoicesService,
    private readonly reconciliationService: ReconciliationService,
    private readonly allowanceLimitService: AllowanceLimitService,
    private readonly allowanceProjectionService: AllowanceProjectionService,
    private readonly orgContextResolver: OrgContextResolver,
  ) {}

  // ── Create ──────────────────────────────────────────────────────

  /**
   * Create a new approval when Policy decides to hold a voucher for
   * human approval.
   *
   * Also transitions the business object from 'draft' to 'pending'
   * atomically (matching the posting pipeline's claimForApproval).
   */
  async createApproval(dto: CreateApprovalDto): Promise<Approval> {
    // Reconciliation-match approvals are staged by the reconciliation engine
    // (executeMatch), never created through this generic endpoint — they have no
    // draft→pending business-object transition.
    if (dto.object_type === 'reconciliation_match') {
      throw new BadRequestException(
        'reconciliation_match approvals are created by the reconciliation engine, not here',
      );
    }
    // Note: 'allowance' is excluded from createApprovalSchema's Zod enum so it is
    // rejected at the controller validation layer (HTTP 422) before reaching here.
    // Allowance approvals are created by AllowanceService.submitAllowance() directly.
    const objectType = dto.object_type;
    const now = Math.floor(Date.now() / 1000);

    // Check for existing pending approval for the same object
    const existing = await this.db
      .selectFrom('approval')
      .selectAll()
      .where('object_type', '=', dto.object_type)
      .where('object_id', '=', dto.object_id)
      .where('status', '=', 'pending')
      .executeTakeFirst();

    if (existing) {
      throw new ConflictException(
        `A pending approval already exists for ${dto.object_type} ${dto.object_id}`,
      );
    }

    const result = await this.db.transaction().execute(async (trx) => {
      // Transition business object draft → pending via the single
      // status-transition seam (ADR-0006 / ADR-0021), matching the pipeline's
      // hold-for-approval claim.
      await this.statusTransition.transition(
        trx,
        objectType,
        dto.object_id,
        'draft',
        'pending',
        {
          conflictMessage: (actual) =>
            `${this.label(dto.object_type)} ${dto.object_id} is ${actual}, expected draft`,
        },
      );

      // Create the approval record
      const approval = await trx
        .insertInto('approval')
        .values({
          object_type: dto.object_type,
          object_id: dto.object_id,
          status: 'pending',
          requested_by: dto.requested_by,
          policy_reason: dto.reason ?? null,
          created_at: now,
          resolved_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return approval;
    });

    return this.mapRow(result);
  }

  // ── Approve ─────────────────────────────────────────────────────

  /**
   * Approve a pending approval and post the associated voucher.
   *
   * Idempotent: if the approval is already approved, returns the existing
   * posted voucher without double-posting.
   */
  async approveApproval(
    id: number,
    approvedBy: string,
  ): Promise<{ approval: Approval; voucher: PostedVoucher | null }> {
    const approval = await this.getApprovalById(id);

    // Idempotency: already approved
    if (approval.status === 'approved') {
      // Fetch the voucher if the business object has one
      const voucher = await this.getPostedVoucherForApproval(approval);
      return { approval, voucher };
    }

    if (approval.status !== 'pending') {
      throw new ConflictException(
        `Approval ${id} is ${approval.status}, cannot approve`,
      );
    }

    // Reconciliation matches are not voucher-generating business objects:
    // approving one ACTIVATES the sub-ledger link (and posts any realized-FX
    // voucher) via the reconciliation engine, rather than re-deriving and
    // posting a draft voucher from the object.
    if (approval.object_type === 'reconciliation_match') {
      return this.approveReconciliationMatch(approval, approvedBy);
    }

    // An allowance decides its split and its voucher INSIDE the posting
    // transaction (issue #212) — see approveAllowance. Everything else keeps
    // the pre-transaction derivation.
    if (approval.object_type === 'allowance') {
      return this.approveAllowance(approval, id, approvedBy);
    }

    // Generate the draft voucher BEFORE the transaction to avoid deadlock
    // (generateDraftVoucher uses this.db, not the transaction handle).
    const draft = await this.generateDraftVoucher(
      approval.object_type,
      approval.object_id,
    );

    // Resolve + structurally validate the re-derived draft through the single
    // write path (ADR-0019). An Approval re-derives its draft at post time
    // (ADR-0015); the semantic tier already passed at submit, so this posts as
    // a system-generated marker (structural + hard-process only). prepare()
    // throws ValidationError on a structural failure — re-thrown as 400 to
    // preserve the prior error type.
    let prepared;
    try {
      prepared = await this.postingService.prepare(draft, {
        kind: 'system-generated',
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new BadRequestException(err.errors.join('; '));
      }
      throw err;
    }

    const now = Math.floor(Date.now() / 1000);

    const fromStatus = 'pending';

    // Post the voucher and update everything atomically. The idempotency claim
    // is THE single status-transition seam, with the correct prior status for
    // the object type (ADR-0006 / ADR-0021). The transition co-writes
    // voucher_id once the voucher exists.
    const voucher = await this.db.transaction().execute(async (trx) => {
      await this.statusTransition.transition(
        trx,
        approval.object_type as 'expense' | 'sales_invoice' | 'allowance',
        approval.object_id,
        fromStatus,
        'posted',
        {
          conflictMessage: (actual) =>
            `${this.label(approval.object_type)} ${approval.object_id} is ${actual}, expected ${fromStatus}`,
        },
      );

      const voucher = await this.postingService.postVoucherTx(
        trx,
        draft,
        prepared.resolved,
      );

      // Re-point the now-posted object at its voucher.
      await trx
        .updateTable(
          approval.object_type as 'expense' | 'sales_invoice' | 'allowance',
        )
        .set({ voucher_id: voucher.id, updated_at: now })
        .where('id', '=', approval.object_id)
        .execute();

      // Update approval status
      await trx
        .updateTable('approval')
        .set({
          status: 'approved',
          approved_by: approvedBy,
          resolved_at: now,
        })
        .where('id', '=', id)
        .execute();

      await this.resolvePendingApprovalFindingTx(
        trx,
        id,
        now,
        approvedBy,
        'Approval approved',
      );

      return voucher;
    });

    const updatedApproval = await this.getApprovalById(id);
    return { approval: updatedApproval, voucher };
  }

  /**
   * Approve several approvals in one call. Each is approved independently
   * (reusing the idempotent {@link approveApproval}); a failure on one id is
   * captured as a per-id error rather than aborting the whole batch, so the
   * operator/agent confirms many holds (e.g. a statement's reconciliation
   * matches) without one bad id losing the rest. Returns one row per input id.
   */
  async approveBatch(
    ids: number[],
    approvedBy: string,
  ): Promise<BatchApproveRow[]> {
    const rows: BatchApproveRow[] = [];
    for (const id of ids) {
      try {
        const { approval, voucher } = await this.approveApproval(
          id,
          approvedBy,
        );
        rows.push({ id, ok: true, approval, voucher });
      } catch (e) {
        rows.push({
          id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return rows;
  }

  // ── Reject ──────────────────────────────────────────────────────

  /**
   * Reject a pending approval, returning the business object to draft state.
   */
  async rejectApproval(id: number, rejectedReason: string): Promise<Approval> {
    const approval = await this.getApprovalById(id);

    if (approval.status !== 'pending') {
      throw new ConflictException(
        `Approval ${id} is ${approval.status}, cannot reject`,
      );
    }

    // Rejecting a reconciliation match discards the draft link (ledger-neutral)
    // instead of returning a business object to draft.
    if (approval.object_type === 'reconciliation_match') {
      await this.reconciliationService.discardDraftMatch(approval.object_id);
      const now = Math.floor(Date.now() / 1000);
      await this.db
        .updateTable('approval')
        .set({
          status: 'rejected',
          rejected_reason: rejectedReason,
          resolved_at: now,
        })
        .where('id', '=', id)
        .execute();
      return this.getApprovalById(id);
    }

    const now = Math.floor(Date.now() / 1000);

    // Allowances use needs_triage as their pre-approval status; all other types use pending.
    const fromStatusForReject =
      approval.object_type === 'allowance' ? 'needs_triage' : 'pending';

    await this.db.transaction().execute(async (trx) => {
      // Return business object to draft via the single status-transition seam
      // (ADR-0006). The guarded transition rejects an illegal flip and atomically
      // claims only from the expected prior status.
      await this.statusTransition.transition(
        trx,
        approval.object_type as 'expense' | 'sales_invoice' | 'allowance',
        approval.object_id,
        fromStatusForReject,
        'draft',
        {
          conflictMessage: (actual) =>
            `${this.label(approval.object_type)} ${approval.object_id} is ${actual}, expected ${fromStatusForReject}`,
        },
      );

      // Update approval status
      await trx
        .updateTable('approval')
        .set({
          status: 'rejected',
          rejected_reason: rejectedReason,
          resolved_at: now,
        })
        .where('id', '=', id)
        .execute();

      await this.resolvePendingApprovalFindingTx(
        trx,
        id,
        now,
        null,
        rejectedReason,
      );
    });

    return this.getApprovalById(id);
  }

  // ── Supersede ───────────────────────────────────────────────────

  /**
   * Supersede a pending approval (e.g. when a newer version arrives).
   */
  async supersedeApproval(id: number, supersededBy: number): Promise<Approval> {
    const approval = await this.getApprovalById(id);

    if (approval.status !== 'pending') {
      throw new ConflictException(
        `Approval ${id} is ${approval.status}, cannot supersede`,
      );
    }

    // Verify the superseding approval exists
    const newer = await this.getApprovalById(supersededBy);
    if (!newer) {
      throw new NotFoundException(`Approval ${supersededBy} not found`);
    }

    const now = Math.floor(Date.now() / 1000);

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('approval')
        .set({
          status: 'superseded',
          superseded_by: supersededBy,
          resolved_at: now,
        })
        .where('id', '=', id)
        .execute();

      await this.resolvePendingApprovalFindingTx(
        trx,
        id,
        now,
        null,
        `Superseded by approval ${supersededBy}`,
      );
    });

    return this.getApprovalById(id);
  }

  // ── List ────────────────────────────────────────────────────────

  /**
   * List approvals with optional filters.
   */
  async listApprovals(query: ListApprovalsQuery = {}): Promise<Approval[]> {
    let qb = this.db.selectFrom('approval').selectAll();

    if (query.status) {
      qb = qb.where('status', '=', query.status);
    }
    if (query.object_type) {
      qb = qb.where('object_type', '=', query.object_type);
    }

    const rows = await qb.orderBy('created_at', 'desc').execute();
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * List only pending approvals.
   */
  async listPendingApprovals(): Promise<Approval[]> {
    return this.listApprovals({ status: 'pending' });
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Approve a reconciliation-match approval: delegate the activation (draft →
   * active + realized-FX posting) to the reconciliation engine, then mark the
   * approval approved. The `voucher` in the result is null — a match has no
   * business-object voucher (any FX voucher is incidental and recorded on the
   * match itself).
   */
  private async approveReconciliationMatch(
    approval: Approval,
    approvedBy: string,
  ): Promise<{ approval: Approval; voucher: PostedVoucher | null }> {
    await this.reconciliationService.activateMatch(approval.object_id);

    const now = Math.floor(Date.now() / 1000);
    await this.db
      .updateTable('approval')
      .set({ status: 'approved', approved_by: approvedBy, resolved_at: now })
      .where('id', '=', approval.id)
      .execute();

    return { approval: await this.getApprovalById(approval.id), voucher: null };
  }

  /**
   * Approve an allowance: decide its split, persist it, project its voucher and
   * post it — all inside ONE transaction (issue #212).
   *
   * The previous shape computed the split before the transaction, generated the
   * draft voucher from the row as it stood BEFORE that split was applied, then
   * wrote the split inside the transaction and posted the stale draft. Two
   * things went wrong with it:
   *
   *  - the persisted split and the posted voucher could describe different
   *    amounts, because the voucher was built from the pre-update row;
   *  - two approvals racing for the same remaining exemption both read the cap
   *    as unconsumed outside any transaction and both took it, overspending a
   *    statutory limit that is the entire point of the accounting.
   *
   * Here the allocation is read, decided, written, projected and posted under
   * one transaction handle. Every read inside it goes through `trx`: the SQLite
   * dialect holds a single connection, so a read off the root `db` while the
   * transaction is open deadlocks. The second of two concurrent approvals
   * therefore sees the first's committed usage, and the row, the voucher and
   * the report are derived from one decision rather than three.
   */
  private async approveAllowance(
    approval: Approval,
    id: number,
    approvedBy: string,
  ): Promise<{ approval: Approval; voucher: PostedVoucher | null }> {
    const now = Math.floor(Date.now() / 1000);

    const voucher = await this.db.transaction().execute(async (trx) => {
      const split = await this.computeAllowanceSplit(approval.object_id, trx);

      const updated = await this.applyAllowanceSplit(
        approval.object_id,
        split,
        now,
        trx,
      );

      const fringe = split.health?.fringeTax
        ? {
            tax: split.health.fringeTax,
            incomeTax: split.health.fringeTax.incomeTax,
            socialTax: split.health.fringeTax.socialTax,
          }
        : null;

      const draft = await this.allowanceProjectionService.project(
        updated,
        fringe,
      );

      // Resolve + structurally validate through the single write path
      // (ADR-0019), reading accounts through `trx`.
      let prepared;
      try {
        prepared = await this.postingService.prepare(
          draft,
          { kind: 'system-generated' },
          trx,
        );
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new BadRequestException(err.errors.join('; '));
        }
        throw err;
      }

      await this.statusTransition.transition(
        trx,
        'allowance',
        approval.object_id,
        'needs_triage',
        'posted',
        {
          conflictMessage: (actual) =>
            `Allowance ${approval.object_id} is ${actual}, expected needs_triage`,
        },
      );

      const posted = await this.postingService.postVoucherTx(
        trx,
        draft,
        prepared.resolved,
      );

      await trx
        .updateTable('allowance')
        .set({ voucher_id: posted.id, updated_at: now })
        .where('id', '=', approval.object_id)
        .execute();

      await trx
        .updateTable('approval')
        .set({ status: 'approved', approved_by: approvedBy, resolved_at: now })
        .where('id', '=', id)
        .execute();

      await this.resolvePendingApprovalFindingTx(
        trx,
        id,
        now,
        approvedBy,
        'Approval approved',
      );

      return posted;
    });

    return { approval: await this.getApprovalById(id), voucher };
  }

  /**
   * Compute (but do NOT write) the tax-free/taxable split for an allowance at
   * approval time, reading everything through the supplied handle.
   *
   * At submit time the split was preliminary — a PREVIEW of what the claim
   * would get if it posted right then. By the time a human approves, other
   * claims may have posted and consumed the limit, so the authoritative
   * allocation is made here, against committed state.
   */
  private async computeAllowanceSplit(
    allowanceId: number,
    executor: Transaction<Database>,
  ): Promise<AllowanceSplit> {
    const allowance = await executor
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', allowanceId)
      .executeTakeFirstOrThrow();

    const { organization } = await this.orgContextResolver.resolve(executor);

    const trip = allowance.trip_id
      ? await executor
          .selectFrom('business_trip')
          .selectAll()
          .where('id', '=', allowance.trip_id)
          .executeTakeFirst()
      : null;

    const domestic = trip
      ? trip.destination_country === organization.country
      : false;

    return this.allowanceLimitService.computeSplit(
      {
        claimantId: allowance.claimant_id,
        type: allowance.type as AllowanceType,
        days: allowance.days ?? undefined,
        km: allowance.km ?? undefined,
        inputAmount: allowance.input_amount ?? undefined,
        periodStart: allowance.period_start,
        periodEnd: allowance.period_end ?? undefined,
        domestic,
        year: new Date(allowance.period_start).getUTCFullYear(),
        excludeAllowanceId: allowance.id,
        healthFacts: healthFactsFromRow(allowance),
      },
      executor,
    );
  }

  /**
   * Write the decided split to the allowance row and return the row AS WRITTEN,
   * so the voucher is projected from the same values the books now hold rather
   * than from the version that was read before the decision.
   */
  private async applyAllowanceSplit(
    allowanceId: number,
    split: AllowanceSplit,
    now: number,
    trx: Transaction<Database>,
  ): Promise<AllowanceRow> {
    return trx
      .updateTable('allowance')
      .set({
        gross_amount: split.grossAmount,
        tax_free_amount: split.taxFreeAmount,
        taxable_amount: split.taxableAmount,
        breakdown:
          split.breakdown.length > 0 ? JSON.stringify(split.breakdown) : null,
        exemption_basis: split.health?.exemptionBasis ?? null,
        limit_window: split.health?.limitWindow ?? null,
        fringe_income_tax_amount: split.health?.fringeTax?.incomeTax ?? 0,
        fringe_social_tax_amount: split.health?.fringeTax?.socialTax ?? 0,
        updated_at: now,
      })
      .where('id', '=', allowanceId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async getApprovalById(id: number): Promise<Approval> {
    const row = await this.db
      .selectFrom('approval')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`Approval ${id} not found`);
    }

    return this.mapRow(row);
  }

  private async resolvePendingApprovalFindingTx(
    trx: Transaction<Database>,
    approvalId: number,
    now: number,
    transitionedBy: string | null,
    transitionReason: string,
  ): Promise<void> {
    await trx
      .updateTable('audit_finding')
      .set({
        status: 'resolved',
        resolved_at: now,
        transitioned_by: transitionedBy,
        transition_reason: transitionReason,
      })
      .where('finding_type', '=', 'pending_approval')
      .where('referenced_object_type', '=', 'approval')
      .where('referenced_object_id', '=', approvalId)
      .where('status', '=', 'open')
      .execute();
  }

  private async generateDraftVoucher(
    objectType: ApprovalObjectType,
    objectId: number,
  ) {
    switch (objectType) {
      case 'expense':
        return this.expensesService.generateDraftVoucher(objectId);
      case 'sales_invoice':
        return this.salesInvoicesService.generateDraftVoucher(objectId);
      case 'allowance':
        // An allowance's voucher is projected from the allocation decided
        // inside the posting transaction (see approveAllowance), never from the
        // row as it stood before. Deriving one here would rebuild it from stale
        // amounts and, for a health claim, omit the fringe-benefit tax lines
        // entirely — so this path refuses rather than producing a plausible
        // wrong voucher.
        throw new BadRequestException(
          'An allowance voucher is derived inside its posting transaction; ' +
            'approve the allowance through ApprovalsService.approveApproval.',
        );
      default:
        throw new BadRequestException(
          `Unknown object type: ${String(objectType)}`,
        );
    }
  }

  private async getPostedVoucherForApproval(
    approval: Approval,
  ): Promise<PostedVoucher | null> {
    // A reconciliation match has no business-object voucher.
    if (approval.object_type === 'reconciliation_match') {
      return null;
    }

    // Look up the business object to find its voucher_id
    const row = await this.db
      .selectFrom(
        approval.object_type as 'expense' | 'sales_invoice' | 'allowance',
      )
      .select('voucher_id')
      .where('id', '=', approval.object_id)
      .executeTakeFirst();

    if (!row?.voucher_id) {
      return null;
    }

    const voucher = await this.db
      .selectFrom('voucher')
      .selectAll()
      .where('id', '=', row.voucher_id)
      .executeTakeFirst();

    if (!voucher) {
      return null;
    }

    const lines = await this.db
      .selectFrom('voucher_line')
      .selectAll()
      .where('voucher_id', '=', voucher.id)
      .orderBy('id')
      .execute();

    return {
      ...voucher,
      lines: lines.map((l) => ({
        id: l.id,
        voucher_id: l.voucher_id,
        account_id: l.account_id,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        fx_rate_date: l.fx_rate_date,
        fx_rate_source: l.fx_rate_source,
        vat_code: l.vat_code,
        is_debit: l.is_debit === 1,
      })),
    };
  }

  private label(type: ApprovalObjectType): string {
    switch (type) {
      case 'expense':
        return 'Expense';
      case 'sales_invoice':
        return 'SalesInvoice';
      case 'allowance':
        return 'Allowance';
      case 'reconciliation_match':
        return 'ReconciliationMatch';
    }
  }

  private mapRow(row: {
    id: number;
    object_type: string;
    object_id: number;
    status: string;
    requested_by: string;
    approved_by: string | null;
    rejected_reason: string | null;
    policy_reason: string | null;
    superseded_by: number | null;
    created_at: number;
    resolved_at: number | null;
  }): Approval {
    return {
      id: row.id,
      object_type: row.object_type as ApprovalObjectType,
      object_id: row.object_id,
      status: row.status as ApprovalStatus,
      requested_by: row.requested_by,
      approved_by: row.approved_by,
      rejected_reason: row.rejected_reason,
      policy_reason: row.policy_reason,
      superseded_by: row.superseded_by,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    };
  }
}
