import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { toBool } from '../database/helpers';
import { Organization, UpdateOrganizationDto } from './types';

const SINGLETON_ID = 1;

/**
 * Reject a value outside its allowed set with a message that names both the
 * field and the alternatives — a 400 the caller can act on, rather than the 500
 * an unchecked string turns into at the database CHECK.
 */
function assertOneOf<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  field: string,
): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new BadRequestException(
      `${field} must be one of ${allowed.map((a) => `'${a}'`).join(', ')}; ` +
        `received '${String(value)}'.`,
    );
  }
}

@Injectable()
export class OrganizationService {
  constructor(@InjectKysely() private readonly db: Kysely<Database>) {}

  /**
   * `executor` lets a caller read the singleton inside its own transaction.
   * Required, not cosmetic: the SQLite dialect holds a single connection, so a
   * read issued against the root `db` while a transaction is open deadlocks.
   */
  async getOrganization(
    executor: Kysely<Database> = this.db,
  ): Promise<Organization> {
    const row = await executor
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
    if (dto.org_type !== undefined) updates.org_type = dto.org_type;
    // The VAT facts are resolved together, and only when the caller touched one
    // of them — a PUT that names none must stay the no-op it always was.
    if (
      dto.vat_registered !== undefined ||
      dto.vat_registration_kind !== undefined ||
      dto.input_vat_entitlement !== undefined ||
      dto.input_vat_deduction_permille !== undefined
    ) {
      Object.assign(
        updates,
        this.resolveVatFactUpdates(dto, await this.getOrganization()),
      );
    }
    if (dto.vat_registration_number !== undefined)
      updates.vat_registration_number = dto.vat_registration_number;
    if (dto.registry_code !== undefined)
      updates.registry_code = dto.registry_code;
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.iban !== undefined) updates.iban = dto.iban;

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

  /**
   * The organisation's VAT facts move TOGETHER (issue #211), so they are
   * validated as one merged state rather than field by field. Three rules:
   *
   *  - a person who is not VAT-registered has no deduction right, so an
   *    entitlement other than 'none' alongside `vat_registered=false` is
   *    rejected — a percentage must never be able to buy back a deduction the
   *    registration does not confer;
   *  - the deductible proportion exists only while the entitlement is
   *    'partial'. Leaving 'partial' clears it in the same statement, so no
   *    stale proportion is left sitting behind a 'full' or 'none' setting;
   *  - a caller that only flips `vat_registered` — every pre-#211 client —
   *    gets the statutory norm for the state it asked for: deregistering means
   *    no entitlement, registering (ordinarily) means the full one. That is the
   *    default an ordinary taxable person has, not a guess about a special
   *    case; partial or restricted entitlement is stated explicitly.
   */
  private resolveVatFactUpdates(
    dto: UpdateOrganizationDto,
    current: Organization,
  ): Record<string, string | number | null> {
    // The payload is an interface, not a validated class, so these arrive as
    // whatever the caller sent. Check them here: an unknown string would
    // otherwise reach the column CHECK and surface as a 500 on what is simply a
    // bad request, and the operator would learn nothing about which value was
    // wrong or what the allowed ones are.
    assertOneOf(
      dto.vat_registration_kind,
      ['ordinary', 'limited'],
      'vat_registration_kind',
    );
    assertOneOf(
      dto.input_vat_entitlement,
      ['full', 'partial', 'none'],
      'input_vat_entitlement',
    );

    const registered = dto.vat_registered ?? current.vat_registered;
    const kind = dto.vat_registration_kind ?? current.vat_registration_kind;

    const registrationChanged =
      dto.vat_registered !== undefined &&
      dto.vat_registered !== current.vat_registered;
    const becameLimited =
      dto.vat_registration_kind === 'limited' &&
      current.vat_registration_kind !== 'limited';
    const entitlement =
      dto.input_vat_entitlement ??
      (becameLimited
        ? 'none'
        : registrationChanged
          ? registered
            ? 'full'
            : 'none'
          : current.input_vat_entitlement);

    // A limited registration confers NO deduction right (issue #211), so an
    // entitlement of 'full' or 'partial' recorded against it would be a setting
    // that can never take effect — and reading it back would suggest a
    // deduction the law does not give. Refuse the combination rather than store
    // a value the plugin will always answer zero to.
    if (registered && kind === 'limited' && entitlement !== 'none') {
      throw new BadRequestException(
        `input_vat_entitlement='${entitlement}' cannot apply to a LIMITED VAT ` +
          `registration: a limited taxable person self-assesses VAT on ` +
          `specified acquisitions and deducts no input VAT. Set ` +
          `vat_registration_kind='ordinary', or input_vat_entitlement='none'.`,
      );
    }

    if (!registered && entitlement !== 'none') {
      throw new BadRequestException(
        `input_vat_entitlement='${entitlement}' cannot apply to an organisation ` +
          `that is not VAT-registered: a person who is not registered has no ` +
          `right to deduct input VAT. Set vat_registered=true, or ` +
          `input_vat_entitlement='none'.`,
      );
    }

    const permille =
      dto.input_vat_deduction_permille !== undefined
        ? dto.input_vat_deduction_permille
        : entitlement === 'partial'
          ? current.input_vat_deduction_permille
          : null;

    if (entitlement === 'partial') {
      if (
        permille === null ||
        permille === undefined ||
        !Number.isSafeInteger(permille) ||
        permille < 0 ||
        permille > 1000
      ) {
        throw new BadRequestException(
          `input_vat_entitlement='partial' requires ` +
            `input_vat_deduction_permille as a whole number of per mille ` +
            `between 0 and 1000 (e.g. 500 for 50%); received ` +
            `${permille === null || permille === undefined ? 'nothing' : String(permille)}.`,
        );
      }
      return {
        vat_registration_kind: kind,
        input_vat_entitlement: entitlement,
        input_vat_deduction_permille: permille,
      };
    }
    if (
      dto.input_vat_deduction_permille !== undefined &&
      dto.input_vat_deduction_permille !== null
    ) {
      throw new BadRequestException(
        `input_vat_deduction_permille applies only when ` +
          `input_vat_entitlement='partial'; the entitlement here is ` +
          `'${entitlement}'.`,
      );
    }

    return {
      vat_registration_kind: kind,
      input_vat_entitlement: entitlement,
      input_vat_deduction_permille: null,
    };
  }

  private mapRow({
    id,
    country,
    base_currency,
    vat_registered,
    vat_registration_kind,
    input_vat_entitlement,
    input_vat_deduction_permille,
    org_type,
    created_at,
    vat_registration_number,
    registry_code,
    name,
    iban,
  }: {
    id: number;
    country: string;
    base_currency: string | null;
    vat_registered: number;
    vat_registration_kind: string;
    input_vat_entitlement: string;
    input_vat_deduction_permille: number | null;
    org_type: string;
    created_at: number;
    vat_registration_number: string | null;
    registry_code: string | null;
    name: string | null;
    iban: string | null;
  }): Organization {
    return {
      id,
      country,
      base_currency,
      vat_registered: toBool(vat_registered),
      vat_registration_kind:
        vat_registration_kind === 'limited' ? 'limited' : 'ordinary',
      input_vat_entitlement:
        input_vat_entitlement === 'partial' || input_vat_entitlement === 'none'
          ? input_vat_entitlement
          : 'full',
      input_vat_deduction_permille,
      org_type,
      created_at,
      vat_registration_number,
      registry_code,
      name,
      iban,
    };
  }
}
