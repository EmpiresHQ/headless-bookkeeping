import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { Organization, UpdateOrganizationDto } from './types';

const SINGLETON_ID = 1;

@Injectable()
export class OrganizationService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async getOrganization(): Promise<Organization> {
    const row = await this.db
      .selectFrom('organization')
      .selectAll()
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException('Organization not found');
    }

    return this.mapRow(row);
  }

  async updateOrganization(dto: UpdateOrganizationDto): Promise<Organization> {
    // Defense-in-depth: the DB enforces the singleton (id = 1 CHECK), but we
    // also reject here if the invariant is somehow violated.
    const count = await this.db
      .selectFrom('organization')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();

    if (!count || Number(count.count) !== 1) {
      throw new ConflictException(
        `Expected exactly 1 organization record, found ${count ? Number(count.count) : 0}`,
      );
    }

    const updates: Record<string, string | number | null> = {};
    if (dto.country !== undefined) updates.country = dto.country;
    if (dto.base_currency !== undefined)
      updates.base_currency = dto.base_currency;
    if (dto.vat_registered !== undefined)
      updates.vat_registered = dto.vat_registered ? 1 : 0;

    if (Object.keys(updates).length === 0) {
      return this.getOrganization();
    }

    await this.db
      .updateTable('organization')
      .set(updates)
      .where('id', '=', SINGLETON_ID)
      .execute();

    return this.getOrganization();
  }

  private mapRow({
    id,
    country,
    base_currency,
    vat_registered,
    created_at,
  }: {
    id: number;
    country: string;
    base_currency: string | null;
    vat_registered: number;
    created_at: number;
  }): Organization {
    return {
      id,
      country,
      base_currency,
      vat_registered: vat_registered === 1,
      created_at,
    };
  }
}
