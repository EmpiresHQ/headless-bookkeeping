export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';

export interface Account {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  currency: string | null;
  parent_id: number | null;
  is_system: boolean;
}
