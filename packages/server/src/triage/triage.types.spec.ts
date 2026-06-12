import { classifyReasonType } from './types';

describe('classifyReasonType', () => {
  it('maps supplier reason', () => {
    expect(classifyReasonType('supplier could not be resolved automatically'))
      .toBe('supplier_unresolved');
  });
  it('maps low confidence reason', () => {
    expect(classifyReasonType('AI confidence 0.61 below threshold 0.8'))
      .toBe('low_confidence');
  });
  it('maps category unresolved reason', () => {
    expect(classifyReasonType("new_expense has an unknown category 'foo'"))
      .toBe('category_unresolved');
  });
  it('maps OCR failure reason', () => {
    expect(classifyReasonType('OCR transcription failed (unreadable): file too blurry'))
      .toBe('ocr_failed');
    expect(classifyReasonType('AI classification failed (timeout): agent unavailable'))
      .toBe('ocr_failed');
  });
  it('maps unimplemented kinds', () => {
    expect(classifyReasonType("Triage kind 'correction' is not yet implemented"))
      .toBe('unimplemented');
  });
  it('maps ai_unknown (could not classify) to low_confidence', () => {
    expect(classifyReasonType('AI could not classify the document'))
      .toBe('low_confidence');
  });
  it('falls back to unknown', () => {
    expect(classifyReasonType('some unexpected reason'))
      .toBe('unknown');
  });
});
