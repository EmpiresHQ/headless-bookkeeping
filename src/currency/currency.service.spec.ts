import { Test } from '@nestjs/testing';
import { CurrencyService } from './currency.service';
import { FXRateService } from './fx-rate.service';
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

describe('FXRateService', () => {
  const service = new FXRateService();

  describe('getRate', () => {
    it('returns 7.14 for USD -> DKK', () => {
      expect(service.getRate('USD', 'DKK')).toBe(7.14);
    });

    it('returns 0.14 for DKK -> USD', () => {
      expect(service.getRate('DKK', 'USD')).toBe(0.14);
    });

    it('returns 7.46 for EUR -> DKK', () => {
      expect(service.getRate('EUR', 'DKK')).toBe(7.46);
    });

    it('returns 0.134 for DKK -> EUR', () => {
      expect(service.getRate('DKK', 'EUR')).toBe(0.134);
    });

    it('throws for an unsupported currency pair', () => {
      expect(() => service.getRate('GBP', 'DKK')).toThrow(
        'No FX rate configured for GBP → DKK',
      );
    });
  });
});
