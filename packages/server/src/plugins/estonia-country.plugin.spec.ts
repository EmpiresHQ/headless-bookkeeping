import { Kysely } from 'kysely';
import { Database } from '../database/types';
import { FxRateService } from '../fx/fx-rate.service';
import { FxRateUnavailableError } from '../fx/fx-rate.types';
import {
  ECB_FIXTURE_RATES,
  FixtureFxRateSource,
  FixtureRate,
  fixtureFxRateService,
  unusedFxRateService,
} from '../../test/fx-fixtures';
import { emptyKmdDeclaration } from '../../test/kmd-fixture';
// src/plugins/estonia-country.plugin.spec.ts
import { EstoniaCountryPlugin } from './estonia-country.plugin';
import {
  CategoryDef,
  OrgContext,
  SupplierFacts,
} from './country-plugin.interface';
import { renderAnnualAccountsXbrl } from './estonia-annual-accounts/xbrl';

describe('EstoniaCountryPlugin — VAT core', () => {
  const ee = new EstoniaCountryPlugin(unusedFxRateService());
  const org: OrgContext = {
    country: 'EE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const eeSupplier: SupplierFacts = {
    country: 'EE',
    goodsVsServices: 'services',
    classificationMemory: [],
  };

  it('name + base currency + monthly period', () => {
    expect(ee.getName()).toBe('EE');
    expect(ee.getDefaultBaseCurrency()).toBe('EUR');
    expect(ee.getPeriodFrequencyOptions()).toEqual(['monthly']);
    expect(ee.getDefaultPeriodFrequency()).toBe('monthly');
  });

  it('exposes the EE VAT code set', () => {
    const codes = ee.getVATCodes();
    expect(codes).toEqual(
      expect.arrayContaining([
        'EE_OUTPUT_24',
        'EE_INPUT_24',
        'EE_OUTPUT_13',
        'EE_INPUT_13',
        'EE_OUTPUT_9',
        'EE_INPUT_9',
        'EE_ZERO',
        'EE_REVERSE_CHARGE',
        'NULL_STANDARD',
      ]),
    );
  });

  it('maps revenue → EE_OUTPUT_24 and expenses → EE_INPUT_24 (standard auto-map)', () => {
    expect(ee.resolveCategoryMapping('revenue', eeSupplier, org)).toEqual({
      accountCode: 'REVENUE',
      vatCode: 'EE_OUTPUT_24',
    });
    expect(ee.resolveCategoryMapping('software', eeSupplier, org)).toEqual({
      accountCode: 'EXPENSE_SOFTWARE',
      vatCode: 'EE_INPUT_24',
    });
    expect(ee.resolveCategoryMapping('wibble', eeSupplier, org)).toEqual({
      accountCode: 'EXPENSE_OTHER',
      vatCode: 'EE_INPUT_24',
    });
  });

  it('maps revenue to an EU B2B customer of services → 0% intra-EU käive (Art 196)', () => {
    const dkCustomer: SupplierFacts = {
      country: 'DK',
      goodsVsServices: 'services',
      classificationMemory: [],
    };
    expect(ee.resolveCategoryMapping('revenue', dkCustomer, org)).toEqual({
      accountCode: 'REVENUE',
      vatCode: 'EE_OUTPUT_0_EU',
    });
  });

  it('keeps standard 24% revenue for a non-EU (export) customer — outside the intra-EU rule', () => {
    const usCustomer: SupplierFacts = {
      country: 'US',
      goodsVsServices: 'services',
      classificationMemory: [],
    };
    // Non-EU export of services is 0% too, but it is NOT the intra-EU (VD 3S)
    // case; we keep the standard code here so the report does not raise a VD
    // entry for it. (Refining export 0% is tracked separately.)
    expect(ee.resolveCategoryMapping('revenue', usCustomer, org).vatCode).toBe(
      'EE_OUTPUT_24',
    );
  });

  it('validateVATCode accepts the EE set + sentinel, rejects unknown', () => {
    expect(
      ee.validateVATCode('EE_INPUT_24', { supplier: eeSupplier, org }),
    ).toBe(true);
    expect(
      ee.validateVATCode('EE_REVERSE_CHARGE', { supplier: eeSupplier, org }),
    ).toBe(true);
    expect(
      ee.validateVATCode('NULL_STANDARD', { supplier: eeSupplier, org }),
    ).toBe(true);
    expect(
      ee.validateVATCode('DK_INPUT_25', { supplier: eeSupplier, org }),
    ).toBe(false);
  });

  it('rounds to whole cents and resolves personal disposition by org type', () => {
    expect(ee.roundToBaseMinorUnits(100.4)).toBe(100);
    expect(ee.resolvePersonalDispositionAccount('company')).toBe(
      'SHAREHOLDER_LOAN',
    );
    expect(ee.resolvePersonalDispositionAccount('sole_proprietor')).toBe(
      'OWNERS_DRAWINGS',
    );
  });
});

describe('EstoniaCountryPlugin — cross-border', () => {
  const ee = new EstoniaCountryPlugin(unusedFxRateService());
  const org: OrgContext = {
    country: 'EE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const mk = (
    country: string,
    gvs: 'goods' | 'services' | 'unknown',
  ): SupplierFacts => ({
    country,
    goodsVsServices: gvs,
    classificationMemory: [],
  });

  it('EE supplier → domestic, EE_INPUT_24', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('EE', 'services'), org, {
        vatCharged: true,
      }),
    ).toEqual({ treatment: 'domestic', vatCode: 'EE_INPUT_24' });
  });
  it('EU supplier (DE) → reverse_charge, EE_REVERSE_CHARGE (our code)', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('DE', 'services'), org, {
        vatCharged: false,
      }),
    ).toEqual({ treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' });
  });
  it('non-EU goods (US) → import', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('US', 'goods'), org, {
        vatCharged: false,
      }).treatment,
    ).toBe('import');
  });
  // Imported B2B services: place of supply is Estonia (KMS §10), so the buyer
  // self-assesses regardless of whether the supplier sits inside or outside the
  // EU. Non-EU service imports are reverse_charge just like intra-EU ones.
  it('non-EU services (US, no VAT) → reverse_charge, EE_REVERSE_CHARGE', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('US', 'services'), org, {
        vatCharged: false,
      }),
    ).toEqual({ treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' });
  });
  it('non-EU services (US) with foreign tax charged → still reverse_charge (foreign tax is not reclaimable EE VAT)', () => {
    expect(
      ee.resolveCrossBorderTreatment(mk('US', 'services'), org, {
        vatCharged: true,
      }),
    ).toEqual({ treatment: 'reverse_charge', vatCode: 'EE_REVERSE_CHARGE' });
  });
});

/**
 * Issue #203. The EE plugin no longer holds a rate: it declares the RULE
 * (ECB, the rate in force on the tax point, bounded lookback) and delegates
 * the lookup. These tests wire a real FxRateService — real cache table, real
 * fallback, real cross-rate arithmetic — to a fixture authority whose
 * publications are the ones the ECB actually made.
 */
describe('EstoniaCountryPlugin — FX (date-specific ECB rates)', () => {
  let ee: EstoniaCountryPlugin;
  let db: Kysely<Database>;
  let source: FixtureFxRateSource;

  beforeEach(async () => {
    source = new FixtureFxRateSource(ECB_FIXTURE_RATES);
    const wired = await fixtureFxRateService(ECB_FIXTURE_RATES, source);
    db = wired.db;
    ee = new EstoniaCountryPlugin(wired.service);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('same currency → identity, and never consults the authority', async () => {
    await expect(
      ee.getReferenceRate('EUR', 'EUR', '2026-06-09'),
    ).resolves.toEqual({
      rate: 1.0,
      rateDate: '2026-06-09',
      source: 'identity',
    });
    expect(source.calls).toEqual([]);
  });

  it('two dates six years apart get the TWO DIFFERENT rates the ECB published', async () => {
    // The defect: both of these returned the same constant 0.92.
    const y2020 = await ee.getReferenceRate('USD', 'EUR', '2020-01-02');
    const y2026 = await ee.getReferenceRate('USD', 'EUR', '2026-09-01');

    // USD→EUR is the reciprocal of the ECB's EUR→USD quotation.
    expect(y2020.rate).toBeCloseTo(1 / 1.1193, 10);
    expect(y2026.rate).toBeCloseTo(1 / 1.1655, 10);
    expect(y2020.rate).not.toBeCloseTo(y2026.rate, 4);
    expect(y2020).toMatchObject({ rateDate: '2020-01-02', source: 'ECB' });
    expect(y2026).toMatchObject({ rateDate: '2026-09-01', source: 'ECB' });
  });

  it('quotes the direct direction too (EUR → USD is the published figure)', async () => {
    const direct = await ee.getReferenceRate('EUR', 'USD', '2020-01-02');
    expect(direct.rate).toBeCloseTo(1.1193, 10);
    // Direct and inverse are exact reciprocals — one publication, two readings.
    const inverse = await ee.getReferenceRate('USD', 'EUR', '2020-01-02');
    expect(direct.rate * inverse.rate).toBeCloseTo(1, 12);
  });

  it('crosses two non-euro currencies through the euro, on ONE publication day', async () => {
    const usdGbp = await ee.getReferenceRate('USD', 'GBP', '2026-09-01');
    // 1 USD = (1/1.1655) EUR = (1/1.1655) × 0.8672 GBP
    expect(usdGbp.rate).toBeCloseTo(0.8672 / 1.1655, 10);
    expect(usdGbp).toMatchObject({ rateDate: '2026-09-01', source: 'ECB' });
  });

  it('a WEEKEND tax point applies the preceding Friday publication, and says so', async () => {
    // 2026-08-29 is a Saturday; the ECB published nothing. KMS § 29 lg 13 asks
    // for the rate IN FORCE, which is Friday 2026-08-28's.
    const saturday = await ee.getReferenceRate('USD', 'EUR', '2026-08-29');
    expect(saturday.rate).toBeCloseTo(1 / 1.1702, 10);
    expect(saturday.rateDate).toBe('2026-08-28');
    expect(saturday.rateDate).not.toBe('2026-08-29');
  });

  it('a TARGET closing day (1 January) falls back to the last working day of the old year', async () => {
    const newYear = await ee.getReferenceRate('USD', 'EUR', '2020-01-01');
    expect(newYear.rate).toBeCloseTo(1 / 1.1234, 10);
    expect(newYear.rateDate).toBe('2019-12-31');
  });

  it('refuses when nothing was published in the whole lookback window', async () => {
    // Deep inside the fixture's silent stretch: no publication on the date and
    // none in the seven days before it. Held, never approximated forwards.
    await expect(
      ee.getReferenceRate('USD', 'EUR', '2023-05-17'),
    ).rejects.toThrow(FxRateUnavailableError);
  });

  it('refuses a currency the authority does not quote at all', async () => {
    await expect(
      ee.getReferenceRate('JPY', 'EUR', '2026-09-01'),
    ).rejects.toThrow(FxRateUnavailableError);
  });

  it('refuses when the authority cannot be reached — no stale substitute', async () => {
    const down = await fixtureFxRateService(
      ECB_FIXTURE_RATES,
      new FixtureFxRateSource(
        ECB_FIXTURE_RATES,
        'ECB',
        ['USD'],
        'upstream 503',
      ),
    );
    const offline = new EstoniaCountryPlugin(down.service);
    await expect(
      offline.getReferenceRate('USD', 'EUR', '2026-09-01'),
    ).rejects.toThrow(/upstream 503/);
    await down.db.destroy();
  });

  it('caches: a repeated question for the same date does not re-ask upstream', async () => {
    await ee.getReferenceRate('USD', 'EUR', '2026-09-01');
    const callsAfterFirst = source.calls.length;
    const again = await ee.getReferenceRate('USD', 'EUR', '2026-09-01');
    expect(source.calls.length).toBe(callsAfterFirst);
    expect(again.rateDate).toBe('2026-09-01');
  });

  it('ADJACENT business days each get their OWN publication, in sequence', async () => {
    // The cache must not answer a never-asked date from an older row it
    // happens to hold: that would reintroduce a date-blind rate for a whole
    // lookback window. Friday first, then the following Monday, same instance
    // and same database.
    const friday = await ee.getReferenceRate('USD', 'EUR', '2026-08-28');
    const monday = await ee.getReferenceRate('USD', 'EUR', '2026-08-31');

    expect(friday.rateDate).toBe('2026-08-28');
    expect(monday.rateDate).toBe('2026-08-31');
    expect(monday.rate).toBeCloseTo(1 / 1.1688, 10);
    expect(monday.rate).not.toBeCloseTo(friday.rate, 6);
    // ... and the weekend between them still resolves back to Friday.
    const sunday = await ee.getReferenceRate('USD', 'EUR', '2026-08-30');
    expect(sunday.rateDate).toBe('2026-08-28');
  });

  it('a rate published AFTER a pre-publication miss is picked up by new postings', async () => {
    // The ECB publishes around 16:00 CET. A posting made this morning, for
    // today, legitimately finds nothing for today and applies the last rate in
    // force. That answer must stay PROVISIONAL: once today's rate appears, a
    // NEW posting has to see it. (Vouchers already posted keep the rate and
    // publication date they were booked at — a posted line is immutable.)
    const today = new Date().toISOString().slice(0, 10);
    const daysAgo = (n: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000)
        .toISOString()
        .slice(0, 10);

    const preRates: FixtureRate[] = [
      { quoteCurrency: 'USD', rateDate: daysAgo(1), rate: 1.1702 },
    ];
    const live = new FixtureFxRateSource(preRates, 'ECB', ['USD']);
    const wired = await fixtureFxRateService(preRates, live);
    const plugin = new EstoniaCountryPlugin(wired.service);

    const morning = await plugin.getReferenceRate('USD', 'EUR', today);
    expect(morning.rateDate).toBe(daysAgo(1));

    preRates.push({ quoteCurrency: 'USD', rateDate: today, rate: 1.1688 });
    const afternoon = await plugin.getReferenceRate('USD', 'EUR', today);
    expect(afternoon.rateDate).toBe(today);
    expect(afternoon.rate).toBeCloseTo(1 / 1.1688, 10);

    await wired.db.destroy();
  });

  it('a cached observation is never revalued by an upstream revision', async () => {
    const first = await ee.getReferenceRate('USD', 'EUR', '2026-09-01');

    // Upstream "corrects" a figure we have already posted against.
    const revised = ECB_FIXTURE_RATES.map((r) =>
      r.quoteCurrency === 'USD' && r.rateDate === '2026-09-01'
        ? { ...r, rate: 9.9999 }
        : r,
    );
    const revisedSource = new FixtureFxRateSource(revised);
    const plugin = new EstoniaCountryPlugin(
      new FxRateService(db, revisedSource),
    );

    // Same database, so the original observation is still cached and governs.
    const second = await plugin.getReferenceRate('USD', 'EUR', '2026-09-01');
    expect(second.rate).toBeCloseTo(first.rate, 12);
  });
});

describe('EstoniaCountryPlugin — retrieval + distribution tax', () => {
  const ee = new EstoniaCountryPlugin(unusedFxRateService());
  const org: OrgContext = {
    country: 'EE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const eeSup: SupplierFacts = {
    country: 'EE',
    goodsVsServices: 'services',
    classificationMemory: [],
  };

  it('getVatRate / computeVat at 24%', () => {
    expect(ee.getVatRate('EE_INPUT_24')).toBe(0.24);
    expect(ee.computeVat(100000, 'EE_INPUT_24')).toEqual({
      netMinorUnits: 100000,
      vatMinorUnits: 24000,
      grossMinorUnits: 124000,
      rate: 0.24,
    });
  });
  it('previewExpenseTreatment for a domestic software expense', () => {
    expect(ee.previewExpenseTreatment('software', eeSup, org)).toEqual({
      accountCode: 'EXPENSE_SOFTWARE',
      vatCode: 'EE_INPUT_24',
      rate: 0.24,
      treatment: 'domestic',
    });
  });
  it('getVatRegistrationThreshold = €40,000 in cents', () => {
    expect(ee.getVatRegistrationThreshold(org)).toBe(4000000);
  });
  it('dividendWithholdingRate is 0 (EE has no withholding)', () => {
    expect(ee.dividendWithholdingRate(org)).toBe(0.0);
  });
  it('resolveDistributionTax: 22/78 of net, to DISTRIBUTION_TAX_PAYABLE', () => {
    // net €1000.00 → tax = round(100000 * 22/78) = 28205
    expect(ee.resolveDistributionTax(100000, org)).toEqual({
      accountCode: 'DISTRIBUTION_TAX_PAYABLE',
      amount: 28205,
    });
  });
  it('assertDistributable blocks when net + distribution tax exceeds distributable', () => {
    // net 100000 + tax 28205 = 128205 total equity hit
    expect(ee.assertDistributable(100000, 128205, org)).toBe(true);
    expect(ee.assertDistributable(100000, 128204, org)).toBe(false);
  });
});

describe('generateStatutoryReports', () => {
  const plugin = new EstoniaCountryPlugin(unusedFxRateService());
  const input = {
    declarant: { regNumber: '17499653', name: 'Test OÜ' },
    period: { name: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31' },
    mode: 'final' as const,
    declaration: {
      ...emptyKmdDeclaration,
      row1_base_24: 200000,
      row4_output_vat: 48000,
      net_vat_due: 48000,
    },
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
        documentKind: 'invoice' as const,
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

  it('returns xml + csv artifacts when both formats requested', () => {
    const { artifacts } = plugin.generateStatutoryReports(input, {
      formats: ['xml', 'csv'],
    });
    expect(artifacts.map((a) => a.mimeType).sort()).toEqual([
      'application/xml',
      'text/csv',
    ]);
    expect(artifacts.find((a) => a.filename.endsWith('.xml'))).toBeDefined();
    expect(artifacts.find((a) => a.filename.endsWith('.csv'))).toBeDefined();
  });

  it('returns only the requested format', () => {
    const { artifacts } = plugin.generateStatutoryReports(input, {
      formats: ['xml'],
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].mimeType).toBe('application/xml');
  });

  it('warns when the declarant reg number is missing', () => {
    const bad = { ...input, declarant: { regNumber: null, name: 'X' } };
    const { warnings } = plugin.generateStatutoryReports(bad, {
      formats: ['xml'],
    });
    expect(
      warnings.some((w) => w.code === 'missing_declarant_reg_number'),
    ).toBe(true);
  });

  it('warns when the declarant reg number format is invalid (not EE + 9 digits)', () => {
    const bad = { ...input, declarant: { regNumber: 'XX1', name: 'X' } };
    const { warnings } = plugin.generateStatutoryReports(bad, {
      formats: ['xml'],
    });
    expect(
      warnings.some((w) => w.code === 'invalid_declarant_reg_number'),
    ).toBe(true);
  });

  it('surfaces INF missing-invoice-number warnings from buildInfPart', () => {
    const noInv = {
      ...input,
      salesLines: [
        { ...input.salesLines[0], invoiceNumber: null, netAmount: 500000 },
      ],
    };
    const { warnings } = plugin.generateStatutoryReports(noInv, {
      formats: ['xml'],
    });
    expect(warnings.some((w) => w.code === 'inf_missing_invoice_number')).toBe(
      true,
    );
  });
});

describe('EstoniaCountryPlugin — KMD row classification', () => {
  const ee = new EstoniaCountryPlugin(unusedFxRateService());

  it('standard 24% output → row 1', () => {
    expect(ee.classifyKmd('EE_OUTPUT_24')).toEqual({
      outputBaseRow: 1,
      acquisitionRow: null,
      vdCode: null,
      review: null,
    });
  });

  it('9% output → row 2', () => {
    expect(ee.classifyKmd('EE_OUTPUT_9').outputBaseRow).toBe(2);
  });

  it('0% intra-EU service → row 3 + VD tähis 3S', () => {
    expect(ee.classifyKmd('EE_OUTPUT_0_EU')).toEqual({
      outputBaseRow: 3,
      acquisitionRow: null,
      vdCode: '3S',
      review: null,
    });
  });

  it('plain 0% (export/other) → row 3, no VD', () => {
    expect(ee.classifyKmd('EE_ZERO')).toEqual({
      outputBaseRow: 3,
      acquisitionRow: null,
      vdCode: null,
      review: null,
    });
  });

  it('reverse charge → self-assessed supply (row 1) + acquisition (row 7), flagged for 6-vs-7 review', () => {
    const c = ee.classifyKmd('EE_REVERSE_CHARGE');
    expect(c.outputBaseRow).toBe(1);
    expect(c.acquisitionRow).toBe(7);
    expect(c.review).toMatch(/row 6.*7|intra-EU/i);
  });

  it('domestic input 24% feeds only the input-VAT total (no base row)', () => {
    expect(ee.classifyKmd('EE_INPUT_24')).toEqual({
      outputBaseRow: null,
      acquisitionRow: null,
      vdCode: null,
      review: null,
    });
  });
});

describe('EstoniaCountryPlugin — getCategories()', () => {
  const plugin = new EstoniaCountryPlugin(unusedFxRateService());
  const org: OrgContext = {
    country: 'EE',
    vatRegistered: true,
    baseCurrency: null,
  };
  const eeSupplier: SupplierFacts = {
    country: 'EE',
    goodsVsServices: 'services',
    classificationMemory: [],
  };

  it('returns the expense categories with stable key/label/accountCode', () => {
    const cats = plugin.getCategories();
    const keys = cats.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'software',
        'transport',
        'travel',
        'marketing',
        'salary',
        'contractor',
        'rent',
        'tax',
        'bank fee',
        'meals',
        'insurance',
        'education',
      ]),
    );
    // No 'revenue' — getCategories() is the EXPENSE set only.
    expect(keys).not.toContain('revenue');
    const software: CategoryDef | undefined = cats.find(
      (c) => c.key === 'software',
    );
    expect(software).toEqual({
      key: 'software',
      label: expect.any(String) as unknown,
      accountCode: 'EXPENSE_SOFTWARE',
    });
  });

  it('is consistent with resolveCategoryMapping (no divergence possible)', () => {
    for (const cat of plugin.getCategories()) {
      expect(
        plugin.resolveCategoryMapping(cat.key, eeSupplier, org).accountCode,
      ).toBe(cat.accountCode);
    }
  });
});

describe('getDocumentClassificationHints', () => {
  const ee = new EstoniaCountryPlugin(unusedFxRateService());

  it('names the Estonian order/proforma vocabulary and the invoice marker', () => {
    const hints = ee.getDocumentClassificationHints();
    expect(hints).toMatch(/Tellimus/i); // order
    expect(hints).toMatch(/ettemaksuarve/i); // prepayment/proforma
    expect(hints).toMatch(/Arve/); // invoice
    expect(hints).toMatch(/order_confirmation/);
    expect(hints).toMatch(/proforma/);
  });
});

describe('EstoniaCountryPlugin — fixed assets', () => {
  const ee = new EstoniaCountryPlugin(unusedFxRateService());
  const org = { country: 'EE', vatRegistered: true, baseCurrency: null };
  const eeSupplier = {
    country: 'EE',
    goodsVsServices: 'goods' as const,
    classificationMemory: [],
  };

  it('maps the four fixed-asset categories to per-class FIXED_ASSETS_* accounts', () => {
    expect(
      ee.resolveCategoryMapping('vehicle', eeSupplier, org).accountCode,
    ).toBe('FIXED_ASSETS_VEHICLES');
    expect(
      ee.resolveCategoryMapping('it_equipment', eeSupplier, org).accountCode,
    ).toBe('FIXED_ASSETS_IT');
    expect(
      ee.resolveCategoryMapping('machinery', eeSupplier, org).accountCode,
    ).toBe('FIXED_ASSETS_EQUIPMENT');
    expect(
      ee.resolveCategoryMapping('furniture', eeSupplier, org).accountCode,
    ).toBe('FIXED_ASSETS_FURNITURE');
  });

  it('exposes the fixed-asset categories in getCategories()', () => {
    const keys = ee.getCategories().map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'vehicle',
        'it_equipment',
        'machinery',
        'furniture',
      ]),
    );
  });

  it('uses straight-line depreciation', () => {
    expect(ee.getDepreciationMethod()).toBe('straight_line');
  });

  it('returns conventional default useful lives per class', () => {
    expect(ee.getFixedAssetDefaults('vehicle').defaultUsefulLifeYears).toBe(5);
    expect(
      ee.getFixedAssetDefaults('it_equipment').defaultUsefulLifeYears,
    ).toBe(3);
    expect(ee.getFixedAssetDefaults('machinery').defaultUsefulLifeYears).toBe(
      5,
    );
    expect(ee.getFixedAssetDefaults('furniture').defaultUsefulLifeYears).toBe(
      7,
    );
  });

  it('defaults residual to 0 except for vehicles (non-zero)', () => {
    expect(ee.getFixedAssetDefaults('it_equipment').defaultResidualMinor).toBe(
      0,
    );
    expect(ee.getFixedAssetDefaults('machinery').defaultResidualMinor).toBe(0);
    expect(ee.getFixedAssetDefaults('furniture').defaultResidualMinor).toBe(0);
    expect(
      ee.getFixedAssetDefaults('vehicle').defaultResidualMinor,
    ).toBeGreaterThan(0);
  });
});

describe('EstoniaCountryPlugin — annual accounts', () => {
  const ee = new EstoniaCountryPlugin(unusedFxRateService());
  const input = {
    period: { name: '2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    priorPeriod: null,
    mode: 'draft' as const,
    balances: [
      { code: 'BANK_EUR', type: 'asset' as const, current: 5000, prior: 0 },
      { code: 'MYSTERY', type: 'asset' as const, current: 250, prior: 0 },
    ],
    fixedAssets: [],
    periodNetIncome: 0,
    priorNetIncome: 0,
    retainedEarningsBroughtForward: 0,
    priorRetainedEarningsBroughtForward: 0,
    declarant: { regNumber: '12345678', name: 'Test OÜ' },
  };

  it('renders one XBRL artifact and warns on unmapped nonzero accounts', () => {
    const result = ee.generateAnnualAccounts(input, { taxonomyVersion: 2026 });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].filename).toBe('annual-accounts-2026.xbrl');
    expect(result.artifacts[0].mimeType).toBe('application/xml');
    expect(result.artifacts[0].content).toBe(
      renderAnnualAccountsXbrl(input, { taxonomyVersion: 2026 }),
    );
    expect(result.warnings.map((w) => w.code)).toContain(
      'unmapped_nonzero_account',
    );
  });
});
