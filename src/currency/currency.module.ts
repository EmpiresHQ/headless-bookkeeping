import { Module } from '@nestjs/common';
import { CurrencyService, ORG_BASE_CURRENCY } from './currency.service';
import { FXRateService } from './fx-rate.service';

@Module({
  providers: [
    {
      provide: ORG_BASE_CURRENCY,
      useValue: 'DKK', // Default base currency; override in AppModule for production
    },
    CurrencyService,
    FXRateService,
  ],
  exports: [CurrencyService, FXRateService],
})
export class CurrencyModule {}
