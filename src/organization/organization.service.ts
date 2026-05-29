import { Injectable, OnModuleInit, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { Organization, UpdateOrganizationDto } from './types';

@Injectable()
export class OrganizationService implements OnModuleInit {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async onModuleInit() {
    // Ensure organization table exists
    await this.db.schema
      .createTable('organization')
      .ifNotExists()
      .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
      .addColumn('country', 'text', (col) => col.notNull().defaultTo('DK'))
      .addColumn('base_currency', 'text', (col) => col.notNull().defaultTo('DKK'))
      .addColumn('vat_registered', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .execute();

    // Seed singleton if not exists
    const existing = await this.db
      .selectFrom('organization')
      .selectAll()
      .executeTakeFirst();

    if (!existing) {
      await this.db
        .insertInto('organization')
        .values({
          country: 'DK',
          base_currency: 'DKK',
          vat_registered: 0,
          created_at: Math.floor(Date.now() / 1000),
        })
        .execute();
    }
  }

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
    // Enforce singleton: reject if more than one row somehow exists
    const count = await this.db
      .selectFrom('organization')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirst();

    if (!count || Number(count.count) !== 1) {
      throw new ConflictException(
        `Expected exactly 1 organization record, found ${count ? Number(count.count) : 0}`,
      );
    }

    const updates: Record<string, string | number> = {};
    if (dto.country !== undefined) updates.country = dto.country;
    if (dto.base_currency !== undefined) updates.base_currency = dto.base_currency;
    if (dto.vat_registered !== undefined) updates.vat_registered = dto.vat_registered ? 1 : 0;

    if (Object.keys(updates).length === 0) {
      return this.getOrganization();
    }

    await this.db
      .updateTable('organization')
      .set(updates)
      .execute();

    return this.getOrganization();
  }

  private mapRow(row: {
    id: number;
    country: string;
    base_currency: string;
    vat_registered: number;
    created_at: number;
  }): Organization {
    return {
      id: row.id,
      country: row.country,
      base_currency: row.base_currency,
      vat_registered: row.vat_registered === 1,
      created_at: row.created_at,
    };
  }
}
