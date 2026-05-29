export interface Organization {
  id: number;
  country: string;
  base_currency: string;
  vat_registered: boolean;
  created_at: number;
}

export interface UpdateOrganizationDto {
  country?: string;
  base_currency?: string;
  vat_registered?: boolean;
}
