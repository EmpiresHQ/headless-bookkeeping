import { OcrService } from './ocr.service';

describe('OcrService', () => {
  let service: OcrService;

  beforeEach(() => {
    service = new OcrService();
  });

  describe('extract', () => {
    it('returns receipt for odd document ids', () => {
      const result = service.extract(1);
      expect(result.kind).toBe('new_expense');
      expect(result.document_type).toBe('receipt');
      expect(result.gross_amount).toBe(1525);
      expect(result.vat_amount).toBe(285);
      expect(result.currency).toBe('EUR');
      expect(result.tax_point_date).toBe('2025-01-15');
      expect(result.category).toBe('transport');
      expect(result.document_vat_marking).toBe('IE_INPUT_23');
      expect(result.confidence).toBe(0.94);
    });

    it('returns invoice for even document ids', () => {
      const result = service.extract(2);
      expect(result.kind).toBe('new_expense');
      expect(result.document_type).toBe('invoice');
      expect(result.gross_amount).toBe(12300);
      expect(result.vat_amount).toBe(2300);
      expect(result.currency).toBe('EUR');
      expect(result.tax_point_date).toBe('2025-01-20');
      expect(result.category).toBe('revenue');
      expect(result.document_vat_marking).toBe('IE_OUTPUT_23');
      expect(result.confidence).toBe(0.98);
    });

    it('is deterministic for the same id', () => {
      const r1 = service.extract(3);
      const r2 = service.extract(3);
      expect(r1).toEqual(r2);
    });
  });
});
