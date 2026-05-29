export interface Organization {
  id: number;
  country: string;
  // Nullable override: null means "inherit base currency from the country
  // plugin" (ADR-0004).
  base_currency: string | null;
  vat_registered: boolean;
  created_at: number;
}

export interface UpdateOrganizationDto {
  country?: string;
  // Pass null to clear the override and fall back to the country plugin default.
  base_currency?: string | null;
  vat_registered?: boolean;
}
