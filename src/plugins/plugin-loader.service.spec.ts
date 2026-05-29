import { Test, TestingModule } from '@nestjs/testing';
import { NullCountryPlugin } from './null-country.plugin';
import { PluginLoader } from './plugin-loader.service';

describe('NullCountryPlugin', () => {
  let plugin: NullCountryPlugin;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NullCountryPlugin],
    }).compile();

    plugin = module.get<NullCountryPlugin>(NullCountryPlugin);
  });

  describe('getName', () => {
    it('should return "null"', () => {
      expect(plugin.getName()).toBe('null');
    });
  });

  describe('getVATCodes', () => {
    it('should return ["NULL_STANDARD"]', () => {
      expect(plugin.getVATCodes()).toEqual(['NULL_STANDARD']);
    });
  });

  describe('resolveCategoryMapping', () => {
    it('should return expected defaults for "software"', () => {
      const result = plugin.resolveCategoryMapping('software', {});
      expect(result).toEqual({
        account: 'EXPENSE_SOFTWARE',
        vatCode: 'NULL_STANDARD',
      });
    });

    it('should return generic fallback for unknown categories', () => {
      const result = plugin.resolveCategoryMapping('transport', {});
      expect(result).toEqual({
        account: 'EXPENSE_TRANSPORT',
        vatCode: 'NULL_STANDARD',
      });
    });
  });

  describe('getPeriodFrequencyOptions', () => {
    it('should return ["yearly"]', () => {
      expect(plugin.getPeriodFrequencyOptions()).toEqual(['yearly']);
    });
  });

  describe('getDefaultPeriodFrequency', () => {
    it('should return "yearly"', () => {
      expect(plugin.getDefaultPeriodFrequency()).toBe('yearly');
    });
  });

  describe('getDefaultBaseCurrency', () => {
    it('should return "EUR" as the neutral default', () => {
      expect(plugin.getDefaultBaseCurrency()).toBe('EUR');
    });
  });

  describe('validateVATCode', () => {
    it('should return true for "NULL_STANDARD"', () => {
      expect(plugin.validateVATCode('NULL_STANDARD', {})).toBe(true);
    });

    it('should return false for any other VAT code', () => {
      expect(plugin.validateVATCode('DK_INPUT_25', {})).toBe(false);
    });
  });
});

describe('PluginLoader', () => {
  let loader: PluginLoader;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NullCountryPlugin, PluginLoader],
    }).compile();

    loader = module.get<PluginLoader>(PluginLoader);
  });

  describe('resolve', () => {
    it('should return a CountryPlugin instance for "DK"', () => {
      const result = loader.resolve('DK');
      expect(result).toBeDefined();
      expect(typeof result.getName).toBe('function');
      expect(typeof result.getVATCodes).toBe('function');
      expect(typeof result.resolveCategoryMapping).toBe('function');
    });

    it('should return NullCountryPlugin for unrecognized country codes', () => {
      const result = loader.resolve('XX');
      expect(result.getName()).toBe('null');
    });

    it('should return NullCountryPlugin for "null"', () => {
      const result = loader.resolve('null');
      expect(result.getName()).toBe('null');
    });

    it('should fail loud when no default plugin is available', () => {
      const brokenLoader = new PluginLoader(
        undefined as unknown as NullCountryPlugin,
      );
      expect(() => brokenLoader.resolve('DK')).toThrow(
        /no default country plugin/i,
      );
    });
  });
});
