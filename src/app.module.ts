import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { OrganizationModule } from './organization/organization.module';
import { CurrencyModule } from './currency/currency.module';
import { NullCountryPlugin } from './plugins/null-country.plugin';
import { PluginLoader } from './plugins/plugin-loader.service';

@Module({
  imports: [DatabaseModule, OrganizationModule, CurrencyModule],
  controllers: [AppController],
  providers: [AppService, NullCountryPlugin, PluginLoader],
})
export class AppModule {}
