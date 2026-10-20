import type { EuVatFacts } from '../plugins/eu-vat';
import type { ServicePlaceRule } from '../plugins/country-plugin.interface';
export interface FinancialPatch {
  gross_amount?: number;
  vat_amount?: number;
  category?: string;
  service_place_rule?: ServicePlaceRule;
  place_of_supply_country?: string | null;
  eu_vat_facts?: EuVatFacts | null;
}
/**
 * `reversal` undoes a posting outright — no replacement voucher. It exists for
 * entries that should never have been booked at all (a duplicate of another
 * object, a personal expense that reached the books), where `financial` is the
 * wrong shape: that one always mints a corrected voucher, and there is nothing
 * to correct TO. ADR-0010 assumes duplicates are caught at triage, before a
 * voucher exists; when one slips through, this is the only sound way back.
 */
export type CorrectionType =
  | 'cosmetic'
  | 'financial'
  | 'credit_note'
  | 'reversal';

export type CorrectionKind = 'supersession' | 'reversal';

export interface CreditNotePayload {
  credit_note_number: string;
  gross_amount: number;
  vat_amount: number;
  tax_point_date: string;
}

export interface CorrectionRequest {
  kind: CorrectionType;
  reason: string;
  patch?: FinancialPatch;
  /** Present when `kind === 'credit_note'`. */
  creditNote?: CreditNotePayload;
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
  /** Present when `outcome === 'credit_note_created'`. */
  creditNoteId?: number;
}
