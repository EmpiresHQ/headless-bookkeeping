import { Injectable } from '@nestjs/common';
import { TriageResult } from './types';

@Injectable()
export class OcrService {
  /**
   * Stub OCR: deterministic odd/even by document id.
   *
   * Odd id  -> receipt / Bolt / 1525 gross / 275 vat / transport / DK_INPUT_25 / 0.94 confidence
   * Even id -> invoice / OpenAI / 10000 gross / 2500 vat / software / DK_INPUT_25 / 0.98 confidence
   */
  extract(documentId: number): TriageResult {
    if (documentId % 2 === 1) {
      return {
        document_type: 'receipt',
        entity_guess: 'Bolt',
        gross_amount: 1525,
        vat_amount: 275,
        category: 'transport',
        vat_code: 'DK_INPUT_25',
        confidence: 0.94,
      };
    }

    return {
      document_type: 'invoice',
      entity_guess: 'OpenAI',
      gross_amount: 10000,
      vat_amount: 2500,
      category: 'software',
      vat_code: 'DK_INPUT_25',
      confidence: 0.98,
    };
  }
}
