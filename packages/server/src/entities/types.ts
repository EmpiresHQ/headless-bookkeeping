import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export type EntityRole = 'supplier' | 'customer' | 'employee' | 'director';
export type GoodsVsServices = 'goods' | 'services' | 'unknown';
/**
 * Whether a counterparty is a taxable person acting as such (issue #209).
 *
 * `taxable_business` — a business, registered for VAT (or otherwise a taxable
 * person) in its country and acting in that capacity. `non_taxable` — a
 * consumer, or a body that is not a taxable person. `unknown` — not
 * established; the books say so rather than pretending otherwise.
 *
 * A country code can never stand in for this: the same FI customer may be
 * either, and the answer decides whether a general-rule service is 0% (taxed
 * where the customer is, Art. 44/196) or 24% (taxed where we are). This is the
 * CUSTOMER's status; our own VAT registration is `organization.vat_registered`.
 */
export type TaxStatus = 'taxable_business' | 'non_taxable' | 'unknown';
export type IdentifierKind =
  | 'registration_key'
  | 'iban'
  | 'merchant_descriptor'
  | 'name_alias'
  | 'email'
  | 'phone'
  | 'address'
  | 'tg_user_id';

export interface Entity {
  id: number;
  role: EntityRole;
  country: string;
  name: string;
  goods_vs_services: GoodsVsServices | null;
  /** NULL ⇒ never recorded; read as `unknown`, never as a consumer. */
  tax_status: TaxStatus | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface EntityIdentifier {
  id: number;
  entity_id: number;
  kind: IdentifierKind;
  value: string;
  confirmed: boolean;
}

export interface EntityWithIdentifiers extends Entity {
  identifiers: EntityIdentifier[];
}

// Supplier/customer require a `registrationKey`; employee/director (claimant)
// require an `email`. Modelled as a single flat object (not a discriminated
// union) so nestjs-zod's `createZodDto` — which needs a ZodObject — can build a
// DTO class from it. The per-role required-field rule is enforced in
// `EntitiesService.onboard` (which throws BadRequestException).
export const onboardEntitySchema = z.object({
  role: z.enum(['supplier', 'customer', 'employee', 'director']),
  country: z.string(),
  name: z.string(),
  registrationKey: z.string().optional(),
  goodsVsServices: z.enum(['goods', 'services', 'unknown']).optional(),
  taxStatus: z
    .enum(['taxable_business', 'non_taxable', 'unknown'])
    .optional()
    .describe(
      'Whether the counterparty is a taxable person (business) acting as such. ' +
        'Omitted ⇒ unknown: a cross-border service sale to this customer is then ' +
        'REFUSED at posting rather than classified on a guess.',
    ),
  email: z.string().email().optional(),
  tgUserId: z.string().optional(),
});

export type OnboardEntityInput = z.infer<typeof onboardEntitySchema>;
export class OnboardEntityDto extends createZodDto(onboardEntitySchema) {}

export const addAliasSchema = z.object({
  kind: z.enum(['iban', 'merchant_descriptor', 'name_alias']),
  value: z.string(),
  confirmed: z.boolean().optional(),
});

export class AddAliasDto extends createZodDto(addAliasSchema) {}

/**
 * Mutable intrinsic facts of an entity. The strong registration key (identity)
 * is NOT updatable here — manage identifiers via addAlias.
 */
export const updateEntitySchema = z.object({
  name: z.string().optional(),
  country: z.string().optional(),
  goodsVsServices: z.enum(['goods', 'services', 'unknown']).optional(),
  // The supported way to resolve an unknown tax status before posting.
  taxStatus: z.enum(['taxable_business', 'non_taxable', 'unknown']).optional(),
});

export class UpdateEntityDto extends createZodDto(updateEntitySchema) {}

export const mergeEntitySchema = z.object({
  duplicate_id: z.number().int().positive(),
});

export class MergeEntityDto extends createZodDto(mergeEntitySchema) {}
