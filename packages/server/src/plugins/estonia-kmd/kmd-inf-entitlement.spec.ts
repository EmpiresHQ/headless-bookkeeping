import { buildInfPart } from './kmd-inf';
import { StatutoryDocLine } from '../statutory-report.types';

/**
 * KMD INF part B against non-deductible input VAT (issue #211).
 *
 * Part B reports the INVOICE: its €1000 threshold is the invoice value WITHOUT
 * VAT, and it carries only invoices whose input VAT was actually deducted. Once
 * irrecoverable VAT is booked into the cost, the ledger legs state neither, so
 * the assembled line carries the document's own figures and this is what reads
 * them.
 */
describe('buildInfPart — purchases and deduction entitlement (issue #211)', () => {
  const line = (over: Partial<StatutoryDocLine> = {}): StatutoryDocLine => ({
    documentKind: 'invoice',
    counterpartyName: 'Seller OÜ',
    counterpartyRegNumber: 'EE101010101',
    invoiceNumber: 'S-1',
    creditsInvoiceNumber: null,
    date: '2026-05-15',
    vatCode: 'EE_INPUT_24',
    netAmount: 100000,
    vatAmount: 24000,
    ...over,
  });

  it('drops a standard-rated purchase on which nothing was deducted', () => {
    const { rows } = buildInfPart(
      [
        line({
          // Nothing deductible: the whole 240 is in the cost.
          netAmount: 124000,
          vatAmount: 0,
          documentNetAmount: 100000,
          documentVatAmount: 24000,
        }),
      ],
      'purchase',
    );
    expect(rows).toHaveLength(0);
  });

  it('measures the threshold on the invoice net, not on the cost', () => {
    // €900 invoice net, half the €216 tax deducted ⇒ cost 1008, which would
    // wrongly cross the €1000 threshold if the cost were used.
    const { rows } = buildInfPart(
      [
        line({
          netAmount: 100800,
          vatAmount: 10800,
          documentNetAmount: 90000,
          documentVatAmount: 21600,
        }),
      ],
      'purchase',
    );
    expect(rows).toHaveLength(0);
  });

  it('reports a qualifying partial invoice at its own value, deducting only what was deducted', () => {
    const { rows } = buildInfPart(
      [
        line({
          netAmount: 112000,
          vatAmount: 12000,
          documentNetAmount: 100000,
          documentVatAmount: 24000,
        }),
      ],
      'purchase',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].netAmount + rows[0].vatAmount).toBe(124000); // invoiceSumVat
    expect(rows[0].vatInPeriod).toBe(12000);
  });

  it('reports a credit note as the negative it is', () => {
    const { rows } = buildInfPart(
      [
        line({
          netAmount: 112000,
          vatAmount: 12000,
          documentNetAmount: 100000,
          documentVatAmount: 24000,
        }),
        line({
          documentKind: 'credit_note',
          invoiceNumber: 'CN-1',
          netAmount: -112000,
          vatAmount: -12000,
          documentNetAmount: -100000,
          documentVatAmount: -24000,
        }),
      ],
      'purchase',
    );
    // The threshold aggregates ABSOLUTE document nets (existing behaviour,
    // unchanged here): |100000| + |-100000| = 200000, over the threshold. What
    // this asserts is the OUTPUT — the refund's figures stay signed, so it
    // subtracts on the return instead of reading as a second purchase.
    expect(rows).toHaveLength(2);
    expect(rows[1].netAmount + rows[1].vatAmount).toBe(-124000);
    expect(rows[1].vatInPeriod).toBe(-12000);
  });

  describe('a payload frozen before #211 carries neither document field', () => {
    /** Exactly what an older version of this code assembled. */
    const legacy = (over: Partial<StatutoryDocLine> = {}): StatutoryDocLine => {
      const l = line(over);
      delete l.documentNetAmount;
      delete l.documentVatAmount;
      return l;
    };

    it('renders it exactly as filed, including a zero-VAT row', () => {
      // A filed return is evidence, not something to re-judge by today's rules:
      // without the marker the new exclusion must not apply.
      const { rows } = buildInfPart(
        [legacy({ netAmount: 124000, vatAmount: 0 })],
        'purchase',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].netAmount).toBe(124000);
      expect(rows[0].vatAmount).toBe(0);
      expect(rows[0].vatInPeriod).toBe(0);
    });

    it('thresholds it on its own ledger net, as it always did', () => {
      expect(
        buildInfPart(
          [legacy({ netAmount: 90000, vatAmount: 21600 })],
          'purchase',
        ).rows,
      ).toHaveLength(0);
      expect(
        buildInfPart(
          [legacy({ netAmount: 100000, vatAmount: 24000 })],
          'purchase',
        ).rows,
      ).toHaveLength(1);
    });
  });

  it('leaves the sales side alone — a zero-VAT sales line is not dropped', () => {
    const { rows } = buildInfPart(
      [line({ vatCode: 'EE_OUTPUT_24', netAmount: 124000, vatAmount: 0 })],
      'sales',
    );
    expect(rows).toHaveLength(1);
  });
});
