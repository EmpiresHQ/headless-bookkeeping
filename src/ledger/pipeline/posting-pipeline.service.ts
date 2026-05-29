import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../../database/types';
import { AccountService } from '../account/account.service';
import { RulesService } from '../../rules/rules.service';
import { PolicyService } from '../../policy/policy.service';
import { PostingService } from '../posting/posting.service';
import { OrganizationService } from '../../organization/organization.service';
import { mustReject } from '../../rules/rules.guards';
import {
  ResolvedLine,
  SemanticValidationContext,
  RuleResult,
} from '../../rules/types';
import {
  SupplierFacts,
  OrgContext,
} from '../../plugins/country-plugin.interface';
import { DraftVoucher, PostedVoucher } from '../voucher/types';
import { PolicyDecision } from '../../policy/types';
import { ValidationError } from '../posting/types';

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
  /** Maps an account_code to a user-facing Category string for ResolvedLine.category. */
  categoryMapper: (accountCode: string) => string;
  /** Re-fetches the business object after a status update (for the response). */
  refetch: () => Promise<unknown>;
  /** Optional semantic rule override (ruleType + reason). */
  override?: { ruleType: string; reason: string };
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
    private readonly accountService: AccountService,
    private readonly rulesService: RulesService,
    private readonly policyService: PolicyService,
    private readonly postingService: PostingService,
    private readonly organizationService: OrganizationService,
  ) {}

  async runPipeline(
    params: PostingPipelineParams,
  ): Promise<PostingPipelineResult> {
    // ── Idempotency guard ──────────────────────────────────────
    const currentStatus = await this.getStatus(
      params.businessObjectType,
      params.businessObjectId,
    );
    if (currentStatus !== 'draft') {
      throw new ConflictException(
        `${this.label(params.businessObjectType)} ${params.businessObjectId} is already ${currentStatus}`,
      );
    }

    // ── 1. Generate transient draft voucher ────────────────────
    const draft = await params.draftGenerator();

    // ── 2. Resolve account codes ───────────────────────────────
    const codes = [...new Set(draft.lines.map((l) => l.account_code))];
    const accounts = await this.accountService.getAccountsByCodes(codes);
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const validAccountIds = new Set(accounts.map((a) => a.id));

    // ── 3. Build ResolvedLine[] ────────────────────────────────
    const resolvedLines: ResolvedLine[] = draft.lines.map((l) => {
      const account = byCode.get(l.account_code);
      return {
        account_id: account?.id ?? -1,
        amount: l.amount,
        currency: l.currency,
        base_amount: l.base_amount,
        fx_rate: l.fx_rate,
        is_debit: l.is_debit,
        account_currency: account?.currency ?? null,
        vat_code: l.vat_code ?? 'NULL_STANDARD',
        category: params.categoryMapper(l.account_code),
      };
    });

    // ── 4. Build semantic validation context ───────────────────
    const org = await this.organizationService.getOrganization();
    const { country, vat_registered, base_currency } = org;
    const supplierFacts: SupplierFacts = {
      country,
      goodsVsServices: 'unknown',
      classificationMemory: [],
    };
    const orgContext: OrgContext = {
      country,
      vatRegistered: vat_registered,
      baseCurrency: base_currency,
    };
    const semanticContext: SemanticValidationContext = {
      countryCode: org.country,
      supplierFacts,
      orgContext,
    };

    // ── 5. Run Rules validation ────────────────────────────────
    const structuralResult = this.rulesService.validate(
      resolvedLines,
      validAccountIds,
      'structural',
    );
    if (mustReject(structuralResult)) {
      throw new BadRequestException({
        message: 'Structural validation failed',
        errors: [structuralResult.message],
      });
    }

    const hardResult = this.rulesService.validate(
      resolvedLines,
      validAccountIds,
      'hard',
    );
    if (mustReject(hardResult)) {
      throw new BadRequestException({
        message: 'Hard process validation failed',
        errors: [hardResult.message],
      });
    }

    // Semantic validation: only on lines with a real VAT code
    const semanticLines = resolvedLines.filter(
      (l) => l.vat_code !== 'NULL_STANDARD',
    );
    let semanticResult: RuleResult = {
      passed: true,
      ruleType: 'semantic',
      message: 'Semantic validation skipped (no lines with VAT code)',
      overrideable: true,
    };
    if (semanticLines.length > 0) {
      semanticResult = this.rulesService.validate(
        semanticLines,
        validAccountIds,
        'semantic',
        semanticContext,
        params.override
          ? {
              ruleType: params.override.ruleType,
              reason: params.override.reason,
            }
          : undefined,
      );
    }

    const ruleResults = [structuralResult, hardResult, semanticResult];

    // ── 6. Policy gate ─────────────────────────────────────────
    const policyDecision = this.policyService.decide(draft, ruleResults);

    if (policyDecision.action === 'auto-post') {
      // ── 7a. Atomic post + status update ──────────────────────
      return this.atomicPost(params, draft, resolvedLines, policyDecision);
    }

    // ── 7b. Hold for approval ─────────────────────────────────
    await this.updateStatus(
      null, // no trx — standalone update
      params.businessObjectType,
      params.businessObjectId,
      'pending',
      null,
    );
    const businessObject = await params.refetch();
    return { businessObject, voucher: null, policy: policyDecision };
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Post the voucher and update the business object status atomically
   * within a single database transaction.
   */
  private async atomicPost(
    params: PostingPipelineParams,
    draft: DraftVoucher,
    resolvedLines: ResolvedLine[],
    policyDecision: PolicyDecision,
  ): Promise<PostingPipelineResult> {
    try {
      const result = await this.db.transaction().execute(async (trx) => {
        const voucher = await this.postingService.postVoucherTx(
          trx,
          draft,
          resolvedLines,
        );
        await this.updateStatus(
          trx,
          params.businessObjectType,
          params.businessObjectId,
          'posted',
          voucher.id,
        );
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
      // Unique constraint on voucher_number
      if (this.isUniqueViolation(err, 'voucher_number')) {
        throw new ConflictException(
          `Voucher number ${draft.voucher_number} already exists`,
        );
      }
      throw err;
    }
  }

  /**
   * Read the current status of a business object for the idempotency guard.
   * Throws NotFoundException if the record does not exist.
   */
  private async getStatus(
    type: 'expense' | 'sales_invoice',
    id: number,
  ): Promise<string> {
    const row = await this.db
      .selectFrom(type)
      .select('status')
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`${this.label(type)} ${id} not found`);
    }
    return row.status;
  }

  /**
   * Update the business object status (and optionally voucher_id).
   * When `trx` is provided the update runs inside an existing transaction;
   * otherwise it executes standalone.
   */
  private async updateStatus(
    trx: Kysely<Database> | null,
    type: 'expense' | 'sales_invoice',
    id: number,
    status: string,
    voucherId: number | null,
  ): Promise<void> {
    const executor = trx ?? this.db;
    const now = Math.floor(Date.now() / 1000);

    await executor
      .updateTable(type)
      .set({
        status,
        voucher_id: voucherId,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  }

  private label(type: 'expense' | 'sales_invoice'): string {
    return type === 'expense' ? 'Expense' : 'SalesInvoice';
  }

  private isUniqueViolation(err: unknown, column: string): boolean {
    return (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed') &&
      err.message.includes(column)
    );
  }
}
