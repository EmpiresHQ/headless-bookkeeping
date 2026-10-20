import { decideEuVat, EuVatFacts, EuVatInput } from './eu-vat';
import { EstoniaCountryPlugin } from './estonia-country.plugin';
import { unusedFxRateService } from '../../test/fx-fixtures';
import { OrgContext, ServicePlaceRule } from './country-plugin.interface';

const general: EuVatFacts = {
  supplyType: 'services',
  recipientStatus: 'taxable_business',
  receivingEstablishmentCountry: 'EE',
  supplierEstablishmentCountry: 'US',
  supplierNonEstablishedInPlace: true,
  businessPurpose: true,
  buyerEvidence: true,
  evidence: [
    {
      fact: 'supplierNonEstablishedInPlace',
      reference: 'synthetic contract',
      source: 'human',
      confirmedBy: 'test-operator',
      confirmedAt: '2026-10-20T00:00:00Z',
    },
  ],
};
const input = (
  facts: EuVatFacts = general,
  rule: ServicePlaceRule = 'general',
): EuVatInput => ({
  date: '2026-06-10',
  supplyType: facts.supplyType ?? 'services',
  rule,
  supplierCountry: 'US',
  recipientCountry: 'EE',
  facts,
});
const plugin = new EstoniaCountryPlugin(unusedFxRateService());
const org: OrgContext = {
  country: 'EE',
  vatRegistered: true,
  baseCurrency: null,
};
const supplier = {
  country: 'US',
  goodsVsServices: 'services' as const,
  classificationMemory: [],
  taxStatus: 'taxable_business' as const,
};
const resolve = (
  facts: EuVatFacts,
  rule: ServicePlaceRule = 'general',
  date = '2026-06-10',
  location?: string,
) =>
  plugin.resolveCrossBorderTreatment(supplier, org, {
    vatCharged: false,
    taxPointDate: date,
    euVatFacts: facts,
    servicePlaceRule: rule,
    placeOfSupplyCountry: location,
  });

describe('composed EU VAT decisions (#398)', () => {
  it('general B2B and B2C have independent establishment criteria', () => {
    expect(decideEuVat(input())).toMatchObject({
      ruleId: 'Art44',
      jurisdiction: 'EE',
      liability: 'article196',
    });
    expect(
      decideEuVat(
        input({
          recipientStatus: 'non_taxable',
          supplierEstablishmentCountry: 'DE',
        }),
      ),
    ).toMatchObject({
      ruleId: 'Art45',
      jurisdiction: 'DE',
      liability: 'supplier',
    });
    expect(
      decideEuVat(input({ ...general, receivingEstablishmentCountry: 'FR' })),
    ).toMatchObject({ jurisdiction: 'FR' });
  });
  it.each([
    'recipientStatus',
    'receivingEstablishmentCountry',
    'supplierNonEstablishedInPlace',
  ] as const)('holds missing %s instead of guessing', (key) => {
    const f = { ...general };
    delete f[key];
    expect(decideEuVat(input(f))).toHaveProperty('hold');
  });
  it('a local intervening establishment defeats ordinary Art196', () => {
    expect(
      decideEuVat(input({ ...general, supplierNonEstablishedInPlace: false })),
    ).toMatchObject({ liability: 'supplier' });
    expect(() =>
      resolve({ ...general, supplierNonEstablishedInPlace: false }),
    ).toThrow('national treatment');
  });
  it.each([
    'immovable_property',
    'short_term_hire_of_means_of_transport',
    'cultural_artistic_sporting_admission',
    'restaurant_catering',
  ] as const)('special %s runs before general B2B', (rule) => {
    const f: EuVatFacts = {
      ...general,
      hireDays: 30,
      vehicleKind: 'other',
      attendance: 'physical',
      onboard: false,
    };
    expect(decideEuVat({ ...input(f, rule), location: 'FR' })).toMatchObject({
      jurisdiction: 'FR',
      liability: 'national_review',
    });
  });
  it.each([
    [30, 'other', false],
    [31, 'other', true],
    [90, 'vessel', false],
    [91, 'vessel', true],
  ] as const)('hire %s/%s boundary', (hireDays, vehicleKind, held) => {
    const d = decideEuVat({
      ...input(
        { ...general, hireDays, vehicleKind },
        'short_term_hire_of_means_of_transport',
      ),
      location: 'FR',
    });
    expect('hold' in d).toBe(held);
  });
  it('virtual admission is dated, including the B2C exception', () => {
    const i = input(
      { ...general, attendance: 'virtual' },
      'cultural_artistic_sporting_admission',
    );
    expect(decideEuVat({ ...i, date: '2024-12-31' })).toMatchObject({
      ruleId: 'virtual_admission_before_2025',
    });
    expect(decideEuVat({ ...i, date: '2025-01-01' })).toMatchObject({
      ruleId: 'Art44',
      effectiveFrom: '2025-01-01',
    });
    expect(
      decideEuVat({
        ...i,
        facts: { ...i.facts, recipientStatus: 'non_taxable' },
      }),
    ).toMatchObject({ ruleId: 'Art54_virtual_2025', jurisdiction: 'EE' });
  });
  it('onboard intra-Community catering uses departure rather than supplier location', () => {
    expect(
      decideEuVat(
        input(
          {
            ...general,
            onboard: true,
            onboardIntraCommunity: true,
            departureCountry: 'DE',
          },
          'restaurant_catering',
        ),
      ),
    ).toMatchObject({ ruleId: 'Art57', jurisdiction: 'DE' });
    expect(
      resolve(
        {
          ...general,
          onboard: true,
          onboardIntraCommunity: true,
          departureCountry: 'EE',
          internationalJourney: true,
          transportMode: 'aircraft',
        },
        'restaurant_catering',
      ),
    ).toMatchObject({
      treatment: 'domestic',
      vatCode: 'EE_INPUT_ONBOARD_ZERO',
    });
    expect(() =>
      resolve({ ...general, onboard: true }, 'restaurant_catering'),
    ).toThrow('onboardIntraCommunity');
  });
  it('Article48 retains distance shares for national adapters without inventing a rate', () => {
    expect(
      decideEuVat(
        input(
          {
            route: [{ from: 'EE', to: 'LV' }],
            transportDistanceByCountry: [
              { country: 'EE', distanceKm: 120 },
              { country: 'LV', distanceKm: 80 },
            ],
          },
          'passenger_transport',
        ),
      ),
    ).toMatchObject({
      jurisdiction: 'distance_apportioned',
      distanceAllocation: [
        { country: 'EE', distanceKm: 120, totalDistanceKm: 200 },
        { country: 'LV', distanceKm: 80, totalDistanceKm: 200 },
      ],
    });
  });
  it('missing passenger route and unsupported specials never fall through', () => {
    expect(() => resolve(general, 'passenger_transport')).toThrow('route');
    expect(() => resolve(general, 'other_special')).toThrow('special-rule');
    expect(() =>
      resolve(general, 'electronically_supplied_to_consumer'),
    ).toThrow('special-rule');
  });
  it('goods have movement/customs paths rather than Art44', () => {
    expect(
      decideEuVat(input({ ...general, supplyType: 'goods' })),
    ).toHaveProperty('hold');
    expect(
      resolve({
        supplyType: 'goods',
        goodsMovement: 'import',
        goodsDestinationCountry: 'EE',
      }),
    ).toMatchObject({ treatment: 'import' });
    expect(() =>
      resolve({ ...general, supplyType: 'goods' }, 'passenger_transport'),
    ).toThrow('goods_service_conflict');
  });
  it('does not deduct supplier VAT as customs import VAT without documentary evidence', () => {
    expect(() =>
      plugin.resolveCrossBorderTreatment(supplier, org, {
        vatCharged: true,
        taxPointDate: '2026-06-10',
        euVatFacts: {
          supplyType: 'goods',
          goodsMovement: 'import',
          goodsDestinationCountry: 'EE',
        },
      }),
    ).toThrow('customs assessment');
  });
  it.each(['margin_scheme', 'use_and_enjoyment', 'transitional_rate'] as const)(
    'holds the explicit %s special case before the general rule',
    (specialCase) => {
      expect(decideEuVat(input({ ...general, specialCase }))).toMatchObject({
        ruleId: `${specialCase}_unsupported`,
      });
    },
  );
  it('SaaS origin follows supplying establishment, not supplier postal country', () => {
    expect(resolve(general)).toMatchObject({
      treatment: 'reverse_charge',
      vatCode: 'EE_REVERSE_CHARGE_3RD_COUNTRY',
    });
    expect(
      resolve({ ...general, supplierEstablishmentCountry: 'DE' }),
    ).toMatchObject({ vatCode: 'EE_REVERSE_CHARGE_EU' });
    expect(() =>
      resolve({ ...general, supplierEstablishmentCountry: undefined }),
    ).toThrow('supplier establishment');
  });
  it('zero/exempt/outside evidence stays distinct from foreign tax', () => {
    const f: EuVatFacts = {
      ...general,
      receivingEstablishmentCountry: 'DE',
      documentTaxTreatment: 'exempt',
      evidence: [
        {
          fact: 'documentTaxTreatment',
          reference: 'synthetic exemption',
          source: 'document',
        },
      ],
    };
    expect(resolve(f)).toMatchObject({
      treatment: 'foreign_cost',
      decision: { nationalTreatment: 'exempt' },
    });
    expect(() => resolve({ ...f, evidence: [] })).toThrow('zero tax alone');
  });
  it.each([
    ['2023-12-31', 0.2],
    ['2024-01-01', 0.22],
    ['2025-06-30', 0.22],
    ['2025-07-01', 0.24],
  ] as const)('dated standard RC rate %s', (date, rate) => {
    expect(
      plugin.getVatRate(resolve(general, 'general', date).vatCode!, date),
    ).toBe(rate);
  });
});
