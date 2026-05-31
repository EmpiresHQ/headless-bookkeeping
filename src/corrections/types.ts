export type CorrectionType = 'cosmetic' | 'financial' | 'credit_note';

export type CorrectionKind = 'supersession' | 'reversal';

export interface CorrectionRequest {
  kind: CorrectionType;
  reason: string;
  patch?: {
    gross_amount?: number;
    vat_amount?: number;
    category?: string;
  };
}

export interface CorrectionResult {
  outcome: string;
  reversalVoucherId?: number;
  correctedVoucherId?: number;
  draftVoucher?: unknown;
}
