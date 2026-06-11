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
  // The pinned currency of the line's account (null for base-currency accounts).
  // ADR-0004: a line on a foreign-currency account must carry that currency.
  account_currency: string | null;
}
