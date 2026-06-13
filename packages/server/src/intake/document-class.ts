export type DocumentType =
  | 'invoice'
  | 'receipt'
  | 'bank_statement'
  | 'credit_note'
  | 'other';

export type IntakeRoute = 'expense' | 'sales_invoice' | 'bank_statement' | 'unsupported';

export interface DocumentClass {
  route: IntakeRoute;
  direction: 'incoming' | 'outgoing' | 'none';
  docType: DocumentType;
}

/**
 * Pure intake router. The document TYPE (from the agent) is the top
 * discriminator; the org-IBAN match (decided in code) is the direction
 * sub-discriminator within invoice/receipt. A bank statement also carries our
 * IBAN, so it is matched on type BEFORE the IBAN gate is consulted. Unknown /
 * not-yet-supported classes route to 'unsupported' (the workflow parks them).
 */
export function classifyDocumentClass(input: {
  documentType: DocumentType;
  ibanMatched: boolean;
}): DocumentClass {
  const { documentType, ibanMatched } = input;

  if (documentType === 'bank_statement') {
    return { route: 'bank_statement', direction: 'none', docType: documentType };
  }

  if (documentType === 'invoice' || documentType === 'receipt') {
    return ibanMatched
      ? { route: 'sales_invoice', direction: 'outgoing', docType: documentType }
      : { route: 'expense', direction: 'incoming', docType: documentType };
  }

  // credit_note + other → not booked automatically in v1.
  return { route: 'unsupported', direction: 'none', docType: documentType };
}
