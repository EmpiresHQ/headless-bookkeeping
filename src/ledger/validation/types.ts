export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface ValidatableLine {
  account_id: number;
  amount: number;
  currency: string;
  base_amount: number;
  fx_rate: number;
  is_debit: boolean;
}
