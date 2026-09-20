export interface Organization {
  id: number;
  country: string;
  // Nullable override: null means "inherit base currency from the country
  // plugin" (ADR-0004).
  base_currency: string | null;
  vat_registered: boolean;
  // Which kind of VAT registration (issue #211). 'ordinary' deducts input VAT;
  // 'limited' (piiratud maksukohustuslane) self-assesses output tax on
  // specified acquisitions and deducts nothing.
  vat_registration_kind: 'ordinary' | 'limited';
  // Right to deduct input VAT (issue #211).
  input_vat_entitlement: 'full' | 'partial' | 'none';
  // Deductible proportion in per mille (0…1000) when entitlement is 'partial';
  // null otherwise.
  input_vat_deduction_permille: number | null;
  // Legal form: 'company' | 'sole_proprietor' (ADR-0017/ADR-0023).
  org_type: string;
  created_at: number;
  // VAT registration (KMKR); distinct from the commercial registry code.
  vat_registration_number: string | null;
  registry_code: string | null;
  name: string | null;
  iban: string | null;
}

export interface UpdateOrganizationDto {
  country?: string;
  // Pass null to clear the override and fall back to the country plugin default.
  base_currency?: string | null;
  vat_registered?: boolean;
  vat_registration_kind?: 'ordinary' | 'limited';
  input_vat_entitlement?: 'full' | 'partial' | 'none';
  // Pass null to clear the proportion (required when leaving 'partial').
  input_vat_deduction_permille?: number | null;
  org_type?: 'company' | 'sole_proprietor';
  vat_registration_number?: string | null;
  registry_code?: string | null;
  name?: string | null;
  iban?: string | null;
}
