import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { RulesService } from '../../rules/rules.service';
import { PolicyService } from '../../policy/policy.service';
import { PostingService } from '../posting/posting.service';
import { StatusTransitionService } from '../status/status-transition.service';
import { OrgContextResolver } from '../../organization/org-context.resolver';
import { mustReject } from '../../rules/rules.guards';
import { ResolvedLine, SemanticValidationContext } from '../../rules/types';
import { SupplierFacts } from '../../plugins/country-plugin.interface';
import { DraftVoucher, PostedVoucher } from '../voucher/types';
import { PolicyDecision } from '../../policy/types';
import { ValidationError } from '../posting/types';
import { NULL_VAT_CODE } from '../posting/vat-constants';

/**
 * Parameters for the posting pipeline.
 *
 * The pipeline is business-object agnostic: callers supply callbacks
 * for object-specific operations (draft generation, category mapping,
 * refetch after status change).
 */
export interface PostingPipelineParams {
  /** The business object ID (expense.id or sales_invoice.id). */
  businessObjectId: number;
  /** Identifies which table to query for the idempotency check and status update. */
  businessObjectType: 'expense' | 'sales_invoice';
  /** Generates the transient DraftVoucher for this business object. */
  draftGenerator: () => Promise<DraftVoucher>;
  /** The business object's user-facing Category (e.g. "software", "revenue"). */
  category: string;
  /** Re-fetches the business object after a status update (for the response). */
  refetch: () => Promise<unknown>;
  /** Optional semantic rule override (ruleType + reason). */
  override?: { ruleType: string; reason: string };
  /** AI confidence score (0–1). Passed to Policy; undefined → skip check. */
  confidence?: number;
  /** Whether the supplier is known (matched to an Entity). */
  supplierKnown?: boolean;
  /** Who/what requested the post; recorded on the Approval if Policy holds. */
  requestedBy?: string;
  /**
   * Optional hook folded into the SAME atomic transaction as the post,
   * AFTER the voucher is inserted and the business object's status/voucher_id
   * are updated. Receives the open `trx` and the posted voucher. Used by the
   * capex flow to create the fixed-asset register row atomically (ADR-0035).
   * MUST use the provided `trx` — never `this.db`.
   */
  afterPost?: (trx: Kysely<Database>, voucher: PostedVoucher) => Promise<void>;
}

export interface PostingPipelineResult {
  businessObject: unknown;
  voucher: PostedVoucher | null;
  policy: PolicyDecision;
}

/**
 * PostingPipelineService — shared orchestration of the full posting pipeline.
 *
 * Encapsulates: idempotency guard → draft generation → account resolution →
 * ResolvedLine construction → semantic context → Rules (structural/hard/semantic) →
 * Policy gate → atomic post-or-hold with status update.
 *
 * Replaces the duplicated ~100-line pipeline logic previously in
 * ExpensesController and SalesInvoicesController.
 */
@Injectable()
export class PostingPipelineService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly rulesService: RulesService,
    private readonly policyService: PolicyService,
    private readonly postingService: PostingService,
    private readonly statusTransition: StatusTransitionService,
    private readonly orgContextResolver: OrgContextResolver,
  ) {}

  async runPipeline(
    params: PostingPipelineParams,
  ): Promise<PostingPipelineResult> {
    // ── 1. Generate transient draft voucher ────────────────────
    const draft = await params.draftGenerator();

    // ── 2. Resolve account codes (THE single resolver, ADR-0019) and enrich
    // with the vat_code + category the Rules/Policy tiers need. Account
    // resolution itself lives only in PostingService.resolveLines.
    const { resolved, accounts } =
      await this.postingService.resolveLines(draft);
    const validAccountIds = new Set(accounts.map((a) => a.id));

    const resolvedLines: ResolvedLine[] = resolved.map((l, i) => ({
      ...l,
      vat_code: draft.lines[i].vat_code ?? NULL_VAT_CODE,
      category: params.category,
    }));

    // ── 4. Build semantic validation context ───────────────────
    const { organization: org, orgContext } =
      await this.orgContextResolver.resolve();
    const supplierFacts: SupplierFacts = {
      country: org.country,
      goodsVsServices: 'unknown',
      classificationMemory: [],
    };
    const semanticContext: SemanticValidationContext = {
      countryCode: org.country,
      supplierFacts,
      orgContext,
      category: params.category,
    };

    // ── 5. Run Rules validation (ONE unified call across all three tiers) ──
    // The unified tier interface (ADR-0005): one async validateAll runs
    // structural + hard-process + semantic and returns them in one shape, so
    // this caller no longer orchestrates a sync `validate` plus a separate
    // async `validateHardProcess`. The semantic tier evaluates only the lines
    // carrying a real VAT code (a NULL_STANDARD placeholder is not semantically
    // meaningful) — including the cross-border treatment check (ADR-0002),
    // which surfaces an unresolvable foreign-supplier treatment as an
    // overrideable semantic failure so Policy HOLDS it for Approval.
    const { structural, hardProcess, semantic } =
      await this.rulesService.validateAll({
        resolvedLines,
        validAccountIds,
        taxPointDate: draft.tax_point_date,
        context: semanticContext,
        semanticLines: resolvedLines.filter(
          (l) => l.vat_code !== NULL_VAT_CODE,
        ),
        override: params.override?.ruleType
          ? {
              ruleType: params.override.ruleType,
              reason: params.override.reason,
            }
          : undefined,
      });

    // Defense-in-depth: the inviolable tiers (structural + hard-process) reject
    // here with a tier-specific 400 before any write is attempted. The
    // authoritative throws still live in PostingService (ADR-0019).
    if (mustReject(structural)) {
      throw new BadRequestException({
        message: 'Structural validation failed',
        errors: [structural.message],
      });
    }
    if (mustReject(hardProcess)) {
      throw new BadRequestException({
        message: 'Hard process validation failed',
        errors: [hardProcess.message],
      });
    }

    const ruleResults = [structural, hardProcess, semantic];

    // ── 6. Policy gate ─────────────────────────────────────────
    const policyDecision = await this.policyService.decide(draft, ruleResults, {
      confidence: params.confidence,
      supplierKnown: params.supplierKnown,
    });

    if (policyDecision.action === 'auto-post') {
      // ── 7a. Atomic post + status update ──────────────────────
      return this.atomicPost(params, draft, resolvedLines, policyDecision);
    }

    // ── 7b. Hold for approval (atomic conditional claim) ───────
    await this.claimForApproval(
      params.businessObjectType,
      params.businessObjectId,
      params.requestedBy ?? 'system',
      policyDecision.reason,
    );
    const businessObject = await params.refetch();
    return { businessObject, voucher: null, policy: policyDecision };
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Post the voucher and update the business object status atomically
   * within a single database transaction. The idempotency guard is a
   * conditional UPDATE inside the transaction — no check-then-act read
   * outside (closes the TOCTOU window, ADR-0021).
   */
  private async atomicPost(
    params: PostingPipelineParams,
    draft: DraftVoucher,
    resolvedLines: ResolvedLine[],
    policyDecision: PolicyDecision,
  ): Promise<PostingPipelineResult> {
    try {
      const result = await this.db.transaction().execute(async (trx) => {
        // ── Guarded atomic transition (ADR-0006 / ADR-0021) ──────
        // THE single seam: rejects an illegal transition, then claims the
        // object only from `draft`. Zero rows → already claimed/posted →
        // Conflict.
        await this.statusTransition.transition(
          trx,
          params.businessObjectType,
          params.businessObjectId,
          'draft',
          'posted',
        );

        const voucher = await this.postingService.postVoucherTx(
          trx,
          draft,
          resolvedLines,
        );

        // Update voucher_id on the already-claimed object
        const now = Math.floor(Date.now() / 1000);
        await trx
          .updateTable(params.businessObjectType)
          .set({ voucher_id: voucher.id, updated_at: now })
          .where('id', '=', params.businessObjectId)
          .execute();

        // Log the override atomically with the posting (ADR-0005 / ADR-0012).
        if (params.override?.ruleType) {
          await this.policyService.logOverrideTx(trx, {
            business_object_type: params.businessObjectType,
            business_object_id: params.businessObjectId,
            rule_type: params.override.ruleType,
            rule_name: params.override.ruleType,
            reason: params.override.reason,
            created_by: 'system',
          });
        }

        if (params.afterPost) {
          await params.afterPost(trx, voucher);
        }

        return { voucher };
      });

      const businessObject = await params.refetch();
      return {
        businessObject,
        voucher: result.voucher,
        policy: policyDecision,
      };
    } catch (err) {
      // Catch ValidationError from PostingService and re-throw as 400
      if (err instanceof ValidationError) {
        throw new BadRequestException({
          message: 'Voucher validation failed',
          errors: err.errors,
        });
      }
      throw err;
    }
  }

  /**
   * Atomic conditional claim for the hold-for-approval path. Within a single
   * transaction: transitions status from 'draft' to 'pending' via the single
   * status-transition seam (ADR-0006 / ADR-0021) AND creates the pending
   * Approval record the hold is for (ADR-0015). Doing both atomically means a
   * held object is never stranded in 'pending' with nothing to approve — the
   * `/post` path is self-sufficient and no separate POST /api/approvals call is
   * required. An illegal transition is rejected and a ConflictException is
   * thrown if the object was already claimed (re-running /post on a held
   * object), so the approval row is never duplicated.
   */
  private async claimForApproval(
    type: 'expense' | 'sales_invoice',
    id: number,
    requestedBy: string,
    policyReason: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const now = Math.floor(Date.now() / 1000);

      await this.statusTransition.transition(trx, type, id, 'draft', 'pending');

      const approval = await trx
        .insertInto('approval')
        .values({
          object_type: type,
          object_id: id,
          status: 'pending',
          requested_by: requestedBy,
          approved_by: null,
          rejected_reason: null,
          policy_reason: policyReason,
          superseded_by: null,
          created_at: now,
          resolved_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('audit_finding')
        .values({
          finding_type: 'pending_approval',
          severity: 'medium',
          description: `Approval ${approval.id} pending for ${type} ${id}: ${policyReason}`,
          referenced_object_type: 'approval',
          referenced_object_id: approval.id,
          status: 'open',
          created_at: now,
          resolved_at: null,
          snoozed_at: null,
          transitioned_by: null,
          transition_reason: null,
        })
        .execute();
    });
  }
}
