import type { Generated } from 'kysely';

export interface Database {
  organization: OrganizationTable;
  account: AccountTable;
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

export interface AccountTable {
  id: Generated<number>;
  code: string;
  name: string;
  // enum: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  type: string;
  // Nullable: set only for foreign-currency accounts (e.g. BANK_USD).
  currency: string | null;
  // Self-referential FK for chart hierarchy; traversal is deferred (Wave 2
  // reserves the column only).
  parent_id: number | null;
  // SQLite boolean (0/1). System accounts cannot be edited/deleted via API.
  is_system: number;
}
