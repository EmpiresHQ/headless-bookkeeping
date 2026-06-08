import { Injectable } from '@nestjs/common';
import { TriageResult } from './types';

@Injectable()
export class OcrService {
  /**
   * Stub OCR: deterministic odd/even by document id.
   *
   * IE/EUR defaults (ADR-0004) with VAT codes NullCountryPlugin accepts
   * (ADR-0002), so triaged drafts pass semantic validation without override.
   *
   * Odd id  -> receipt / Bolt / 1525 gross / 285 vat / transport / IE_INPUT_23 / 0.94 confidence
   * Even id -> invoice / Acme Ltd / 12300 gross / 2300 vat / revenue / IE_OUTPUT_23 / 0.98 confidence
   *            (a sales invoice carries output VAT; the draft generator resolves
   *             'revenue' -> IE_OUTPUT_23 regardless, ADR-0002)
   */
  extract(documentId: number): TriageResult {
    if (documentId % 2 === 1) {
      return {
        kind: 'new_expense',
        document_type: 'receipt',
        gross_amount: 1525,
        vat_amount: 285,
        currency: 'EUR',
        tax_point_date: '2025-01-15',
        category: 'transport',
        document_vat_marking: 'IE_INPUT_23',
        confidence: 0.94,
      };
    }

    return {
      kind: 'new_expense',
      document_type: 'invoice',
      gross_amount: 12300,
      vat_amount: 2300,
      currency: 'EUR',
      tax_point_date: '2025-01-20',
      category: 'revenue',
      document_vat_marking: 'IE_OUTPUT_23',
      confidence: 0.98,
    };
  }
}
