import type { TaxStatus } from '../api';

/** Supplier/customer onboarding fields — shared by Settings' Add entity and
 *  the in-form creation in Books (books/CounterpartyField), so both send and
 *  explain the same facts. */
export type GoodsOrServices = 'goods' | 'services' | 'unknown';

export const GOODS_OPTIONS: readonly {
  value: GoodsOrServices;
  label: string;
}[] = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'goods', label: 'Goods' },
  { value: 'services', label: 'Services' },
];

export const TAX_STATUS_OPTIONS: readonly {
  value: TaxStatus;
  label: string;
}[] = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'taxable_business', label: 'Business (taxable person)' },
  { value: 'non_taxable', label: 'Consumer (non-taxable)' },
];

export const REG_KEY_HINT =
  'Registry or VAT number — the strong identity that matches documents and bank lines. Cannot be changed later.';

export const TAX_STATUS_HINT =
  'Whether this counterparty is a business acting as such. Needed before a cross-border service invoice can be posted — while it is unknown the server refuses rather than guessing.';
