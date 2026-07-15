import { describe, expect, it } from 'vitest';
import {
  humanizePolicyReason,
  outcomeText,
  triageChipLabel,
  triageSubtitle,
} from './reason';

describe('humanizePolicyReason', () => {
  it('renders the amount-ceiling hold with euro amounts from the persisted cents', () => {
    expect(
      humanizePolicyReason('Voucher amount 8900 exceeds ceiling 5000'),
    ).toBe('89.00 € above the 50.00 € auto-post limit');
  });
  it('renders the confidence hold with the real numbers', () => {
    expect(humanizePolicyReason('AI confidence 0.41 below threshold 0.8')).toBe(
      'AI confidence 0.41 — below the 0.8 auto-post threshold',
    );
  });
  it('renders the unknown-supplier hold', () => {
    expect(humanizePolicyReason('Unknown supplier requires approval')).toBe(
      'Unknown supplier — policy requires your approval',
    );
  });
  it('unwraps rule failures', () => {
    expect(
      humanizePolicyReason('Semantic rule failure: VAT exceeds gross'),
    ).toBe('Rule check failed: VAT exceeds gross');
  });
  it('falls back to a generic line for null (reconciliation_match carries no reason)', () => {
    expect(humanizePolicyReason(null)).toBe('Held for your approval');
  });
  it('passes unknown strings through verbatim', () => {
    expect(humanizePolicyReason('Some future policy text')).toBe(
      'Some future policy text',
    );
  });
});

describe('triageSubtitle', () => {
  it('extracts the confidence numbers for low_confidence', () => {
    expect(
      triageSubtitle({
        reason: 'AI confidence 0.41 below threshold 0.8',
        reason_type: 'low_confidence',
      }),
    ).toBe('AI confidence 0.41 — below the 0.8 threshold, check the result');
  });
  it('falls back to a fixed line when low_confidence has no numbers', () => {
    expect(
      triageSubtitle({
        reason: 'AI could not classify the document',
        reason_type: 'low_confidence',
      }),
    ).toBe('AI was not confident — check the result');
  });
  it('maps the other reason types to human questions', () => {
    expect(
      triageSubtitle({ reason: 'x', reason_type: 'supplier_unresolved' }),
    ).toBe('Unknown supplier — who is this?');
    expect(
      triageSubtitle({ reason: 'x', reason_type: 'outgoing_invoice' }),
    ).toBe('Looks like your outgoing invoice — confirm it');
    expect(triageSubtitle({ reason: 'x', reason_type: 'ocr_failed' })).toBe(
      'OCR could not read the file — retry or replace',
    );
    expect(
      triageSubtitle({ reason: 'x', reason_type: 'classification_failed' }),
    ).toBe('AI classification failed — retry or classify manually');
    expect(triageSubtitle({ reason: 'x', reason_type: 'not_a_document' })).toBe(
      'Does not look like a business document',
    );
  });
  it('shows the server sentence for unknown types', () => {
    expect(
      triageSubtitle({
        reason: 'Held for human review',
        reason_type: 'unknown',
      }),
    ).toBe('Held for human review');
  });
});

describe('triageChipLabel / outcomeText', () => {
  it('maps reason types to chip verbs', () => {
    expect(triageChipLabel('supplier_unresolved')).toBe('resolve');
    expect(triageChipLabel('low_confidence')).toBe('classify');
    expect(triageChipLabel('outgoing_invoice')).toBe('invoice');
    expect(triageChipLabel('ocr_failed')).toBe('retry');
    expect(triageChipLabel('classification_failed')).toBe('classify');
    expect(triageChipLabel(null)).toBe('review');
  });
  it('describes triage outcomes without IDs', () => {
    expect(
      outcomeText({ kind: 'expense', document_id: 1, expense_id: 2 }),
    ).toBe('Expense created from the document');
    expect(
      outcomeText({ kind: 'bank_statement', document_id: 1, job_id: 9 }),
    ).toBe('Bank statement — import started');
    expect(
      outcomeText({ kind: 'unknown', document_id: 1, reason: 'blurred scan' }),
    ).toBe('Still needs review: blurred scan');
  });
});
