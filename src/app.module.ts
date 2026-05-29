import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { OrganizationModule } from './organization/organization.module';
import { CurrencyModule } from './currency/currency.module';
import { PluginsModule } from './plugins/plugins.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    DatabaseModule,
    OrganizationModule,
    CurrencyModule,
    PluginsModule,
    HealthModule,
  ],
})
export class AppModule {}
