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
  it('maps every routeSalesInvoice park reason to outgoing_invoice (checked first)', () => {
    // Below-threshold outgoing park: must win over the low_confidence check.
    expect(
      classifyReasonType(
        'Outgoing invoice — AI confidence 0.5 below threshold 0.8',
      ),
    ).toBe('outgoing_invoice');
    // Customer-unresolved outgoing park: must win over the supplier check
    // (the underlying reason mentions neither supplier nor customer-as-supplier).
    expect(
      classifyReasonType(
        'Outgoing invoice — customer must be created or selected by an operator before this outgoing invoice can be booked',
      ),
    ).toBe('outgoing_invoice');
    // Invoice-number-missing outgoing park.
    expect(
      classifyReasonType(
        'Outgoing invoice — no invoice number found on the document',
      ),
    ).toBe('outgoing_invoice');
    // Duplicate-number outgoing park.
    expect(
      classifyReasonType(
        'Outgoing invoice — invoice number INV-77 already exists (likely a duplicate of an already-booked invoice)',
      ),
    ).toBe('outgoing_invoice');
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
