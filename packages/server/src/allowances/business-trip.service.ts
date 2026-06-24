import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';

export interface CreateBusinessTripDto {
  claimantId: number;
  departureDate: string; // YYYY-MM-DD
  returnDate: string; // YYYY-MM-DD
  destinationCountry: string;
  purpose?: string;
}

@Injectable()
export class BusinessTripService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async createBusinessTrip(dto: CreateBusinessTripDto) {
    if (dto.returnDate < dto.departureDate) {
      throw new UnprocessableEntityException(
        'returnDate must be on or after departureDate',
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const [row] = await this.db
      .insertInto('business_trip')
      .values({
        claimant_id: dto.claimantId,
        departure_date: dto.departureDate,
        return_date: dto.returnDate,
        destination_country: dto.destinationCountry,
        purpose: dto.purpose ?? null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .execute();
    return row;
  }

  async findBusinessTrip(id: number) {
    return this.db
      .selectFrom('business_trip')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async listBusinessTrips(claimantId?: number) {
    let q = this.db.selectFrom('business_trip').selectAll();
    if (claimantId !== undefined) {
      q = q.where('claimant_id', '=', claimantId);
    }
    return q.orderBy('departure_date', 'desc').execute();
  }
}
