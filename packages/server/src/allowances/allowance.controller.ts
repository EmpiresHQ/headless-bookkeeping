import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Query,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
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
  km: z.number().positive().optional(),
  input_amount: z.number().int().nonnegative().optional(),
  route_description: z.string().optional(),
  period_start: z.string().regex(DATE_REGEX).optional(),
  period_end: z.string().regex(DATE_REGEX).optional(),
});

@Controller('api/allowances')
export class AllowanceController {
  constructor(private readonly service: AllowanceService) {}

  @Post()
  async create(@Body() body: unknown) {
    const dto = createAllowanceSchema.parse(body);
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
}
