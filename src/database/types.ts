import type { Generated } from 'kysely';

export interface Database {
  organization: OrganizationTable;
}

export interface OrganizationTable {
  id: Generated<number>;
  country: string;
  base_currency: string;
  vat_registered: number;
  created_at: number;
}
