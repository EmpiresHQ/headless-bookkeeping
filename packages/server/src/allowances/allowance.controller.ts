import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Query,
  HttpCode,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { AllowanceService } from './allowance.service';

const ALLOWANCE_TYPES = [
  'daily_allowance',
  'mileage',
  'phone',
  'internet',
  'health',
] as const;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const createAllowanceSchema = z.object({
  type: z.enum(ALLOWANCE_TYPES),
  claimant_id: z.number().int().positive(),
  trip_id: z.number().int().positive().optional(),
  days: z.number().int().positive().optional(),
  km: z.number().int().positive().optional(),
  input_amount: z.number().int().nonnegative().optional(),
  route_description: z.string().optional(),
  period_start: z.string().regex(DATE_REGEX).optional(),
  period_end: z.string().regex(DATE_REGEX).optional(),
  // Health/sports eligibility facts (issue #212). Optional in the SCHEMA and
  // required in the SERVICE for type='health': the service's refusal names each
  // missing fact and how to supply it, which a bare Zod "required" cannot, and
  // the other allowance types must not be forced to carry them.
  health_category: z.string().min(1).optional(),
  claimant_relation: z.enum(['employee', 'board_member', 'other']).optional(),
  supporting_document_id: z.number().int().positive().optional(),
  supporting_document_ref: z.string().min(1).optional(),
  provider_registration: z.string().min(1).optional(),
  offered_to_all_employees: z.boolean().optional(),
});

class CreateAllowanceDto extends createZodDto(createAllowanceSchema) {}

@Controller('api/allowances')
export class AllowanceController {
  constructor(private readonly service: AllowanceService) {}

  @Post()
  async create(@Body() dto: CreateAllowanceDto) {
    return this.service.createAllowance({
      claimantId: dto.claimant_id,
      type: dto.type,
      tripId: dto.trip_id,
      days: dto.days,
      km: dto.km,
      inputAmount: dto.input_amount,
      routeDescription: dto.route_description,
      periodStart: dto.period_start,
      periodEnd: dto.period_end,
      // Only a health claim carries eligibility facts. Handing every other
      // type an object full of undefineds would put health's vocabulary into
      // a mileage or phone request that has nothing to do with it.
      ...(dto.type === 'health'
        ? {
            health: {
              category: dto.health_category,
              claimantRelation: dto.claimant_relation,
              supportingDocumentId: dto.supporting_document_id,
              supportingDocumentRef: dto.supporting_document_ref,
              providerRegistration: dto.provider_registration,
              offeredToAllEmployees: dto.offered_to_all_employees,
            },
          }
        : {}),
    });
  }

  @Get()
  list(
    @Query('claimant_id') claimantId?: string,
    @Query('trip_id') tripId?: string,
  ) {
    const parsedClaimantId =
      claimantId !== undefined ? parseInt(claimantId, 10) : undefined;
    if (
      parsedClaimantId !== undefined &&
      (isNaN(parsedClaimantId) || parsedClaimantId <= 0)
    ) {
      throw new BadRequestException('claimant_id must be a positive integer');
    }

    const parsedTripId =
      tripId !== undefined ? parseInt(tripId, 10) : undefined;
    if (
      parsedTripId !== undefined &&
      (isNaN(parsedTripId) || parsedTripId <= 0)
    ) {
      throw new BadRequestException('trip_id must be a positive integer');
    }

    return this.service.listAllowances({
      claimantId: parsedClaimantId,
      tripId: parsedTripId,
    });
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const allowance = await this.service.findAllowance(id);
    if (!allowance) throw new NotFoundException(`Allowance ${id} not found`);
    return allowance;
  }

  @Post(':id/submit')
  @HttpCode(204)
  async submit(@Param('id', ParseIntPipe) id: number) {
    await this.service.submitAllowance(id);
  }
}
