import { OcrService } from './ocr.service';

describe('OcrService', () => {
  let service: OcrService;

  beforeEach(() => {
    service = new OcrService();
  });

  describe('extract', () => {
    it('returns receipt for odd document ids', () => {
      const result = service.extract(1);
      expect(result.document_type).toBe('receipt');
      expect(result.entity_guess).toBe('Bolt');
      expect(result.gross_amount).toBe(1525);
      expect(result.vat_amount).toBe(275);
      expect(result.category).toBe('transport');
      expect(result.vat_code).toBe('DK_INPUT_25');
      expect(result.confidence).toBe(0.94);
    });

    it('returns invoice for even document ids', () => {
      const result = service.extract(2);
      expect(result.document_type).toBe('invoice');
      expect(result.entity_guess).toBe('OpenAI');
      expect(result.gross_amount).toBe(10000);
      expect(result.vat_amount).toBe(2500);
      expect(result.category).toBe('software');
      expect(result.vat_code).toBe('DK_INPUT_25');
      expect(result.confidence).toBe(0.98);
    });

    it('is deterministic for the same id', () => {
      const r1 = service.extract(3);
      const r2 = service.extract(3);
      expect(r1).toEqual(r2);
    });
  });
});
