export interface TriageResult {
  document_type: 'receipt' | 'invoice' | 'unknown';
  entity_guess: string;
  gross_amount: number;
  vat_amount: number;
  category: string;
  vat_code: string;
  confidence: number;
}

export interface TriageOutcomeExpense {
  kind: 'expense';
  document_id: number;
  expense_id: number;
}

export interface TriageOutcomeInvoice {
  kind: 'invoice';
  document_id: number;
  invoice_id: number;
}

export interface TriageOutcomeUnknown {
  kind: 'unknown';
  document_id: number;
  reason: string;
}

export type TriageOutcome =
  | TriageOutcomeExpense
  | TriageOutcomeInvoice
  | TriageOutcomeUnknown;
