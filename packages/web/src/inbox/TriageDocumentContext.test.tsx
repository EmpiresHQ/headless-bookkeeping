import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DocumentDetails } from '../api';
import { TriageDocumentContext } from './TriageDocumentContext';

const DETAILS = (
  over: Partial<
    NonNullable<
      Extract<DocumentDetails['classification'], { ok: true }>['result']
    >
  > = {},
): DocumentDetails => ({
  document_id: 12,
  ocr: { ok: true, markdown: 'CIRCLE K 48.20 …' },
  classification: {
    ok: true,
    result: {
      kind: 'new_expense',
      document_type: 'receipt',
      gross_amount: 4820,
      vat_amount: 867,
      currency: 'EUR',
      tax_point_date: '2026-07-01',
      category: 'fuel',
      document_vat_marking: null,
      supplier_invoice_number: null,
      confidence: 0.41,
      ...over,
    },
  },
});

describe('TriageDocumentContext', () => {
  it('renders persisted intake facts with a signed amount and VAT rate', () => {
    render(<TriageDocumentContext details={DETAILS()} />);
    expect(screen.getByText('Extracted facts')).toBeInTheDocument();
    expect(screen.getByText('−48.20 €')).toBeInTheDocument();
    // 867 cents VAT on 4820 gross ≈ 22% of the net.
    expect(screen.getByText(/8\.67 € \(\d+%\)/)).toBeInTheDocument();
    expect(screen.getByText('01.07.2026')).toBeInTheDocument();
    expect(screen.getByText('fuel')).toBeInTheDocument();
  });

  it('flags low AI confidence with the warning tone', () => {
    render(<TriageDocumentContext details={DETAILS({ confidence: 0.41 })} />);
    expect(screen.getByText('0.41')).toHaveClass('text-warn');
  });

  it('marks high AI confidence with the ok tone', () => {
    render(<TriageDocumentContext details={DETAILS({ confidence: 0.95 })} />);
    expect(screen.getByText('0.95')).toHaveClass('text-ok');
  });

  it('discloses the raw OCR text in a collapsed section', () => {
    render(<TriageDocumentContext details={DETAILS()} />);
    const details = screen.getByText('OCR text').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('CIRCLE K 48.20 …');
  });

  it('renders nothing until details load', () => {
    const { container } = render(<TriageDocumentContext details={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
