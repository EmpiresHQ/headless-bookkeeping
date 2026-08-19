import {
  DuplicateExpenseRow,
  findDuplicateExpense,
  normalizeInvoiceNumber,
} from './duplicate-detection';

/**
 * Unit spec for the deterministic duplicate-detection key (issue #195).
 *
 * It proves, over the real production data quoted in the issue, that:
 *  (a) normalisation folds case, separators and the OCR confusables I→1, O→0;
 *  (b) two expenses match on (supplier_id, normalised invoice number) when
 *      BOTH sides print a number;
 *  (c) the (supplier_id, currency, gross_amount, tax_point_date, claimant_id)
 *      fallback fires ONLY when the INCOMING document prints no number — so
 *      the five legitimate Anomaly invoices of 16.00 on 2026-05-31 are NOT
 *      collapsed, not even when the earliest of them lost its number to OCR;
 *  (d) a `reversed` expense never blocks creation;
 *  (e) a NULL supplier never groups.
 */
describe('duplicate-detection', () => {
  describe('normalizeInvoiceNumber', () => {
    it('uppercases', () => {
      expect(normalizeInvoiceNumber('ri7uspnx0013')).toBe('R17USPNX0013');
    });

    it('strips everything non-alphanumeric', () => {
      expect(normalizeInvoiceNumber('CHK 906485')).toBe('CHK906485');
      expect(normalizeInvoiceNumber('R17USPNX-0014')).toBe('R17USPNX0014');
    });

    it('folds the OCR confusables I→1 and O→0', () => {
      expect(normalizeInvoiceNumber('RI7USPNX0014')).toBe('R17USPNX0014');
      expect(normalizeInvoiceNumber('INV-O01')).toBe('1NV001');
    });

    it('treats an absent, empty or punctuation-only number as no number', () => {
      expect(normalizeInvoiceNumber(null)).toBeNull();
      expect(normalizeInvoiceNumber(undefined)).toBeNull();
      expect(normalizeInvoiceNumber('')).toBeNull();
      expect(normalizeInvoiceNumber('   ')).toBeNull();
      expect(normalizeInvoiceNumber('---')).toBeNull();
    });
  });

  describe('findDuplicateExpense', () => {
    const SUPPLIER_ANOMALY = 11;
    const SUPPLIER_NEXT_HOUSE = 12;
    const SUPPLIER_MOBILE_TRADE = 13;
    const SUPPLIER_X_CORP = 14;

    const row = (
      over: Partial<DuplicateExpenseRow> & { id: number },
    ): DuplicateExpenseRow => ({
      supplier_id: SUPPLIER_ANOMALY,
      currency: 'EUR',
      supplier_invoice_number: null,
      gross_amount: 1600,
      tax_point_date: '2026-05-31',
      status: 'draft',
      claimant_id: null,
      ai_document_type: 'invoice',
      ...over,
    });

    it('matches identical invoice numbers (production pair 43 / 69)', () => {
      const existing = [
        row({
          id: 43,
          supplier_invoice_number: 'RI7USPNX0013',
          gross_amount: 5200,
          tax_point_date: '2026-04-30',
        }),
      ];
      const hit = findDuplicateExpense(
        {
          supplier_id: SUPPLIER_ANOMALY,
          currency: 'EUR',
          supplier_invoice_number: 'RI7USPNX0013',
          gross_amount: 5200,
          tax_point_date: '2026-04-30',
        },
        existing,
      );
      expect(hit?.existingExpenseId).toBe(43);
      expect(hit?.matchedOn).toBe('invoice_number');
      expect(hit?.reason).toContain('possible duplicate of expense #43');
    });

    it('matches through OCR damage: RI7USPNX0014 vs R17USPNX-0014 (pair 72 / 73)', () => {
      const existing = [
        row({ id: 72, supplier_invoice_number: 'RI7USPNX0014' }),
      ];
      const hit = findDuplicateExpense(
        {
          supplier_id: SUPPLIER_ANOMALY,
          currency: 'EUR',
          supplier_invoice_number: 'R17USPNX-0014',
          gross_amount: 1600,
          tax_point_date: '2026-05-31',
        },
        existing,
      );
      expect(hit?.existingExpenseId).toBe(72);
      expect(hit?.matchedOn).toBe('invoice_number');
    });

    it('matches a number carrying a space (pair 77 / 80, CHK 906485)', () => {
      const existing = [
        row({
          id: 77,
          supplier_id: SUPPLIER_NEXT_HOUSE,
          currency: 'EUR',
          supplier_invoice_number: 'CHK 906485',
          gross_amount: 6000,
          tax_point_date: '2026-06-01',
        }),
      ];
      const hit = findDuplicateExpense(
        {
          supplier_id: SUPPLIER_NEXT_HOUSE,
          currency: 'EUR',
          supplier_invoice_number: 'CHK 906485',
          gross_amount: 6000,
          tax_point_date: '2026-06-01',
        },
        existing,
      );
      expect(hit?.existingExpenseId).toBe(77);
    });

    it('matches when the receipt carries no number at all (pair 96 / 97)', () => {
      const existing = [
        row({
          id: 96,
          supplier_id: SUPPLIER_X_CORP,
          currency: 'EUR',
          supplier_invoice_number: '2AUEKTA30001',
          gross_amount: 1100,
          tax_point_date: '2026-07-15',
        }),
      ];
      const hit = findDuplicateExpense(
        {
          supplier_id: SUPPLIER_X_CORP,
          currency: 'EUR',
          supplier_invoice_number: null,
          gross_amount: 1100,
          tax_point_date: '2026-07-15',
        },
        existing,
      );
      expect(hit?.existingExpenseId).toBe(96);
      expect(hit?.matchedOn).toBe('amount_and_date');
    });

    it('matches when NEITHER side carries a number', () => {
      const existing = [row({ id: 200, supplier_invoice_number: null })];
      const hit = findDuplicateExpense(
        {
          supplier_id: SUPPLIER_ANOMALY,
          currency: 'EUR',
          supplier_invoice_number: null,
          gross_amount: 1600,
          tax_point_date: '2026-05-31',
        },
        existing,
      );
      expect(hit?.existingExpenseId).toBe(200);
      expect(hit?.matchedOn).toBe('amount_and_date');
    });

    it('does NOT flag the five legitimate Anomaly invoices of 16.00 on 2026-05-31', () => {
      const numbers = [
        'RI7USPNX0006',
        'RI7USPNX0007',
        'RI7USPNX0008',
        'RI7USPNX0009',
        'RI7USPNX0010',
      ];
      const existing: DuplicateExpenseRow[] = [];
      numbers.forEach((supplier_invoice_number, i) => {
        const candidate = {
          supplier_id: SUPPLIER_ANOMALY,
          currency: 'EUR',
          supplier_invoice_number,
          gross_amount: 1600,
          tax_point_date: '2026-05-31',
        };
        expect(findDuplicateExpense(candidate, existing)).toBeNull();
        existing.push(row({ id: 100 + i, supplier_invoice_number }));
      });
      expect(existing).toHaveLength(5);
    });

    it('does NOT flag two different documents for one purchase (pair 84 / 85)', () => {
      // Order confirmation 28965 vs invoice 2599 — both print a number, and
      // the numbers differ, so the amount/date fallback must not run.
      const existing = [
        row({
          id: 84,
          supplier_id: SUPPLIER_MOBILE_TRADE,
          currency: 'EUR',
          supplier_invoice_number: '28965',
          gross_amount: 39900,
          tax_point_date: '2026-07-02',
        }),
      ];
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_MOBILE_TRADE,
            currency: 'EUR',
            supplier_invoice_number: '2599',
            gross_amount: 39900,
            tax_point_date: '2026-07-02',
          },
          existing,
        ),
      ).toBeNull();
    });

    it('does NOT match a reversed expense — the reversal exists so it can be re-entered', () => {
      const existing = [
        row({
          id: 300,
          supplier_invoice_number: 'RI7USPNX0013',
          status: 'reversed',
        }),
      ];
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            currency: 'EUR',
            supplier_invoice_number: 'RI7USPNX0013',
            gross_amount: 1600,
            tax_point_date: '2026-05-31',
          },
          existing,
        ),
      ).toBeNull();

      const noNumber = [
        row({ id: 301, supplier_invoice_number: null, status: 'reversed' }),
      ];
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            currency: 'EUR',
            supplier_invoice_number: null,
            gross_amount: 1600,
            tax_point_date: '2026-05-31',
          },
          noNumber,
        ),
      ).toBeNull();
    });

    it('never groups on a NULL supplier', () => {
      const existing = [
        row({ id: 400, supplier_id: null, supplier_invoice_number: null }),
      ];
      expect(
        findDuplicateExpense(
          {
            supplier_id: null,
            currency: 'EUR',
            supplier_invoice_number: null,
            gross_amount: 1600,
            tax_point_date: '2026-05-31',
          },
          existing,
        ),
      ).toBeNull();
    });

    it('does not cross supplier boundaries', () => {
      const existing = [
        row({
          id: 500,
          supplier_id: SUPPLIER_NEXT_HOUSE,
          currency: 'EUR',
          supplier_invoice_number: 'RI7USPNX0013',
        }),
      ];
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            currency: 'EUR',
            supplier_invoice_number: 'RI7USPNX0013',
            gross_amount: 1600,
            tax_point_date: '2026-05-31',
          },
          existing,
        ),
      ).toBeNull();
    });

    it('does not fall back on a different amount or a different date', () => {
      const existing = [row({ id: 600, supplier_invoice_number: null })];
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            currency: 'EUR',
            supplier_invoice_number: null,
            gross_amount: 1601,
            tax_point_date: '2026-05-31',
          },
          existing,
        ),
      ).toBeNull();
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            currency: 'EUR',
            supplier_invoice_number: null,
            gross_amount: 1600,
            tax_point_date: '2026-06-01',
          },
          existing,
        ),
      ).toBeNull();
    });

    it('prefers an invoice-number match over the fallback, and names the earliest original', () => {
      const existing = [
        row({ id: 10, supplier_invoice_number: null }),
        row({ id: 11, supplier_invoice_number: null }),
        row({ id: 12, supplier_invoice_number: 'RI7USPNX0013' }),
      ];
      const hit = findDuplicateExpense(
        {
          supplier_id: SUPPLIER_ANOMALY,
          currency: 'EUR',
          supplier_invoice_number: 'R17USPNX-0013',
          gross_amount: 1600,
          tax_point_date: '2026-05-31',
        },
        existing,
      );
      expect(hit?.existingExpenseId).toBe(12);
      expect(hit?.matchedOn).toBe('invoice_number');

      const fallbackHit = findDuplicateExpense(
        {
          supplier_id: SUPPLIER_ANOMALY,
          currency: 'EUR',
          supplier_invoice_number: null,
          gross_amount: 1600,
          tax_point_date: '2026-05-31',
        },
        existing,
      );
      // The earliest surviving expense is the original the operator must look at.
      expect(fallbackHit?.existingExpenseId).toBe(10);
    });

    it('does NOT fall back when the CANDIDATE prints a number and the peer merely lacks one', () => {
      // Production replay: Anomaly's five legitimate invoices of 16.00 on
      // 2026-05-31, with the OCR failure of pair 96/97 hitting the FIRST
      // arrival, so the earliest row carries no number. Falling back whenever a
      // number is missing on EITHER side lets that one numberless row bridge
      // every numbered peer sharing the amount and date, refusing four real
      // deductions — exactly the collapse issue #195 rejects.
      const existing = [row({ id: 1, supplier_invoice_number: null })];
      for (const supplier_invoice_number of [
        'RI7USPNX0007',
        'RI7USPNX0008',
        'RI7USPNX0009',
        'RI7USPNX0010',
      ]) {
        expect(
          findDuplicateExpense(
            {
              supplier_id: SUPPLIER_ANOMALY,
              supplier_invoice_number,
              currency: 'EUR',
              gross_amount: 1600,
              tax_point_date: '2026-05-31',
            },
            existing,
          ),
        ).toBeNull();
      }
    });

    it('does NOT fall back across different claimants', () => {
      // Two employees each buy the same-priced item from one supplier on one
      // day: two real purchases, two real reimbursements.
      const existing = [
        row({ id: 700, supplier_invoice_number: null, claimant_id: 1 }),
      ];
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            supplier_invoice_number: null,
            currency: 'EUR',
            gross_amount: 1600,
            tax_point_date: '2026-05-31',
            claimant_id: 2,
          },
          existing,
        ),
      ).toBeNull();

      // The SAME claimant twice is still the ordinary fallback.
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            supplier_invoice_number: null,
            currency: 'EUR',
            gross_amount: 1600,
            tax_point_date: '2026-05-31',
            claimant_id: 1,
          },
          existing,
        )?.existingExpenseId,
      ).toBe(700);
    });

    it('does NOT fall back across different currencies', () => {
      // 100.00 USD and 100.00 EUR share a minor-unit amount and nothing else.
      const existing = [
        row({
          id: 800,
          supplier_invoice_number: null,
          currency: 'USD',
          gross_amount: 10000,
        }),
      ];
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            supplier_invoice_number: null,
            currency: 'EUR',
            gross_amount: 10000,
            tax_point_date: '2026-05-31',
          },
          existing,
        ),
      ).toBeNull();
    });

    it('still matches on the invoice number across claimants and currencies', () => {
      // One printed number is one purchase whoever paid it and in whatever
      // currency the reader believed it was denominated: rule 1 is unaffected.
      const existing = [
        row({
          id: 900,
          supplier_invoice_number: 'RI7USPNX0013',
          claimant_id: 1,
          currency: 'USD',
        }),
      ];
      expect(
        findDuplicateExpense(
          {
            supplier_id: SUPPLIER_ANOMALY,
            supplier_invoice_number: 'R17USPNX-0013',
            currency: 'EUR',
            gross_amount: 1600,
            tax_point_date: '2026-05-31',
            claimant_id: 2,
          },
          existing,
        )?.existingExpenseId,
      ).toBe(900);
    });

    it('reports the document type of the matched expense', () => {
      // The caller needs it to tell an invoice+receipt pair (file the receipt
      // silently) from two independent number-less receipts (ask a human).
      const existing = [
        row({
          id: 950,
          supplier_invoice_number: null,
          ai_document_type: 'receipt',
        }),
      ];
      const hit = findDuplicateExpense(
        {
          supplier_id: SUPPLIER_ANOMALY,
          supplier_invoice_number: null,
          currency: 'EUR',
          gross_amount: 1600,
          tax_point_date: '2026-05-31',
        },
        existing,
      );
      expect(hit?.existingExpenseId).toBe(950);
      expect(hit?.existingDocumentType).toBe('receipt');
    });
  });
});
