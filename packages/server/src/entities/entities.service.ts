import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
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
import { normalizeIdentifier, MATCH_KINDS } from './identifier-normalization';

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

      const regKey = normalizeIdentifier(
        'registration_key',
        dto.registrationKey,
      );
      await trx
        .insertInto('entity_identifier')
        .values({
          entity_id: row.id,
          kind: 'registration_key',
          value: regKey ?? dto.registrationKey,
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
   * Resolve any of a set of candidate identifiers to existing entities. Each
   * candidate is normalized; a candidate that normalizes to null is skipped.
   * Returns the DISTINCT entity ids that match at least one candidate on a
   * confirmed identifier. Empty array when nothing matches.
   */
  async resolveByIdentifiers(
    candidates: { kind: string; value: string }[],
  ): Promise<number[]> {
    const ids = new Set<number>();
    for (const c of candidates) {
      // address (and any non-match kind) is stored but never a match key —
      // exact-matching a postal address produces false merges. Enforce here so
      // the policy holds regardless of what a caller passes.
      if (!MATCH_KINDS.includes(c.kind as (typeof MATCH_KINDS)[number]))
        continue;
      const value = normalizeIdentifier(c.kind, c.value);
      if (value === null) continue;
      const rows = await this.db
        .selectFrom('entity_identifier')
        .select('entity_id')
        .where('kind', '=', c.kind)
        .where('value', '=', value)
        .where('confirmed', '=', 1)
        .execute();
      for (const r of rows) ids.add(r.entity_id);
    }
    return [...ids];
  }

  /**
   * Onboard a supplier/customer with an arbitrary set of identifiers (each
   * normalized before write; identifiers that normalize to null are skipped).
   * All written identifiers are confirmed. Used by the AI intake path where the
   * anchoring identifier may be an email/phone rather than a registration key.
   *
   * NOTE: if every identifier normalizes to null the entity is created with NO
   * identifiers, so the CALLER is responsible for ensuring at least one anchoring
   * identifier is present when that matters.
   */
  async onboardWithIdentifiers(input: {
    role: 'supplier' | 'customer';
    country: string;
    name: string;
    goodsVsServices?: 'goods' | 'services' | 'unknown';
    identifiers: { kind: string; value: string }[];
  }): Promise<EntityWithIdentifiers> {
    const now = Math.floor(Date.now() / 1000);
    const normalized = input.identifiers
      .map((i) => ({
        kind: i.kind,
        value: normalizeIdentifier(i.kind, i.value),
      }))
      .filter((i): i is { kind: string; value: string } => i.value !== null);

    const entity = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('entity')
        .values({
          role: input.role,
          country: input.country,
          name: input.name,
          goods_vs_services: input.goodsVsServices ?? null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      if (normalized.length > 0) {
        await trx
          .insertInto('entity_identifier')
          .values(
            normalized.map((i) => ({
              entity_id: row.id,
              kind: i.kind,
              value: i.value,
              confirmed: 1,
            })),
          )
          .execute();
      }
      return row;
    });

    const identifiers = await this.getIdentifiers(entity.id);
    return { ...this.mapEntity(entity), identifiers };
  }

  /**
   * Backfill a single identifier onto an existing entity if it is not already
   * present (compared on the normalized value). Idempotent. Confirmed on write.
   */
  async addIdentifierIfAbsent(
    entityId: number,
    kind: string,
    rawValue: string,
  ): Promise<void> {
    const value = normalizeIdentifier(kind, rawValue);
    if (value === null) return;

    const existing = await this.db
      .selectFrom('entity_identifier')
      .select('id')
      .where('entity_id', '=', entityId)
      .where('kind', '=', kind)
      .where('value', '=', value)
      .limit(1)
      .executeTakeFirst();
    if (existing) return;

    await this.db
      .insertInto('entity_identifier')
      .values({ entity_id: entityId, kind, value, confirmed: 1 })
      .execute();
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

  /**
   * Delete an entity (and its identifiers) — ONLY if nothing references it
   * (no expense.supplier_id / sales_invoice.customer_id). Lets an operator
   * clear probe/junk counterparties; a referenced one is refused so the books
   * never dangle.
   */
  async delete(id: number): Promise<Entity> {
    const found = await this.findById(id); // 404s if unknown

    const refExpense = await this.db
      .selectFrom('expense')
      .select('id')
      .where('supplier_id', '=', id)
      .limit(1)
      .executeTakeFirst();
    const refInvoice = await this.db
      .selectFrom('sales_invoice')
      .select('id')
      .where('customer_id', '=', id)
      .limit(1)
      .executeTakeFirst();
    if (refExpense || refInvoice) {
      throw new ConflictException(
        `Entity ${id} (${found.name}) is referenced by an expense/invoice — cannot delete.`,
      );
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('entity_identifier')
        .where('entity_id', '=', id)
        .execute();
      await trx.deleteFrom('entity').where('id', '=', id).execute();
    });

    const { identifiers: _ignore, ...entity } = found;
    void _ignore;
    return entity;
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
