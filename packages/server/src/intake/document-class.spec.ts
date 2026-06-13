import { classifyDocumentClass } from './document-class';

describe('classifyDocumentClass', () => {
  it('routes an invoice/receipt to sales_invoice when our IBAN matched', () => {
    expect(
      classifyDocumentClass({ documentType: 'invoice', ibanMatched: true }),
    ).toEqual({
      route: 'sales_invoice',
      direction: 'outgoing',
      docType: 'invoice',
    });
    expect(
      classifyDocumentClass({ documentType: 'receipt', ibanMatched: true })
        .route,
    ).toBe('sales_invoice');
  });

  it('routes an invoice/receipt to expense when our IBAN did NOT match', () => {
    expect(
      classifyDocumentClass({ documentType: 'invoice', ibanMatched: false }),
    ).toEqual({ route: 'expense', direction: 'incoming', docType: 'invoice' });
  });

  it('routes a bank statement to bank_statement regardless of IBAN', () => {
    expect(
      classifyDocumentClass({
        documentType: 'bank_statement',
        ibanMatched: true,
      }).route,
    ).toBe('bank_statement');
    expect(
      classifyDocumentClass({
        documentType: 'bank_statement',
        ibanMatched: false,
      }).route,
    ).toBe('bank_statement');
  });

  it('routes credit_note/other to unsupported ONLY when our IBAN matched (we are the payee)', () => {
    expect(
      classifyDocumentClass({ documentType: 'credit_note', ibanMatched: true }),
    ).toEqual({
      route: 'unsupported',
      direction: 'outgoing',
      docType: 'credit_note',
    });
    expect(
      classifyDocumentClass({ documentType: 'other', ibanMatched: true }).route,
    ).toBe('unsupported');
  });

  it('routes a non-IBAN document of ANY non-bank type to the existing expense path (incoming, unchanged)', () => {
    expect(
      classifyDocumentClass({ documentType: 'other', ibanMatched: false }),
    ).toEqual({ route: 'expense', direction: 'incoming', docType: 'other' });
    expect(
      classifyDocumentClass({ documentType: 'credit_note', ibanMatched: false })
        .route,
    ).toBe('expense');
  });
});
