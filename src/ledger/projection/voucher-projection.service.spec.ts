import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationService } from '../../organization/organization.service';
import { PluginLoader } from '../../plugins/plugin-loader.service';
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

  const mockPlugin = {
    resolveCategoryMapping,
    // Rounding to base-currency minor units is a plugin rule (ADR-0002); the
    // projection rounds each leg through it. Neutral Math.round matches the
    // null-plugin default and keeps base_amounts byte-identical.
    roundToBaseMinorUnits: jest.fn((amount: number) => Math.round(amount)),
  } as unknown as CountryPlugin;

  const mockOrg = {
    getOrganization: jest.fn().mockResolvedValue({
      country: 'IE',
      vat_registered: true,
      base_currency: null,
    }),
  };

  const mockPluginLoader = {
    resolve: jest.fn().mockReturnValue(mockPlugin),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoucherProjectionService,
        { provide: OrganizationService, useValue: mockOrg },
        { provide: PluginLoader, useValue: mockPluginLoader },
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

    it('always keeps the VAT_PAYABLE line, even at zero VAT', async () => {
      const draft = await service.project(
        saleFacts({ vatAmount: 0, grossAmount: 10000 }),
        'sale',
      );
      expect(draft.lines).toHaveLength(3);
      const vat = draft.lines.find((l) => l.account_code === 'VAT_PAYABLE')!;
      expect(vat.amount).toBe(0);
      expect(debitTotal(draft.lines)).toBe(creditTotal(draft.lines));
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
