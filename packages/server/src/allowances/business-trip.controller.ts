import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Query,
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
    return this.service.listBusinessTrips(
      claimantId ? parseInt(claimantId, 10) : undefined,
    );
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findBusinessTrip(id);
  }
}
