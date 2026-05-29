import { Test, TestingModule } from '@nestjs/testing';
import { CurrencyService, ORG_BASE_CURRENCY } from './currency.service';
import { FXRateService } from './fx-rate.service';

describe('CurrencyService', () => {
  let service: CurrencyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CurrencyService,
        {
          provide: ORG_BASE_CURRENCY,
          useValue: 'DKK',
        },
      ],
    }).compile();

    service = module.get<CurrencyService>(CurrencyService);
  });

  describe('getBaseCurrency', () => {
    it('should return the Organization base_currency', () => {
      expect(service.getBaseCurrency()).toBe('DKK');
    });
  });

  describe('convertToBase', () => {
    it('should convert 100 USD to 714 DKK at rate 7.14', () => {
      const result = service.convertToBase(100, 'USD', 7.14);
      expect(result).toBe(714);
    });

    it('should convert 50 EUR to 373 DKK at rate 7.46', () => {
      const result = service.convertToBase(50, 'EUR', 7.46);
      expect(result).toBe(373);
    });
  });
});

describe('FXRateService', () => {
  let service: FXRateService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FXRateService],
    }).compile();

    service = module.get<FXRateService>(FXRateService);
  });

  describe('getRate', () => {
    it('should return 7.14 for USD → DKK', () => {
      expect(service.getRate('USD', 'DKK')).toBe(7.14);
    });

    it('should return 0.14 for DKK → USD', () => {
      expect(service.getRate('DKK', 'USD')).toBe(0.14);
    });

    it('should return 7.46 for EUR → DKK', () => {
      expect(service.getRate('EUR', 'DKK')).toBe(7.46);
    });

    it('should return 0.134 for DKK → EUR', () => {
      expect(service.getRate('DKK', 'EUR')).toBe(0.134);
    });

    it('should throw for unsupported currency pair', () => {
      expect(() => service.getRate('GBP', 'DKK')).toThrow(
        'No FX rate configured for GBP → DKK',
      );
    });
  });
});
