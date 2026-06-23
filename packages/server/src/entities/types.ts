import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export type EntityRole = 'supplier' | 'customer' | 'employee' | 'director';
export type GoodsVsServices = 'goods' | 'services' | 'unknown';
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

const onboardSupplierCustomerSchema = z.object({
  role: z.enum(['supplier', 'customer']),
  country: z.string(),
  name: z.string(),
  registrationKey: z.string(),
  goodsVsServices: z.enum(['goods', 'services', 'unknown']).optional(),
});

const onboardClaimantSchema = z.object({
  role: z.enum(['employee', 'director']),
  country: z.string(),
  name: z.string(),
  email: z.string().email(),
  tgUserId: z.string().optional(),
});

export const onboardEntitySchema = z.discriminatedUnion('role', [
  onboardSupplierCustomerSchema,
  onboardClaimantSchema,
]);

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
});

export class UpdateEntityDto extends createZodDto(updateEntitySchema) {}

export const mergeEntitySchema = z.object({
  duplicate_id: z.number().int().positive(),
});

export class MergeEntityDto extends createZodDto(mergeEntitySchema) {}
