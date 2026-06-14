export interface Organization {
  id: number;
  country: string;
  // Nullable override: null means "inherit base currency from the country
  // plugin" (ADR-0004).
  base_currency: string | null;
  vat_registered: boolean;
  // Legal form: 'company' | 'sole_proprietor' (ADR-0017/ADR-0023).
  org_type: string;
  created_at: number;
  // Declarant identity for statutory reports (migration 037).
  vat_registration_number: string | null;
  name: string | null;
  iban: string | null;
}

export interface UpdateOrganizationDto {
  country?: string;
  // Pass null to clear the override and fall back to the country plugin default.
  base_currency?: string | null;
  vat_registered?: boolean;
  org_type?: 'company' | 'sole_proprietor';
  vat_registration_number?: string | null;
  name?: string | null;
  iban?: string | null;
}
