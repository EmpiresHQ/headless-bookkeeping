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
import { BusinessTripService } from './business-trip.service';
import { OrgContextResolver } from '../organization/org-context.resolver';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
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
    private readonly auditFindingsService: AuditFindingsService,
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
          split.breakdown.length > 0
            ? JSON.stringify(split.breakdown)
            : null,
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

    // Create AuditFinding outside the transaction (AuditFindingsService uses this.db).
    await this.auditFindingsService.create({
      finding_type: 'needs_triage',
      severity: 'medium',
      description: 'Allowance requires approver confirmation',
      referenced_object_type: 'allowance',
      referenced_object_id: id,
    });

    const now = Math.floor(Date.now() / 1000);

    await this.db.transaction().execute(async (trx) => {
      // Insert approval row directly — do NOT call ApprovalsService.createApproval()
      // to avoid circular DI and because that method runs draft→pending which is
      // wrong for the allowance status machine (allowances skip 'pending' entirely).
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
