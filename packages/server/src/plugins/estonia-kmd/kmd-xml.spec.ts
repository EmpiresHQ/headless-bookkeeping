import { renderKmdXml } from './kmd-xml';
import { validateAgainstKmdXsd } from './xsd-validate';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StatutoryReportInput } from '../statutory-report.types';

const xsd = readFileSync(
  join(__dirname, '../../../test/fixtures/vatdeclaration.xsd'),
  'utf8',
);

const input: StatutoryReportInput = {
  declarant: { regNumber: 'EE100000001', name: 'Test OÜ' },
  period: { name: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31' },
  mode: 'final',
  boxes: [
    {
      vat_code: 'EE_OUTPUT_24',
      input_vat: 0,
      output_vat: 48000,
      line_count: 1,
    },
  ],
  totals: { totalInputVat: 0, totalOutputVat: 48000, totalPayable: 48000 },
  salesLines: [
    {
      documentKind: 'invoice',
      counterpartyName: 'Acme OÜ',
      counterpartyRegNumber: 'EE100000002',
      invoiceNumber: 'INV-1',
      creditsInvoiceNumber: null,
      date: '2026-05-10',
      vatCode: 'EE_OUTPUT_24',
      netAmount: 200000,
      vatAmount: 48000,
    },
  ],
  purchaseLines: [],
};

it('produces XSD-valid KMD XML with declarant + period', () => {
  const xml = renderKmdXml(input);
  const res = validateAgainstKmdXsd(xml, xsd);
  expect(res.errors).toEqual([]);
  expect(res.valid).toBe(true);
  expect(xml).toContain('<taxPayerRegCode>EE100000001</taxPayerRegCode>');
});

it('includes the INF Part A row for a ≥€1000 partner', () => {
  const xml = renderKmdXml(input);
  expect(xml).toContain('<invoiceNumber>INV-1</invoiceNumber>');
  expect(xml).toContain('EE100000002');
  expect(xml).toContain('<invoiceSum>2000.00</invoiceSum>');
  expect(xml).toContain('<taxRate>24</taxRate>');
});

it('stays XSD-valid with a purchase line and a credit note (negative)', () => {
  const withB = {
    ...input,
    purchaseLines: [
      {
        documentKind: 'invoice' as const,
        counterpartyName: 'Vend OÜ',
        counterpartyRegNumber: 'EE100000003',
        invoiceNumber: 'SUP-1',
        creditsInvoiceNumber: null,
        date: '2026-05-12',
        vatCode: 'EE_INPUT_24',
        netAmount: 500000,
        vatAmount: 120000,
      },
      {
        documentKind: 'credit_note' as const,
        counterpartyName: 'Vend OÜ',
        counterpartyRegNumber: 'EE100000003',
        invoiceNumber: 'CN-1',
        creditsInvoiceNumber: 'SUP-1',
        date: '2026-05-20',
        vatCode: 'EE_INPUT_24',
        netAmount: -100000,
        vatAmount: -24000,
      },
    ],
  };
  const res = validateAgainstKmdXsd(renderKmdXml(withB), xsd);
  expect(res.errors).toEqual([]);
});
