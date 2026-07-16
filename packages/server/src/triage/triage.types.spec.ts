import { pass2FailureReason } from '../ai/intake-workflow.service';
import type { Pass2FailureCategory } from '../ai/pass2-agent.service';
import {
  classifyReasonType,
  isTriageReasonType,
  resolveReasonType,
  TRIAGE_REASON_TYPES,
} from './types';

describe('classifyReasonType', () => {
  it('maps supplier reason', () => {
    expect(
      classifyReasonType('supplier could not be resolved automatically'),
    ).toBe('supplier_unresolved');
  });
  it('maps low confidence reason', () => {
    expect(classifyReasonType('AI confidence 0.61 below threshold 0.8')).toBe(
      'low_confidence',
    );
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
    expect(
      classifyReasonType("new_expense has an unknown category 'foo'"),
    ).toBe('category_unresolved');
  });
  it('maps OCR failure reason', () => {
    expect(
      classifyReasonType(
        'OCR transcription failed (unreadable): file too blurry',
      ),
    ).toBe('ocr_failed');
    // A Pass-2 failure string is NOT an OCR failure — the file/OCR are fine,
    // only the agent classification failed (the bug this module fixes: this
    // used to fall into the 'classification failed' OCR-bucket keyword).
    expect(
      classifyReasonType(
        'AI classification failed (timeout): agent unavailable',
      ),
    ).toBe('classification_failed');
  });
  it('maps unimplemented kinds', () => {
    expect(
      classifyReasonType("Triage kind 'correction' is not yet implemented"),
    ).toBe('unimplemented');
  });
  it('maps ai_unknown (could not classify) to low_confidence', () => {
    expect(classifyReasonType('AI could not classify the document')).toBe(
      'low_confidence',
    );
  });
  it('falls back to unknown', () => {
    expect(classifyReasonType('some unexpected reason')).toBe('unknown');
  });
});

// Contract between pass2FailureReason() and classifyReasonType(): every
// Pass-2 failure string it can produce must bucket to 'classification_failed'
// — never 'ocr_failed' or 'supplier_unresolved'. The file/OCR are fine when
// Pass 2 fails; only the agent classification step failed.
describe('classifyReasonType(pass2FailureReason(...)) contract', () => {
  const PASS2_FAILURE_CATEGORIES: Pass2FailureCategory[] = [
    'enrichment-failed',
    'enrichment-incomplete',
    'enrichment-tool-not-called',
    'invalid-output',
    'transient',
    'agent-unavailable',
  ];

  it.each(PASS2_FAILURE_CATEGORIES)(
    'maps every pass2FailureReason category (%s) to classification_failed',
    (category) => {
      expect(
        classifyReasonType(pass2FailureReason(category, 'some detail')),
      ).toBe('classification_failed');
    },
  );

  it('is not mis-bucketed as supplier_unresolved by a Zod path in the detail', () => {
    // Guards the supplier-bucket-order hazard: pass2FailureReason interpolates
    // raw error text, which for an invalid-output failure can be a Zod path
    // like "supplier_proposal.match_entity_id".
    expect(
      classifyReasonType(
        pass2FailureReason(
          'invalid-output',
          'Zod error at supplier_proposal.match_entity_id',
        ),
      ),
    ).toBe('classification_failed');
  });

  it('is not mis-bucketed as ocr_failed by an "OCR" mention in the detail', () => {
    expect(
      classifyReasonType(
        pass2FailureReason('transient', 'OCR-ish text in the detail'),
      ),
    ).toBe('classification_failed');
  });

  it('maps the literal production string (enrichment-incomplete) to classification_failed', () => {
    expect(
      classifyReasonType(
        'AI classification failed during enrichment (enrichment-incomplete): enrichment phase returned no reusable summary',
      ),
    ).toBe('classification_failed');
  });

  it('still maps a genuine OCR failure to ocr_failed', () => {
    expect(
      classifyReasonType(
        'OCR transcription failed (unreadable): file too blurry',
      ),
    ).toBe('ocr_failed');
  });
});

describe('new reason types (order/proforma park + duplicate gate)', () => {
  it('registers both new reason types on the type guard and array', () => {
    expect(isTriageReasonType('non_postable_document')).toBe(true);
    expect(isTriageReasonType('possible_duplicate')).toBe(true);
    expect(TRIAGE_REASON_TYPES).toEqual(
      expect.arrayContaining(['non_postable_document', 'possible_duplicate']),
    );
  });
  it('maps a non-postable (order confirmation / proforma) park reason', () => {
    expect(
      classifyReasonType(
        'Order confirmation — not a primary tax document; awaiting the final invoice',
      ),
    ).toBe('non_postable_document');
  });
  it('maps a duplicate-gate reason, winning over the generic supplier check', () => {
    // Contains the word "supplier" — must still resolve to possible_duplicate
    // because the duplicate branch is ordered before the supplier branch.
    expect(
      classifyReasonType(
        'possible duplicate of expense #84 (same supplier, 52.00 gross, 2026-07-15)',
      ),
    ).toBe('possible_duplicate');
  });
});

describe('isTriageReasonType', () => {
  it.each(TRIAGE_REASON_TYPES)('accepts every known reason type (%s)', (rt) => {
    expect(isTriageReasonType(rt)).toBe(true);
  });

  it('rejects an unrecognized string', () => {
    expect(isTriageReasonType('made_up_reason')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isTriageReasonType(null)).toBe(false);
    expect(isTriageReasonType(undefined)).toBe(false);
    expect(isTriageReasonType(42)).toBe(false);
  });
});

describe('resolveReasonType', () => {
  it('prefers the persisted value when it is a valid TriageReasonType', () => {
    // The description would legacy-classify as ocr_failed (mentions "OCR"),
    // but the persisted write-time value must win — this is the exact bug
    // migration 065 fixes (a Pass-2 failure mislabeled via string-sniffing).
    expect(
      resolveReasonType(
        'classification_failed',
        'AI classification failed during enrichment (enrichment-incomplete): OCR-ish text',
      ),
    ).toBe('classification_failed');
  });

  it('falls back to classifyReasonType when persisted is null (legacy row)', () => {
    expect(
      resolveReasonType(
        null,
        'OCR transcription failed (unreadable): file too blurry',
      ),
    ).toBe('ocr_failed');
  });

  it('falls back to classifyReasonType when persisted is undefined', () => {
    expect(
      resolveReasonType(undefined, 'AI confidence 0.61 below threshold 0.8'),
    ).toBe('low_confidence');
  });

  it('falls back to classifyReasonType when persisted is an unrecognized value (junk)', () => {
    expect(
      resolveReasonType(
        'not_a_real_reason_type',
        'AI confidence 0.61 below threshold 0.8',
      ),
    ).toBe('low_confidence');
  });
});
