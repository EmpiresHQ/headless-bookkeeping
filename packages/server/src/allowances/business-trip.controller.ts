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
import { BusinessTripService } from './business-trip.service';

const createBusinessTripSchema = z.object({
  claimant_id: z.number().int().positive(),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  destination_country: z.string().length(2),
  purpose: z.string().optional(),
});

@Controller('api/business-trips')
export class BusinessTripController {
  constructor(private readonly service: BusinessTripService) {}

  @Post()
  async create(@Body() body: unknown) {
    const dto = createBusinessTripSchema.parse(body);
    return this.service.createBusinessTrip({
      claimantId: dto.claimant_id,
      departureDate: dto.departure_date,
      returnDate: dto.return_date,
      destinationCountry: dto.destination_country,
      purpose: dto.purpose,
    });
  }

  @Get()
  list(@Query('claimant_id') claimantId?: string) {
    const parsed = claimantId !== undefined ? parseInt(claimantId, 10) : undefined;
    if (parsed !== undefined && (isNaN(parsed) || parsed <= 0)) {
      throw new BadRequestException('claimant_id must be a positive integer');
    }
    return this.service.listBusinessTrips(parsed);
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const trip = await this.service.findBusinessTrip(id);
    if (!trip) throw new NotFoundException(`Business trip ${id} not found`);
    return trip;
  }
}
