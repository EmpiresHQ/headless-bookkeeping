import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import {
  Entity,
  EntityIdentifier,
  EntityWithIdentifiers,
  OnboardEntityDto,
  AddAliasDto,
  UpdateEntityDto,
} from './types';

@Injectable()
export class EntitiesService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  async onboard(dto: OnboardEntityDto): Promise<EntityWithIdentifiers> {
    const now = Math.floor(Date.now() / 1000);

    const entity = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('entity')
        .values({
          role: dto.role,
          country: dto.country,
          name: dto.name,
          goods_vs_services: dto.goodsVsServices ?? null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('entity_identifier')
        .values({
          entity_id: row.id,
          kind: 'registration_key',
          value: dto.registrationKey,
          confirmed: 1,
        })
        .execute();

      return row;
    });

    const identifiers = await this.getIdentifiers(entity.id);
    return { ...this.mapEntity(entity), identifiers };
  }

  async findById(id: number): Promise<EntityWithIdentifiers> {
    const entity = await this.db
      .selectFrom('entity')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!entity) {
      throw new NotFoundException(`Entity ${id} not found`);
    }

    const identifiers = await this.getIdentifiers(entity.id);
    return { ...this.mapEntity(entity), identifiers };
  }

  async findByRegistrationKey(
    key: string,
  ): Promise<EntityWithIdentifiers | undefined> {
    const entity = await this.db
      .selectFrom('entity')
      .innerJoin(
        'entity_identifier',
        'entity_identifier.entity_id',
        'entity.id',
      )
      .where('entity_identifier.kind', '=', 'registration_key')
      .where('entity_identifier.value', '=', key)
      .where('entity_identifier.confirmed', '=', 1)
      .selectAll('entity')
      .executeTakeFirst();

    if (!entity) {
      return undefined;
    }

    const identifiers = await this.getIdentifiers(entity.id);
    return { ...this.mapEntity(entity), identifiers };
  }

  /**
   * Update an entity's mutable intrinsic facts (C4). The strong registration
   * key is identity and is not touched here. Only provided fields change.
   */
  async update(
    id: number,
    dto: UpdateEntityDto,
  ): Promise<EntityWithIdentifiers> {
    await this.findById(id); // 404s if unknown

    const set: {
      name?: string;
      country?: string;
      goods_vs_services?: string;
      updated_at: number;
    } = { updated_at: Math.floor(Date.now() / 1000) };
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.country !== undefined) set.country = dto.country;
    if (dto.goodsVsServices !== undefined)
      set.goods_vs_services = dto.goodsVsServices;

    await this.db.updateTable('entity').set(set).where('id', '=', id).execute();

    return this.findById(id);
  }

  async addAlias(
    entityId: number,
    dto: AddAliasDto,
  ): Promise<EntityIdentifier> {
    const now = Math.floor(Date.now() / 1000);

    const row = await this.db
      .insertInto('entity_identifier')
      .values({
        entity_id: entityId,
        kind: dto.kind,
        value: dto.value,
        confirmed: dto.confirmed ? 1 : 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.db
      .updateTable('entity')
      .set({ updated_at: now })
      .where('id', '=', entityId)
      .execute();

    return this.mapIdentifier(row);
  }

  async resolveByIdentifier(
    kind: string,
    value: string,
  ): Promise<EntityWithIdentifiers | undefined> {
    const entity = await this.db
      .selectFrom('entity')
      .innerJoin(
        'entity_identifier',
        'entity_identifier.entity_id',
        'entity.id',
      )
      .where('entity_identifier.kind', '=', kind)
      .where('entity_identifier.value', '=', value)
      .where('entity_identifier.confirmed', '=', 1)
      .selectAll('entity')
      .executeTakeFirst();

    if (!entity) {
      return undefined;
    }

    const identifiers = await this.getIdentifiers(entity.id);
    return { ...this.mapEntity(entity), identifiers };
  }

  async list(): Promise<Entity[]> {
    const rows = await this.db
      .selectFrom('entity')
      .selectAll()
      .orderBy('id')
      .execute();

    return rows.map((r) => this.mapEntity(r));
  }

  private async getIdentifiers(entityId: number): Promise<EntityIdentifier[]> {
    const rows = await this.db
      .selectFrom('entity_identifier')
      .selectAll()
      .where('entity_id', '=', entityId)
      .orderBy('id')
      .execute();

    return rows.map((r) => this.mapIdentifier(r));
  }

  private mapEntity(row: {
    id: number;
    role: string;
    country: string;
    name: string;
    goods_vs_services: string | null;
    created_at: number | null;
    updated_at: number | null;
  }): Entity {
    return {
      id: row.id,
      role: row.role as Entity['role'],
      country: row.country,
      name: row.name,
      goods_vs_services: row.goods_vs_services as Entity['goods_vs_services'],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapIdentifier(row: {
    id: number;
    entity_id: number;
    kind: string;
    value: string;
    confirmed: number;
  }): EntityIdentifier {
    return {
      id: row.id,
      entity_id: row.entity_id,
      kind: row.kind as EntityIdentifier['kind'],
      value: row.value,
      confirmed: row.confirmed === 1,
    };
  }
}
