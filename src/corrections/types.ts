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
  /**
   * True when the original voucher's period was locked and the reversal +
   * correction were re-dated into the current open period (ADR-0009).
   */
  redirected?: boolean;
  /** The open period the correction was redirected into (when `redirected`). */
  redirectedToPeriodId?: number;
}
