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

      const trip = await this.tripService.findBusinessTrip(dto.tripId);
      if (!trip) {
        throw new NotFoundException(`Business trip ${dto.tripId} not found`);
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
}
