import { Test, TestingModule } from '@nestjs/testing';
import { OrgContextResolver } from '../../organization/org-context.resolver';
import { CurrencyService } from '../../currency/currency.service';
import {
  CategoryMappingResult,
  CountryPlugin,
} from '../../plugins/country-plugin.interface';
import { VoucherProjectionService } from './voucher-projection.service';
import { EconomicFacts } from './types';

/**
 * Unit tests for the deep projection module (ADR-0006). OrganizationService,
 * PluginLoader (country plugin) and CurrencyService are stubbed so we test the
 * projection's orchestration + balancing in isolation — the plugin stays the
 * sole resolver of Account + VAT code (ADR-0002), the projection only wires it.
 */
describe('VoucherProjectionService', () => {
  let service: VoucherProjectionService;

  const mapping: CategoryMappingResult = {
    accountCode: 'EXPENSE_SOFTWARE',
    vatCode: 'IE_INPUT_23',
  };
  const revenueMapping: CategoryMappingResult = {
    accountCode: 'REVENUE',
    vatCode: 'IE_OUTPUT_23',
  };

  const resolveCategoryMapping = jest.fn();

  // Cross-border resolution defaults to `domestic` so existing purchase/sale
  // tests keep the standard legs; individual tests override it for reverse
  // charge. getVatRate returns the EE standard 24% for the reverse-charge code.
  const resolveCrossBorderTreatment = jest.fn();
  const getVatRate = jest.fn((vatCode: string) =>
    vatCode === 'EE_REVERSE_CHARGE' ? 0.24 : 0,
  );

  const mockPlugin = {
    resolveCategoryMapping,
    resolveCrossBorderTreatment,
    getVatRate,
    // Rounding to base-currency minor units is a plugin rule (ADR-0002); the
    // projection rounds each leg through it. Neutral Math.round matches the
    // null-plugin default and keeps base_amounts byte-identical.
    roundToBaseMinorUnits: jest.fn((amount: number) => Math.round(amount)),
  } as unknown as CountryPlugin;

  // The projection now resolves the org + plugin + OrgContext through the
  // OrgContextResolver (the single owner of that ceremony). The stub returns the
  // same org / plugin / OrgContext shape the inline ceremony used to build.
  const mockResolver = {
    resolve: jest.fn().mockResolvedValue({
      organization: {
        country: 'IE',
        vat_registered: true,
        base_currency: null,
      },
      plugin: mockPlugin,
      orgContext: {
        country: 'IE',
        vatRegistered: true,
        baseCurrency: null,
      },
    }),
  };

  // A currency stub that books EUR at 1.0 (identity) and any other currency at
  // a fixed 2.0 rate, rounding to integer cents — exercising the fx_rate +
  // base_amount path without a real plugin.
  const mockCurrency = {
    toBase: jest.fn((amount: number, currency: string) =>
      Promise.resolve({
        baseAmount: currency === 'EUR' ? amount : Math.round(amount * 2),
        rate: currency === 'EUR' ? 1.0 : 2.0,
        baseCurrency: 'EUR',
      }),
    ),
    // Unrounded multiply (the projection applies the plugin's rounding rule on
    // top). EUR is identity (rate 1.0); any other currency uses the fixed 2.0.
    convertToBase: jest.fn((amount: number, currency: string) =>
      currency === 'EUR' ? amount : amount * 2,
    ),
  };

  beforeEach(async () => {
    resolveCategoryMapping.mockReset();
    resolveCategoryMapping.mockImplementation((category: string) =>
      category === 'revenue' ? revenueMapping : mapping,
    );
    resolveCrossBorderTreatment.mockReset();
    resolveCrossBorderTreatment.mockReturnValue({
      treatment: 'domestic',
      vatCode: 'IE_INPUT_23',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoucherProjectionService,
        { provide: OrgContextResolver, useValue: mockResolver },
        { provide: CurrencyService, useValue: mockCurrency },
      ],
    }).compile();

    service = module.get(VoucherProjectionService);
  });

  const purchaseFacts = (
    overrides?: Partial<EconomicFacts>,
  ): EconomicFacts => ({
    category: 'software',
    grossAmount: 12300,
    vatAmount: 2300,
    currency: 'EUR',
    taxPointDate: '2026-03-15',
    ...overrides,
  });

  const saleFacts = (overrides?: Partial<EconomicFacts>): EconomicFacts => ({
    category: 'revenue',
    grossAmount: 12300,
    vatAmount: 2300,
    currency: 'EUR',
    taxPointDate: '2026-03-15',
    ...overrides,
  });

  const debitTotal = (lines: { is_debit: boolean; base_amount: number }[]) =>
    lines.filter((l) => l.is_debit).reduce((s, l) => s + l.base_amount, 0);
  const creditTotal = (lines: { is_debit: boolean; base_amount: number }[]) =>
    lines.filter((l) => !l.is_debit).reduce((s, l) => s + l.base_amount, 0);

  describe('purchase direction (Expense)', () => {
    it('books Dr category(net) / Dr VAT_RECEIVABLE / Cr AP(gross)', async () => {
      const draft = await service.project(purchaseFacts(), 'purchase');

      expect(draft.voucher_number).toBe('PENDING');
      expect(draft.tax_point_date).toBe('2026-03-15');
      expect(draft.lines).toHaveLength(3);

      const cat = draft.lines.find(
        (l) => l.account_code === 'EXPENSE_SOFTWARE',
      )!;
      expect(cat.is_debit).toBe(true);
      expect(cat.amount).toBe(10000);
      expect(cat.vat_code).toBe('IE_INPUT_23');

      const vat = draft.lines.find((l) => l.account_code === 'VAT_RECEIVABLE')!;
      expect(vat.is_debit).toBe(true);
      expect(vat.amount).toBe(2300);
      expect(vat.vat_code).toBe('IE_INPUT_23');

      const ap = draft.lines.find((l) => l.account_code === 'AP')!;
      expect(ap.is_debit).toBe(false);
      expect(ap.amount).toBe(12300);
      expect(ap.vat_code).toBeNull();
    });

    it('balances in base currency (debits == credits)', async () => {
      const draft = await service.project(purchaseFacts(), 'purchase');
      expect(debitTotal(draft.lines)).toBe(creditTotal(draft.lines));
    });

    it('omits the VAT_RECEIVABLE line when vat_amount is zero', async () => {
      const draft = await service.project(
        purchaseFacts({ vatAmount: 0, grossAmount: 10000 }),
        'purchase',
      );
      expect(draft.lines).toHaveLength(2);
      expect(
        draft.lines.find((l) => l.account_code === 'VAT_RECEIVABLE'),
      ).toBeUndefined();
      expect(debitTotal(draft.lines)).toBe(creditTotal(draft.lines));
    });

    it('asks the plugin for the category mapping (does not embed rules)', async () => {
      await service.project(purchaseFacts(), 'purchase');
      expect(resolveCategoryMapping).toHaveBeenCalledWith(
        'software',
        expect.objectContaining({ country: 'IE' }),
        expect.objectContaining({ vatRegistered: true }),
      );
    });

    it('credits CLAIMANT_PAYABLE (not AP) when claimantId is set', async () => {
      const draft = await service.project(
        {
          category: 'meals',
          grossAmount: 2400,
          vatAmount: 400,
          currency: 'EUR',
          taxPointDate: '2026-06-01',
          claimantId: 7,
        },
        'purchase',
      );

      const credit = draft.lines.find((l) => !l.is_debit);
      expect(credit?.account_code).toBe('CLAIMANT_PAYABLE');
      const ap = draft.lines.find((l) => l.account_code === 'AP');
      expect(ap).toBeUndefined();
    });

    it('credits AP (not CLAIMANT_PAYABLE) when claimantId is null', async () => {
      const draft = await service.project(
        {
          category: 'software',
          grossAmount: 10000,
          vatAmount: 2300,
          currency: 'EUR',
          taxPointDate: '2026-06-01',
          claimantId: null,
        },
        'purchase',
      );

      const credit = draft.lines.find((l) => !l.is_debit);
      expect(credit?.account_code).toBe('AP');
    });

    it('omits VAT_RECEIVABLE when companyAddressedReceipt is false', async () => {
      const draft = await service.project(
        {
          category: 'meals',
          grossAmount: 1200,
          vatAmount: 200,
          currency: 'EUR',
          taxPointDate: '2026-06-01',
          claimantId: 3,
          companyAddressedReceipt: false,
        },
        'purchase',
      );

      const vatLine = draft.lines.find(
        (l) => l.account_code === 'VAT_RECEIVABLE',
      );
      expect(vatLine).toBeUndefined();

      // Full gross must be expensed (no VAT split)
      const expenseLine = draft.lines.find(
        (l) => l.is_debit && l.account_code !== 'VAT_RECEIVABLE',
      );
      expect(expenseLine?.amount).toBe(1200);
      // VAT code must be null when reclaim is suppressed (semantically correct for VAT return)
      expect(expenseLine?.vat_code).toBeNull();
    });

    it('credits CLAIMANT_PAYABLE on reverse-charge when claimantId is set', async () => {
      // Override: trigger the reverse-charge path exactly as the reverse-charge
      // describe block does, but with a claimantId set.
      resolveCrossBorderTreatment.mockReturnValueOnce({
        treatment: 'reverse_charge',
        vatCode: 'EE_REVERSE_CHARGE',
      });

      const draft = await service.project(
        {
          category: 'software',
          grossAmount: 1600,
          vatAmount: 0,
          currency: 'EUR',
          taxPointDate: '2026-06-01',
          claimantId: 5,
          supplierCountry: 'US',
          goodsVsServices: 'services',
        },
        'purchase',
      );

      // Four legs: Dr expense / Dr VAT_RECEIVABLE / Cr <payable> / Cr VAT_PAYABLE
      expect(draft.lines).toHaveLength(4);
      const creditLine = draft.lines.find(
        (l) =>
          !l.is_debit &&
          (l.account_code === 'AP' || l.account_code === 'CLAIMANT_PAYABLE'),
      );
      expect(creditLine?.account_code).toBe('CLAIMANT_PAYABLE');
      // AP must not appear at all
      expect(draft.lines.find((l) => l.account_code === 'AP')).toBeUndefined();
    });
  });

  describe('sale direction (SalesInvoice)', () => {
    it('books Dr AR(gross) / Cr category(net) / Cr VAT_PAYABLE', async () => {
      const draft = await service.project(saleFacts(), 'sale');

      expect(draft.lines).toHaveLength(3);

      const ar = draft.lines.find((l) => l.account_code === 'AR')!;
      expect(ar.is_debit).toBe(true);
      expect(ar.amount).toBe(12300);
      expect(ar.vat_code).toBeNull();

      const rev = draft.lines.find((l) => l.account_code === 'REVENUE')!;
      expect(rev.is_debit).toBe(false);
      expect(rev.amount).toBe(10000);
      expect(rev.vat_code).toBe('IE_OUTPUT_23');

      const vat = draft.lines.find((l) => l.account_code === 'VAT_PAYABLE')!;
      expect(vat.is_debit).toBe(false);
      expect(vat.amount).toBe(2300);
      expect(vat.vat_code).toBe('IE_OUTPUT_23');
    });

    it('balances in base currency (debits == credits)', async () => {
      const draft = await service.project(saleFacts(), 'sale');
      expect(debitTotal(draft.lines)).toBe(creditTotal(draft.lines));
    });

    it('omits the VAT_PAYABLE line at zero VAT (a 0-amount line cannot post)', async () => {
      const draft = await service.project(
        saleFacts({ vatAmount: 0, grossAmount: 10000 }),
        'sale',
      );
      // A 0% / exempt sale books just Dr AR / Cr REVENUE — the voucher_line
      // CHECK (amount > 0) forbids a zero VAT leg, so we drop it (symmetric to
      // the purchase side).
      expect(draft.lines).toHaveLength(2);
      expect(
        draft.lines.find((l) => l.account_code === 'VAT_PAYABLE'),
      ).toBeUndefined();
      expect(debitTotal(draft.lines)).toBe(creditTotal(draft.lines));
    });
  });

  describe('reverse charge (purchase, imported services)', () => {
    beforeEach(() => {
      // Imported B2B service: the plugin resolves reverse charge with OUR code.
      resolveCrossBorderTreatment.mockReturnValue({
        treatment: 'reverse_charge',
        vatCode: 'EE_REVERSE_CHARGE',
      });
    });

    it('self-assesses output + input VAT at the EE rate, net cash zero', async () => {
      // $16 imported service, no VAT on the document (vatAmount 0, gross 1600).
      const draft = await service.project(
        purchaseFacts({
          grossAmount: 1600,
          vatAmount: 0,
          supplierCountry: 'US',
          goodsVsServices: 'services',
        }),
        'purchase',
      );

      // Dr expense(gross) / Dr VAT_RECEIVABLE / Cr AP(gross) / Cr VAT_PAYABLE
      expect(draft.lines).toHaveLength(4);

      const cat = draft.lines.find(
        (l) => l.account_code === 'EXPENSE_SOFTWARE',
      )!;
      expect(cat.is_debit).toBe(true);
      expect(cat.amount).toBe(1600);
      expect(cat.vat_code).toBe('EE_REVERSE_CHARGE');

      const ap = draft.lines.find((l) => l.account_code === 'AP')!;
      expect(ap.is_debit).toBe(false);
      expect(ap.amount).toBe(1600); // payable is the net cost — no VAT to supplier
      expect(ap.vat_code).toBeNull();

      const inputVat = draft.lines.find(
        (l) => l.account_code === 'VAT_RECEIVABLE',
      )!;
      const outputVat = draft.lines.find(
        (l) => l.account_code === 'VAT_PAYABLE',
      )!;
      expect(inputVat.is_debit).toBe(true);
      expect(outputVat.is_debit).toBe(false);
      // 24% of 1600 = 384, self-assessed on both sides
      expect(inputVat.amount).toBe(384);
      expect(outputVat.amount).toBe(384);
      expect(inputVat.vat_code).toBe('EE_REVERSE_CHARGE');
      expect(outputVat.vat_code).toBe('EE_REVERSE_CHARGE');
    });

    it('balances in base currency (the two VAT legs cancel)', async () => {
      const draft = await service.project(
        purchaseFacts({
          grossAmount: 1600,
          vatAmount: 0,
          supplierCountry: 'US',
          goodsVsServices: 'services',
        }),
        'purchase',
      );
      expect(debitTotal(draft.lines)).toBe(creditTotal(draft.lines));
      // net cash effect of the VAT is zero: payable equals the gross only
      expect(creditTotal(draft.lines)).toBe(1600 + 384);
    });
  });

  describe('foreign currency', () => {
    it('books one uniform fx_rate on every line and balances in base', async () => {
      const draft = await service.project(
        purchaseFacts({ currency: 'USD' }),
        'purchase',
      );
      draft.lines.forEach((l) => expect(l.fx_rate).toBe(2.0));
      // net 10000 -> 20000, vat 2300 -> 4600, gross 12300 -> 24600
      const cat = draft.lines.find(
        (l) => l.account_code === 'EXPENSE_SOFTWARE',
      )!;
      expect(cat.base_amount).toBe(20000);
      expect(debitTotal(draft.lines)).toBe(creditTotal(draft.lines));
      expect(debitTotal(draft.lines)).toBe(24600);
    });

    it('resolves the rate via CurrencyService.toBase at the tax-point date', async () => {
      await service.project(purchaseFacts({ currency: 'USD' }), 'purchase');
      expect(mockCurrency.toBase).toHaveBeenCalledWith(
        10000, // net amount
        'USD',
        '2026-03-15',
      );
    });
  });
});
