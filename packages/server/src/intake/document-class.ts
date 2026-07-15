export type DocumentType =
  | 'invoice'
  | 'receipt'
  | 'bank_statement'
  | 'credit_note'
  | 'order_confirmation'
  | 'proforma'
  | 'other';

export type IntakeRoute =
  | 'expense'
  | 'sales_invoice'
  | 'bank_statement'
  | 'unsupported';

export interface DocumentClass {
  route: IntakeRoute;
  direction: 'incoming' | 'outgoing' | 'none';
  docType: DocumentType;
}

/**
 * Pure intake router. The default route is `expense` (incoming) — that is the
 * existing path for documents that arrive from outside the org. The ONLY ways to
 * leave the expense path are:
 *
 *  1. documentType === 'bank_statement'  → bank_statement (always, IBAN ignored)
 *  2. ibanMatched && invoice/receipt     → sales_invoice  (we are the seller)
 *  3. ibanMatched && credit_note/other   → unsupported    (our IBAN but not a
 *                                          clean sale — park for manual review)
 *
 * Any non-bank document WITHOUT an IBAN match routes to expense, regardless of
 * its declared type (including credit_note and other, which the AI may emit for
 * perfectly ordinary incoming expenses).
 */
export function classifyDocumentClass(input: {
  documentType: DocumentType;
  ibanMatched: boolean;
}): DocumentClass {
  const { documentType, ibanMatched } = input;

  if (documentType === 'bank_statement') {
    return {
      route: 'bank_statement',
      direction: 'none',
      docType: documentType,
    };
  }

  if (ibanMatched) {
    if (documentType === 'invoice' || documentType === 'receipt') {
      return {
        route: 'sales_invoice',
        direction: 'outgoing',
        docType: documentType,
      };
    }
    // credit_note, other — our IBAN present but not a clean sale → park.
    return {
      route: 'unsupported',
      direction: 'outgoing',
      docType: documentType,
    };
  }

  // No IBAN match, non-bank type → existing incoming expense path, unchanged.
  return { route: 'expense', direction: 'incoming', docType: documentType };
}
