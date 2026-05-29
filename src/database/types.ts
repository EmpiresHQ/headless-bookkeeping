import type { Generated } from 'kysely';

export interface Database {
  organization: OrganizationTable;
}

export interface OrganizationTable {
  id: Generated<number>;
  country: string;
  // Nullable override: NULL means "inherit base currency from the country
  // plugin" (ADR-0004).
  base_currency: string | null;
  vat_registered: number;
  created_at: number;
}
