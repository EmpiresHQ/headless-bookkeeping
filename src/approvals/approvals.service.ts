import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { PostingService } from '../ledger/posting/posting.service';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import { ValidationError } from '../ledger/posting/types';
import { ExpensesService } from '../expenses/expenses.service';
import { SalesInvoicesService } from '../sales-invoices/sales-invoices.service';
import {
  Approval,
  ApprovalStatus,
  ApprovalObjectType,
  CreateApprovalDto,
  ListApprovalsQuery,
} from './types';
import { PostedVoucher } from '../ledger/voucher/types';

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
        dto.object_type,
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

    // Post the voucher and update everything atomically. The idempotency claim
    // is THE single status-transition seam, with `pending` as the expected
    // prior status (ADR-0006 / ADR-0021) — the same guarantee the auto-post
    // path gets with `draft`. The pending → posted transition co-writes
    // voucher_id once the voucher exists.
    const voucher = await this.db.transaction().execute(async (trx) => {
      await this.statusTransition.transition(
        trx,
        approval.object_type,
        approval.object_id,
        'pending',
        'posted',
        {
          conflictMessage: (actual) =>
            `${this.label(approval.object_type)} ${approval.object_id} is ${actual}, expected pending`,
        },
      );

      const voucher = await this.postingService.postVoucherTx(
        trx,
        draft,
        prepared.resolved,
      );

      // Re-point the now-posted object at its voucher.
      await trx
        .updateTable(approval.object_type)
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

      return voucher;
    });

    const updatedApproval = await this.getApprovalById(id);
    return { approval: updatedApproval, voucher };
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

    const now = Math.floor(Date.now() / 1000);

    await this.db.transaction().execute(async (trx) => {
      // Return business object to draft via the single status-transition seam
      // (pending → draft, ADR-0006). The guarded transition rejects an illegal
      // flip and atomically claims only from `pending`.
      await this.statusTransition.transition(
        trx,
        approval.object_type,
        approval.object_id,
        'pending',
        'draft',
        {
          conflictMessage: (actual) =>
            `${this.label(approval.object_type)} ${approval.object_id} is ${actual}, expected pending`,
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

    await this.db
      .updateTable('approval')
      .set({
        status: 'superseded',
        superseded_by: supersededBy,
        resolved_at: now,
      })
      .where('id', '=', id)
      .execute();

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

  private async generateDraftVoucher(
    objectType: ApprovalObjectType,
    objectId: number,
  ) {
    switch (objectType) {
      case 'expense':
        return this.expensesService.generateDraftVoucher(objectId);
      case 'sales_invoice':
        return this.salesInvoicesService.generateDraftVoucher(objectId);
      default:
        throw new BadRequestException(
          `Unknown object type: ${String(objectType)}`,
        );
    }
  }

  private async getPostedVoucherForApproval(
    approval: Approval,
  ): Promise<PostedVoucher | null> {
    // Look up the business object to find its voucher_id
    const row = await this.db
      .selectFrom(approval.object_type)
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
        vat_code: l.vat_code,
        is_debit: l.is_debit === 1,
      })),
    };
  }

  private label(type: ApprovalObjectType): string {
    return type === 'expense' ? 'Expense' : 'SalesInvoice';
  }

  private mapRow(row: {
    id: number;
    object_type: string;
    object_id: number;
    status: string;
    requested_by: string;
    approved_by: string | null;
    rejected_reason: string | null;
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
      superseded_by: row.superseded_by,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    };
  }
}
