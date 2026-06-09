export type EntityRole = 'supplier' | 'customer';
export type GoodsVsServices = 'goods' | 'services' | 'unknown';
export type IdentifierKind =
  | 'registration_key'
  | 'iban'
  | 'merchant_descriptor'
  | 'name_alias';

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

export interface OnboardEntityDto {
  role: EntityRole;
  country: string;
  name: string;
  registrationKey: string;
  goodsVsServices?: GoodsVsServices;
}

export interface AddAliasDto {
  kind: Exclude<IdentifierKind, 'registration_key'>;
  value: string;
  confirmed?: boolean;
}

/**
 * Mutable intrinsic facts of an entity. The strong registration key (identity)
 * is NOT updatable here — manage identifiers via addAlias.
 */
export interface UpdateEntityDto {
  name?: string;
  country?: string;
  goodsVsServices?: GoodsVsServices;
}
