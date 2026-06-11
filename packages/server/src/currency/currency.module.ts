import { Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module';
import { PluginsModule } from '../plugins/plugins.module';
import { CurrencyService } from './currency.service';

@Module({
  imports: [OrganizationModule, PluginsModule],
  providers: [CurrencyService],
  exports: [CurrencyService],
})
export class CurrencyModule {}
