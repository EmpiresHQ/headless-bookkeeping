import { Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module';
import { PluginsModule } from '../plugins/plugins.module';
import { CurrencyService } from './currency.service';
import { FXRateService } from './fx-rate.service';

@Module({
  imports: [OrganizationModule, PluginsModule],
  providers: [CurrencyService, FXRateService],
  exports: [CurrencyService, FXRateService],
})
export class CurrencyModule {}
