import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { AllowanceLimitService } from './allowance-limit.service';
import { HealthFactsInput, requireHealthFacts } from './health-facts';
import type { HealthEligibilityFacts } from '../plugins/health-allowance.types';
import { BusinessTripService } from './business-trip.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { StatusTransitionService } from '../ledger/status/status-transition.service';
import type { AllowanceType } from '../plugins/allowance-rates.types';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export interface CreateAllowanceDto {
  claimantId: number;
  type: AllowanceType;
  tripId?: number;
  /** Explicit day count override. If omitted for daily_allowance + tripId, computed from trip dates. */
  days?: number;
  km?: number;
  inputAmount?: number;
  routeDescription?: string;
  /** Required for non-trip allowances (mileage, phone, internet, health) */
  periodStart?: string;
  periodEnd?: string;
  /**
   * health only: the eligibility facts the statutory exemption depends on
   * (issue #212). Required — a health claim that records none of them cannot be
   * classified, and is refused rather than guessed at.
   */
  health?: HealthFactsInput;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AllowanceService {
  constructor(
    @InjectKysely() private readonly db: Kysely<Database>,
    private readonly limitService: AllowanceLimitService,
    private readonly tripService: BusinessTripService,
    private readonly orgContextResolver: OrgContextResolver,
    private readonly statusTransition: StatusTransitionService,
  ) {}

  async createAllowance(dto: CreateAllowanceDto) {
    const { organization } = await this.orgContextResolver.resolve();

    let periodStart: string;
    let periodEnd: string | undefined;
    let days: number | undefined = dto.days;
    let domestic = false;

    if (dto.type === 'daily_allowance') {
      if (!dto.tripId) {
        throw new UnprocessableEntityException(
          'tripId is required for daily_allowance',
        );
      }

      const trip = await this.tripService.findBusinessTrip(dto.tripId);
      if (!trip) {
        throw new NotFoundException(`Business trip ${dto.tripId} not found`);
      }

      // Duplicate guard — enforced at service layer (no UNIQUE constraint in DB)
      const existing = await this.db
        .selectFrom('allowance')
        .select('id')
        .where('claimant_id', '=', dto.claimantId)
        .where('trip_id', '=', dto.tripId)
        .where('type', '=', 'daily_allowance')
        .where('status', '!=', 'rejected')
        .where('status', '!=', 'cancelled')
        .executeTakeFirst();

      if (existing) {
        throw new ConflictException(
          'A daily_allowance already exists for this trip',
        );
      }

      periodStart = trip.departure_date;
      periodEnd = trip.return_date;

      // Inclusive day count: departure June 10, return June 15 = 6 days
      days =
        days ??
        Math.round(
          (new Date(periodEnd).getTime() - new Date(periodStart).getTime()) /
            86400000,
        ) + 1;

      domestic = trip.destination_country === organization.country;
    } else {
      // For non-daily-allowance types, periodStart must be provided
      if (!dto.periodStart) {
        throw new UnprocessableEntityException(
          'periodStart is required for this allowance type',
        );
      }
      periodStart = dto.periodStart;
      periodEnd = dto.periodEnd;
    }

    const year = new Date(periodStart).getUTCFullYear();

    // A health claim must arrive with the facts the exemption depends on. The
    // refusal happens BEFORE anything is written, so a claim that cannot be
    // classified leaves no half-made row behind (issue #212).
    const healthFacts: HealthEligibilityFacts | null =
      dto.type === 'health' ? requireHealthFacts(dto.health) : null;

    // The split stored now is a PREVIEW. The authoritative allocation against
    // the statutory limit is made inside the transaction that posts the
    // voucher, so a draft reserves nothing and cannot overspend a cap by
    // sitting unapproved.
    const split = await this.limitService.computeSplit({
      claimantId: dto.claimantId,
      type: dto.type,
      days,
      km: dto.km,
      inputAmount: dto.inputAmount,
      periodStart,
      periodEnd,
      domestic,
      year,
      healthFacts,
    });

    const now = Math.floor(Date.now() / 1000);

    const [row] = await this.db
      .insertInto('allowance')
      .values({
        claimant_id: dto.claimantId,
        trip_id: dto.tripId ?? null,
        type: dto.type,
        days: days ?? null,
        km: dto.km ?? null,
        input_amount: dto.inputAmount ?? null,
        route_description: dto.routeDescription ?? null,
        gross_amount: split.grossAmount,
        tax_free_amount: split.taxFreeAmount,
        taxable_amount: split.taxableAmount,
        breakdown:
          split.breakdown.length > 0 ? JSON.stringify(split.breakdown) : null,
        health_category: healthFacts?.category ?? null,
        claimant_relation: healthFacts?.claimantRelation ?? null,
        supporting_document_id: healthFacts?.supportingDocumentId ?? null,
        supporting_document_ref: healthFacts?.supportingDocumentRef ?? null,
        provider_registration: healthFacts?.providerRegistration ?? null,
        offered_to_all_employees: healthFacts
          ? healthFacts.offeredToAllEmployees
            ? 1
            : 0
          : null,
        exemption_basis: split.health?.exemptionBasis ?? null,
        limit_window: split.health?.limitWindow ?? null,
        fringe_income_tax_amount: split.health?.fringeTax?.incomeTax ?? 0,
        fringe_social_tax_amount: split.health?.fringeTax?.socialTax ?? 0,
        period_start: periodStart,
        period_end: periodEnd ?? null,
        voucher_id: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .execute();

    return row;
  }

  async findAllowance(id: number) {
    return this.db
      .selectFrom('allowance')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async listAllowances(filters?: { claimantId?: number; tripId?: number }) {
    let q = this.db.selectFrom('allowance').selectAll();
    if (filters?.claimantId !== undefined) {
      q = q.where('claimant_id', '=', filters.claimantId);
    }
    if (filters?.tripId !== undefined) {
      q = q.where('trip_id', '=', filters.tripId);
    }
    return q.orderBy('created_at', 'desc').execute();
  }

  /**
   * Submit an allowance for approver review.
   *
   * Atomically:
   * 1. Validates status is 'draft' (409 if not).
   * 2. Creates an AuditFinding (finding_type='needs_triage', severity='medium').
   * 3. Inserts a pending Approval row directly (bypassing ApprovalsService to
   *    avoid circular DI — allowances have a different status machine).
   * 4. Transitions status draft → needs_triage via StatusTransitionService.
   */
  async submitAllowance(id: number): Promise<void> {
    const allowance = await this.findAllowance(id);
    if (!allowance) {
      throw new NotFoundException(`Allowance ${id} not found`);
    }
    if (allowance.status !== 'draft') {
      throw new ConflictException(
        `Allowance ${id} is ${allowance.status}, expected draft`,
      );
    }

    // Guard: prevent duplicate pending approvals (e.g. re-submit after a transient failure).
    const existingPending = await this.db
      .selectFrom('approval')
      .select('id')
      .where('object_type', '=', 'allowance')
      .where('object_id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (existingPending) {
      throw new ConflictException(
        `Allowance ${id} already has a pending approval`,
      );
    }

    const now = Math.floor(Date.now() / 1000);

    // All three side-effects are atomic: AuditFinding + Approval + status transition.
    await this.db.transaction().execute(async (trx) => {
      // Re-read status inside the transaction so the check is atomic with the
      // transition — the outer check above is a fast-path early exit only.
      const current = await trx
        .selectFrom('allowance')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if (current.status !== 'draft') {
        throw new ConflictException(
          `Allowance ${id} is ${current.status}, expected draft`,
        );
      }

      // Insert audit_finding directly via trx to keep the operation atomic.
      // AuditFindingsService.create() uses this.db and cannot participate in a
      // caller-supplied transaction, so we bypass it here and use the raw insert.
      await trx
        .insertInto('audit_finding')
        .values({
          finding_type: 'needs_triage',
          severity: 'medium',
          description: 'Allowance requires approver confirmation',
          referenced_object_type: 'allowance',
          referenced_object_id: id,
          status: 'open',
          created_at: now,
        })
        .execute();

      // Insert approval row directly — do NOT call ApprovalsService.createApproval()
      // to avoid circular DI and because that method runs draft→pending which is
      // wrong for the allowance status machine (allowances use needs_triage).
      await trx
        .insertInto('approval')
        .values({
          object_type: 'allowance',
          object_id: id,
          status: 'pending',
          requested_by: 'claimant',
          approved_by: null,
          rejected_reason: null,
          policy_reason: 'Allowances always require approver confirmation',
          superseded_by: null,
          created_at: now,
          resolved_at: null,
        })
        .execute();

      // Transition draft → needs_triage via the guarded seam.
      await this.statusTransition.transition(
        trx,
        'allowance',
        id,
        'draft',
        'needs_triage',
        {
          conflictMessage: (actual) =>
            `Allowance ${id} is ${actual}, expected draft`,
        },
      );
    });
  }
}
