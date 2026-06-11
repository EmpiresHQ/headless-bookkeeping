import { renderKmdCsv } from './kmd-csv';
import { StatutoryReportInput } from '../statutory-report.types';

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
  purchaseLines: [
    {
      documentKind: 'invoice',
      counterpartyName: 'Vend OÜ',
      counterpartyRegNumber: 'EE100000003',
      invoiceNumber: 'SUP-1',
      creditsInvoiceNumber: null,
      date: '2026-05-12',
      vatCode: 'EE_INPUT_24',
      netAmount: 500000,
      vatAmount: 120000,
    },
  ],
};

it('emits a KMD6 main row first with FALSE flags and the 24% net base', () => {
  const csv = renderKmdCsv(input);
  const rows = csv.split('\r\n');
  expect(rows[0].startsWith('KMD6;')).toBe(true);
  const cols = rows[0].split(';');
  expect(cols[0]).toBe('KMD6');
  expect(cols[1]).toBe('FALSE'); // noSales (we have a sale row)
  expect(cols[2]).toBe('FALSE'); // noPurchases
  expect(cols[5]).toBe('2000.00'); // transactions24 net base
});

it('emits an A row for the sale and a B row for the purchase', () => {
  const csv = renderKmdCsv(input);
  const rows = csv.split('\r\n');
  const a = rows.find((r) => r.startsWith('A;'));
  const b = rows.find((r) => r.startsWith('B;'));
  expect(a).toBe('A;EE100000002;Acme OÜ;INV-1;2026-05-10;2000.00;24');
  expect(b).toBe('B;EE100000003;Vend OÜ;SUP-1;2026-05-12;6200.00;;1200.00');
});
