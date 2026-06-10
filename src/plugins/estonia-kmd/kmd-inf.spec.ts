import { buildInfPart, EE_RATE_BY_CODE } from './kmd-inf';
import { StatutoryDocLine } from '../statutory-report.types';

const line = (over: Partial<StatutoryDocLine>): StatutoryDocLine => ({
  documentKind: 'invoice',
  counterpartyName: 'Acme OÜ',
  counterpartyRegNumber: 'EE100000001',
  invoiceNumber: 'INV-1',
  creditsInvoiceNumber: null,
  date: '2026-05-10',
  vatCode: 'EE_OUTPUT_24',
  netAmount: 200000,
  vatAmount: 48000,
  ...over,
});

describe('buildInfPart', () => {
  it('excludes B2C (no registration number)', () => {
    const { rows } = buildInfPart([line({ counterpartyRegNumber: null, netAmount: 500000 })]);
    expect(rows).toHaveLength(0);
  });

  it('excludes partners under the €1000 net threshold', () => {
    const { rows } = buildInfPart([line({ netAmount: 99999 })]);
    expect(rows).toHaveLength(0);
  });

  it('includes ALL lines of a partner once their net total ≥ €1000', () => {
    const { rows } = buildInfPart([
      line({ invoiceNumber: 'A', netAmount: 60000 }),
      line({ invoiceNumber: 'B', netAmount: 60000 }),
    ]);
    expect(rows.map((r) => r.invoiceNumber).sort()).toEqual(['A', 'B']);
  });

  it('excludes zero-rated and reverse-charge codes from INF', () => {
    const { rows } = buildInfPart([
      line({ vatCode: 'EE_ZERO', netAmount: 500000 }),
      line({ vatCode: 'EE_REVERSE_CHARGE', netAmount: 500000 }),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('maps vat code to numeric rate', () => {
    expect(EE_RATE_BY_CODE['EE_OUTPUT_24']).toBe(24);
    expect(EE_RATE_BY_CODE['EE_INPUT_13']).toBe(13);
  });

  it('warns when a qualifying line has no invoice number', () => {
    const { warnings } = buildInfPart([line({ invoiceNumber: null, netAmount: 500000 })]);
    expect(warnings[0].code).toBe('inf_missing_invoice_number');
    expect(warnings[0].counterparty).toBe('Acme OÜ');
  });
});
