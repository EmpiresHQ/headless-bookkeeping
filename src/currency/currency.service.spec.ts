import { Test } from '@nestjs/testing';
import { CurrencyService } from './currency.service';
import { OrganizationService } from '../organization/organization.service';
import { PluginLoader } from '../plugins/plugin-loader.service';

describe('CurrencyService.convertToBase', () => {
  let service: CurrencyService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        CurrencyService,
        {
          provide: OrganizationService,
          useValue: {
            getOrganization: jest.fn(),
          },
        },
        {
          provide: PluginLoader,
          useValue: {
            resolve: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(CurrencyService);
  });

  it('converts 100 USD to 714 at rate 7.14', () => {
    expect(service.convertToBase(100, 'USD', 7.14)).toBe(714);
  });

  it('converts 50 EUR to 373 at rate 7.46', () => {
    expect(service.convertToBase(50, 'EUR', 7.46)).toBe(373);
  });
});

describe('CurrencyService.toBase (the deep conversion module)', () => {
  let service: CurrencyService;
  let getOrganization: jest.Mock;
  let resolve: jest.Mock;
  let getReferenceRate: jest.Mock;
  let getDefaultBaseCurrency: jest.Mock;
  let roundToBaseMinorUnits: jest.Mock;

  const buildService = (
    org: {
      country: string;
      base_currency: string | null;
    },
    // The plugin owns rounding to base minor units (ADR-0002). Default to the
    // neutral null-plugin rule (Math.round) so existing expectations hold; a
    // test can inject a different rule to prove delegation.
    rounding: (amount: number) => number = (amount) => Math.round(amount),
  ) => {
    getReferenceRate = jest.fn();
    getDefaultBaseCurrency = jest.fn().mockReturnValue('EUR');
    roundToBaseMinorUnits = jest.fn(rounding);
    getOrganization = jest.fn().mockResolvedValue(org);
    resolve = jest.fn().mockReturnValue({
      getReferenceRate,
      getDefaultBaseCurrency,
      roundToBaseMinorUnits,
    });
    service = new CurrencyService(
      { getOrganization } as unknown as OrganizationService,
      { resolve } as unknown as PluginLoader,
    );
  };

  it('same currency → identity, rate 1.0, never hits the plugin', async () => {
    buildService({ country: 'IE', base_currency: null });

    const result = await service.toBase(12345, 'EUR', '2026-01-15');

    expect(result).toEqual({
      baseAmount: 12345,
      rate: 1.0,
      baseCurrency: 'EUR',
    });
    // The plugin's reference-rate path must NOT be touched for same currency
    // (NullCountryPlugin throws on real cross-currency pairs).
    expect(getReferenceRate).not.toHaveBeenCalled();
  });

  it('foreign currency → multiply by the plugin reference rate and round (Math.round)', async () => {
    buildService({ country: 'IE', base_currency: null });
    // 100 USD * 0.9876 = 98.76 → rounds to 99
    getReferenceRate.mockReturnValue(0.9876);

    const result = await service.toBase(100, 'USD', '2026-01-15');

    expect(getReferenceRate).toHaveBeenCalledWith('USD', 'EUR', '2026-01-15');
    expect(result).toEqual({
      baseAmount: 99,
      rate: 0.9876,
      baseCurrency: 'EUR',
    });
  });

  it('foreign currency → rounds half away from zero like Math.round', async () => {
    buildService({ country: 'IE', base_currency: null });
    // 1 unit * 2.5 = 2.5 → Math.round → 3
    getReferenceRate.mockReturnValue(2.5);

    const result = await service.toBase(1, 'USD', '2026-01-15');

    expect(result.baseAmount).toBe(3);
  });

  it('base-currency resolution: uses the Organization override when set', async () => {
    buildService({ country: 'IE', base_currency: 'USD' });
    // Source EUR ≠ base USD → goes through the plugin.
    getReferenceRate.mockReturnValue(1.1);

    const result = await service.toBase(100, 'EUR', '2026-01-15');

    expect(getReferenceRate).toHaveBeenCalledWith('EUR', 'USD', '2026-01-15');
    expect(result.baseCurrency).toBe('USD');
    expect(result.baseAmount).toBe(110);
    // Override means the plugin default is never consulted.
    expect(getDefaultBaseCurrency).not.toHaveBeenCalled();
  });

  it('base-currency resolution: falls back to the plugin default when no override', async () => {
    buildService({ country: 'IE', base_currency: null });

    const result = await service.toBase(500, 'EUR', '2026-01-15');

    expect(getDefaultBaseCurrency).toHaveBeenCalled();
    expect(result.baseCurrency).toBe('EUR');
    expect(result.baseAmount).toBe(500);
  });

  it('delegates base rounding to the plugin: a different rule changes the rounded result', async () => {
    // A jurisdiction that truncates (floor) instead of rounding half-up.
    buildService({ country: 'IE', base_currency: null }, (amount) =>
      Math.floor(amount),
    );
    // 100 USD * 0.9876 = 98.76 → Math.round would give 99, floor gives 98.
    getReferenceRate.mockReturnValue(0.9876);

    const result = await service.toBase(100, 'USD', '2026-01-15');

    expect(roundToBaseMinorUnits).toHaveBeenCalledWith(98.76);
    expect(result.baseAmount).toBe(98);
  });

  it('null-plugin rounding keeps Math.round semantics (half away from zero)', async () => {
    buildService({ country: 'IE', base_currency: null });
    // 1 * 2.5 = 2.5 → Math.round → 3 (byte-identical to the former hardcoded rule).
    getReferenceRate.mockReturnValue(2.5);

    const result = await service.toBase(1, 'USD', '2026-01-15');

    expect(roundToBaseMinorUnits).toHaveBeenCalledWith(2.5);
    expect(result.baseAmount).toBe(3);
  });

  it('convertToBaseRounded routes rounding through the plugin too', async () => {
    buildService({ country: 'IE', base_currency: null }, (amount) =>
      Math.floor(amount),
    );

    // 100 * 0.9876 = 98.76 → plugin floor → 98.
    const rounded = await service.convertToBaseRounded(100, 'USD', 0.9876);

    expect(roundToBaseMinorUnits).toHaveBeenCalledWith(98.76);
    expect(rounded).toBe(98);
  });
});
